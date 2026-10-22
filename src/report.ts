import fs from "node:fs";
import path from "node:path";
import type { Band, Box, Region, TextDiff } from "./compare.ts";
import { CONTEXT_OPTIONS, name, type ResolvedConfig, type Sides } from "./config.ts";
import { floor4, fmtBand, fmtRegion, pct, signed } from "./format.ts";

interface BaseResult {
  /** The route: `/a`, or `/a::/b` for a pair. */
  url: string;
  /** The path loaded on each side; both equal `url` unless it is a pair. */
  left: string;
  right: string;
  /** The element compared on each side; null for the whole page. */
  selector: Sides | null;
  /** A `before` hook ran on both sides before the shot, so the page was measured in its state. */
  hook: boolean;
  width: number;
}

/** A route that was captured on both sides and diffed. */
export interface ComparedResult extends BaseResult {
  status: "compared";
  score: number;
  diffPixels: number;
  totalPixels: number;
  heightDelta: number;
  widthDelta: number;
  /** Pixels that changed between shots of the same load, painted out on both sides. */
  unstablePixels: number;
  /** Connected diff patches, largest first. */
  regions: Region[];
  /** Rows only one side has; null when the rows were too different to align. */
  bands: Band[] | null;
  /** Score over the rows the alignment pairs; null unless there are bands. */
  alignedScore: number | null;
  /** innerText line diff; `added` is on left only, `removed` on right only. */
  text: TextDiff;
  /** Paths relative to the out dir. */
  images: { left: string; right: string; diff: string };
  /** At most three: bands, tallest first, then the largest regions. Not one per region. */
  crops: CropResult[];
}

/** A crop of one change: left and right panels, a 1px red box round it, or a 2px red seam. */
export interface CropResult {
  /** `{slug}.{width}.c{n}.png`, relative to the out dir. */
  path: string;
  kind: "band" | "region";
  /** The change on each side, in that side's page px. `h` 0 is where the other side's band would go. */
  left: Box;
  right: Box;
  /** Left is always on top (`stacked`) or on the left (`side`). */
  layout: "stacked" | "side";
  /** 1 is native; never below 0.75. */
  scale: number;
  /** Only the top rows (or left columns) of the change fit. */
  clipped: boolean;
}

/** A route that threw before it could be diffed — neither a pass nor a fail. */
export interface ErrorResult extends BaseResult {
  status: "error";
  error: string;
}

export type RouteResult = ComparedResult | ErrorResult;

export interface RunMeta {
  tool: "renderdiff";
  version: string;
  generatedAt: string;
  left: string;
  right: string;
  widths: number[];
  threshold: number | null;
  /** The instant both sides' clocks start at on every load, ISO. */
  clock: string;
  blockUrlPatterns: string[];
  hideSelectors: string[];
  /** `urlPath` is absent for a mask that applies to every route. */
  masks: { urlPath?: string; reason: string }[];
  /** `chromium` (bundled), or `chrome` when that failed to launch and the system Chrome did. */
  browser: { name: string; version: string };
  /** The storage state file's basename per side, or null. Never its contents. */
  storageState: { left: string | null; right: string | null };
}

export interface Summary {
  compared: number;
  errors: number;
  /** Null when nothing was compared. */
  mean: number | null;
  worst: { url: string; width: number; score: number } | null;
  /** Comparisons under `meta.threshold`; 0 when no threshold was set. */
  belowThreshold: number;
}

/** The shape of `results.json`, written to the out dir on every run. */
export interface Results {
  meta: RunMeta;
  results: RouteResult[];
  summary: Summary;
}

/** Sort ascending by score; surface the mean and the worst (lowest-scoring) row. */
export function stats(rows: ComparedResult[]) {
  const sorted = [...rows].sort((a, b) => a.score - b.score);
  const mean = sorted.reduce((s, r) => s + r.score, 0) / sorted.length;
  return { sorted, mean, worst: sorted[0]! };
}

/** Scores to 4 decimals, rounded down like `pct`. */
const round = (key: string, v: unknown) =>
  typeof v === "number" && /^(score|alignedScore|mean)$/.test(key) ? floor4(v) : v;

export function writeResults(results: RouteResult[], meta: RunMeta, outDir: string): string {
  const compared = results.filter((r): r is ComparedResult => r.status === "compared");
  const { mean, worst } = compared.length ? stats(compared) : { mean: null, worst: null };
  const out: Results = {
    meta,
    results,
    summary: {
      compared: compared.length,
      errors: results.length - compared.length,
      mean,
      worst: worst && { url: worst.url, width: worst.width, score: worst.score },
      belowThreshold:
        meta.threshold === null ? 0 : compared.filter((r) => r.score < meta.threshold!).length,
    },
  };
  const rows = results.map((r) => `    ${JSON.stringify(r, round)}`).join(",\n");
  // One record per line: greppable, and a reader can pull one route without parsing the rest.
  const json = JSON.stringify({ ...out, results: [] }, round, 2).replace(
    '"results": []',
    // A function, so a `$` in a route or text line isn't read as a replacement pattern.
    () => (rows ? `"results": [\n${rows}\n  ]` : '"results": []'),
  );
  const file = path.join(outDir, "results.json");
  fs.writeFileSync(file, json + "\n");
  return file;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Green above 99.5%, amber to 97%, red below. Tuned to be read, not to be precise. */

const band = (score: number) => (score >= 0.995 ? "good" : score >= 0.97 ? "warn" : "bad");

function section(rows: ComparedResult[]): string {
  if (!rows.length) return "";
  const { sorted, mean, worst } = stats(rows);

  return `
<section>
  <p class="agg">mean <b class="${band(mean)}">${pct(mean)}</b> &middot;
     worst <b class="${band(worst.score)}">${pct(worst.score)}</b>
     (${esc(name(worst))} @${worst.width}) &middot; ${sorted.length} comparison(s)</p>
  ${sorted.map(card).join("\n")}
</section>`;
}

/** Cap on regions and text lines listed per card; the counts are always full. */
const LIST_CAP = 5;
const TEXT_CAP = 20;

function findings(r: ComparedResult): string {
  const items: string[] = [];
  if (r.regions.length) {
    items.push(
      `<p>${r.regions.length} region(s)</p><ul class="regions">${r.regions
        .slice(0, LIST_CAP)
        .map((g) => `<li>${fmtRegion(g)} — ${g.pixels.toLocaleString("en-US")} px</li>`)
        .join("")}</ul>`,
    );
  }
  if (r.crops.length) {
    items.push(
      `<div class="crops">${r.crops
        .map(
          (c) =>
            `<a class="crop" href="${c.path}" target="_blank" title="${c.kind}, left ${c.layout === "stacked" ? "on top" : "on the left"}"><img loading="lazy" src="${c.path}"></a>`,
        )
        .join("")}</div>`,
    );
  }
  if (r.bands?.length) {
    items.push(
      `<ul class="bands">${r.bands.map((b) => `<li>band ${fmtBand(b)}</li>`).join("")}</ul>`,
    );
  }
  const { added, removed } = r.text;
  if (added.length || removed.length) {
    const lines = [
      ...added.map((t) => `<li class="add">+ ${esc(t)}</li>`),
      ...removed.map((t) => `<li class="del">- ${esc(t)}</li>`),
    ];
    items.push(
      `<p>text: ${added.length} added, ${removed.length} removed</p>` +
        `<ul class="text">${lines.slice(0, TEXT_CAP).join("")}</ul>`,
    );
  }
  return items.length ? `<div class="findings">${items.join("")}</div>` : "";
}

function card(r: ComparedResult): string {
  const imgs = r.images;
  return `
<article class="card">
  <header>
    <span class="score ${band(r.score)}">${pct(r.score)}</span>
    <code>${esc(name(r))}</code>
    <span class="w">@${r.width}px</span>
    ${r.hook ? `<span class="hook">before hook</span>` : ""}
    ${r.heightDelta ? `<span class="delta">height ${signed(r.heightDelta)}px</span>` : ""}
    ${r.widthDelta ? `<span class="delta">width ${signed(r.widthDelta)}px</span>` : ""}
    ${r.unstablePixels ? `<span class="unstable">${r.unstablePixels.toLocaleString("en-US")} px unstable</span>` : ""}
    ${r.alignedScore !== null ? `<span class="aligned">aligned ${pct(r.alignedScore)}</span>` : ""}
    <span class="px">${r.diffPixels.toLocaleString()} / ${r.totalPixels.toLocaleString()} px differ</span>
  </header>
  ${findings(r)}
  <div class="grid">
    <figure><figcaption>left</figcaption><a href="${imgs.left}" target="_blank"><img loading="lazy" src="${imgs.left}"></a></figure>
    <figure><figcaption>right</figcaption><a href="${imgs.right}" target="_blank"><img loading="lazy" src="${imgs.right}"></a></figure>
    <figure><figcaption>diff</figcaption><a href="${imgs.diff}" target="_blank"><img loading="lazy" src="${imgs.diff}"></a></figure>
  </div>
</article>`;
}

export async function writeReport(
  results: RouteResult[],
  meta: RunMeta,
  cfg: ResolvedConfig,
): Promise<string> {
  const compared = results.filter((r): r is ComparedResult => r.status === "compared");
  const errors = results.filter((r): r is ErrorResult => r.status === "error");

  const html = `<!doctype html>
<meta charset="utf-8">
<title>Visual diff</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#1a1a1a; --mut:#666; --line:#e3e3e3; --card:#fafafa; }
  @media (prefers-color-scheme: dark) { :root { --bg:#16181c; --fg:#e8e8e8; --mut:#999; --line:#2c2f36; --card:#1c1f24; } }
  * { box-sizing: border-box }
  body { margin:0; padding:2rem; background:var(--bg); color:var(--fg);
         font:14px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif; }
  h1 { font-size:1.4rem; margin:0 0 .25rem }
  h2 { font-size:1.05rem; margin:2.5rem 0 .25rem }
  .meta { color:var(--mut); font-size:12px; margin:0 0 2rem }
  .meta code { color:var(--fg) }
  .blurb { color:var(--mut); margin:.25rem 0 .75rem; max-width:70ch }
  .agg { margin:.25rem 0 1rem }
  .good { color:#2e7d32 } .warn { color:#b58900 } .bad { color:#c62828 }
  .card { border:1px solid var(--line); border-radius:8px; background:var(--card);
          margin:0 0 1rem; padding:.75rem 1rem 1rem; }
  .card header { display:flex; align-items:center; gap:.75rem; flex-wrap:wrap; margin-bottom:.75rem }
  .score { font-weight:700; font-variant-numeric:tabular-nums; min-width:4.5rem }
  .w, .px, .delta, .unstable, .aligned, .hook { color:var(--mut); font-size:12px }
  .findings { font-size:12px; color:var(--mut); margin:0 0 .75rem }
  .findings p { margin:.25rem 0 0 }
  .findings ul { margin:.25rem 0; font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace }
  .crops { display:flex; flex-wrap:wrap; gap:.5rem; margin:.25rem 0 }
  .crops img { width:auto; max-width:100%; max-height:160px }
  .findings .add { color:#2e7d32 } .findings .del { color:#c62828 }
  .unstable { background:rgba(255,0,255,.12); padding:.1rem .4rem; border-radius:4px }
  .delta { background:rgba(181,137,0,.15); padding:.1rem .4rem; border-radius:4px }
  .grid { display:grid; grid-template-columns:repeat(3,1fr); gap:.75rem }
  @media (max-width:900px) { .grid { grid-template-columns:1fr } }
  figure { margin:0 }
  figcaption { color:var(--mut); font-size:11px; text-transform:uppercase;
               letter-spacing:.05em; margin-bottom:.35rem }
  img { width:100%; height:auto; border:1px solid var(--line); border-radius:4px;
        background:#fff; display:block }
  code { font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace }
  details { margin:1rem 0; color:var(--mut) }
  ul { margin:.5rem 0; padding-left:1.25rem }
</style>

<h1>Visual diff</h1>
<p class="meta">
  left <code>${esc(meta.left)}</code> vs right <code>${esc(meta.right)}</code><br>
  ${esc(meta.generatedAt)} &middot; ${esc(meta.browser.name)} ${esc(meta.browser.version)}${(
    ["left", "right"] as const
  )
    .filter((s) => meta.storageState[s])
    .map((s) => ` &middot; ${s} storage state <code>${esc(meta.storageState[s]!)}</code>`)
    .join("")}
</p>

${section(compared)}

${
  errors.length
    ? `<section><h2 class="bad">Errors</h2>
<p class="blurb">These produced no measurement, so they are neither a pass nor a fail.</p>
<ul>${errors.map((r) => `<li><code>${esc(name(r))}</code> @${r.width}px — ${esc(r.error)}</li>`).join("")}</ul></section>`
    : ""
}

<details>
  <summary>What was neutralized</summary>
  <p>Blocked on both sides — analytics, consent, and A/B tooling that would otherwise
     rewrite the DOM differently on each load:</p>
  <ul>${cfg.blockUrlPatterns.map((p) => `<li><code>${esc(p)}</code></li>`).join("")}</ul>
  <p>Masked, because they drift — painted over on both sides, so they can neither pass
     nor fail:</p>
  ${
    cfg.masks.length
      ? `<ul>${cfg.masks.map((m) => `<li>${esc(m.reason)}</li>`).join("")}</ul>`
      : `<p><em>None configured.</em></p>`
  }
  <p>Pinned on both sides: clock starts at <code>${esc(meta.clock)}</code> on every load, a seeded
     <code>Math.random</code>, timezone <code>${CONTEXT_OPTIONS.timezoneId}</code>, locale
     <code>${CONTEXT_OPTIONS.locale}</code>, <code>${CONTEXT_OPTIONS.colorScheme}</code> colour
     scheme, reduced motion, CSS animations and transitions off, videos paused at frame 0.</p>
  <p>Unstable pixels — ones that changed between two shots of the same load — are painted
     magenta on both sides, counted on each card, and excluded from the measurement. A route
     more than 25% unstable is an error.</p>
  <p>Magenta is also padding where one page is taller or wider than the other. It counts
     against the score on purpose — see the height delta on the row.</p>
</details>
`;

  fs.mkdirSync(cfg.outDir, { recursive: true });
  const out = path.join(cfg.outDir, "report.html");
  fs.writeFileSync(out, html);
  return out;
}
