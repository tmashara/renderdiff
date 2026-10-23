/**
 * The only module that knows renderdiff's output formats.
 *
 * A black-box suite has to read results back out of what the tool produces: the compact
 * summary on stdout (what a pipe gets), the `--progress` lines, `report.html` and
 * `results.json`. That coupling is real, so it lives in
 * exactly one file — if `run.ts`'s log line or `report.ts`'s markup changes, this is the only
 * place that needs fixing.
 *
 * Metrics come from `results.json`. stdout is parsed only to pin its own formats: the compact
 * summary and, with `--progress`, one line per comparison. The report is parsed only for claims that are specific to
 * the report: pixel counts, image filenames, the listed regions and text lines, the Errors
 * section, and the "What was neutralized" disclosure. `results.json` is read as-is, typed by
 * the contract `src/index.ts` exports (a type-only import, erased at runtime).
 */
import fs from "node:fs";
import path from "node:path";
import type { ComparedResult, Results } from "../../src/index.ts";

/** `results.json` from a run's out dir. */
export function results(outDir: string): Results {
  return JSON.parse(fs.readFileSync(path.join(outDir, "results.json"), "utf8"));
}

/**
 * The compared entry for one comparison in `results.json`; `selector` picks among routes listed
 * once per selector, by its left side. Throws with context when absent.
 */
export function result(
  res: Results,
  route: string,
  width: number,
  selector?: string,
): ComparedResult {
  const found = res.results.find(
    (r) => r.url === route && r.width === width && (!selector || r.selector?.left === selector),
  );
  if (found?.status !== "compared") {
    const seen = res.results.map((r) => `${r.url}@${r.width}:${r.status}`).join(", ") || "(none)";
    throw new Error(`no compared result for ${route}@${width}; saw: ${seen}`);
  }
  return found;
}

export interface Summary {
  /** Routes on the `clean:` line; a selector route is `/a [sel]`, as is its key in `routes`. */
  clean: string[];
  /** Routes on the `accepted:` line: every width clean or accepted. */
  accepted: string[];
  /** `route@width` of each stale accepted difference, from the `stale accepted:` line. */
  stale: string[];
  /** The `rerun:` line of a `--rerun-failed` run, else null. */
  rerun: { shots: number; routes: number; reused: number; untouched: number } | null;
  /** Each differing route: widths that were clean or accepted, then one row per collapsed width group. */
  routes: Map<
    string,
    {
      clean: number[];
      accepted: number[];
      rows: {
        widths: number[];
        text: string;
        failed: string | null;
        dom: string | null;
        crops: string[];
      }[];
      errors: { widths: number[]; message: string }[];
    }
  >;
  verdict: {
    differ: number;
    routes: number;
    shots: number;
    total: number;
    errors: number;
    /** Null when nothing was compared. */
    worst: { score: number; route: string; width: number } | null;
    /** Null unless a threshold was set. */
    below: { count: number; threshold: number } | null;
    results: string;
  };
}

const VERDICT =
  /^renderdiff: (\d+) of (\d+) routes differ \((\d+) of (\d+) shots\), (\d+) errors?(?:, worst ([\d.]+)% (.+?)@(\d+))?(?:, (\d+) below ([\d.]+)%)? — (.+)$/;

/** The compact summary printed when stdout is not a TTY. Throws when there is no verdict line. */
export function parseSummary(stdout: string): Summary {
  const lines = stdout.split("\n");
  const v = lines.map((l) => VERDICT.exec(l)).find(Boolean);
  if (!v) throw new Error(`no verdict line in:\n${stdout}`);
  // A selector can hold spaces, so a route ends where the next `/` starts or the line ends.
  const listed = (label: string) =>
    new RegExp(`^${label}: (.*)$`, "m").exec(stdout)?.[1]!.match(/\/\S*(?: \[.*?\])?(?= \/|$)/g) ??
    [];
  const stale = /^stale accepted: (.*) — .*$/m.exec(stdout)?.[1]!.split(" ") ?? [];
  const rerun =
    /^rerun: (\d+) shot\(s\) on (\d+) route\(s\), (\d+) reused, (\d+) route\(s\) untouched$/m.exec(
      stdout,
    );
  const routes: Summary["routes"] = new Map();
  let at: ReturnType<Summary["routes"]["get"]>;
  for (const line of lines) {
    let m;
    if ((m = /^(\/\S*(?: \[.*\])?)(?:  clean @([\d,]+))?(?:  accepted @([\d,]+))?$/.exec(line))) {
      at = {
        clean: m[2] ? m[2].split(",").map(Number) : [],
        accepted: m[3] ? m[3].split(",").map(Number) : [],
        rows: [],
        errors: [],
      };
      routes.set(m[1]!, at);
    } else if (at && (m = /^  @([\d,]+)  ERROR (.*)$/.exec(line))) {
      at.errors.push({ widths: m[1]!.split(",").map(Number), message: m[2]! });
    } else if (at && (m = /^  @([\d,]+)  (.*)$/.exec(line))) {
      at.rows.push({
        widths: m[1]!.split(",").map(Number),
        text: m[2]!,
        failed: null,
        dom: null,
        crops: [],
      });
    } else if (at?.rows.length && (m = /^    failed (.*)$/.exec(line))) {
      at.rows.at(-1)!.failed = m[1]!;
    } else if (at?.rows.length && (m = /^    dom (.*)$/.exec(line))) {
      at.rows.at(-1)!.dom = m[1]!;
    } else if (at?.rows.length && (m = /^    crops (.*)$/.exec(line))) {
      at.rows.at(-1)!.crops = m[1]!.split(" ");
    }
  }
  return {
    clean: listed("clean"),
    accepted: listed("accepted"),
    stale,
    rerun: rerun && {
      shots: Number(rerun[1]),
      routes: Number(rerun[2]),
      reused: Number(rerun[3]),
      untouched: Number(rerun[4]),
    },
    routes,
    verdict: {
      differ: Number(v[1]),
      routes: Number(v[2]),
      shots: Number(v[3]),
      total: Number(v[4]),
      errors: Number(v[5]),
      worst: v[6] ? { score: Number(v[6]) / 100, route: v[7]!, width: Number(v[8]) } : null,
      below: v[9] ? { count: Number(v[9]), threshold: Number(v[10]) / 100 } : null,
      results: v[11]!,
    },
  };
}

export interface ProgressRow {
  route: string;
  width: number;
  /** The detail line's `.card`, or `.a | .b`; null for a whole-page route. */
  selector: string | null;
  /** 0..1, or null for a route that errored. */
  score: number | null;
  /** left − right, in px. 0 when the badge was absent. */
  heightDelta: number;
  /** Pixels painted out as unstable. 0 when the badge was absent. */
  unstablePixels: number;
  /** Diff region count, and the largest region's box (null when there are none). */
  regions: number;
  largest: Box | null;
  /** `delta` is signed like `heightDelta`: + for rows only left has, − for rows only right has. */
  bands: { delta: number; y: number; side: "left" | "right" }[];
  /** Null when no aligned score was printed. */
  alignedScore: number | null;
  /** True when the rows were too different to align. */
  unaligned: boolean;
  added: number;
  removed: number;
  /** The `dom` detail line, or null. */
  dom: string | null;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** `  [2/15] 97.41%  /about @1440  (height -112px)  (unstable 1,024px)` — or `ERROR` in place of the score. */
const PROGRESS =
  /^\s*\[\d+\/\d+\]\s+(ERROR|[\d.]+%)\s+(\S+)\s+@(\d+)(?:\s+\(height ([+-]?\d+)px\))?(?:\s+\(unstable ([\d,]+)px\))?\s*$/;

/** Indented detail lines under a progress row, e.g. `        3 regions, largest 412×88 at (0,1240)`. */
const REGIONS = /^\s+(\d+) regions?, largest (\d+)×(\d+) at \((\d+),(\d+)\)$/;
const BAND = /^\s+band ([+-]\d+)px at y=(\d+) \((left|right)\)$/;
const ALIGNED = /^\s+aligned ([\d.]+)%$/;
const TEXT = /^\s+text: (\d+) added, (\d+) removed$/;
const SELECTOR = /^\s+selector (.+)$/;

export function parseProgress(stdout: string): ProgressRow[] {
  const rows: ProgressRow[] = [];
  for (const line of stdout.split("\n")) {
    const m = PROGRESS.exec(line);
    if (m) {
      rows.push({
        route: m[2]!,
        width: Number(m[3]),
        selector: null,
        score: m[1] === "ERROR" ? null : Number(m[1]!.slice(0, -1)) / 100,
        heightDelta: m[4] ? Number(m[4]) : 0,
        unstablePixels: m[5] ? num(m[5]) : 0,
        regions: 0,
        largest: null,
        bands: [],
        alignedScore: null,
        unaligned: false,
        added: 0,
        removed: 0,
        dom: null,
      });
      continue;
    }
    const last = rows.at(-1);
    if (!last) continue;
    let d;
    if ((d = SELECTOR.exec(line))) {
      last.selector = d[1]!;
    } else if ((d = REGIONS.exec(line))) {
      last.regions = Number(d[1]);
      last.largest = { w: Number(d[2]), h: Number(d[3]), x: Number(d[4]), y: Number(d[5]) };
    } else if ((d = BAND.exec(line))) {
      last.bands.push({ delta: Number(d[1]), y: Number(d[2]), side: d[3] as "left" | "right" });
    } else if ((d = ALIGNED.exec(line))) {
      last.alignedScore = Number(d[1]) / 100;
    } else if ((d = TEXT.exec(line))) {
      last.added = Number(d[1]);
      last.removed = Number(d[2]);
    } else if ((d = /^\s+dom (.+)$/.exec(line))) {
      last.dom = d[1]!;
    } else if (/^\s+rows too different to align$/.test(line)) {
      last.unaligned = true;
    }
  }
  return rows;
}

/** The row for one comparison. Throws rather than returning undefined — a missing row is a
 *  test failure with a useless stack otherwise. */
export function row(rows: ProgressRow[], route: string, width: number): ProgressRow {
  const found = rows.find((r) => r.route === route && r.width === width);
  if (!found) {
    const seen = rows.map((r) => `${r.route}@${r.width}`).join(", ") || "(none)";
    throw new Error(`no result for ${route}@${width}; saw: ${seen}`);
  }
  return found;
}

export interface ReportCard {
  /** `/a`, or `/a [sel]` for a selector route. */
  route: string;
  width: number;
  score: number;
  band: "good" | "warn" | "bad";
  heightDelta: number;
  widthDelta: number;
  diffPixels: number;
  totalPixels: number;
  unstablePixels: number;
  /** Null when the card shows no aligned score. */
  alignedScore: number | null;
  /** The listed regions (the card caps the list), each with the elements line it shows, or null. */
  regions: (Box & { pixels: number; dom: string | null })[];
  /** The listed bands: `+24px at y=196 (left)` and the elements line, or null. */
  bands: { text: string; dom: string | null }[];
  /** The text-diff lines listed on the card: left-only and right-only. */
  added: string[];
  removed: string[];
  images: string[];
  /** Region crop links in the findings block. */
  crops: string[];
  /** The card carries the "before hook" badge. */
  hook: boolean;
  /** The accepted badge's reasons, or null. */
  accepted: string | null;
}

export interface ReportErrorRow {
  route: string;
  width: number;
  message: string;
}

export interface Report {
  cards: ReportCard[];
  errors: ReportErrorRow[];
  /** The stale accepted differences section; `message` is the reason. */
  stale: ReportErrorRow[];
  /** Block globs listed in the "What was neutralized" disclosure. */
  blockPatterns: string[];
  /** Mask `reason` strings listed in the same disclosure. */
  maskReasons: string[];
  /** Raw disclosure HTML, for `.includes()` assertions. */
  neutralized: string;
}

const num = (s: string) => Number(s.replace(/,/g, ""));
const unesc = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

const unescOr = (s: string | undefined) => (s === undefined ? null : unesc(s));

function between(html: string, start: string, end: string): string {
  const i = html.indexOf(start);
  if (i === -1) return "";
  const j = html.indexOf(end, i + start.length);
  return html.slice(i + start.length, j === -1 ? undefined : j);
}

export function parseReport(html: string): Report {
  const cards: ReportCard[] = [];
  // Split rather than one big regex: the header's optional delta badges make a single
  // pattern unreadable and order-sensitive.
  for (const chunk of html.split('<article class="card">').slice(1)) {
    const card = chunk.slice(0, chunk.indexOf("</article>"));
    const score = /<span class="score (good|warn|bad)">([\d.]+)%<\/span>/.exec(card);
    const route = /<code>([^<]*)<\/code>/.exec(card);
    const width = /<span class="w">@(\d+)px<\/span>/.exec(card);
    const px = /<span class="px">([\d,]+) \/ ([\d,]+) px differ<\/span>/.exec(card);
    if (!score || !route || !width || !px) {
      throw new Error(`unrecognised report card markup:\n${card}`);
    }
    const height = /<span class="delta">height ([+-]?\d+)px<\/span>/.exec(card);
    const wDelta = /<span class="delta">width ([+-]?\d+)px<\/span>/.exec(card);
    const unstable = /<span class="unstable">([\d,]+) px unstable<\/span>/.exec(card);
    const aligned = /<span class="aligned">aligned ([\d.]+)%<\/span>/.exec(card);
    cards.push({
      route: unesc(route[1]!),
      width: Number(width[1]),
      score: Number(score[2]) / 100,
      band: score[1] as ReportCard["band"],
      heightDelta: height ? Number(height[1]) : 0,
      widthDelta: wDelta ? Number(wDelta[1]) : 0,
      diffPixels: num(px[1]!),
      totalPixels: num(px[2]!),
      unstablePixels: unstable ? num(unstable[1]!) : 0,
      alignedScore: aligned ? Number(aligned[1]) / 100 : null,
      regions: [
        ...card.matchAll(
          /<li>(\d+)×(\d+) at \((\d+),(\d+)\) — ([\d,]+) px(?:<span class="dom"> — (.*?)<\/span>)?<\/li>/g,
        ),
      ].map((m) => ({
        w: Number(m[1]),
        h: Number(m[2]),
        x: Number(m[3]),
        y: Number(m[4]),
        pixels: num(m[5]!),
        dom: m[6] ? unesc(m[6]) : null,
      })),
      bands: [
        ...card.matchAll(/<li>band ([^<]*)(?:<span class="dom"> — (.*?)<\/span>)?<\/li>/g),
      ].map((m) => ({
        text: m[1]!,
        dom: m[2] ? unesc(m[2]) : null,
      })),
      added: [...card.matchAll(/<li class="add">\+ ([^<]*)<\/li>/g)].map((m) => unesc(m[1]!)),
      removed: [...card.matchAll(/<li class="del">- ([^<]*)<\/li>/g)].map((m) => unesc(m[1]!)),
      images: [...card.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]!),
      crops: [...card.matchAll(/<a class="crop" href="([^"]+)"/g)].map((m) => m[1]!),
      hook: card.includes('<span class="hook">before hook</span>'),
      accepted: unescOr(/<span class="accepted">accepted: ([^<]*)<\/span>/.exec(card)?.[1]),
    });
  }

  const listed = (section: string) =>
    [...section.matchAll(/<li><code>([^<]*)<\/code> @(\d+)px — ([\s\S]*?)<\/li>/g)].map((m) => ({
      route: unesc(m[1]!),
      width: Number(m[2]),
      message: m[3]!,
    }));
  const errors = listed(between(html, '<h2 class="bad">Errors</h2>', "</section>"));
  const stale = listed(between(html, "<h2>Stale accepted differences</h2>", "</section>"));

  const neutralized = between(html, "<details>", "</details>");
  const blockPatterns = [...neutralized.matchAll(/<li><code>([^<]*)<\/code><\/li>/g)].map(
    (m) => m[1]!,
  );
  const maskReasons = [...neutralized.matchAll(/<li>((?!<code>)[^<]*)<\/li>/g)].map((m) => m[1]!);

  return { cards, errors, stale, blockPatterns, maskReasons, neutralized };
}

/** The report card for one comparison. Throws with context when absent. */
export function card(report: Report, route: string, width: number): ReportCard {
  const found = report.cards.find((c) => c.route === route && c.width === width);
  if (!found) {
    const seen = report.cards.map((c) => `${c.route}@${c.width}`).join(", ") || "(none)";
    throw new Error(`no report card for ${route}@${width}; saw: ${seen}`);
  }
  return found;
}
