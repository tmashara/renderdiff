#!/usr/bin/env node
/**
 * Screenshot diff between two origins.
 *
 *   renderdiff <left-origin> <right-origin> <route…>
 *
 * Screenshots the given routes on both origins at several viewport widths and
 * pixel-diffs them. Routes are required and literal — the tool does no route discovery.
 *
 * Per-site knobs (masks for content that drifts, extra selectors to hide, defaults for
 * the flags below) live in a `renderdiff.config.ts` / `.mjs` in the working directory.
 */
import {
  label,
  loadConfig,
  parseRoutes,
  resolveConfig,
  version,
  type CliOverrides,
  type ResolvedConfig,
  type Route,
} from "./config.ts";

interface Args extends CliOverrides {
  dryRun: boolean;
  open: boolean;
  /** Undefined: decide by whether stdout is a terminal. */
  progress?: boolean;
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
  const origins: string[] = [];
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
    else if (v === "--progress") a.progress = true;
    else if (v === "--no-progress") a.progress = false;
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
    else if (v.includes("://")) origins.push(v);
    else a.routes.push(v);
  }
  if (origins.length > 2) {
    throw new Error(`at most two origins (left, right), got ${origins.length}: ${origins.join(" ")}`);
  }
  for (const [i, side] of (["left", "right"] as const).entries()) {
    if (origins[i] === undefined) continue;
    if (a[side] !== undefined) {
      throw new Error(`${side} origin given twice: ${origins[i]} and --${side} ${a[side]}`);
    }
    a[side] = origins[i];
  }
  return a;
}

const HELP = `
  renderdiff — screenshot diff between two origins

  Usage
    renderdiff <left-origin> <right-origin> <route…> [options]

    renderdiff http://localhost:3000 https://example.com / /about
    renderdiff http://localhost:3000 https://example.com /pricing::/plans

  Any argument containing :// is an origin: the first is left, the second right (or
  pass --left / --right). A route is a literal path, loaded on both sides; /a::/b loads
  /a on the left and /b on the right. No globs, no discovery.

  Writes report.html, results.json and crops of each change to --out. Exits 1 if a
  route errors or falls below --threshold, 2 on bad arguments or an origin that is down.

  Options
    --left <url>        Left origin, instead of the first positional one.
    --right <url>       Right origin, instead of the second positional one.
    --width <n>         Viewport width; repeatable. Replaces the defaults.
    --threshold <0..1>  Fail if any comparison scores below this.
    --out <dir>         Output directory                   (default: ./renderdiff-out)
    --concurrency <n>   Parallel workers                                 (default: 2)
    --config <path>     Config file. Default: renderdiff.config.{ts,mts,js,mjs} in cwd.
    --dry-run           Print the URL pairs and exit. No browser.
    --open              Open the report when the run finishes.
    --progress          A line per shot as it finishes. The default on a terminal;
                        otherwise one summary of the differing routes at the end.
    --no-progress       The end-of-run summary, even on a terminal.
    -h, --help          Show this.
    -v, --version       Print the version.

  Default widths: 1440, 1152, 896, 704, 375

  Masks, hidden selectors, blocked URLs and route lists go in a config file; CLI flags
  win over it. See the README, or skills/renderdiff/reference.md.
`;

const usage = () => {
  console.error("  Usage: renderdiff <left-origin> <right-origin> <route…>");
  console.error("  Try:   renderdiff --help");
};

// A function declaration, not a const arrow: TypeScript only lets a `never`-returning
// call narrow control flow when the callee is declared this way.
function die(message: string): never {
  console.error(`✗ ${message}\n`);
  usage();
  process.exit(2);
}

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

let routes: Route[];
try {
  routes = parseRoutes(rawRoutes);
} catch (e) {
  die(e instanceof Error ? e.message : String(e));
}

if (configPath) console.log(`Config: ${configPath}`);
console.log(`Routes: ${routes.length}`);

if (args.dryRun) {
  for (const r of routes) {
    console.log(`  ${label(r).padEnd(52)} ${cfg.left}${r.left}  |  ${cfg.right}${r.right}`);
  }
  process.exit(0);
}

await preflight(cfg.left, cfg.right);

const { run } = await import("./run.ts");
try {
  process.exit(await run({
      routes,
      cfg,
      open: args.open,
      progress: args.progress ?? !!process.stdout.isTTY,
    }));
} catch (e) {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
