import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium, errors, type Browser, type Page } from "playwright";
import { applyAccepted, readAccepted, updateAccepted } from "./accept.ts";
import { cancelUnstable, capture, HookError, prepare, type Shot } from "./capture.ts";
import { compare, crops, type Band } from "./compare.ts";
import { locate, type ElementDiff } from "./locate.ts";
import {
  CONTEXT_OPTIONS,
  label,
  masksFor,
  name,
  selectorText,
  version,
  type ResolvedConfig,
  type Route,
} from "./config.ts";
import { fmtBand, fmtElements, fmtRegion, pct, signed } from "./format.ts";
import {
  stats,
  writeReport,
  writeResults,
  type ComparedResult,
  type ErrorResult,
  type Results,
  type RouteResult,
} from "./report.ts";

/** A busy main thread can stall the probe; the elements are a hint, so give up rather than wait. */
const LOCATE_TIMEOUT = 5_000;

/** Past this share of a page unstable, too little was measured for a score to mean anything. */
const MAX_UNSTABLE_SHARE = 0.25;

interface Job {
  route: Route;
  width: number;
}

interface RunOpts {
  routes: Route[];
  cfg: ResolvedConfig;
  open: boolean;
  /** A line per shot as it lands; otherwise one compact summary at the end. */
  progress: boolean;
  /** Accept every difference not yet accepted, with this reason. */
  accept: string | null;
  /** Rerun only what the previous results.json in the out dir didn't find clean or accepted. */
  rerun: boolean;
  acceptedFile: string;
}

const slug = (url: string) =>
  url === "/"
    ? "index"
    : url
        .slice(1)
        .toLowerCase()
        .replace(/\//g, "-")
        .replace(/[^a-z0-9-]/g, "_");

const slugSelector = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, "_");

const stem = (r: Route) =>
  (
    (r.left === r.right ? slug(r.left) : `${slug(r.left)}~${slug(r.right)}`) +
    (r.selector
      ? `@${[...new Set([r.selector.left, r.selector.right])].map(slugSelector).join("~")}`
      : "")
  ).slice(0, 200);

/** Route name -> file stem, unique across the run. Suffixes follow route order, so reruns agree. */
function slugs(routes: Route[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const route of routes) {
    let s = stem(route);
    for (let n = 2; used.has(s); n++) s = `${stem(route)}-${n}`;
    used.add(s);
    out.set(name(route), s);
  }
  return out;
}

/** Only a directory holding nothing but files renderdiff writes is safe to wipe. */
const ours = (f: string) =>
  f === "report.html" ||
  f === "results.json" ||
  /^[a-z0-9_~@-]+\.[\d.]+\.(left|right|diff|c\d+)\.png$/.test(f);

function wipeable(dir: string): boolean {
  if (!fs.existsSync(dir)) return true;
  return fs.statSync(dir).isDirectory() && fs.readdirSync(dir).every(ours);
}

const reusable = (r: RouteResult) =>
  r.status === "compared" && ((r.diffPixels === 0 && r.unstablePixels === 0) || r.accepted);

const files = (r: RouteResult) =>
  r.status === "compared" ? [...Object.values(r.images), ...r.crops.map((c) => c.path)] : [];

/** Everything that decides how a shot is taken, hook and `locate` sources included. */
function configHash(cfg: ResolvedConfig, routes: Route[]): string {
  const { threshold, outDir, concurrency, storageState, ...rest } = cfg;
  const json = JSON.stringify(
    {
      ...rest,
      storageState: [storageState.left, storageState.right].map((f) => f && path.basename(f)),
      routes,
    },
    (_, v) => (typeof v === "function" ? String(v) : v),
  );
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}

/** The previous run's results when this run repeats it, else why it doesn't. */
function previous(file: string, now: Record<string, unknown>): Results | string {
  if (!fs.existsSync(file)) return `no ${file} to rerun from; run without --rerun-failed first`;
  let prev: Results;
  try {
    prev = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return `${file} is not valid JSON; run without --rerun-failed`;
  }
  const was: Record<string, unknown> = {
    ...prev.meta,
    routes: [...new Set(prev.results?.map(name))],
  };
  for (const [key, value] of Object.entries(now)) {
    if (key === "config" && value !== was[key]) {
      return (
        `the config (masks, hooks, hidden selectors, blocked URLs, CSS, storage state) ` +
        `differs from the one that wrote ${file}; run without --rerun-failed to start over`
      );
    }
    if (JSON.stringify(value) !== JSON.stringify(was[key])) {
      return (
        `${key} ${JSON.stringify(value)} differ from the previous run's ${JSON.stringify(was[key])} ` +
        `in ${file}; run without --rerun-failed to start over`
      );
    }
  }
  return prev;
}

export async function run({
  routes,
  cfg,
  open,
  progress,
  accept,
  rerun,
  acceptedFile,
}: RunOpts): Promise<number> {
  const names = routes.map(name);
  const setup = {
    left: cfg.left,
    right: cfg.right,
    widths: cfg.widths,
    blockUrlPatterns: cfg.blockUrlPatterns,
    hideSelectors: cfg.hideSelectors,
    masks: cfg.masks.map(({ urlPath, reason }) => ({ urlPath, reason })),
    storageState: {
      left: cfg.storageState.left && path.basename(cfg.storageState.left),
      right: cfg.storageState.right && path.basename(cfg.storageState.right),
    },
  };
  let accepted;
  try {
    accepted = readAccepted(acceptedFile);
  } catch (e) {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const config = configHash(cfg, routes);
  const prev = rerun
    ? previous(path.join(cfg.outDir, "results.json"), {
        version: version(),
        left: cfg.left,
        right: cfg.right,
        widths: cfg.widths,
        routes: names,
        config,
      })
    : null;
  if (typeof prev === "string") {
    console.error(`✗ --rerun-failed: ${prev}`);
    return 2;
  }
  if (!prev && !wipeable(cfg.outDir)) {
    console.error(
      `✗ output directory ${cfg.outDir} holds files renderdiff didn't write — ` +
        `refusing to wipe it. Pass --out with a new or empty directory.`,
    );
    return 2;
  }
  if (!prev) fs.rmSync(cfg.outDir, { recursive: true, force: true });
  fs.mkdirSync(cfg.outDir, { recursive: true });

  if (prev) applyAccepted(prev.results, accepted);
  const before = new Map(prev?.results.map((r) => [`${name(r)}@${r.width}`, r]));
  const results: RouteResult[] = [];
  const jobs: Job[] = [];
  for (const route of routes) {
    for (const width of cfg.widths) {
      const had = before.get(`${name(route)}@${width}`);
      if (had && reusable(had)) results.push(had);
      else jobs.push({ route, width });
    }
  }

  const stems = slugs(routes);
  const launched = jobs.length ? await launch() : null;
  const queue = [...jobs];
  let done = 0;
  // Whole minute, so an HH:MM display reads the same on both sides.
  const now = Math.floor(Date.now() / 60_000) * 60_000;

  const worker = async (browser: Browser) => {
    // One context per origin so cookies/localStorage never cross between them.
    const leftCtx = await browser.newContext({
      ...CONTEXT_OPTIONS,
      storageState: cfg.storageState.left ?? undefined,
    });
    const rightCtx = await browser.newContext({
      ...CONTEXT_OPTIONS,
      storageState: cfg.storageState.right ?? undefined,
    });
    const leftPage = await leftCtx.newPage();
    const rightPage = await rightCtx.newPage();
    await prepare(leftPage, cfg, now);
    await prepare(rightPage, cfg, now);

    for (let job = queue.shift(); job; job = queue.shift()) {
      const { route, width } = job;
      const key = name(route);
      const { before, ...where } = route;
      const entry = { url: label(route), ...where, hook: before !== null, width };
      const tag = `${label(route)} @${width}`;
      // Its own line: parse.ts reads the route on the row as one \S+ token.
      const sel = route.selector ? `selector ${selectorText(route.selector)}` : "";
      try {
        // allSettled, not all: a page must not start the next job while still loading this one.
        const settled = await Promise.allSettled([
          shoot(leftPage, cfg.left + route.left, route, "left", width, cfg, now),
          shoot(rightPage, cfg.right + route.right, route, "right", width, cfg, now),
        ]);
        const failed = settled.find((r) => r.status === "rejected");
        if (failed) throw failed.reason;
        const [leftShot, rightShot] = settled.map(
          (r) => (r as PromiseFulfilledResult<Shot>).value,
        ) as [Shot, Shot];
        // A blank page matches any other blank page, so refuse rather than score two of
        // them. One blank side is left to the diff, which shows it plainly.
        if (leftShot.blank && rightShot.blank) {
          throw new Error(
            `page did not render on either side ` +
              `(left: ${leftShot.blank}; right: ${rightShot.blank}) at ${key}`,
          );
        }
        const unstablePixels = await cancelUnstable(leftShot, rightShot);

        const { diffPng, spots, ...metrics } = await compare(leftShot, rightShot);
        if (unstablePixels > MAX_UNSTABLE_SHARE * metrics.totalPixels) {
          throw new Error(`page did not settle: ${unstablePixels}px unstable at ${key}`);
        }
        const measured = metrics.totalPixels - unstablePixels;
        metrics.score = measured > 0 ? 1 - metrics.diffPixels / measured : 0;
        const base = `${stems.get(key)}.${width}`;
        const images = {
          left: `${base}.left.png`,
          right: `${base}.right.png`,
          diff: `${base}.diff.png`,
        };
        const write = (name: string, buf: Buffer) =>
          fs.promises.writeFile(path.join(cfg.outDir, name), buf);
        // Both pages still hold this job's document: the next load waits for the loop.
        const [made, named] = await Promise.all([
          crops(leftShot.png, rightShot.png, spots),
          Promise.race([
            locate([leftPage, rightPage], [leftShot, rightShot], spots, [
              masksFor(cfg, leftPage, route),
              masksFor(cfg, rightPage, route),
            ]).catch(() => null),
            sleep(LOCATE_TIMEOUT, null, { ref: false }),
          ]),
        ]);
        named?.forEach((els, i) => (spots[i]!.target.elements = els));
        const cropped = made.map(({ png, ...c }, i) => ({ path: `${base}.c${i + 1}.png`, ...c }));
        await Promise.all([
          write(images.left, leftShot.png),
          write(images.right, rightShot.png),
          write(images.diff, diffPng),
          ...made.map((c, i) => write(cropped[i]!.path, c.png)),
        ]);

        results.push({
          ...entry,
          status: "compared",
          ...metrics,
          unstablePixels,
          images,
          crops: cropped,
          accepted: false,
        });
        const { regions, bands, alignedScore, text } = metrics;
        const dom = elementsOf(metrics);
        const details = [
          sel,
          regions.length
            ? `${regions.length} region${regions.length > 1 ? "s" : ""}, largest ${fmtRegion(regions[0]!)}`
            : "",
          ...(bands ?? []).map((b) => `band ${fmtBand(b)}`),
          alignedScore !== null ? `aligned ${pct(alignedScore)}` : "",
          bands === null ? "rows too different to align" : "",
          text.added.length || text.removed.length
            ? `text: ${text.added.length} added, ${text.removed.length} removed`
            : "",
          dom.length ? `dom ${fmtElements(dom)}` : "",
        ].filter(Boolean);
        ++done;
        if (!progress) continue;
        console.log(
          `  [${done}/${jobs.length}] ${pct(metrics.score)}  ${tag}` +
            (metrics.heightDelta ? `  (height ${signed(metrics.heightDelta)}px)` : "") +
            (unstablePixels ? `  (unstable ${unstablePixels.toLocaleString("en-US")}px)` : "") +
            details.map((d) => `\n        ${d}`).join(""),
        );
      } catch (e) {
        results.push({
          ...entry,
          status: "error",
          error: e instanceof Error ? e.message : String(e),
        });
        ++done;
        if (progress) {
          console.log(`  [${done}/${jobs.length}] ERROR  ${tag}` + (sel && `\n        ${sel}`));
        }
      }
    }
    await leftCtx.close();
    await rightCtx.close();
  };

  if (progress) {
    console.log(`Capturing ${jobs.length} pair(s) with ${cfg.concurrency} worker(s)...\n`);
  }
  if (launched) {
    await Promise.all(Array.from({ length: cfg.concurrency }, () => worker(launched.browser)));
    await launched.browser.close();
  }
  const browserMeta = launched
    ? { name: launched.channel ?? "chromium", version: launched.browser.version() }
    : prev!.meta.browser;

  // A rerun overwrites a shot's files in place; drop the ones it no longer writes, ours only.
  const kept = new Set(results.flatMap(files));
  for (const { route, width } of jobs) {
    const had = before.get(`${name(route)}@${width}`);
    for (const f of had ? files(had) : []) {
      if (!kept.has(f) && ours(f)) fs.rmSync(path.join(cfg.outDir, f), { force: true });
    }
  }

  // Workers finish out of order; job order keeps results.json stable across runs.
  const order = (r: RouteResult) =>
    names.indexOf(name(r)) * cfg.widths.length + cfg.widths.indexOf(r.width);
  results.sort((a, b) => order(a) - order(b));

  let { unmatched, stale } = applyAccepted(results, accepted);
  if (accept !== null) {
    const added = unmatched.map(({ route, width, fingerprint }) => ({
      route,
      width,
      reason: accept,
      fingerprint,
    }));
    const pruned = stale.length;
    if (updateAccepted(acceptedFile, stale, added)) {
      ({ stale } = applyAccepted(results, readAccepted(acceptedFile)));
    }
    console.log(`accepted ${added.length} difference(s), pruned ${pruned} stale — ${acceptedFile}`);
  }

  const { left, right, widths, ...rest } = setup;
  const meta = {
    tool: "renderdiff" as const,
    version: version(),
    generatedAt: new Date().toISOString(),
    left,
    right,
    widths,
    threshold: cfg.threshold,
    clock: new Date(now).toISOString(),
    ...rest,
    browser: browserMeta,
    config,
  };
  const reportPath = await writeReport(results, meta, cfg, stale);
  const resultsPath = writeResults(results, meta, cfg.outDir, stale);

  if (prev) {
    const rerunRoutes = new Set(jobs.map((j) => name(j.route))).size;
    console.log(
      `rerun: ${jobs.length} shot(s) on ${rerunRoutes} route(s), ` +
        `${results.length - jobs.length} reused, ${names.length - rerunRoutes} route(s) untouched`,
    );
  }
  if (stale.length) {
    console.log(
      `stale accepted: ${stale.map((a) => `${a.route}@${a.width}`).join(" ")} — ${acceptedFile}`,
    );
  }
  if (progress) summarize(results, reportPath, resultsPath);
  else console.log(compact(results, names, resultsPath, cfg.threshold));

  if (open) {
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    spawn(opener, [reportPath], { detached: true, stdio: "ignore" }).unref();
  }

  // A measured failure outranks an unmeasured route, so an error can't hide a threshold failure.
  const below = results.filter(
    (r) =>
      r.status === "compared" && !r.accepted && cfg.threshold !== null && r.score < cfg.threshold,
  );
  if (below.length) {
    console.error(`\n✗ ${below.length} route(s) below ${pct(cfg.threshold!)}.`);
  }
  return below.length ? 1 : results.some((r) => r.status === "error") ? 3 : 0;
}

/**
 * A missing browser binary is the likeliest first-run failure, so fall back to the system
 * Chrome (both sides share it, so the comparison stays symmetric), then name the fix.
 */
async function launch() {
  try {
    return { browser: await chromium.launch(), channel: null };
  } catch (e) {
    try {
      const browser = await chromium.launch({ channel: "chrome" });
      console.log(
        `Bundled Chromium failed to launch; using the system Chrome ${browser.version()}.`,
      );
      return { browser, channel: "chrome" };
    } catch {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `could not launch Chromium, or the system Chrome:\n  ${msg}\n\n` +
          `  Install the browser with:  npx playwright install chromium`,
      );
    }
  }
}

const transient = (e: unknown) =>
  !(e instanceof HookError) &&
  (e instanceof errors.TimeoutError ||
    (e instanceof Error && /net::ERR_|Execution context was destroyed/.test(e.message)));

/** One retry for a transient failure: a live site can time out once on a cold edge. */
async function shoot(
  page: Page,
  url: string,
  route: Route,
  side: "left" | "right",
  width: number,
  cfg: ResolvedConfig,
  now: number,
): Promise<Shot> {
  try {
    return await capture(page, url, route, side, width, cfg, now);
  } catch (e) {
    if (!transient(e)) throw e;
    await page.waitForTimeout(1000);
    return await capture(page, url, route, side, width, cfg, now);
  }
}

function summarize(results: RouteResult[], reportPath: string, resultsPath: string) {
  const compared = results.filter((r): r is ComparedResult => r.status === "compared");

  const open = compared.filter((r) => !r.accepted);
  if (open.length) {
    const { sorted, mean, worst } = stats(open);
    console.log(`\nmean ${pct(mean)}   worst ${pct(worst.score)} (${name(worst)} @${worst.width})`);
    for (const r of sorted.slice(0, 10)) {
      console.log(
        `    ${pct(r.score).padStart(7)}  ${name(r)}@${r.width}` +
          (r.heightDelta ? `  height ${signed(r.heightDelta)}px` : ""),
      );
    }
  }

  const accepted = compared.filter((r) => r.accepted);
  if (accepted.length) {
    console.log(
      `\nAccepted (${accepted.length}): ${accepted.map((r) => `${name(r)}@${r.width}`).join(" ")}`,
    );
  }

  const errors = results.filter((r): r is ErrorResult => r.status === "error");
  if (errors.length) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) console.log(`  ${name(e)}@${e.width}: ${e.error}`);
  }

  console.log(`\nReport: ${reportPath}`);
  console.log(`Results: ${resultsPath}`);
}

/** At most this many elements per summary line. */
const DOM_ELEMENTS = 3;

/** Located elements in crop order, bands tallest first then regions, one per selector; none accepted. */
function elementsOf(r: {
  regions: { elements?: ElementDiff[]; accepted?: string }[];
  bands: Band[] | null;
}): ElementDiff[] {
  const all = [...[...(r.bands ?? [])].sort((a, b) => b.h - a.h), ...r.regions].flatMap((g) =>
    g.accepted ? [] : (g.elements ?? []),
  );
  return all
    .filter((e, i) => all.findIndex((o) => o.selector === e.selector) === i)
    .slice(0, DOM_ELEMENTS);
}

/** At most this many text-diff lines per compact row. */
const TEXT_LINES = 3;

/**
 * The non-TTY summary, sized for an agent's context: clean routes on one line, then each
 * differing route with its widths collapsed where everything but the score agrees, and a
 * one-line verdict that names results.json.
 */
export function compact(
  results: RouteResult[],
  routes: string[],
  resultsPath: string,
  threshold: number | null,
): string {
  const out: string[] = [];
  const clean: string[] = [];
  const accepted: string[] = [];
  let differ = 0;
  for (const route of routes) {
    const rows = results.filter((r) => name(r) === route);
    const ok = rows.filter((r): r is ComparedResult => r.status === "compared");
    // Unstable pixels went unmeasured, so a shot with any is not clean, only unchanged.
    const same = ok.filter((r) => r.diffPixels === 0 && r.unstablePixels === 0);
    const acc = ok.filter((r) => r.accepted);
    const changed = ok.filter((r) => !same.includes(r) && !r.accepted);
    if (same.length === rows.length) {
      clean.push(route);
      continue;
    }
    if (same.length + acc.length === rows.length) {
      accepted.push(route);
      continue;
    }
    if (changed.some((r) => r.diffPixels > 0)) differ++;
    out.push(
      route +
        (same.length ? `  clean @${same.map((r) => r.width).join(",")}` : "") +
        (acc.length ? `  accepted @${acc.map((r) => r.width).join(",")}` : ""),
    );
    const groups = new Map<string, ComparedResult[]>();
    for (const r of changed) {
      const key = JSON.stringify([
        r.heightDelta,
        r.widthDelta,
        r.bands?.map((b) => [b.side, b.h]) ?? null,
        r.alignedScore === null ? null : pct(r.alignedScore),
        r.text,
      ]);
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    for (const g of groups.values()) {
      out.push(`  @${g.map((r) => r.width).join(",")}  ${row(g)}`);
      const dom = elementsOf(g[0]!);
      if (dom.length)
        out.push(`    dom ${g.length > 1 ? `@${g[0]!.width} ` : ""}${fmtElements(dom)}`);
      const paths = g.flatMap((r) => r.crops.map((c) => c.path));
      if (paths.length) out.push(`    crops ${paths.join(" ")}`);
    }
    const failed = new Map<string, number[]>();
    for (const r of rows)
      if (r.status === "error") failed.set(r.error, [...(failed.get(r.error) ?? []), r.width]);
    for (const [error, widths] of failed) out.push(`  @${widths.join(",")}  ERROR ${error}`);
  }
  if (accepted.length) out.unshift(`accepted: ${accepted.join(" ")}`);
  if (clean.length) out.unshift(`clean: ${clean.join(" ")}`);
  const all = results.filter((r): r is ComparedResult => r.status === "compared");
  const compared = all.filter((r) => !r.accepted);
  const shots = compared.filter((r) => r.diffPixels > 0).length;
  const errors = results.length - all.length;
  const worst = compared.length ? stats(compared).worst : null;
  out.push(
    `renderdiff: ${differ} of ${routes.length} routes differ (${shots} of ${results.length} shots), ` +
      `${errors} error${errors === 1 ? "" : "s"}` +
      (worst ? `, worst ${pct(worst.score)} ${name(worst)}@${worst.width}` : "") +
      (threshold === null
        ? ""
        : `, ${compared.filter((r) => r.score < threshold).length} below ${pct(threshold)}`) +
      ` — ${resultsPath}`,
  );
  return out.join("\n");
}

/** One compact row for comparisons that agree on everything but score, regions and unstable px. */
function row(g: ComparedResult[]): string {
  const [r] = g as [ComparedResult];
  const span = (ns: number[], f: (n: number) => string) => {
    const [lo, hi] = [Math.min(...ns), Math.max(...ns)];
    return lo === hi ? f(lo) : `${f(lo)}–${f(hi)}`;
  };
  const regions = g.map((x) => x.regions.length);
  const accepted = g.map(
    (x) => [...(x.bands ?? []), ...x.regions].filter((c) => c.accepted).length,
  );
  const unstable = Math.max(...g.map((x) => x.unstablePixels));
  // Band y varies with width; a collapsed row shows the first one's, marked approximate.
  const y = (b: Band) => `@y${g.length > 1 ? "~" : ""}${b.y}`;
  const text = [...r.text.added.map((t) => `+"${t}"`), ...r.text.removed.map((t) => `-"${t}"`)];
  return [
    span(
      g.map((x) => x.score),
      pct,
    ),
    r.heightDelta ? `h${signed(r.heightDelta)}` : "",
    r.widthDelta ? `w${signed(r.widthDelta)}` : "",
    r.bands === null ? "unaligned" : "",
    ...(r.bands ?? []).map((b) => `band ${b.side === "left" ? "+" : "-"}${b.h}${y(b)}`),
    r.alignedScore !== null ? `aligned ${pct(r.alignedScore)}` : "",
    Math.max(...regions) ? `${span(regions, String)} reg` : "",
    unstable ? `unstable ${unstable.toLocaleString("en-US")}px` : "",
    Math.max(...accepted) ? `${span(accepted, String)} accepted` : "",
    text.length
      ? `text ${text.slice(0, TEXT_LINES).join(" ")}` +
        (text.length > TEXT_LINES ? ` (+${text.length - TEXT_LINES} more)` : "")
      : "",
  ]
    .filter(Boolean)
    .join("  ");
}
