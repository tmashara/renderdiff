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
  alive,
  ENGINES,
  isHttpUrl,
  label,
  loadConfig,
  name,
  normalize,
  parseRoutes,
  resolveConfig,
  selectorText,
  version,
  type CliOverrides,
  type Engine,
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
  /** --only values: config routes to keep, or files listing them. */
  only?: string[];
  /** From --selector / --left-selector / --right-selector; replaces a config route object's own. */
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

function* flags(argv: string[]) {
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const v = eq === -1 ? raw : raw.slice(0, eq);
    const inline = eq === -1 ? undefined : raw.slice(eq + 1);
    let took = false;
    // A numeric flag takes a negative number, so the range check can name the problem.
    const value = (numeric = false) => {
      const s = inline ?? argv[i + 1];
      const isFlag =
        inline === undefined && s?.startsWith("-") && !(numeric && Number.isFinite(Number(s)));
      if (s === undefined || !s.trim() || isFlag) throw new Error(`${v} needs a value`);
      if (inline === undefined) i++;
      took = true;
      return s.trim();
    };
    yield { v, inline, value };
    if (inline !== undefined && !took) throw new Error(`${v} takes no value`);
  }
}

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
  for (const { v, inline, value } of flags(argv)) {
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
    else if (v === "--aria") a.aria = true;
    else if (v === "--mask-media") a.maskMedia = true;
    else if (v === "--no-freeze-video") a.freezeVideo = false;
    else if (v === "--sitemap") {
      if (inline === "") throw new Error("--sitemap= needs a URL or path");
      a.sitemap = inline === undefined ? true : value();
    } else if (v === "--accept") a.accept = value();
    else if (v === "--left") a.left = value();
    else if (v === "--right") a.right = value();
    else if (v === "--out") a.outDir = value();
    else if (v === "--config") a.config = value();
    else if (v === "--browser") {
      const b = value();
      if (!ENGINES.includes(b as Engine))
        throw new Error(`--browser expects ${ENGINES.join(" or ")}, got ${b}`);
      a.browser = b as Engine;
    } else if (v === "--mask") (a.masks ??= []).push(value());
    else if (v === "--only") (a.only ??= []).push(value());
    else if (v === "--hide") (a.hideSelectors ??= []).push(value());
    else if (v === "--selector" || v === "--left-selector" || v === "--right-selector") {
      sel[v === "--selector" ? "both" : v === "--left-selector" ? "left" : "right"] = value();
    } else if (
      v === "--storage-state" ||
      v === "--left-storage-state" ||
      v === "--right-storage-state"
    ) {
      state[v === "--storage-state" ? "both" : v === "--left-storage-state" ? "left" : "right"] =
        value();
    } else if (v === "--width") {
      const w = num("--width", value(true));
      if (!Number.isInteger(w) || w < 1) {
        throw new Error(`--width expects a positive integer, got ${w}`);
      }
      (a.widths ??= []).push(w);
    } else if (v === "--concurrency") {
      const n = num("--concurrency", value(true));
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`--concurrency expects a positive integer, got ${n}`);
      }
      a.concurrency = n;
    } else if (v === "--threshold") {
      const t = num("--threshold", value(true));
      if (t < 0 || t > 1) throw new Error(`--threshold expects 0..1, got ${t}`);
      a.threshold = t;
    } else if (v.startsWith("-")) throw new Error(`unknown flag: ${v}`);
    else if (/^https?:\/\//i.test(v)) origins.push(v);
    else a.routes.push(v);
  }
  const xml = a.sitemap === true && [...origins, ...a.routes].find((t) => /\.xml$/i.test(t));
  if (xml) {
    throw new Error(
      `use --sitemap=${xml} to read that sitemap; bare --sitemap reads the right side's`,
    );
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
  if (a.only && (a.routes.length || a.sitemap)) {
    const drop = a.routes.length ? "the routes given on the command line" : "--sitemap";
    throw new Error(`--only picks from the config's routes; drop ${drop}`);
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
    renderdiff report <out-dir> [--verdict <file>] [--title <text>] [--markdown <file> [--base-url <url>]]
    renderdiff merge <full-out> <partial-out> --out <dir>
    renderdiff pack <out-dir> --out <dir>
    renderdiff probe <url> [--width <n>] [--loads <n>]

  An argument starting with http:// or https:// is an origin: the first is left (your
  change), the second right (the reference); or pass --left / --right. A route is a
  literal path, loaded on both sides; /a::/b loads /a on the left and /b on the right.
  '/a @sel' compares one element on that route ('/a @sel::/b @sel2' per side).
  No globs, no discovery.

  With --selector, each side compares the one element it matches instead of the page;
  it must match exactly one. It applies to every route without its own @sel, over the
  config's own selectors.

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
  the --verdict file's text. --markdown <file> also writes a before/after table per route
  (right before, left after, links to the shots) for a PR description; for an intended change,
  run with --threshold 0 --no-recheck first. --base-url <url> is a URL the shot names are
  appended to in those links, for an out dir uploaded there.

  renderdiff merge writes <full-out>'s results to --out with each shot <partial-out> also
  has replaced by the partial run's, and its other shots added. Both must compare the same origins.

  renderdiff pack copies <out-dir> to --out for publishing: report.html, evidence.html,
  results.json and only the images it names, as lossless WebP (a shot past 16,383px stays PNG),
  one image for a shot whose sides are byte-identical and no diff for a zero-diff shot.
  Never .cache/. merge and --rerun-failed refuse a packed dir.

  renderdiff probe loads one URL --loads times (default 8, in parallel up to --concurrency),
  each in a fresh browser context as a run loads a side (with the storage state of the config
  side the URL is on), and lists the elements whose computed style or position in their parent
  varies between loads: what to mask. Exits 0 if nothing varies, 1 if something does, 3 if a
  load errored.

  Writes report.html, results.json and crops of each change to --out. Exits 1 if any
  shot differs and isn't accepted (with --threshold, only if one scores below it;
  --threshold 0 never fails on a diff), 3 if a route errored (unmeasured) or the run
  crashed, 2 on bad arguments or config, an origin that is down (at the start or mid-run),
  a sitemap it can't use, or an out dir it won't wipe.

  Options
    --left <url>        Left origin, instead of the first positional one.
    --right <url>       Right origin, instead of the second positional one.
    --width <n>         Viewport width; repeatable. Replaces the defaults.
    --threshold <0..1>  Fail only if a comparison scores below this, not on any diff.
    --out <dir>         Output directory                   (default: ./renderdiff-out)
    --concurrency <n>   Parallel workers              (default: half the cores, 2–8)
    --config <path>     Config file. Default: renderdiff.config.{ts,mts,js,mjs} in cwd.
    --browser <name>    chromium or webkit; both sides are shot in it (default: chromium).
                        webkit writes to ./renderdiff-out-webkit by default and accepts
                        into renderdiff.accepted.webkit.json.
    --selector <sel>    Compare one element (a Playwright selector) on both sides.
    --left-selector <sel>, --right-selector <sel>
                        That side's selector, over --selector.
    --mask <sel>        Paint this selector over on both sides, every route; repeatable.
    --hide <sel>        Hide this CSS selector on both sides, every route; repeatable.
    --mask-media        Mask every iframe on every route.
    --no-freeze-video   Leave videos playing and video.js overlays visible.
    --storage-state <file>
                        Start both sides with this storage state JSON. Never commit it.
    --left-storage-state <file>, --right-storage-state <file>
                        That side's storage state, over --storage-state.
    --accept <reason>   Accept this run's differences, scoped by its routes and widths.
    --rerun-failed      Rerun what the last run in --out didn't find clean or accepted,
                        keeping the rest (and matching shots with at most 100 unstable
                        px). Same origins, routes and widths as that run.
    --only <route|file> Run only the config's routes with this path (or pair), their
                        hooks and selectors kept; '/a @sel' narrows to that selector.
                        Repeatable. A value naming a file in cwd lists one per line,
                        # lines skipped.
    --cache-right       Replay the right side's network from the last --cache-right run
                        in --out, if under an hour old and covering every shot; else load
                        it live and record it. The page still renders and is shot fresh.
    --no-recheck        Don't reload a differing shot's right side to find content that
                        varies per load. Off anyway under --cache-right.
    --computed          Also diff every element's computed style and ::before/::after,
                        and links' and controls' :hover/:focus-visible (Chromium only),
                        and say whether the markup is identical. Pixels still decide.
    --aria              Also diff each page's accessibility tree (Playwright's ARIA
                        snapshot) line by line. Pixels still decide.
    --sitemap[=<url>]   Add the paths in the right side's sitemap (one index level, files
                        dropped). Default <right>/sitemap.xml; give a URL or path with =.
    --dry-run           Print the URL pairs and exit. No browser.
    --open              Open the report when the run finishes.
    --progress          A line per shot as it finishes. The default on a terminal;
                        otherwise one summary of the differing routes at the end,
                        and an n/N shots line on stderr every tenth of the run.
    --no-progress       The end-of-run summary, even on a terminal.
    -h, --help          Show this.
    -v, --version       Print the version.

  Default widths: 1440, 1152, 896, 704, 375

  Per-route masks, blocked URLs and route lists go in a config file; CLI flags win over it
  or add to it. See https://github.com/tmashara/renderdiff#readme
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
    const opt: {
      "--verdict"?: string;
      "--title"?: string;
      "--markdown"?: string;
      "--base-url"?: string;
    } = {};
    for (const { v, value } of flags(argv)) {
      if (v === "--verdict" || v === "--title" || v === "--markdown" || v === "--base-url") {
        opt[v] = value();
      } else if (v.startsWith("-") || dir !== undefined)
        throw new Error(`unexpected argument: ${v}`);
      else dir = v;
    }
    if (!dir)
      throw new Error(
        "usage: renderdiff report <out-dir> [--verdict <file>] [--title <text>] [--markdown <file> [--base-url <url>]]",
      );
    if (opt["--base-url"] !== undefined && !opt["--markdown"])
      throw new Error("--base-url needs --markdown");
    const file = path.join(dir, "results.json");
    if (!fs.existsSync(file)) throw new Error(`no ${file}; run renderdiff with --out ${dir} first`);
    const verdict =
      opt["--verdict"] === undefined ? null : fs.readFileSync(opt["--verdict"], "utf8");
    const { writeEvidence, writeMarkdown, writeReport } = await import("./report.ts");
    const data: Results = JSON.parse(fs.readFileSync(file, "utf8"));
    console.log(await writeReport(data.results, data.meta, dir, data.summary.stale));
    const out = await writeEvidence(data, dir, verdict, opt["--title"]);
    console.log(`${out} (${Math.ceil(fs.statSync(out).size / 1024)} KB)`);
    if (opt["--markdown"])
      console.log(writeMarkdown(data, dir, opt["--markdown"], opt["--base-url"]));
    process.exit(0);
  } catch (e) {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}

/** `renderdiff merge` and `renderdiff pack`: out dirs in, a new --out; no browser, so never exit 1 or 3. */
async function outCommand(command: "merge" | "pack", argv: string[]): Promise<never> {
  try {
    const n = command === "merge" ? 2 : 1;
    const dirs: string[] = [];
    let out: string | undefined;
    for (const { v, value } of flags(argv)) {
      if (v === "--out") out = value();
      else if (v.startsWith("-") || dirs.length === n) throw new Error(`unexpected argument: ${v}`);
      else dirs.push(v);
    }
    if (dirs.length !== n || !out)
      throw new Error(
        `usage: renderdiff ${command} ${n === 2 ? "<full-out> <partial-out>" : "<out-dir>"} --out <dir>`,
      );
    const run = await import("./run.ts");
    await (n === 2 ? run.merge(dirs[0]!, dirs[1]!, out) : run.pack(dirs[0]!, out));
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

/** The config routes the `--only` values pick; a value naming a file is a route list. */
function only(values: string[], routes: Route[]): Route[] {
  const names = routes.map(name);
  const has = names.length
    ? `the config has: ${names.slice(0, 20).join(", ")}` +
      (names.length > 20 ? ` … and ${names.length - 20} more` : "")
    : "the config has no routes";
  const picked = new Set<Route>();
  for (const v of values) {
    const file = fs.statSync(v, { throwIfNoEntry: false })?.isFile();
    const specs = file
      ? fs
          .readFileSync(v, "utf8")
          .split(/\r?\n/)
          .map((l) => l.trim())
          .map((l, i) => [l, `--only ${v}: "${l}" (line ${i + 1})`] as const)
          .filter(([l]) => l && !l.startsWith("#"))
      : [[v, `--only ${v}`] as const];
    if (file && !specs.length) throw new Error(`--only ${v} lists no routes`);
    for (const [spec, shown] of specs) {
      const [w] = parseRoutes([spec]) as [Route];
      const hits = routes.filter(
        (r) => label(r) === label(w) && (!w.selector || name(r) === name(w)),
      );
      if (!hits.length) {
        const typo = !file && (!v.includes("/") || /\.\w+$/.test(v)) ? " (and no such file)" : "";
        throw new Error(`${shown} matches no config route${typo}; ${has}`);
      }
      for (const r of hits) picked.add(r);
    }
  }
  return routes.filter((r) => picked.has(r));
}

const PROBE_FLAGS = [
  "--help",
  "--version",
  "--left",
  "--config",
  "--width",
  "--concurrency",
  "--mask",
  "--hide",
  "--mask-media",
  "--no-freeze-video",
  "--storage-state",
  "--browser",
];

/** `renderdiff probe <url>`: load one URL several times and list what varies between loads. */
async function probe(a: Args, loads: number): Promise<never> {
  if (!a.left) die("probe needs a URL: renderdiff probe <url>");
  if (a.right || a.routes.length) die("probe takes one URL, with its path");
  if ((a.widths?.length ?? 0) > 1) die("probe takes one --width");
  if (!isHttpUrl(a.left)) die(`not an http(s) URL: ${a.left}`);
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
  const at = (o?: string) => !!o && isHttpUrl(o) && new URL(o).origin === u.origin;
  const side = at(fileConfig.right)
    ? "right"
    : at(fileConfig.left)
      ? "left"
      : cfg.storageState.right
        ? "right"
        : "left";
  const s = cfg.storageState[side];
  cfg.storageState = { left: s, right: s };
  if (configPath) console.log(`Config: ${configPath}`);
  if (s) console.log(`Storage state: ${s} (${side})`);
  if (!a.widths) {
    const more = cfg.widths.length > 1;
    console.log(
      `Width: ${cfg.widths[0]}${more ? ` (first of ${cfg.widths.join(", ")}; --width <n> for another)` : ""}`,
    );
  }
  await preflight(cfg.left, cfg.left);
  const { probe } = await import("./probe.ts");
  try {
    process.exit(await probe(cfg.left + route.left, route, cfg.widths[0]!, cfg, loads));
  } catch (e) {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(3);
  }
}

if (
  ["report", "merge", "pack"].includes(process.argv[2]!) &&
  process.argv.slice(3).some((t) => t === "--help" || t === "-h")
) {
  console.log(HELP.trimEnd());
  process.exit(0);
}
if (process.argv[2] === "report") await report(process.argv.slice(3));
if (process.argv[2] === "merge" || process.argv[2] === "pack")
  await outCommand(process.argv[2], process.argv.slice(3));

const probing = process.argv[2] === "probe";
let loads = 0;
let args: Args;
try {
  const argv = process.argv.slice(probing ? 3 : 2);
  if (probing) loads = takeLoads(argv);
  args = parseArgs(argv);
  const extra =
    probing &&
    argv.map((t) => t.split("=")[0]!).find((f) => f.startsWith("--") && !PROBE_FLAGS.includes(f));
  if (extra) throw new Error(`probe does not take ${extra}`);
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

if (args.only && !configPath) die("--only filters a config file's routes; none was found");

if (!rawRoutes.length && !args.sitemap && !args.only) {
  die("no routes given.");
}

let routes: Route[];
try {
  routes = parseRoutes(rawRoutes, args.selector, fileConfig.before, fileConfig.beforeShot);
  if (args.only) routes = only(args.only, routes);
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
      acceptedFile: path.join(
        configPath ? path.dirname(configPath) : process.cwd(),
        // An engine's pixels never match the other's, so neither may prune the other's entries.
        cfg.browser ? ACCEPTED_FILE.replace(/\.json$/, `.${cfg.browser}.json`) : ACCEPTED_FILE,
      ),
    }),
  );
} catch (e) {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(3);
}
