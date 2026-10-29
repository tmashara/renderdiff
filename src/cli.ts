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
import fs from "node:fs";
import path from "node:path";
import { ACCEPTED_FILE } from "./accept.ts";
import type { Results } from "./report.ts";
import {
  label,
  loadConfig,
  normalize,
  parseRoutes,
  resolveConfig,
  selectorText,
  version,
  type CliOverrides,
  type ResolvedConfig,
  type Route,
  type Sides,
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
  /** From --selector / --left-selector / --right-selector; replaces every route's own. */
  selector?: Sides;
  /** The reason to accept this run's differences with. */
  accept?: string;
  rerunFailed: boolean;
  cacheRight: boolean;
  recheck: boolean;
  /** `true` for the right side's /sitemap.xml, else a URL or path read against right. */
  sitemap?: string | true;
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
    rerunFailed: false,
    cacheRight: false,
    recheck: true,
    help: false,
    version: false,
    routes: [],
  };
  const origins: string[] = [];
  const sel: { both?: string; left?: string; right?: string } = {};
  const state: typeof sel = {};
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
    else if (v === "--rerun-failed") a.rerunFailed = true;
    else if (v === "--cache-right") a.cacheRight = true;
    else if (v === "--no-recheck") a.recheck = false;
    else if (v === "--computed") a.computed = true;
    else if (v === "--mask-media") a.maskMedia = true;
    else if (v === "--no-freeze-video") a.freezeVideo = false;
    else if (v === "--sitemap") {
      if (inline === "") throw new Error("--sitemap= needs a URL or path");
      a.sitemap = inline ?? true;
    } else if (v === "--accept") {
      a.accept = next().trim();
      if (!a.accept) throw new Error("--accept needs a reason");
    } else if (v === "--left") a.left = next();
    else if (v === "--right") a.right = next();
    else if (v === "--out") a.outDir = next();
    else if (v === "--config") a.config = next();
    else if (v === "--mask") {
      const s = next().trim();
      if (!s) throw new Error("--mask needs a value");
      (a.masks ??= []).push(s);
    } else if (v === "--selector" || v === "--left-selector" || v === "--right-selector") {
      const s = next();
      if (!s) throw new Error(`${v} needs a value`);
      sel[v === "--selector" ? "both" : v === "--left-selector" ? "left" : "right"] = s;
    } else if (
      v === "--storage-state" ||
      v === "--left-storage-state" ||
      v === "--right-storage-state"
    ) {
      const s = next();
      if (!s) throw new Error(`${v} needs a value`);
      state[v === "--storage-state" ? "both" : v === "--left-storage-state" ? "left" : "right"] = s;
    } else if (v === "--width") {
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
    else if (/^https?:\/\//i.test(v)) origins.push(v);
    else a.routes.push(v);
  }
  if (origins.length > 2) {
    throw new Error(
      `at most two origins (left, right), got ${origins.length}: ${origins.join(" ")}`,
    );
  }
  for (const [i, side] of (["left", "right"] as const).entries()) {
    if (origins[i] === undefined) continue;
    if (a[side] !== undefined) {
      throw new Error(`${side} origin given twice: ${origins[i]} and --${side} ${a[side]}`);
    }
    a[side] = origins[i];
  }
  const left = sel.left ?? sel.both;
  const right = sel.right ?? sel.both;
  if (!left !== !right) {
    const [has, lacks] = left ? ["left", "right"] : ["right", "left"];
    throw new Error(`--${has}-selector needs --${lacks}-selector or --selector`);
  }
  if (left && right) a.selector = { left, right };
  if (a.dryRun && (a.rerunFailed || a.accept !== undefined)) {
    throw new Error(`${a.rerunFailed ? "--rerun-failed" : "--accept"} needs a run, not --dry-run`);
  }
  if (state.both || state.left || state.right) {
    a.storageState = { left: state.left ?? state.both, right: state.right ?? state.both };
  }
  return a;
}

const HELP = `
  renderdiff — check that a migration didn't change how pages render

  Usage
    renderdiff <left-origin> <right-origin> <route…> [options]

    renderdiff http://localhost:3000 https://example.com / /about
    renderdiff http://localhost:3000 https://example.com /pricing::/plans
    renderdiff report <out-dir> [--verdict <file>] [--title <text>]
    renderdiff merge <full-out> <partial-out> --out <dir>
    renderdiff probe <url> [--width <n>] [--loads <n>]

  An argument starting with http:// or https:// is an origin: the first is left (your
  change), the second right (the reference); or pass --left / --right. A route is a
  literal path, loaded on both sides; /a::/b loads /a on the left and /b on the right.
  No globs, no discovery.

  With --selector, each side compares the one element it matches instead of the page;
  it must match exactly one. It applies to every route, over the config's own selectors.

  With --storage-state, each side starts with that Playwright storage state (cookies,
  localStorage), e.g. signed in. Make one with:
    npx playwright codegen --save-storage=auth.json <url>
  A before hook in the config runs on each page before it settles, e.g. to open a menu;
  a beforeShot hook runs after, right before the shot.

  --accept "<reason>" records this run's differences in renderdiff.accepted.json (next to
  the config, or in cwd); later runs report them as accepted, and anything new still shows.
  --rerun-failed reruns only what the previous run in --out didn't find clean or accepted.

  renderdiff report reads results.json in <out-dir>, rewrites report.html, and writes
  evidence.html beside it: one self-contained page (crops embedded) with a parity banner and
  the --verdict file's text.

  renderdiff merge writes <full-out>'s results to --out with each shot <partial-out> also
  has replaced by the partial run's, and its other shots added. Both must compare the same origins.

  renderdiff probe loads one URL --loads times (default 8, in parallel up to --concurrency),
  each in a fresh browser context as a run loads a side, and lists the elements whose computed
  style or position in their parent varies between loads: what to mask. Exits 0 if nothing
  varies, 1 if something does, 3 if a load errored.

  Writes report.html, results.json and crops of each change to --out. Exits 1 if any
  shot differs and isn't accepted (with --threshold, only if one scores below it;
  --threshold 0 never fails on a diff), 3 if a route errored (unmeasured) or the run
  crashed, 2 on bad arguments or config, an origin that is down, a sitemap it can't use,
  or an out dir it won't wipe.

  Options
    --left <url>        Left origin, instead of the first positional one.
    --right <url>       Right origin, instead of the second positional one.
    --width <n>         Viewport width; repeatable. Replaces the defaults.
    --threshold <0..1>  Fail only if a comparison scores below this, not on any diff.
    --out <dir>         Output directory                   (default: ./renderdiff-out)
    --concurrency <n>   Parallel workers              (default: half the cores, 2–8)
    --config <path>     Config file. Default: renderdiff.config.{ts,mts,js,mjs} in cwd.
    --selector <sel>    Compare one element (a Playwright selector) on both sides.
    --left-selector <sel>, --right-selector <sel>
                        That side's selector, over --selector.
    --mask <sel>        Paint this selector over on both sides, every route; repeatable.
    --mask-media        Mask every iframe on every route.
    --no-freeze-video   Leave videos playing and video.js overlays visible.
    --storage-state <file>
                        Start both sides with this storage state JSON. Never commit it.
    --left-storage-state <file>, --right-storage-state <file>
                        That side's storage state, over --storage-state.
    --accept <reason>   Accept this run's differences, scoped by its routes and widths.
    --rerun-failed      Rerun what the last run in --out didn't find clean or accepted,
                        keeping the rest. Same origins, routes and widths as that run.
    --cache-right       Replay the right side's network from the last --cache-right run
                        in --out, if under an hour old and covering every shot; else load
                        it live and record it. The page still renders and is shot fresh.
    --no-recheck        Don't reload a differing shot's right side to find content that
                        varies per load. Off anyway under --cache-right.
    --computed          Also diff every element's computed style and ::before/::after,
                        and say whether the markup is identical. Pixels still decide.
    --sitemap[=<url>]   Add the paths in the right side's sitemap (one index level, files
                        dropped). Default <right>/sitemap.xml; give a URL or path with =.
    --dry-run           Print the URL pairs and exit. No browser.
    --open              Open the report when the run finishes.
    --progress          A line per shot as it finishes. The default on a terminal;
                        otherwise one summary of the differing routes at the end.
    --no-progress       The end-of-run summary, even on a terminal.
    -h, --help          Show this.
    -v, --version       Print the version.

  Default widths: 1440, 1152, 896, 704, 375

  Per-route masks, hidden selectors, blocked URLs and route lists go in a config file; CLI flags
  win over it. See https://github.com/tmashara/renderdiff#readme
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
  console.error("  If that is a local dev server, start it first — and make sure it serves the");
  console.error("  same assets as the other origin (a bare preview server that 404s images will");
  console.error("  collapse every page and diff as garbage).\n");
  process.exit(2);
}

const FILE =
  /\.(pdf|xml|gz|zip|json|txt|csv|rss|atom|png|jpe?g|gif|svg|webp|avif|mp4|webm|mp3|docx?|xlsx?|pptx?)$/i;
const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** The `<loc>` paths of one sitemap, host dropped, and whether it is a sitemap index. */
async function locs(url: URL): Promise<{ index: boolean; paths: string[] }> {
  let res: Response, xml: string;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    xml = await res.text();
  } catch (e) {
    // Node's fetch says only "fetch failed"; the cause names ECONNREFUSED, ENOTFOUND, ...
    const why = e instanceof Error ? (e.cause instanceof Error ? e.cause : e).message : e;
    throw new Error(`sitemap: could not fetch ${url} (${why})`);
  }
  if (res.status >= 400) throw new Error(`sitemap: HTTP ${res.status} at ${url}`);
  if (!/<(urlset|sitemapindex)[\s>]/.test(xml)) throw new Error(`sitemap: ${url} is not a sitemap`);
  const paths = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?\s*<\/loc>/gs)].flatMap(
    (m) => {
      const loc = m[1]!.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ENTITY[e]!);
      if (!URL.canParse(loc, url)) return [];
      // A local build's sitemap names the production host, so keep only the path.
      const u = new URL(loc, url);
      return [u.pathname + u.search];
    },
  );
  return { index: /<sitemapindex[\s>]/.test(xml), paths };
}

/** Sitemap paths not already covered by `routes`, as routes; one level of index followed. */
async function sitemapRoutes(spec: string | true, routes: Route[]): Promise<Route[]> {
  const base = cfg.right + "/";
  const url = new URL(spec === true ? "sitemap.xml" : spec, base);
  const root = await locs(url);
  const all = root.index
    ? (await Promise.all(root.paths.map((p) => locs(new URL(p, base))))).flatMap((s) => s.paths)
    : root.paths;
  const unique = [...new Set(all.map(normalize))];
  const pages = unique.filter((p) => !FILE.test(new URL(p, base).pathname));
  const dropped = unique.length - pages.length;
  if (!pages.length) throw new Error(`sitemap ${url} gave no routes`);
  console.log(
    `Sitemap: ${url}: ${pages.length} routes` + (dropped ? `, ${dropped} files dropped` : ""),
  );
  const covered = new Set(routes.flatMap((r) => [r.left, r.right]));
  return parseRoutes(
    pages.filter((p) => !covered.has(p)),
    args.selector,
    fileConfig.before,
    fileConfig.beforeShot,
  );
}

/** `renderdiff report <out-dir>`: report.html and evidence.html from results.json, no browser. */
async function report(argv: string[]): Promise<never> {
  try {
    let dir: string | undefined;
    const opt: { "--verdict"?: string; "--title"?: string } = {};
    for (let i = 0; i < argv.length; i++) {
      const v = argv[i]!;
      if (v === "--verdict" || v === "--title") {
        const value = argv[++i];
        if (value === undefined) throw new Error(`${v} needs a value`);
        opt[v] = value;
      } else if (v.startsWith("-") || dir !== undefined)
        throw new Error(`unexpected argument: ${v}`);
      else dir = v;
    }
    if (!dir)
      throw new Error("usage: renderdiff report <out-dir> [--verdict <file>] [--title <text>]");
    const file = path.join(dir, "results.json");
    if (!fs.existsSync(file)) throw new Error(`no ${file}; run renderdiff with --out ${dir} first`);
    const verdict =
      opt["--verdict"] === undefined ? null : fs.readFileSync(opt["--verdict"], "utf8");
    const { writeEvidence, writeReport } = await import("./report.ts");
    const data: Results = JSON.parse(fs.readFileSync(file, "utf8"));
    console.log(await writeReport(data.results, data.meta, dir, data.summary.stale));
    const out = await writeEvidence(data, dir, verdict, opt["--title"]);
    console.log(`${out} (${Math.ceil(fs.statSync(out).size / 1024)} KB)`);
    process.exit(0);
  } catch (e) {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}

/** `renderdiff merge <full-out> <partial-out> --out <dir>`: no browser, so never exit 1 or 3. */
async function merge(argv: string[]): Promise<never> {
  try {
    const dirs: string[] = [];
    let out: string | undefined;
    for (let i = 0; i < argv.length; i++) {
      const v = argv[i]!;
      if (v === "--out") {
        out = argv[++i];
        if (out === undefined) throw new Error("--out needs a value");
      } else if (v.startsWith("-") || dirs.length === 2)
        throw new Error(`unexpected argument: ${v}`);
      else dirs.push(v);
    }
    if (dirs.length !== 2 || !out)
      throw new Error("usage: renderdiff merge <full-out> <partial-out> --out <dir>");
    const { merge } = await import("./run.ts");
    await merge(dirs[0]!, dirs[1]!, out);
    process.exit(0);
  } catch (e) {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}

/** Takes `--loads <n>` out of `argv`, for `renderdiff probe`. */
function takeLoads(argv: string[]): number {
  let loads = 8;
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    const eq = raw.indexOf("=");
    const v = eq === -1 ? raw : raw.slice(0, eq);
    if (v === "--loads") {
      const value = eq === -1 ? argv[i + 1] : raw.slice(eq + 1);
      if (value === undefined || value === "" || value.startsWith("-")) {
        throw new Error("--loads needs a value");
      }
      loads = num("--loads", value);
      if (!Number.isInteger(loads) || loads < 2) {
        throw new Error(`--loads expects an integer of at least 2, got ${loads}`);
      }
      argv.splice(i--, eq === -1 ? 2 : 1);
    }
  }
  return loads;
}

/** `renderdiff probe <url>`: load one URL several times and list what varies between loads. */
async function probe(a: Args, loads: number): Promise<never> {
  if (!a.left) die("probe needs a URL: renderdiff probe <url>");
  if (a.right || a.routes.length) die("probe takes one URL, with its path");
  if ((a.widths?.length ?? 0) > 1) die("probe takes one --width");
  if (a.selector) die("probe does not take --selector; it walks the whole page");
  if (!URL.canParse(a.left)) die(`not a URL: ${a.left}`);
  const u = new URL(a.left);
  let route: Route;
  try {
    cfg = resolveConfig(fileConfig, { ...a, left: u.origin, right: u.origin });
    [route] = parseRoutes(
      [u.pathname + u.search],
      undefined,
      fileConfig.before,
      fileConfig.beforeShot,
    ) as [Route];
  } catch (e) {
    die(e instanceof Error ? e.message : String(e));
  }
  if (configPath) console.log(`Config: ${configPath}`);
  await preflight(cfg.left, cfg.left);
  const { probe } = await import("./probe.ts");
  try {
    process.exit(await probe(cfg.left + route.left, route, cfg.widths[0]!, cfg, loads));
  } catch (e) {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(3);
  }
}

if (process.argv[2] === "report") await report(process.argv.slice(3));
if (process.argv[2] === "merge") await merge(process.argv.slice(3));

const probing = process.argv[2] === "probe";
let loads = 0;
let args: Args;
try {
  const argv = process.argv.slice(probing ? 3 : 2);
  if (probing) loads = takeLoads(argv);
  args = parseArgs(argv);
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

const { config: fileConfig, path: configPath } = await loadConfig(args.config).catch(
  (e: unknown) => {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  },
);

let cfg: ResolvedConfig;
if (probing) await probe(args, loads);
try {
  cfg = resolveConfig(fileConfig, args);
} catch (e) {
  die(e instanceof Error ? e.message : String(e));
}

const rawRoutes = args.routes.length ? args.routes : (fileConfig.routes ?? []);

if (!rawRoutes.length && !args.sitemap) {
  die("no routes given.");
}

let routes: Route[];
try {
  routes = parseRoutes(rawRoutes, args.selector, fileConfig.before, fileConfig.beforeShot);
} catch (e) {
  die(e instanceof Error ? e.message : String(e));
}

if (configPath) console.log(`Config: ${configPath}`);

if (args.sitemap) {
  try {
    routes = [...routes, ...(await sitemapRoutes(args.sitemap, routes))];
  } catch (e) {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}

console.log(`Routes: ${routes.length}`);

if (args.dryRun) {
  for (const r of routes) {
    console.log(
      `  ${label(r).padEnd(52)} ${cfg.left}${r.left}  |  ${cfg.right}${r.right}` +
        (r.selector ? `  [${selectorText(r.selector)}]` : ""),
    );
  }
  process.exit(0);
}

await preflight(cfg.left, cfg.right);

const { run } = await import("./run.ts");
try {
  process.exit(
    await run({
      routes,
      cfg,
      open: args.open,
      progress: args.progress ?? !!process.stdout.isTTY,
      accept: args.accept ?? null,
      rerun: args.rerunFailed,
      cacheRight: args.cacheRight,
      recheck: args.recheck,
      acceptedFile: path.join(configPath ? path.dirname(configPath) : process.cwd(), ACCEPTED_FILE),
    }),
  );
} catch (e) {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(3);
}
