import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium, errors, type Page } from "playwright";
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
    (r.selector ? `@${[...new Set([r.selector.left, r.selector.right])].map(slugSelector).join("~")}` : "")
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

export async function run({ routes, cfg, open, progress }: RunOpts): Promise<number> {
  if (!wipeable(cfg.outDir)) {
    console.error(
      `✗ output directory ${cfg.outDir} holds files renderdiff didn't write — ` +
        `refusing to wipe it. Pass --out with a new or empty directory.`,
    );
    return 2;
  }
  fs.rmSync(cfg.outDir, { recursive: true, force: true });
  fs.mkdirSync(cfg.outDir, { recursive: true });

  const jobs: Job[] = [];
  for (const route of routes)
    for (const width of cfg.widths) jobs.push({ route, width });

  const stems = slugs(routes);
  const results: RouteResult[] = [];
  const { browser, channel } = await launch();
  const queue = [...jobs];
  let done = 0;
  // Whole minute, so an HH:MM display reads the same on both sides.
  const now = Math.floor(Date.now() / 60_000) * 60_000;

  const worker = async () => {
    // One context per origin so cookies/localStorage never cross between them.
    const leftCtx = await browser.newContext({ ...CONTEXT_OPTIONS, storageState: cfg.storageState.left ?? undefined });
    const rightCtx = await browser.newContext({ ...CONTEXT_OPTIONS, storageState: cfg.storageState.right ?? undefined });
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
          throw new Error(
            `page did not settle: ${unstablePixels}px unstable at ${key}`,
          );
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
            (metrics.heightDelta
              ? `  (height ${signed(metrics.heightDelta)}px)`
              : "") +
            (unstablePixels
              ? `  (unstable ${unstablePixels.toLocaleString("en-US")}px)`
              : "") +
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
    console.log(
      `Capturing ${jobs.length} pair(s) with ${cfg.concurrency} worker(s)...\n`,
    );
  }
  await Promise.all(Array.from({ length: cfg.concurrency }, worker));
  const browserMeta = { name: channel ?? "chromium", version: browser.version() };
  await browser.close();

  // Workers finish out of order; job order keeps results.json stable across runs.
  const names = routes.map(name);
  const order = (r: RouteResult) =>
    names.indexOf(name(r)) * cfg.widths.length + cfg.widths.indexOf(r.width);
  results.sort((a, b) => order(a) - order(b));

  const meta = {
    tool: "renderdiff" as const,
    version: version(),
    generatedAt: new Date().toISOString(),
    left: cfg.left,
    right: cfg.right,
    widths: cfg.widths,
    threshold: cfg.threshold,
    clock: new Date(now).toISOString(),
    blockUrlPatterns: cfg.blockUrlPatterns,
    hideSelectors: cfg.hideSelectors,
    masks: cfg.masks.map(({ urlPath, reason }) => ({ urlPath, reason })),
    browser: browserMeta,
    storageState: {
      left: cfg.storageState.left && path.basename(cfg.storageState.left),
      right: cfg.storageState.right && path.basename(cfg.storageState.right),
    },
  };
  const reportPath = await writeReport(results, meta, cfg);
  const resultsPath = writeResults(results, meta, cfg.outDir);

  if (progress) summarize(results, reportPath, resultsPath);
  else console.log(compact(results, names, resultsPath, cfg.threshold));

  if (open) {
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    spawn(opener, [reportPath], { detached: true, stdio: "ignore" }).unref();
  }

  // A measured failure outranks an unmeasured route, so an error can't hide a threshold failure.
  const below = results.filter(
    (r) => r.status === "compared" && cfg.threshold !== null && r.score < cfg.threshold,
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
      console.log(`Bundled Chromium failed to launch; using the system Chrome ${browser.version()}.`);
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
  const compared = results.filter(
    (r): r is ComparedResult => r.status === "compared",
  );

  if (compared.length) {
    const { sorted, mean, worst } = stats(compared);
    console.log(
      `\nmean ${pct(mean)}   worst ${pct(worst.score)} (${name(worst)} @${worst.width})`,
    );
    for (const r of sorted.slice(0, 10)) {
      console.log(
        `    ${pct(r.score).padStart(7)}  ${name(r)}@${r.width}` +
          (r.heightDelta ? `  height ${signed(r.heightDelta)}px` : ""),
      );
    }
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

/** Located elements in crop order, bands tallest first then regions, one per selector. */
function elementsOf(r: { regions: { elements?: ElementDiff[] }[]; bands: (Band & { elements?: ElementDiff[] })[] | null }): ElementDiff[] {
  const all = [...[...(r.bands ?? [])].sort((a, b) => b.h - a.h), ...r.regions].flatMap((g) => g.elements ?? []);
  return all.filter((e, i) => all.findIndex((o) => o.selector === e.selector) === i).slice(0, DOM_ELEMENTS);
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
  let differ = 0;
  for (const route of routes) {
    const rows = results.filter((r) => name(r) === route);
    const ok = rows.filter((r): r is ComparedResult => r.status === "compared");
    // Unstable pixels went unmeasured, so a shot with any is not clean, only unchanged.
    const same = ok.filter((r) => r.diffPixels === 0 && r.unstablePixels === 0);
    const changed = ok.filter((r) => !same.includes(r));
    if (same.length === rows.length) {
      clean.push(route);
      continue;
    }
    if (changed.some((r) => r.diffPixels > 0)) differ++;
    out.push(route + (same.length ? `  clean @${same.map((r) => r.width).join(",")}` : ""));
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
      if (dom.length) out.push(`    dom ${g.length > 1 ? `@${g[0]!.width} ` : ""}${fmtElements(dom)}`);
      const paths = g.flatMap((r) => r.crops.map((c) => c.path));
      if (paths.length) out.push(`    crops ${paths.join(" ")}`);
    }
    const failed = new Map<string, number[]>();
    for (const r of rows) if (r.status === "error") failed.set(r.error, [...(failed.get(r.error) ?? []), r.width]);
    for (const [error, widths] of failed) out.push(`  @${widths.join(",")}  ERROR ${error}`);
  }
  if (clean.length) out.unshift(`clean: ${clean.join(" ")}`);
  const compared = results.filter((r): r is ComparedResult => r.status === "compared");
  const shots = compared.filter((r) => r.diffPixels > 0).length;
  const errors = results.length - compared.length;
  const worst = compared.length ? stats(compared).worst : null;
  out.push(
    `renderdiff: ${differ} of ${routes.length} routes differ (${shots} of ${results.length} shots), ` +
      `${errors} error${errors === 1 ? "" : "s"}` +
      (worst ? `, worst ${pct(worst.score)} ${name(worst)}@${worst.width}` : "") +
      (threshold === null ? "" : `, ${compared.filter((r) => r.score < threshold).length} below ${pct(threshold)}`) +
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
  const unstable = Math.max(...g.map((x) => x.unstablePixels));
  // Band y varies with width; a collapsed row shows the first one's, marked approximate.
  const y = (b: Band) => `@y${g.length > 1 ? "~" : ""}${b.y}`;
  const text = [...r.text.added.map((t) => `+"${t}"`), ...r.text.removed.map((t) => `-"${t}"`)];
  return [
    span(g.map((x) => x.score), pct),
    r.heightDelta ? `h${signed(r.heightDelta)}` : "",
    r.widthDelta ? `w${signed(r.widthDelta)}` : "",
    r.bands === null ? "unaligned" : "",
    ...(r.bands ?? []).map((b) => `band ${b.side === "left" ? "+" : "-"}${b.h}${y(b)}`),
    r.alignedScore !== null ? `aligned ${pct(r.alignedScore)}` : "",
    Math.max(...regions) ? `${span(regions, String)} reg` : "",
    unstable ? `unstable ${unstable.toLocaleString("en-US")}px` : "",
    text.length
      ? `text ${text.slice(0, TEXT_LINES).join(" ")}` +
        (text.length > TEXT_LINES ? ` (+${text.length - TEXT_LINES} more)` : "")
      : "",
  ]
    .filter(Boolean)
    .join("  ");
}
