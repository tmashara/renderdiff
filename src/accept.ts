import fs from "node:fs";
import type { Band, Region } from "./compare.ts";
import { name } from "./config.ts";
import { fmtElements } from "./format.ts";
import type { ComparedResult, RouteResult } from "./report.ts";

export const ACCEPTED_FILE = "renderdiff.accepted.json";

/**
 * One change, without its `y`: a change above it moves it down the page without changing it.
 * `elements` and `thumb` tell a new change in the same spot from the accepted one.
 */
export interface Fingerprint {
  kind: "band" | "region" | "size";
  side?: "left" | "right";
  /** A region's; a band's width is in its thumb, and `size` holds the width and height deltas. */
  x?: number;
  w: number;
  h: number;
  /** The `dom` of each element under it, sorted; absent when they weren't looked at. */
  elements?: string[];
  thumb?: string;
}

/** A difference recorded as already there or intended, so later runs report it as accepted. */
export interface Accepted {
  /** The route as the summary names it: `/a`, `/a::/b`, `/a [.sel]`. */
  route: string;
  width: number;
  reason: string;
  fingerprint: Fingerprint;
}

type Change = { fp: Fingerprint; target: Region | Band | null };

/** Each band and region, plus the size difference, which padding hides from both. */
function changes(r: ComparedResult): Change[] {
  const els = (g: Region | Band) =>
    g.elements && { elements: g.elements.map((e) => fmtElements([e], Infinity)).sort() };
  return [
    ...(r.bands ?? []).map((b) => ({
      fp: { kind: "band" as const, side: b.side, w: 0, h: b.h, ...els(b), thumb: b.thumb },
      target: b,
    })),
    ...r.regions.map((g) => ({
      fp: { kind: "region" as const, x: g.x, w: g.w, h: g.h, ...els(g), thumb: g.thumb },
      target: g,
    })),
    ...(r.heightDelta || r.widthDelta
      ? [{ fp: { kind: "size" as const, w: r.widthDelta, h: r.heightDelta }, target: null }]
      : []),
  ];
}

/** A cell may drift by one step a channel: noise, not a change. */
const near = (a = "", b = "") =>
  a.length === b.length &&
  [...a].every((c, i) => Math.abs(parseInt(c, 16) - parseInt(b[i]!, 16)) <= 1);

const same = (a: Fingerprint, b: Fingerprint) =>
  a.kind === b.kind &&
  a.side === b.side &&
  a.x === b.x &&
  a.w === b.w &&
  a.h === b.h &&
  (!a.elements || !b.elements || a.elements.join("\n") === b.elements.join("\n")) &&
  near(a.thumb, b.thumb);

export function readAccepted(file: string): Accepted[] {
  if (!fs.existsSync(file)) return [];
  let list: unknown;
  try {
    list = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${e instanceof Error ? e.message : e}`);
  }
  const ok = (a: Record<string, unknown>) =>
    typeof a.route === "string" &&
    typeof a.width === "number" &&
    typeof a.reason === "string" &&
    a.reason.trim() &&
    typeof a.fingerprint === "object" &&
    a.fingerprint !== null;
  if (!Array.isArray(list) || !list.every(ok)) {
    throw new Error(`${file} must be an array of { route, width, reason, fingerprint }`);
  }
  return list as Accepted[];
}

/**
 * Mark each change an accepted entry matches, one entry per change, and a result `accepted`
 * when every change matched and nothing went unmeasured. Returns the changes nothing matched,
 * and the entries for a measured route and width that matched nothing.
 */
export function applyAccepted(results: RouteResult[], list: Accepted[]) {
  const used = new Set<Accepted>();
  const unmatched: Omit<Accepted, "reason">[] = [];
  for (const r of results) {
    if (r.status !== "compared") continue;
    const mine = list.filter((a) => a.route === name(r) && a.width === r.width);
    const cs = r.diffPixels > 0 ? changes(r) : [];
    let missed = 0;
    for (const { fp, target } of cs) {
      const hit = mine.find((a) => !used.has(a) && same(a.fingerprint, fp));
      if (hit) used.add(hit);
      else missed = unmatched.push({ route: name(r), width: r.width, fingerprint: fp });
      if (target && hit) target.accepted = hit.reason;
      else if (target) delete target.accepted;
    }
    r.accepted = cs.length > 0 && !missed && r.unstablePixels === 0;
  }
  const measured = new Set(
    results.filter((r) => r.status === "compared").map((r) => `${name(r)}@${r.width}`),
  );
  const stale = list.filter((a) => !used.has(a) && measured.has(`${a.route}@${a.width}`));
  return { unmatched, stale };
}

/** One entry per line, so a diff of the file reads as the differences it adds and drops. */
export function writeAccepted(file: string, list: Accepted[]) {
  const rows = list.map((a) => `  ${JSON.stringify(a)}`).join(",\n");
  fs.writeFileSync(file, rows ? `[\n${rows}\n]\n` : "[]\n");
}
