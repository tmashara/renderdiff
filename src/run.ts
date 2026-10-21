import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium, errors, type Page } from "playwright";
import { cancelUnstable, capture, prepare, type Shot } from "./capture.ts";
import { compare } from "./compare.ts";
import { CONTEXT_OPTIONS, type ResolvedConfig, type Route } from "./config.ts";
import { pct, signed } from "./format.ts";
import {
  stats,
  writeReport,
  type ComparedResult,
  type ErrorResult,
  type RouteResult,
} from "./report.ts";

interface Job {
  route: Route;
  width: number;
}

interface RunOpts {
  routes: Route[];
  cfg: ResolvedConfig;
  open: boolean;
}

const slug = (url: string) =>
  url === "/"
    ? "index"
    : url
        .slice(1)
        .toLowerCase()
        .replace(/\//g, "-")
        .replace(/[^a-z0-9-]/g, "_")
        .slice(0, 200);

/** Route -> file stem, unique across the run. Suffixes follow route order, so reruns agree. */
function slugs(routes: Route[]): Map<Route, string> {
  const out = new Map<Route, string>();
  const used = new Set<string>();
  for (const route of routes) {
    let s = slug(route);
    for (let n = 2; used.has(s); n++) s = `${slug(route)}-${n}`;
    used.add(s);
    out.set(route, s);
  }
  return out;
}

/** Only a directory holding nothing but files renderdiff writes is safe to wipe. */
const ours = (f: string) =>
  f === "report.html" ||
  /^[a-z0-9_-]+\.[\d.]+\.(left|right|diff)\.png$/.test(f);

function wipeable(dir: string): boolean {
  if (!fs.existsSync(dir)) return true;
  return fs.statSync(dir).isDirectory() && fs.readdirSync(dir).every(ours);
}

export async function run({ routes, cfg, open }: RunOpts): Promise<number> {
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
  const browser = await launch();
  const queue = [...jobs];
  let done = 0;
  const now = Date.now();

  const worker = async () => {
    // One context per origin so cookies/localStorage never cross between them.
    const leftCtx = await browser.newContext(CONTEXT_OPTIONS);
    const rightCtx = await browser.newContext(CONTEXT_OPTIONS);
    const leftPage = await leftCtx.newPage();
    const rightPage = await rightCtx.newPage();
    await prepare(leftPage, cfg, now);
    await prepare(rightPage, cfg, now);

    for (let job = queue.shift(); job; job = queue.shift()) {
      const { route, width } = job;
      const label = `${route} @${width}`;
      try {
        // allSettled, not all: a page must not start the next job while still loading this one.
        const settled = await Promise.allSettled([
          shoot(leftPage, cfg.left + route, route, width, cfg),
          shoot(rightPage, cfg.right + route, route, width, cfg),
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
              `(left: ${leftShot.blank}; right: ${rightShot.blank}) at ${route}`,
          );
        }
        const unstablePixels = await cancelUnstable(leftShot, rightShot);

        const { diffPng, ...metrics } = await compare(leftShot, rightShot);
        const base = `${stems.get(route)}.${width}`;
        const images = {
          left: `${base}.left.png`,
          right: `${base}.right.png`,
          diff: `${base}.diff.png`,
        };
        const write = (name: string, buf: Buffer) =>
          fs.promises.writeFile(path.join(cfg.outDir, name), buf);
        await Promise.all([
          write(images.left, leftShot.png),
          write(images.right, rightShot.png),
          write(images.diff, diffPng),
        ]);

        results.push({
          url: route,
          width,
          status: "compared",
          ...metrics,
          unstablePixels,
          images,
        });
        console.log(
          `  [${++done}/${jobs.length}] ${pct(metrics.score)}  ${label}` +
            (metrics.heightDelta
              ? `  (height ${signed(metrics.heightDelta)}px)`
              : "") +
            (unstablePixels
              ? `  (unstable ${unstablePixels.toLocaleString("en-US")}px)`
              : ""),
        );
      } catch (e) {
        results.push({
          url: route,
          width,
          status: "error",
          error: e instanceof Error ? e.message : String(e),
        });
        console.log(`  [${++done}/${jobs.length}] ERROR  ${label}`);
      }
    }
    await leftCtx.close();
    await rightCtx.close();
  };

  console.log(
    `Capturing ${jobs.length} pair(s) with ${cfg.concurrency} worker(s)...\n`,
  );
  await Promise.all(Array.from({ length: cfg.concurrency }, worker));
  await browser.close();

  const reportPath = await writeReport(
    results,
    {
      left: cfg.left,
      right: cfg.right,
      generatedAt: new Date().toISOString(),
      clock: new Date(now).toISOString(),
    },
    cfg,
  );

  summarize(results, reportPath);

  if (open) {
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    spawn(opener, [reportPath], { detached: true, stdio: "ignore" }).unref();
  }

  const errors = results.filter((r) => r.status === "error");
  if (errors.length) return 1;

  if (cfg.threshold !== null) {
    const below = results.filter(
      (r) => r.status === "compared" && r.score < cfg.threshold!,
    );
    if (below.length) {
      console.error(`\n✗ ${below.length} route(s) below ${pct(cfg.threshold)}.`);
      return 1;
    }
  }

  return 0;
}

/** A missing browser binary is the likeliest first-run failure — name the fix. */
async function launch() {
  try {
    return await chromium.launch();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `could not launch Chromium:\n  ${msg}\n\n` +
        `  Install the browser with:  npx playwright install chromium`,
    );
  }
}

const transient = (e: unknown) =>
  e instanceof errors.TimeoutError ||
  (e instanceof Error &&
    /net::ERR_|Execution context was destroyed/.test(e.message));

/** One retry for a transient failure: a live site can time out once on a cold edge. */
async function shoot(
  page: Page,
  url: string,
  urlPath: string,
  width: number,
  cfg: ResolvedConfig,
): Promise<Shot> {
  try {
    return await capture(page, url, urlPath, width, cfg);
  } catch (e) {
    if (!transient(e)) throw e;
    await page.waitForTimeout(1000);
    return await capture(page, url, urlPath, width, cfg);
  }
}

function summarize(results: RouteResult[], reportPath: string) {
  const compared = results.filter(
    (r): r is ComparedResult => r.status === "compared",
  );

  if (compared.length) {
    const { sorted, mean, worst } = stats(compared);
    console.log(
      `\nmean ${pct(mean)}   worst ${pct(worst.score)} (${worst.url} @${worst.width})`,
    );
    for (const r of sorted.slice(0, 10)) {
      console.log(
        `    ${pct(r.score).padStart(7)}  ${r.url}@${r.width}` +
          (r.heightDelta ? `  height ${signed(r.heightDelta)}px` : ""),
      );
    }
  }

  const errors = results.filter((r): r is ErrorResult => r.status === "error");
  if (errors.length) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) console.log(`  ${e.url}@${e.width}: ${e.error}`);
  }

  console.log(`\nReport: ${reportPath}`);
}
