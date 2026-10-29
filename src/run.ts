import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium, errors, type Browser, type BrowserContext, type Page } from "playwright";
import sharp from "sharp";
import { applyAccepted, readAccepted, unacceptable, updateAccepted } from "./accept.ts";
import { CACHE_DIR, cacheFile, replayable, REPLAY_TTL, saveRecording, shotId } from "./cache.ts";
import { cancelUnstable, capture, HookError, prepare, step, type Shot } from "./capture.ts";
import { compare, crops, type Band, type Box, type Region } from "./compare.ts";
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
  fmtPixelFindings,
  stats,
  writeEvidence,
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
/** Bounds one capture: a renderer that dies or never returns from an evaluate would hang the run. */
const SHOT_TIMEOUT = (Math.max(0, Number(process.env.RENDERDIFF_SHOT_TIMEOUT)) || 120) * 1000;

/** Past this share of a page unstable, too little was measured for a score to mean anything. */
const MAX_UNSTABLE_SHARE = 0.25;

interface Job {
  route: Route;
  width: number;
  retried?: boolean;
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
  /** Reload a differing shot's right side in a fresh context to find what varies per load. */
  recheck: boolean;
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

/** The smallest box holding every set pixel of a row-major `width`-wide mask. */
function bbox(mask: Uint8Array, width: number) {
  let [x0, y0, x1, y1] = [width, Infinity, -1, -1];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = i % width,
      y = Math.floor(i / width);
    [x0, x1, y1] = [Math.min(x0, x), Math.max(x1, x), y];
    if (y0 === Infinity) y0 = y;
  }
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Only a directory holding nothing but files renderdiff writes is safe to wipe. */
const ours = (f: string) =>
  f === "report.html" ||
  f === "evidence.html" ||
  f === "results.json" ||
  f === CACHE_DIR ||
  /^[a-z0-9_~@-]+\.[\d.]+\.((left|right)(\.unsettled-[ab])?|diff|c\d+)\.png$/.test(f);

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
  r.status === "compared"
    ? [...Object.values(r.images), ...r.crops.map((c) => c.path)]
    : (r.frames ?? []);

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
  if (prev.results?.some((r) => r.from))
    return `${file} was written by renderdiff merge; rerun into a new --out and merge again`;
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
  recheck,
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
    const pages = { left: await leftCtx.newPage(), right: await rightCtx.newPage() };
    await prepare(pages.left, cfg, now);
    await prepare(pages.right, cfg, now);

    for (let job = queue.shift(); job; job = queue.shift()) {
      const { route, width } = job;
      const key = name(route);
      const { before, beforeShot, ...where } = route;
      const entry = {
        url: label(route),
        ...where,
        hook: before !== null || beforeShot !== null,
        width,
      };
      const tag = `${label(route)} @${width}`;
      // Its own line: parse.ts reads the route on the row as one \S+ token.
      const sel = route.selector ? `selector ${selectorText(route.selector)}` : "";
      const base = `${stems.get(key)}.${width}`;
      const write = (name: string, buf: Buffer) =>
        fs.promises.writeFile(path.join(cfg.outDir, name), buf);
      let frames: string[] | undefined;
      try {
        missed = 0;
        // allSettled, not all: a page must not start the next job while still loading this one.
        const settled = await Promise.allSettled([
          shoot(pages, cfg.left + route.left, route, "left", width, cfg, now),
          shoot(pages, cfg.right + route.right, route, "right", width, cfg, now),
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
        const raw = [leftShot.png, rightShot.png] as const;
        const unstablePixels = await cancelUnstable(leftShot, rightShot);

        let { diffPng, spots, ...metrics } = await compare(leftShot, rightShot);
        if (unstablePixels > MAX_UNSTABLE_SHARE * metrics.totalPixels) {
          if (!job.retried) {
            queue.push({ ...job, retried: true });
            continue;
          }
          const where = await Promise.all(
            (["left", "right"] as const).map(async (side, s) => {
              const shot = s ? rightShot : leftShot;
              if (!shot.prev || !shot.unstable) return [];
              const [a, b] = [`${base}.${side}.unsettled-a.png`, `${base}.${side}.unsettled-b.png`];
              (frames ??= []).push(a, b);
              await Promise.all([write(a, shot.prev), write(b, raw[s]!)]);
              const { width: w } = await sharp(raw[s]!).metadata();
              return [`${side}: ${a} vs -b differ within ${fmtRegion(bbox(shot.unstable, w))}`];
            }),
          );
          throw new Error(
            `page did not settle: ${unstablePixels}px unstable at ${key}, again on retry; ${where.flat().join("; ")}`,
          );
        }
        let varies: Region[] = [];
        let variesPixels = 0;
        if (recheck && !har && metrics.diffPixels) {
          let ctx: BrowserContext | undefined;
          try {
            ctx = await browser.newContext({
              ...CONTEXT_OPTIONS,
              storageState: cfg.storageState.right ?? undefined,
            });
            const again = { left: pages.left, right: await ctx.newPage() };
            await prepare(again.right, cfg, now);
            const shot = await shoot(
              again,
              cfg.right + route.right,
              route,
              "right",
              width,
              cfg,
              now,
            );
            const self = await compare({ ...rightShot, png: raw[1] }, shot);
            if (self.diffPixels) {
              const found = self.spots.filter((s) => s.kind === "region");
              const named = await Promise.race([
                locate([pages.right, again.right], [rightShot, shot], found, [
                  masksFor(cfg, pages.right, route),
                  masksFor(cfg, again.right, route),
                ]).catch(() => null),
                sleep(LOCATE_TIMEOUT, null, { ref: false }),
              ]);
              named?.forEach((els, i) => (found[i]!.target.elements = els));
              const regions = self.regions.map(({ hash, ...g }) => g);
              // Element boxes, not the pixels that changed: those miss the left's own value.
              const mask = await boxMask(
                raw[1],
                regions.flatMap((g) => {
                  const own = g.elements?.flatMap((e) => (e.left ? [e.left] : [])) ?? [];
                  return own.length ? own : [g];
                }),
              );
              const u = rightShot.unstable;
              const l = { ...leftShot, png: raw[0] };
              const r = {
                ...rightShot,
                png: raw[1],
                unstable: u ? mask.map((v, i) => v | u[i]!) : mask,
              };
              const painted = await cancelUnstable(l, r);
              ({ diffPng, spots, ...metrics } = await compare(l, r));
              [leftShot.png, rightShot.png] = [l.png, r.png];
              varies = regions;
              variesPixels = painted - unstablePixels;
            }
          } catch {
            // A hint, like locate: a failed recheck leaves the shot as first measured.
          } finally {
            await ctx?.close().catch(() => {});
          }
        }
        const measured = metrics.totalPixels - unstablePixels - variesPixels;
        metrics.score = measured > 0 ? 1 - metrics.diffPixels / measured : 0;
        const images = {
          left: `${base}.left.png`,
          right: `${base}.right.png`,
          diff: `${base}.diff.png`,
        };
        // Both pages still hold this job's document: the next load waits for the loop.
        const [made, named] = await Promise.all([
          crops(leftShot.png, rightShot.png, spots),
          Promise.race([
            locate([pages.left, pages.right], [leftShot, rightShot], spots, [
              masksFor(cfg, pages.left, route),
              masksFor(cfg, pages.right, route),
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
              Promise.all([snap(pages.left, "left"), snap(pages.right, "right")]).then(
                ([l, r]) => ({
                  computed: diffSnapshots(l, r, [pages.left.url(), pages.right.url()]),
                }),
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
        const marked = [...new Set([...leftShot.marked, ...rightShot.marked])];
        results.push({
          ...entry,
          status: "compared",
          ...metrics,
          unstablePixels,
          ...(variesPixels ? { varies, variesPixels } : {}),
          images,
          crops: cropped,
          accepted: false,
          failed: { left: leftShot.failed, right: rightShot.failed },
          ...(marked.length ? { masked: marked } : {}),
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
          ...(frames && { frames }),
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

function readResults(dir: string): Results {
  const file = path.join(dir, "results.json");
  if (!fs.existsSync(file)) throw new Error(`no ${file}; run renderdiff with --out ${dir} first`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
}

/** `renderdiff merge`: the full run's results with the partial run's shots replacing or added. */
export async function merge(fullDir: string, partialDir: string, outDir: string): Promise<void> {
  const full = readResults(fullDir);
  const partial = readResults(partialDir);
  for (const side of ["left", "right"] as const) {
    if (full.meta[side] !== partial.meta[side])
      throw new Error(
        `${side} differs: ${full.meta[side]} in ${fullDir}, ${partial.meta[side]} in ${partialDir}`,
      );
  }
  const real = (p: string): string => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.join(real(path.dirname(path.resolve(p))), path.basename(p));
    }
  };
  for (const dir of [fullDir, partialDir]) {
    const rel = path.relative(real(dir), real(outDir));
    if (!rel || (rel.split(path.sep)[0] !== ".." && !path.isAbsolute(rel)))
      throw new Error(`--out ${outDir} is or is inside ${dir}; pass a new directory`);
  }
  if (!wipeable(outDir))
    throw new Error(
      `output directory ${outDir} holds files renderdiff didn't write — ` +
        `refusing to wipe it. Pass --out with a new or empty directory.`,
    );

  const key = (r: RouteResult) => `${name(r)}@${r.width}`;
  const taken = new Map(
    partial.results.map((r) => [key(r), { ...r, from: r.from ?? partial.meta.generatedAt }]),
  );
  const results = full.results.map((r) => taken.get(key(r)) ?? r);
  const replaced = results.filter((r) => taken.has(key(r))).length;
  const kept = new Set(full.results.map(key));
  results.push(...[...taken.values()].filter((r) => !kept.has(key(r))));

  const copies = new Map<string, { src: string; shot: string }>();
  for (const r of results) {
    const src = taken.has(key(r)) ? partialDir : fullDir;
    for (const f of files(r)) {
      if (!fs.existsSync(path.join(src, f))) throw new Error(`${path.join(src, f)} is missing`);
      const had = copies.get(f);
      if (had)
        throw new Error(`${had.shot} and ${key(r)} both write ${f}; rerun both into one --out`);
      copies.set(f, { src, shot: key(r) });
    }
  }

  if (fs.existsSync(outDir)) {
    for (const f of fs.readdirSync(outDir))
      fs.rmSync(path.join(outDir, f), { recursive: true, force: true });
  }
  fs.mkdirSync(outDir, { recursive: true });
  for (const [f, { src }] of copies) fs.copyFileSync(path.join(src, f), path.join(outDir, f));

  const union = <T>(a: T[], b: T[]) => [
    ...new Map([...a, ...b].map((v) => [JSON.stringify(v), v])).values(),
  ];
  const replays = results.flatMap((r) =>
    r.status === "compared" && r.rightReplayedFrom ? [r.rightReplayedFrom] : [],
  );
  const meta = {
    ...full.meta,
    widths: union(full.meta.widths, partial.meta.widths),
    masks: union(full.meta.masks, partial.meta.masks),
    hideSelectors: union(full.meta.hideSelectors, partial.meta.hideSelectors),
    blockUrlPatterns: union(full.meta.blockUrlPatterns, partial.meta.blockUrlPatterns),
    rightReplayedFrom: replays.sort()[0] ?? null,
  };
  const stale = [
    ...(full.summary.stale ?? []).filter((a) => !taken.has(`${a.route}@${a.width}`)),
    ...(partial.summary.stale ?? []),
  ];
  await writeReport(results, meta, outDir, stale);
  const resultsPath = writeResults(results, meta, outDir, stale);
  await writeEvidence(readResults(outDir), outDir, null);
  console.log(
    `merged ${taken.size} shot(s) from ${partialDir} (${replaced} replaced, ` +
      `${taken.size - replaced} added) into ${outDir}`,
  );
  console.log(compact(results, [...new Set(results.map(name))], resultsPath, meta.threshold));
}

const browserOf = (l: { browser: Browser; channel: string | null }) => ({
  name: l.channel ?? "chromium",
  version: l.browser.version(),
});

// Replaces Playwright's own headless --blink-settings, so its hover/pointer values are repeated.
const ARGS = [
  "--blink-settings=imageAnimationPolicy=2,primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
];

/**
 * A missing browser binary is the likeliest first-run failure, so fall back to the system
 * Chrome (both sides share it, so the comparison stays symmetric), then name the fix.
 */
async function launch() {
  try {
    return { browser: await chromium.launch({ args: ARGS }), channel: null };
  } catch (e) {
    try {
      const browser = await chromium.launch({ channel: "chrome", args: ARGS });
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
  pages: Record<"left" | "right", Page>,
  url: string,
  route: Route,
  side: "left" | "right",
  width: number,
  cfg: ResolvedConfig,
  now: number,
): Promise<Shot> {
  const once = async () => {
    const page = pages[side];
    const shot = await Promise.race([
      capture(page, url, route, side, width, cfg, now),
      sleep(SHOT_TIMEOUT, null, { ref: false }),
    ]);
    if (shot) return shot;
    const at = step.get(page);
    // Awaited: page.clock is the context's, so prepare() and the next capture would reach a closing page.
    await page.close();
    pages[side] = await page.context().newPage();
    await prepare(pages[side], cfg, now);
    const E = at === "before hook" || at === "beforeShot hook" ? HookError : errors.TimeoutError;
    throw new E(`timeout after ${SHOT_TIMEOUT / 1000}s at ${at} on ${side}`);
  };
  try {
    return await once();
  } catch (e) {
    if (!transient(e)) throw e;
    await pages[side].waitForTimeout(1000);
    return await once();
  }
}

/** A per-pixel mask the size of `png`, set inside each box. */
async function boxMask(png: Buffer, boxes: Box[]): Promise<Uint8Array> {
  const { width = 0, height = 0 } = await sharp(png).metadata();
  const mask = new Uint8Array(width * height);
  for (const b of boxes) {
    const [x0, y0] = [Math.max(0, Math.floor(b.x)), Math.max(0, Math.floor(b.y))];
    const [x1, y1] = [
      Math.min(width, Math.ceil(b.x + b.w)),
      Math.min(height, Math.ceil(b.y + b.h)),
    ];
    for (let y = y0; y < y1; y++) mask.fill(1, y * width + x0, y * width + Math.max(x0, x1));
  }
  return mask;
}

/** Routes whose right side differed between two loads, and the mask that would cover it. */
function fmtVaries(results: RouteResult[], routes: string[]): string[] {
  const rows = results.filter((r): r is ComparedResult => r.status === "compared" && !!r.varies);
  const selectors = (rs: ComparedResult[]) => [
    ...new Set(
      rs.flatMap((r) =>
        r.varies!.flatMap((g) => g.elements ?? []).map((e) => e.selector.replace(/::\w+$/, "")),
      ),
    ),
  ];
  const out: string[] = [];
  const masks: string[] = [];
  for (const route of routes) {
    const rs = rows.filter((r) => name(r) === route);
    if (!rs.length) continue;
    const sels = selectors(rs);
    const px = rs.reduce((n, r) => n + r.variesPixels!, 0);
    out.push(
      `varies ${route} @${rs.map((r) => r.width).join(",")}  ` +
        `${px.toLocaleString("en-US")}px  ${sels.join(" ") || "(not located)"}`,
    );
    for (const s of sels) {
      masks.push(
        `{ selector: ${JSON.stringify(s)}, urlPath: ${JSON.stringify(rs[0]!.right)}, reason: "varies per load" }`,
      );
    }
  }
  const sels = selectors(rows);
  if (sels.length) {
    out.push(`  --mask ${sels.map((s) => `'${s.replace(/'/g, `'\\''`)}'`).join(" --mask ")}`);
    out.push(`  masks: [${masks.join(", ")}]`);
  }
  return out;
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

  const repeated = fmtPixelFindings(results);
  if (repeated.length) console.log(`\n${repeated.join("\n")}`);
  const computed = fmtComputed(results, routes);
  if (computed.length) console.log(`\n${computed.join("\n")}`);
  const varies = fmtVaries(results, routes);
  if (varies.length) console.log(`\n${varies.join("\n")}`);

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
  out.push(
    ...fmtPixelFindings(results),
    ...fmtComputed(results, routes),
    ...fmtVaries(results, routes),
  );
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
