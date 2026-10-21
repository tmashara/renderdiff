/**
 * The only module that knows vdiff's output formats.
 *
 * A black-box suite has to read results back out of the two things the tool produces: the
 * progress lines on stdout and `report.html`. That coupling is real, so it lives in exactly
 * one file — if `run.ts`'s log line or `report.ts`'s markup changes, this is the only place
 * that needs fixing.
 *
 * Scores come from stdout (a stable one-line-per-comparison format). The report is parsed
 * only for claims that are specific to the report: pixel counts, image filenames, the
 * Errors section, and the "What was neutralized" disclosure.
 */

export interface ProgressRow {
  route: string;
  width: number;
  /** 0..1, or null for a route that errored. */
  score: number | null;
  /** left − right, in px. 0 when the badge was absent. */
  heightDelta: number;
}

/** `  [2/15] 97.41%  /about @1440  (height -112px)` — or `ERROR` in place of the score. */
const PROGRESS =
  /^\s*\[\d+\/\d+\]\s+(ERROR|[\d.]+%)\s+(\S+)\s+@(\d+)(?:\s+\(height ([+-]?\d+)px\))?\s*$/;

export function parseProgress(stdout: string): ProgressRow[] {
  const rows: ProgressRow[] = [];
  for (const line of stdout.split("\n")) {
    const m = PROGRESS.exec(line);
    if (!m) continue;
    rows.push({
      route: m[2]!,
      width: Number(m[3]),
      score: m[1] === "ERROR" ? null : Number(m[1]!.slice(0, -1)) / 100,
      heightDelta: m[4] ? Number(m[4]) : 0,
    });
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
  route: string;
  width: number;
  score: number;
  band: "good" | "warn" | "bad";
  heightDelta: number;
  widthDelta: number;
  diffPixels: number;
  totalPixels: number;
  images: string[];
}

export interface ReportErrorRow {
  route: string;
  width: number;
  message: string;
}

export interface Report {
  cards: ReportCard[];
  errors: ReportErrorRow[];
  /** Block globs listed in the "What was neutralized" disclosure. */
  blockPatterns: string[];
  /** Mask `reason` strings listed in the same disclosure. */
  maskReasons: string[];
  /** Raw disclosure HTML, for `.includes()` assertions. */
  neutralized: string;
}

const num = (s: string) => Number(s.replace(/,/g, ""));

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
    cards.push({
      route: route[1]!,
      width: Number(width[1]),
      score: Number(score[2]) / 100,
      band: score[1] as ReportCard["band"],
      heightDelta: height ? Number(height[1]) : 0,
      widthDelta: wDelta ? Number(wDelta[1]) : 0,
      diffPixels: num(px[1]!),
      totalPixels: num(px[2]!),
      images: [...card.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]!),
    });
  }

  const errors: ReportErrorRow[] = [];
  const errorSection = between(html, '<h2 class="bad">Errors</h2>', "</section>");
  for (const m of errorSection.matchAll(
    /<li><code>([^<]*)<\/code> @(\d+)px — ([\s\S]*?)<\/li>/g,
  )) {
    errors.push({ route: m[1]!, width: Number(m[2]), message: m[3]! });
  }

  const neutralized = between(html, "<details>", "</details>");
  const blockPatterns = [...neutralized.matchAll(/<li><code>([^<]*)<\/code><\/li>/g)].map(
    (m) => m[1]!,
  );
  const maskReasons = [...neutralized.matchAll(/<li>((?!<code>)[^<]*)<\/li>/g)].map(
    (m) => m[1]!,
  );

  return { cards, errors, blockPatterns, maskReasons, neutralized };
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
