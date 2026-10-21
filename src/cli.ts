#!/usr/bin/env node
/**
 * Screenshot diff between two origins.
 *
 *   vdiff <route…> --left <url> --right <url>
 *
 * Screenshots the given routes on both origins at several viewport widths and
 * pixel-diffs them. Routes are required and literal — the tool does no route discovery.
 *
 * Per-site knobs (masks for content that drifts, extra selectors to hide, defaults for
 * the flags below) live in a `vdiff.config.ts` / `.mjs` in the working directory.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadConfig,
  resolveConfig,
  type CliOverrides,
  type ResolvedConfig,
  type Route,
} from "./config.ts";

interface Args extends CliOverrides {
  dryRun: boolean;
  open: boolean;
  help: boolean;
  version: boolean;
  config?: string;
  routes: string[];
}

/** `Number(raw)`, but reject anything that isn't a finite number with a flag-named error. */
const num = (flag: string, raw: string): number => {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`${flag} expects a number, got "${raw}"`);
  }
  return n;
};

function parseArgs(argv: string[]): Args {
  const a: Args = {
    dryRun: false,
    open: false,
    help: false,
    version: false,
    routes: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    // Accept both `--flag value` and `--flag=value`.
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const v = eq === -1 ? raw : raw.slice(0, eq);
    const inline = eq === -1 ? undefined : raw.slice(eq + 1);
    // Require a value: the inline `--flag=value`, or the next argv token — but not
    // another flag, which means the value was simply omitted. Only advance `i` when
    // a positional token is actually consumed.
    const next = () => {
      if (inline !== undefined) return inline;
      const peek = argv[i + 1];
      if (peek === undefined || peek.startsWith("-")) {
        throw new Error(`${v} needs a value`);
      }
      return argv[++i]!;
    };
    if (v === "--help" || v === "-h") a.help = true;
    else if (v === "--version" || v === "-v") a.version = true;
    else if (v === "--dry-run") a.dryRun = true;
    else if (v === "--open") a.open = true;
    else if (v === "--left") a.left = next();
    else if (v === "--right") a.right = next();
    else if (v === "--out") a.outDir = next();
    else if (v === "--config") a.config = next();
    else if (v === "--width") {
      const w = num("--width", next());
      if (w <= 0) throw new Error(`--width expects a positive number, got ${w}`);
      (a.widths ??= []).push(w);
    } else if (v === "--concurrency") {
      const n = num("--concurrency", next());
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`--concurrency expects a positive integer, got ${n}`);
      }
      a.concurrency = n;
    } else if (v === "--threshold") {
      const t = num("--threshold", next());
      if (t < 0 || t > 1) throw new Error(`--threshold expects 0..1, got ${t}`);
      a.threshold = t;
    } else if (v.startsWith("-")) throw new Error(`unknown flag: ${v}`);
    else a.routes.push(v);
  }
  return a;
}

const HELP = `
  vdiff — screenshot diff between two origins

  Usage
    vdiff <route…> --left <url> --right <url> [options]

  Screenshots each route on both origins at several viewport widths, pixel-diffs the
  pairs, and writes a scored HTML report. Routes are literal paths — no globs, no
  discovery. Exits 1 if any route errors or falls below --threshold.

  Options
    --left <url>        Left origin, e.g. http://localhost:3000        (required)
    --right <url>       Right origin, e.g. https://example.com         (required)
    --width <n>         Viewport width; repeatable. Replaces the defaults.
    --threshold <0..1>  Fail if any comparison scores below this.
    --out <dir>         Output directory                        (default: ./vdiff-out)
    --concurrency <n>   Parallel workers                                 (default: 2)
    --config <path>     Config file. Default: vdiff.config.{ts,mts,js,mjs} in cwd.
    --dry-run           Print the URL pairs and exit. No browser.
    --open              Open the report when the run finishes.
    -h, --help          Show this.
    -v, --version       Print the version.

  Default widths: 1440, 1152, 896, 704, 375

  Example
    vdiff / /about /pricing --left http://localhost:3000 --right https://example.com

  Config file
    A vdiff.config.ts (or .mjs) in the working directory supplies defaults for the
    flags above, plus the things flags cannot express: per-route masks for content
    that legitimately drifts, extra selectors to hide, extra URLs to block.
    CLI flags always win over the config file.
`;

const usage = () => {
  console.error("  Usage: vdiff <route…> --left <url> --right <url>");
  console.error("  Try:   vdiff --help");
};

// A function declaration, not a const arrow: TypeScript only lets a `never`-returning
// call narrow control flow when the callee is declared this way.
function die(message: string): never {
  console.error(`✗ ${message}\n`);
  usage();
  process.exit(2);
}

/** `pricing` / `/pricing/` -> `/pricing`; `/` stays `/`. */
const normalize = (url: string) => {
  const trimmed = url.replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed ? `/${trimmed}` : "/";
};

const alive = async (origin: string) => {
  try {
    return (
      (
        await fetch(origin, {
          method: "HEAD",
          signal: AbortSignal.timeout(3000),
        })
      ).status < 500
    );
  } catch {
    return false;
  }
};

/**
 * Refuse to start unless both origins answer — two error pages diffed against each
 * other score well, which is the likeliest way this tool lies.
 */
async function preflight(left: string, right: string) {
  const [leftUp, rightUp] = await Promise.all([alive(left), alive(right)]);
  if (leftUp && rightUp) return;
  const down = [!leftUp && `left (${left})`, !rightUp && `right (${right})`]
    .filter(Boolean)
    .join(" and ");
  console.error(`✗ ${down} not responding.\n`);
  console.error(
    "  If that is a local dev server, start it first — and make sure it serves the",
  );
  console.error(
    "  same assets as the other origin (a bare preview server that 404s images will",
  );
  console.error("  collapse every page and diff as garbage).\n");
  process.exit(2);
}

function version(): string {
  const pkg = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "package.json",
  );
  try {
    return JSON.parse(fs.readFileSync(pkg, "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

let args: Args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  die(e instanceof Error ? e.message : String(e));
}

if (args.help) {
  console.log(HELP.trimEnd());
  process.exit(0);
}
if (args.version) {
  console.log(version());
  process.exit(0);
}

const { config: fileConfig, path: configPath } = await loadConfig(
  args.config,
).catch((e: unknown) => {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
});

let cfg: ResolvedConfig;
try {
  cfg = resolveConfig(fileConfig, args);
} catch (e) {
  die(e instanceof Error ? e.message : String(e));
}

const rawRoutes = args.routes.length ? args.routes : (fileConfig.routes ?? []);

if (!rawRoutes.length) {
  die("no routes given.");
}

const glob = rawRoutes.find((r) => r.includes("*"));
if (glob) {
  die(`globs are not supported (${glob}) — pass literal paths.`);
}

const routes: Route[] = rawRoutes.map(normalize);

if (configPath) console.log(`Config: ${configPath}`);
console.log(`Routes: ${routes.length}`);

if (args.dryRun) {
  for (const r of routes) {
    console.log(`  ${r.padEnd(52)} ${cfg.left}${r}  |  ${cfg.right}${r}`);
  }
  process.exit(0);
}

await preflight(cfg.left, cfg.right);

const { run } = await import("./run.ts");
try {
  process.exit(await run({ routes, cfg, open: args.open }));
} catch (e) {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
