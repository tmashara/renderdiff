import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium, errors, type Browser, type Page } from "playwright";
import { applyAccepted, readAccepted, unacceptable, updateAccepted } from "./accept.ts";
import { CACHE_DIR, cacheFile, replayable, REPLAY_TTL, saveRecording, shotId } from "./cache.ts";
import { cancelUnstable, capture, HookError, prepare, type Shot } from "./capture.ts";
import { compare, crops, type Band, type Region } from "./compare.ts";
import { diffSnapshots, fmtComputed, pageError } from "./computed.ts";
import { locate, snapshot, type ElementDiff } from "./locate.ts";
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
import { fmtBand, fmtElements, fmtFailed, fmtLine, fmtRegion, pct, signed } from "./format.ts";
import {
  fails,
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
/** A full-page walk reads every element's style; past this, report the snapshot as failed. */
const COMPUTED_TIMEOUT = 15_000;

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
  /** Replay the right side's traffic from the out dir's recording, or record one. */
  cacheRight: boolean;
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
  f === "evidence.html" ||
  f === "results.json" ||
  f === CACHE_DIR ||
  /^[a-z0-9_~@-]+\.[\d.]+\.(left|right|diff|c\d+)\.png$/.test(f);

function wipeable(dir: string): boolean {
  if (!fs.existsSync(dir)) return true;
  return fs.statSync(dir).isDirectory() && fs.readdirSync(dir).every(ours);
}

/** A stylesheet or font face failed on a side; older results.json files lack the field. */
const broken = (r: ComparedResult) => !!(r.failed?.left.length || r.failed?.right.length);

export const reusable = (r: RouteResult) =>
  r.status === "compared" &&
  ((r.diffPixels === 0 && r.unstablePixels === 0 && !broken(r)) || r.accepted);

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
        `the config (masks, hooks, hidden selectors, blocked URLs, CSS, storage state, --computed) ` +
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
  cacheRight,
}: RunOpts): Promise<number> {
  const names = routes.map(name);
  const setup = {
    left: cfg.left,
    right: cfg.right,
    widths: cfg.widths,
    blockUrlPatterns: cfg.blockUrlPatterns,
    hideSelectors: cfg.hideSelectors,
    masks: cfg.masks.map(({ urlPath, reason }) => ({ urlPath, reason })),
    freezeVideo: cfg.freezeVideo,
    platform: process.platform,
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
  if (!prev && fs.existsSync(cfg.outDir)) {
    for (const f of fs.readdirSync(cfg.outDir)) {
      if (f !== CACHE_DIR || !cacheRight)
        fs.rmSync(path.join(cfg.outDir, f), { recursive: true, force: true });
    }
  }
  fs.mkdirSync(cfg.outDir, { recursive: true });

  if (prev) applyAccepted(prev.results, accepted);
  const before = new Map(prev?.results.map((r) => [`${name(r)}@${r.width}`, r]));
  const results: RouteResult[] = [];
  const jobs: Job[] = [];
  for (const route of routes) {
    for (const width of cfg.widths) {
      const had = before.get(`${name(route)}@${width}`);
      // A shot measured against a replay stands only for a run that would replay it too.
      const replay = had?.status === "compared" && had.rightReplayedFrom;
      const fresh = !replay || (cacheRight && Date.now() - Date.parse(replay) < REPLAY_TTL);
      if (had && reusable(had) && fresh) results.push(had);
      else jobs.push({ route, width });
    }
  }

  const stems = slugs(routes);
  const launched = jobs.length ? await launch() : null;
  const queue = [...jobs];
  let done = 0;
  // Whole minute, so an HH:MM display reads the same on both sides.
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  const har = launched && cacheRight ? cacheFile(cfg, browserOf(launched)) : null;
  const replayedAt =
    har &&
    replayable(
      har,
      jobs.map((j) => shotId(j.route, j.width)),
    );
  const recorded: string[] = [];
  if (har && !replayedAt) fs.mkdirSync(path.dirname(har), { recursive: true });
  const part = (i: number) => `${har}.${i}.part`;

  const worker = async (browser: Browser, i: number) => {
    // One context per origin so cookies/localStorage never cross between them.
    // A service worker answers requests a HAR never sees; blocked on both sides to stay symmetric.
    const sw = har ? { serviceWorkers: "block" as const } : {};
    const leftCtx = await browser.newContext({
      ...CONTEXT_OPTIONS,
      ...sw,
      storageState: cfg.storageState.left ?? undefined,
    });
    const rightCtx = await browser.newContext({
      ...CONTEXT_OPTIONS,
      ...sw,
      storageState: cfg.storageState.right ?? undefined,
    });
    // Registered before the HAR route, so it sees only what the recording lacks.
    let missed = 0;
    if (replayedAt) {
      await rightCtx.route("**", (r) => {
        missed++;
        return r.fallback();
      });
    }
    if (har) {
      await rightCtx.routeFromHAR(
        replayedAt ? har : part(i),
        replayedAt
          ? { notFound: "fallback" }
          : { update: true, updateContent: "embed", updateMode: "minimal" },
      );
    }
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
        missed = 0;
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
        // A replay that went live in part compared against two different moments of the reference.
        if (missed) rightShot.failed.push(`${missed} request(s) not in the recording, loaded live`);
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
        const snap = (page: Page, side: "left" | "right") =>
          snapshot(
            page,
            masksFor(cfg, page, route),
            COMPUTED_TIMEOUT,
            route.selector ? page.locator(route.selector[side]) : null,
          ).catch((e: unknown) => {
            throw new Error(pageError(e));
          });
        const computed = cfg.computed
          ? await Promise.race([
              Promise.all([snap(leftPage, "left"), snap(rightPage, "right")]).then(
                ([l, r]) => ({ computed: diffSnapshots(l, r) }),
                (e: Error) => ({ computed: null, computedError: e.message }),
              ),
              sleep(COMPUTED_TIMEOUT + 5_000, null, { ref: false }).then(() => ({
                computed: null,
                computedError: `took over ${(COMPUTED_TIMEOUT + 5_000) / 1000}s`,
              })),
            ])
          : null;
        const cropped = made.map(({ png, ...c }, i) => ({ path: `${base}.c${i + 1}.png`, ...c }));
        await Promise.all([
          write(images.left, leftShot.png),
          write(images.right, rightShot.png),
          write(images.diff, diffPng),
          ...made.map((c, i) => write(cropped[i]!.path, c.png)),
        ]);

        if (!rightShot.failed.length) recorded.push(shotId(route, width));
        results.push({
          ...entry,
          status: "compared",
          ...metrics,
          unstablePixels,
          images,
          crops: cropped,
          accepted: false,
          failed: { left: leftShot.failed, right: rightShot.failed },
          ...computed,
          ...(replayedAt ? { rightReplayedFrom: new Date(replayedAt).toISOString() } : {}),
        });
        const { regions, bands, alignedScore, text } = metrics;
        const dom = elementsOf(metrics);
        const assets = fmtFailed({ left: leftShot.failed, right: rightShot.failed });
        const details = [
          sel,
          assets ? `failed ${assets}` : "",
          regions.length
            ? `${regions.length} region${regions.length > 1 ? "s" : ""}, largest ${fmtRegion(regions[0]!)}`
            : "",
          ...more(regions.flatMap((g) => (g.line ? [fmtLine(g.line)] : []))),
          ...(bands ?? []).map((b) => `band ${fmtBand(b)}`),
          alignedScore !== null ? `aligned ${pct(alignedScore)}` : "",
          bands === null ? "rows too different to align" : "",
          text.added.length || text.removed.length
            ? `text: ${text.added.length} added, ${text.removed.length} removed`
            : "",
          dom.length ? `dom ${fmtElements(dom)}` : "",
          computed && !computed.computed
            ? `computed: snapshot failed, ${computed.computedError}`
            : "",
          computed?.computed
            ? `computed ${computed.computed.dom ? `dom differs (${computed.computed.dom})` : "dom identical"}, ${computed.computed.changes.length + computed.computed.truncated} change(s)`
            : "",
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
    await Promise.all(
      Array.from({ length: cfg.concurrency }, (_, i) => worker(launched.browser, i)),
    );
    await launched.browser.close();
  }
  const browserMeta = launched ? browserOf(launched) : prev!.meta.browser;
  let unsaved = "";
  if (har && !replayedAt) {
    try {
      saveRecording(
        har,
        Array.from({ length: cfg.concurrency }, (_, i) => part(i)),
        recorded,
        now,
      );
    } catch (e) {
      unsaved = e instanceof Error ? e.message : String(e);
    }
  }
  const replays = results.flatMap((r) =>
    r.status === "compared" && r.rightReplayedFrom ? [r.rightReplayedFrom] : [],
  );

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
    const why = new Map<string, number>();
    for (const r of results) {
      const w = r.status === "compared" && r.diffPixels > 0 && !r.accepted && unacceptable(r);
      if (w) why.set(w, (why.get(w) ?? 0) + 1);
    }
    const skipped = [...why.values()].reduce((a, b) => a + b, 0);
    if (skipped) {
      console.log(
        `not accepted: ${skipped} differing shot(s) can't be (` +
          [...why].map(([w, n]) => `${n} ${w}`).join(", ") +
          `) — reference.md § Masks, accepts and thresholds`,
      );
    }
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
    rightReplayedFrom: replays.sort()[0] ?? null,
    rerun: prev ? { rerun: jobs.length, reused: results.length - jobs.length } : null,
  };
  const reportPath = await writeReport(results, meta, cfg.outDir, stale);
  const resultsPath = writeResults(results, meta, cfg.outDir, stale);

  if (prev) {
    const rerunRoutes = new Set(jobs.map((j) => name(j.route))).size;
    console.log(
      `rerun: ${jobs.length} shot(s) on ${rerunRoutes} route(s), ` +
        `${results.length - jobs.length} reused, ${names.length - rerunRoutes} route(s) untouched`,
    );
  }
  if (meta.rightReplayedFrom) {
    console.log(`right: replayed from a recording of ${meta.rightReplayedFrom} (--cache-right)`);
  }
  if (har && !replayedAt) {
    console.log(
      unsaved
        ? `right: loaded live; recording not saved: ${unsaved}`
        : `right: loaded live and recorded for --cache-right (replayed for ${REPLAY_TTL / 60_000} min)`,
    );
  }
  if (stale.length) {
    console.log(
      `stale accepted: ${stale.map((a) => `${a.route}@${a.width}`).join(" ")} — ${acceptedFile}`,
    );
  }
  if (progress) summarize(results, names, reportPath, resultsPath);
  else console.log(compact(results, names, resultsPath, cfg.threshold));

  if (open) {
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    spawn(opener, [reportPath], { detached: true, stdio: "ignore" }).unref();
  }

  // A measured failure outranks an unmeasured route, so an error can't hide a diff.
  const below = results.filter((r) => fails(r, cfg.threshold));
  if (below.length) {
    const n = new Set(below.map(name)).size;
    const what =
      cfg.threshold === null ? (n === 1 ? "differs" : "differ") : `below ${pct(cfg.threshold)}`;
    const shots = `${below.length} shot${below.length === 1 ? "" : "s"}`;
    console.error(`\n✗ ${n} route${n === 1 ? "" : "s"} ${what} (${shots}).`);
  }
  return below.length ? 1 : results.some((r) => r.status === "error") ? 3 : 0;
}

const browserOf = (l: { browser: Browser; channel: string | null }) => ({
  name: l.channel ?? "chromium",
  version: l.browser.version(),
});

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

function summarize(
  results: RouteResult[],
  routes: string[],
  reportPath: string,
  resultsPath: string,
) {
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

  const computed = fmtComputed(results, routes);
  if (computed.length) console.log(`\n${computed.join("\n")}`);

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
    // Unstable pixels went unmeasured and a failed asset rendered a fallback, so a shot with
    // either is not clean, only unchanged.
    const same = ok.filter((r) => r.diffPixels === 0 && r.unstablePixels === 0 && !broken(r));
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
      const failed = fmtFailed({
        left: [...new Set(g.flatMap((r) => r.failed?.left ?? []))],
        right: [...new Set(g.flatMap((r) => r.failed?.right ?? []))],
      });
      if (failed) out.push(`    failed ${failed}`);
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
  out.push(...fmtComputed(results, routes));
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

/** The first three, and how many more there are. */
const more = (lines: string[]) =>
  lines.length > 3 ? [...lines.slice(0, 3), `(+${lines.length - 3} more)`] : lines;

/** One compact row for comparisons that agree on everything but score, regions and unstable px. */
function row(g: ComparedResult[]): string {
  const [r] = g as [ComparedResult];
  const span = (ns: number[], f: (n: number) => string) => {
    const [lo, hi] = [Math.min(...ns), Math.max(...ns)];
    return lo === hi ? f(lo) : `${f(lo)}–${f(hi)}`;
  };
  const drawn = (c: Region) => c.line && !c.accepted;
  const regions = g.map((x) => x.regions.filter((c) => !drawn(c)).length);
  const lined = g.find((x) => x.regions.some(drawn)) ?? r;
  const ys = (x: ComparedResult) =>
    x.regions
      .filter(drawn)
      .map((c) => c.line!.y)
      .join();
  const approx = new Set(g.map(ys)).size > 1;
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
    ...more(lined.regions.flatMap((c) => (drawn(c) ? [fmtLine(c.line!, approx)] : []))),
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
