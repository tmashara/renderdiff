import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { Accepted } from "./accept.ts";
import {
  addAt,
  fmtAt,
  fmtComputed,
  groupFindings,
  SHOWN,
  type ComputedDiff,
  type Finding,
} from "./computed.ts";
import type { Band, Box, Region, TextDiff } from "./compare.ts";
import { CONTEXT_OPTIONS, name, type Sides } from "./config.ts";
import type { ElementDiff } from "./locate.ts";
import {
  floor4,
  fmtBand,
  fmtElements,
  fmtFailed,
  fmtLine,
  fmtRegion,
  pct,
  signed,
} from "./format.ts";

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
  /** Regions where a second, fresh load of the right side differed from the first. Absent when none did or it wasn't rechecked. */
  varies?: Region[];
  /** Pixels painted out for them on both sides, like unstable ones, and left out of the score. */
  variesPixels?: number;
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
  /** Every band and region matched an accepted one, and no padding or unstable pixel went unmatched. */
  accepted: boolean;
  /** Stylesheets and font faces that failed to load per side, e.g. `font Inter 700`. */
  failed: { left: string[]; right: string[] };
  /** With `--cache-right`: when the recording the right side was replayed from was made, ISO. */
  rightReplayedFrom?: string;
  /** With `--computed`: the computed-style diff; null when the snapshot failed, with `computedError` saying why. */
  computed?: ComputedDiff | null;
  computedError?: string;
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
  /**
   * The instant both sides' clocks start at on every load of this run, ISO. A `--rerun-failed`
   * shot reused from an earlier run was taken under that run's clock.
   */
  clock: string;
  blockUrlPatterns: string[];
  hideSelectors: string[];
  /** `urlPath` is absent for a mask that applies to every route. */
  masks: { urlPath?: string; reason: string }[];
  /** `chromium` (bundled), or `chrome` when that failed to launch and the system Chrome did. */
  browser: { name: string; version: string };
  /** The storage state file's basename per side, or null. Never its contents. */
  storageState: { left: string | null; right: string | null };
  /** A hash of everything that decides how a shot is taken; `--rerun-failed` needs it unchanged. */
  config: string;
  /** The oldest `rightReplayedFrom` among the results, or null when every right side loaded live. */
  rightReplayedFrom: string | null;
  freezeVideo: boolean;
  /** `process.platform` of the run; accepted entries and pixels are OS-specific. */
  platform: string;
  /** With `--rerun-failed`: shots rerun and shots reused from the previous run; else null. */
  rerun: { rerun: number; reused: number } | null;
}

export interface Summary {
  compared: number;
  errors: number;
  /** Null when nothing was compared. */
  mean: number | null;
  worst: { url: string; width: number; score: number } | null;
  /** Comparisons under `meta.threshold`, accepted ones aside; 0 when no threshold was set. */
  belowThreshold: number;
  /** Comparisons with any differing pixel, accepted ones aside. Without a threshold, any exits 1. */
  differing: number;
  /** Comparisons whose every difference was accepted. */
  accepted: number;
  /** Accepted differences for a measured route and width that weren't seen: prune them. */
  stale: Accepted[];
  /** Each pixel finding seen on two or more routes, once, with the routes and widths it was seen at. */
  findings: PixelFinding[];
  /** With `--computed`: each style change once, with the routes and widths it was seen at. */
  computed?: Finding[];
}

/** An element change, text line or element-less band delta, as the summary prints it. */
export interface PixelFinding {
  finding: string;
  selector?: string;
  at: Finding["at"];
}

/** The shape of `results.json`, written to the out dir on every run. */
export interface Results {
  meta: RunMeta;
  results: RouteResult[];
  summary: Summary;
}

/** Unaccepted findings that repeat on two or more routes, most widespread first. */
export function pixelFindings(results: RouteResult[]): PixelFinding[] {
  const out = new Map<string, PixelFinding>();
  for (const r of results) {
    if (r.status !== "compared" || r.accepted) continue;
    const tokens = new Map<string, string | undefined>();
    for (const g of [...(r.bands ?? []), ...r.regions]) {
      if (g.accepted) continue;
      for (const e of g.elements ?? []) tokens.set(fmtElements([e]), e.selector);
      if ("side" in g && !g.elements?.length)
        tokens.set(`band ${g.side === "left" ? "+" : "-"}${g.h}px`, undefined);
    }
    for (const t of r.text.added) tokens.set(`+"${t}"`, undefined);
    for (const t of r.text.removed) tokens.set(`-"${t}"`, undefined);
    for (const [finding, selector] of tokens) {
      const f = out.get(finding) ?? { finding, ...(selector ? { selector } : {}), at: [] };
      out.set(finding, f);
      addAt(f.at, r);
    }
  }
  const shots = (f: PixelFinding) => f.at.reduce((n, a) => n + a.widths.length, 0);
  return [...out.values()]
    .filter((f) => f.at.length >= 2)
    .sort(
      (a, b) =>
        b.at.length - a.at.length || shots(b) - shots(a) || a.finding.localeCompare(b.finding),
    );
}

/** The console block: one line per repeated finding, then where it was seen. */
export function fmtPixelFindings(results: RouteResult[]): string[] {
  const findings = pixelFindings(results);
  if (!findings.length) return [];
  const out = [`findings: ${findings.length} repeated on 2+ routes`];
  for (const f of findings.slice(0, SHOWN))
    out.push(`  ${f.finding}  ×${f.at.length} routes  ${fmtAt(f.at)}`);
  if (findings.length > SHOWN) out.push(`  (+${findings.length - SHOWN} more in results.json)`);
  return out;
}

/** Sort ascending by score; surface the mean and the worst (lowest-scoring) row. */
export function stats(rows: ComparedResult[]) {
  const sorted = [...rows].sort((a, b) => a.score - b.score);
  const mean = sorted.reduce((s, r) => s + r.score, 0) / sorted.length;
  return { sorted, mean, worst: sorted[0]! };
}

/** A shot that exits 1: unaccepted and differing, or with a threshold, scoring below it. */
export const fails = (r: RouteResult, threshold: number | null) =>
  r.status === "compared" &&
  !r.accepted &&
  (threshold === null ? r.diffPixels > 0 : r.score < threshold);

const VERDICTS = ["good", "warn", "bad"] as const;

/** Red: fails or errored. Amber: differs, but not enough to fail. Green: identical or accepted. */
export function verdict(r: RouteResult, threshold: number | null): (typeof VERDICTS)[number] {
  if (r.status === "error" || fails(r, threshold)) return "bad";
  return r.accepted || r.diffPixels === 0 ? "good" : "warn";
}

/** Scores to 4 decimals, rounded down like `pct`. */
const round = (key: string, v: unknown) =>
  typeof v === "number" && /^(score|alignedScore|mean)$/.test(key) ? floor4(v) : v;

export function writeResults(
  results: RouteResult[],
  meta: RunMeta,
  outDir: string,
  stale: Accepted[],
): string {
  const compared = results.filter((r): r is ComparedResult => r.status === "compared");
  const open = compared.filter((r) => !r.accepted);
  const { mean, worst } = open.length ? stats(open) : { mean: null, worst: null };
  const out: Results = {
    meta,
    results,
    summary: {
      compared: compared.length,
      errors: results.length - compared.length,
      mean,
      worst: worst && { url: worst.url, width: worst.width, score: worst.score },
      belowThreshold:
        meta.threshold === null
          ? 0
          : compared.filter((r) => !r.accepted && r.score < meta.threshold!).length,
      differing: open.filter((r) => r.diffPixels > 0).length,
      accepted: compared.filter((r) => r.accepted).length,
      stale,
      findings: pixelFindings(results),
      ...(compared.some((r) => "computed" in r) ? { computed: groupFindings(results) } : {}),
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

/** The shot's file stem, `{slug}.{width}`: unique per route and width. */
const cardId = (r: ComparedResult) => r.images.left.replace(/\.left\.png$/, "");

const href = (r: RouteResult) => (r.status === "compared" ? `#${esc(cardId(r))}` : "#errors");

const shotLink = (r: RouteResult, threshold: number | null) =>
  `<a class="${verdict(r, threshold)}" href="${href(r)}" title="${r.status === "error" ? esc(r.error) : pct(r.score)}">${r.width}</a>`;

function sidebar(results: RouteResult[], threshold: number | null): string {
  const routes = Map.groupBy(results, name);
  const items = [...routes].map(([rt, shots]) => {
    const worst = VERDICTS[Math.max(...shots.map((r) => VERDICTS.indexOf(verdict(r, threshold))))];
    return `<li data-route="${esc(rt.toLowerCase())}"><a class="rt ${worst}" href="${href(shots.find((r) => r.status === "compared") ?? shots[0]!)}">${esc(rt)}</a>
  <span class="ws">${shots.map((r) => shotLink(r, threshold)).join("")}</span></li>`;
  });
  return `<nav class="side">
<input id="q" type="search" aria-label="Filter routes" placeholder="Filter ${routes.size} route(s)" autocomplete="off">
<ul id="routes">
${items.join("\n")}
</ul>
</nav>
<script>
  const q = document.getElementById("q");
  q.oninput = () => {
    const v = q.value.trim().toLowerCase();
    for (const li of document.querySelectorAll("#routes li")) li.hidden = !li.dataset.route.includes(v);
  };
</script>`;
}

function summary(results: RouteResult[], meta: RunMeta, stale: Accepted[]): string {
  const compared = results.filter((r): r is ComparedResult => r.status === "compared");
  const open = compared.filter((r) => !r.accepted);
  const differing = open.filter((r) => r.diffPixels > 0);
  const errors = results.length - compared.length;
  const agg = open.length ? stats(open) : null;
  const count = (n: number, what: string, cls = "") =>
    `<span${n && cls ? ` class="${cls}"` : ""}><b>${n}</b> ${what}</span>`;
  // Worst shot first, so the routes come out ordered by their worst shot.
  const byRoute = Map.groupBy(stats(differing).sorted, name);
  const routes = [...new Set(results.map(name))];
  const computed = fmtComputed(results, routes);
  const repeated = fmtPixelFindings(results);
  return `<section class="summary">
<p class="counts">
  ${count(routes.length, "route(s)")}
  ${count(results.length, `shot(s) at ${meta.widths.join(", ")}px`)}
  ${count(differing.length, "differ", differing.some((r) => fails(r, meta.threshold)) ? "bad" : "warn")}
  ${errors ? `<a href="#errors">${count(errors, "error(s)", "bad")}</a>` : count(0, "error(s)")}
  ${count(compared.length - open.length, "accepted")}
  ${count(stale.length, "stale accepted", "warn")}
</p>
${
  agg
    ? `<p>mean <b class="${band(agg.mean)}">${pct(agg.mean)}</b> &middot;
  worst <b class="${band(agg.worst.score)}">${pct(agg.worst.score)}</b>
  <a href="#${esc(cardId(agg.worst))}">${esc(name(agg.worst))} @${agg.worst.width}</a></p>`
    : ""
}
${
  differing.length
    ? `<ul class="differs">${[...byRoute]
        .map(
          ([rt, shots]) =>
            `<li><code>${esc(rt)}</code> ${shots
              .map((r) => `${shotLink(r, meta.threshold)} <span class="w">${pct(r.score)}</span>`)
              .join(" ")}</li>`,
        )
        .join("\n")}</ul>`
    : `<p class="good">No differing shots.</p>`
}
${
  repeated.length
    ? `<details><summary>Findings: ${repeated[0]!.slice("findings: ".length)}</summary>
<pre class="computed">${esc(repeated.slice(1).join("\n"))}</pre></details>`
    : ""
}
${
  computed.length
    ? `<details><summary>Computed styles: ${groupFindings(results).length} finding(s)</summary>
<pre class="computed">${esc(computed.join("\n"))}</pre></details>`
    : ""
}
</section>`;
}

/** Cap on regions and text lines listed per card; the counts are always full. */
const LIST_CAP = 5;
const TEXT_CAP = 20;

const dom = (els: ElementDiff[] | undefined) =>
  els?.length ? `<span class="dom"> — ${esc(fmtElements(els))}</span>` : "";

const cropLink = (c: CropResult) =>
  `<a class="crop" href="${esc(c.path)}" target="_blank" title="${c.kind}, left ${c.layout === "stacked" ? "on top" : "on the left"}"><img loading="lazy" src="${esc(c.path)}"></a>`;

function findings(r: ComparedResult, crop = cropLink): string {
  const items: string[] = [];
  const failed = fmtFailed(r.failed);
  if (failed) items.push(`<p class="failed">failed to load: ${esc(failed)}</p>`);
  if (r.regions.length) {
    items.push(
      `<p>${r.regions.length} region(s)</p><ul class="regions">${r.regions
        .slice(0, LIST_CAP)
        .map(
          (g) =>
            `<li>${fmtRegion(g)} — ${g.pixels.toLocaleString("en-US")} px${g.line ? `, ${fmtLine(g.line)}` : ""}${dom(g.elements)}</li>`,
        )
        .join("")}</ul>`,
    );
  }
  if (r.crops.length) {
    items.push(`<div class="crops">${r.crops.map(crop).join("")}</div>`);
  }
  if (r.bands?.length) {
    items.push(
      `<ul class="bands">${r.bands.map((b) => `<li>band ${fmtBand(b)}${dom(b.elements)}</li>`).join("")}</ul>`,
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

const reasons = (r: ComparedResult) =>
  [
    ...new Set([...(r.bands ?? []), ...r.regions].flatMap((g) => (g.accepted ? [g.accepted] : []))),
  ].join("; ");

const head = (r: ComparedResult) => `
  <header>
    <span class="score ${band(r.score)}">${pct(r.score)}</span>
    <code>${esc(name(r))}</code>
    <span class="w">@${r.width}px</span>
    ${r.hook ? `<span class="hook">before hook</span>` : ""}
    ${r.accepted ? `<span class="accepted">accepted: ${esc(reasons(r))}</span>` : ""}
    ${r.heightDelta ? `<span class="delta">height ${signed(r.heightDelta)}px</span>` : ""}
    ${r.widthDelta ? `<span class="delta">width ${signed(r.widthDelta)}px</span>` : ""}
    ${r.unstablePixels ? `<span class="unstable">${r.unstablePixels.toLocaleString("en-US")} px unstable</span>` : ""}
    ${r.variesPixels ? `<span class="unstable">${r.variesPixels.toLocaleString("en-US")} px vary per load</span>` : ""}
    ${r.alignedScore !== null ? `<span class="aligned">aligned ${pct(r.alignedScore)}</span>` : ""}
    ${r.computed ? `<span class="w">${r.computed.dom ? `dom differs (${r.computed.dom})` : "dom identical"}</span>` : ""}
    <span class="px">${r.diffPixels.toLocaleString()} / ${r.totalPixels.toLocaleString()} px differ</span>
  </header>`;

function card(r: ComparedResult): string {
  const imgs = r.images;
  return `
<article class="card" id="${esc(cardId(r))}">${head(r)}
  ${findings(r)}
  <div class="grid">
    <figure><figcaption>left</figcaption><a href="${imgs.left}" target="_blank"><img loading="lazy" src="${imgs.left}"></a></figure>
    <figure><figcaption>right</figcaption><a href="${imgs.right}" target="_blank"><img loading="lazy" src="${imgs.right}"></a></figure>
    <figure><figcaption>diff</figcaption><a href="${imgs.diff}" target="_blank"><img loading="lazy" src="${imgs.diff}"></a></figure>
  </div>
</article>`;
}

const STYLE = `<style>
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
  .w, .px, .delta, .unstable, .aligned, .hook, .accepted { color:var(--mut); font-size:12px }
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
</style>`;

const REPORT_STYLE = `<style>
  body { padding:0; display:grid; grid-template-columns:260px minmax(0,1fr) }
  main { padding:2rem; min-width:0 }
  .side { position:sticky; top:0; height:100vh; overflow:auto; padding:1rem;
          border-right:1px solid var(--line); font-size:12px }
  .side input { width:100%; padding:.35rem .5rem; margin-bottom:.5rem; font:inherit; color:var(--fg);
                background:var(--card); border:1px solid var(--line); border-radius:4px }
  .side ul { list-style:none; padding:0; margin:0 }
  .side li { padding:.3rem 0; border-bottom:1px solid var(--line) }
  .side .rt { display:block; overflow-wrap:anywhere; text-decoration:none;
              font-family:ui-monospace,SFMono-Regular,Menlo,monospace }
  .ws a, .differs a { margin-right:.4rem; font-variant-numeric:tabular-nums }
  .summary .counts { display:flex; flex-wrap:wrap; gap:1rem; font-size:15px; margin:0 0 .5rem }
  .summary .counts a { color:inherit }
  .summary .differs { font-size:13px; padding-left:0; list-style:none }
  .card { scroll-margin-top:1rem }
  .card:target { outline:2px solid #509ee3 }
  @media (max-width:900px) {
    body { display:block }
    .side { position:static; height:auto; max-height:40vh; border-right:0; border-bottom:1px solid var(--line) }
  }
</style>`;

function computedSection(results: RouteResult[]): string {
  const lines = fmtComputed(results, [...new Set(results.map(name))]);
  return lines.length
    ? `<section><h2>Computed styles</h2><pre class="computed">${esc(lines.join("\n"))}</pre></section>`
    : "";
}

const listed = (errors: ErrorResult[], stale: Accepted[]) =>
  (errors.length
    ? `<section id="errors"><h2 class="bad">Errors</h2>
<p class="blurb">These produced no measurement, so they are neither a pass nor a fail.</p>
<ul>${errors.map((r) => `<li><code>${esc(name(r))}</code> @${r.width}px — ${esc(r.error)}</li>`).join("")}</ul></section>`
    : "") +
  (stale.length
    ? `<section><h2>Stale accepted differences</h2>
<p class="blurb">Accepted, but not seen on this run: prune them from the accepted file.</p>
<ul>${stale.map((a) => `<li><code>${esc(a.route)}</code> @${a.width}px — ${esc(a.reason)}</li>`).join("")}</ul></section>`
    : "");

const neutralized = (meta: RunMeta) => `<details>
  <summary>What was neutralized</summary>
  <p>Blocked on both sides — analytics, consent, and A/B tooling that would otherwise
     rewrite the DOM differently on each load:</p>
  <ul>${meta.blockUrlPatterns.map((p) => `<li><code>${esc(p)}</code></li>`).join("")}</ul>
  <p>Masked, because they drift — painted over on both sides, so they can neither pass
     nor fail:</p>
  ${
    meta.masks.length
      ? `<ul>${meta.masks.map((m) => `<li>${esc(m.reason)}</li>`).join("")}</ul>`
      : `<p><em>None configured.</em></p>`
  }
  <p>Pinned on both sides: clock starts at <code>${esc(meta.clock)}</code> on every load, a seeded
     <code>Math.random</code>, timezone <code>${CONTEXT_OPTIONS.timezoneId}</code>, locale
     <code>${CONTEXT_OPTIONS.locale}</code>, <code>${CONTEXT_OPTIONS.colorScheme}</code> colour
     scheme, reduced motion, CSS animations and transitions off, animated images and SVG animations held on their
     first frame${
       meta.freezeVideo ? ", videos kept from playing with video.js overlays hidden" : ""
     }.</p>
  <p>Unstable pixels — ones that changed between two shots of the same load — are painted
     magenta on both sides, counted on each card, and excluded from the measurement. A route
     more than 25% unstable is an error.</p>
  <p>Magenta is also padding where one page is taller or wider than the other. It counts
     against the score on purpose — see the height delta on the row.</p>
</details>`;

export async function writeReport(
  results: RouteResult[],
  meta: RunMeta,
  outDir: string,
  stale: Accepted[],
): Promise<string> {
  const compared = results.filter((r): r is ComparedResult => r.status === "compared");
  const errors = results.filter((r): r is ErrorResult => r.status === "error");

  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>Visual diff</title>
${STYLE}
${REPORT_STYLE}
<body>
${sidebar(results, meta.threshold)}
<main>
<h1>Visual diff</h1>
<p class="meta">
  left <code>${esc(meta.left)}</code> vs right <code>${esc(meta.right)}</code><br>
  ${esc(meta.generatedAt)} &middot; ${esc(meta.browser.name)} ${esc(meta.browser.version)}${(
    ["left", "right"] as const
  )
    .filter((s) => meta.storageState[s])
    .map((s) => ` &middot; ${s} storage state <code>${esc(meta.storageState[s]!)}</code>`)
    .join("")}
  ${meta.rightReplayedFrom ? `&middot; right replayed from a recording of <code>${esc(meta.rightReplayedFrom)}</code>` : ""}
</p>

${summary(results, meta, stale)}

${stats(compared).sorted.map(card).join("\n")}

${listed(errors, stale)}

${neutralized(meta)}
</main>
`;

  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, "report.html");
  fs.writeFileSync(out, html);
  return out;
}

// ponytail: hard 12MB ceiling on embedded crops (base64) to fit a 16MB Artifact; split files if runs hit it.
const EVIDENCE_BUDGET = 12_000_000;

/** One self-contained page for a ticket: the verdict, the banner and the non-clean shots' crops. */
export async function writeEvidence(
  { meta, results, summary }: Results,
  outDir: string,
  verdict: string | null,
  title = "Visual parity evidence",
): Promise<string> {
  // Lazy, so importing the package's types never loads Playwright.
  const { compact, reusable } = await import("./run.ts");
  const routes = [...new Set(results.map(name))];
  const compared = results.filter((r): r is ComparedResult => r.status === "compared");
  const errors = results.filter((r): r is ErrorResult => r.status === "error");
  const byScore = (a: ComparedResult, b: ComparedResult) => a.score - b.score;
  const cards = compared.filter((r) => !reusable(r)).sort(byScore);
  const acceptedCards = compared.filter((r) => r.accepted).sort(byScore);

  const worst = new Map<string, CropResult>();
  for (const r of cards) if (r.crops[0] && !worst.has(name(r))) worst.set(name(r), r.crops[0]);
  const embedded = new Map<CropResult, string>();
  let used = 0;
  let omitted = 0;
  const all = [...worst.values(), ...[...cards, ...acceptedCards].flatMap((r) => r.crops)];
  for (const c of new Set(all)) {
    let webp: Buffer;
    try {
      webp = await sharp(path.join(outDir, c.path))
        .resize({ width: 1000, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
    } catch {
      omitted++;
      continue;
    }
    const uri = `data:image/webp;base64,${webp.toString("base64")}`;
    if (used + uri.length > EVIDENCE_BUDGET) {
      omitted++;
      continue;
    }
    used += uri.length;
    embedded.set(c, uri);
  }
  const crop = (c: CropResult) =>
    embedded.has(c)
      ? `<img src="${embedded.get(c)}" title="${c.kind}, left ${c.layout === "stacked" ? "on top" : "on the left"}">`
      : `<p class="omitted">crop omitted</p>`;

  const open = compared.filter((r) => !r.accepted);
  const count = (n: number, what: string) => (n ? [`${n} ${what}`] : []);
  const notes = [
    ...count(errors.length, "error(s)"),
    ...count(open.filter((r) => r.unstablePixels).length, "shot(s) with unstable pixels"),
    ...count(open.filter((r) => r.varies).length, "shot(s) vary per load (painted out)"),
    ...count(open.filter((r) => fmtFailed(r.failed)).length, "shot(s) with failed assets"),
    ...count(
      open.filter((r) => r.diffPixels > 0 && !fails(r, meta.threshold)).length,
      "shot(s) differ under threshold",
    ),
    ...count(meta.rerun?.reused ?? 0, "shot(s) reused by --rerun-failed"),
    ...count(omitted, "crop(s) omitted (over the size budget or missing)"),
  ];
  const [cls, label] = compared.some((r) => fails(r, meta.threshold))
    ? ["bad", "Differs"]
    : !results.length || meta.rerun?.reused || !results.every(reusable)
      ? ["warn", "Not verified"]
      : ["good", "Parity"];

  const shots = (route: string) => results.filter((r) => name(r) === route);
  const clean = routes.filter((rt) =>
    shots(rt).every((r) => r.status === "compared" && !r.accepted && reusable(r)),
  );
  const accepted = routes.filter((rt) => !clean.includes(rt) && shots(rt).every(reusable));
  const why = (rt: string) =>
    [...new Set(compared.filter((r) => name(r) === rt && r.accepted).map(reasons))].join("; ");

  const html = `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${esc(title)}</title>
${STYLE}
<style>
  .banner { font-size:1.2rem; font-weight:700; padding:.6rem 1rem; border-radius:8px;
            border:2px solid currentColor; margin:0 0 .5rem }
  .verdict { white-space:pre-wrap; border-left:3px solid var(--line); padding-left:1rem }
  .crops img { max-height:none }
  .omitted { font-style:italic }
</style>

<h1>${esc(title)}</h1>
<p class="meta">
  left <code>${esc(meta.left)}</code> vs right <code>${esc(meta.right)}</code><br>
  ${esc(meta.generatedAt)} &middot; renderdiff ${esc(meta.version)} &middot;
  widths ${meta.widths.join(", ")} &middot;
  threshold ${meta.threshold === null ? "none" : pct(meta.threshold)} &middot;
  ${esc(meta.platform ?? "unknown platform")} &middot; ${esc(meta.browser.name)} ${esc(meta.browser.version)}
</p>

<div class="banner ${cls}">${label}</div>
${notes.length ? `<p class="blurb">${esc(notes.join(" · "))}</p>` : ""}
<p><code>${esc(compact(results, routes, "results.json", meta.threshold).split("\n").at(-1)!)}</code></p>

<section><h2>Verdict</h2>
${verdict?.trim() ? `<div class="verdict">${esc(verdict.trim())}</div>` : `<p class="blurb"><em>No verdict attached.</em></p>`}
</section>

<section><h2>Coverage</h2>
<details><summary>${clean.length} clean route(s)</summary>
<ul>${clean.map((rt) => `<li><code>${esc(rt)}</code></li>`).join("")}</ul></details>
${
  accepted.length
    ? `<p>Accepted:</p><ul>${accepted.map((rt) => `<li><code>${esc(rt)}</code> — ${esc(why(rt))}</li>`).join("")}</ul>`
    : ""
}
</section>

${listed(errors, summary.stale)}

${computedSection(results)}

${
  cards.length
    ? `<section><h2>Not clean</h2>${cards
        .map((r) => `<article class="card">${head(r)}${findings(r, crop)}</article>`)
        .join("\n")}</section>`
    : ""
}

${
  acceptedCards.length
    ? `<section><h2>Accepted</h2>${acceptedCards
        .map((r) => `<article class="card">${head(r)}${findings(r, crop)}</article>`)
        .join("\n")}</section>`
    : ""
}

${neutralized(meta)}
`;

  const out = path.join(outDir, "evidence.html");
  fs.writeFileSync(out, html);
  if (Buffer.byteLength(html) > 16 * 1024 * 1024) {
    console.warn("evidence.html is over 16 MB: too big to publish as an Artifact");
  }
  return out;
}
