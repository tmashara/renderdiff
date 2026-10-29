import fs from "node:fs";
import type { Band, Region } from "./compare.ts";
import { name } from "./config.ts";
import { fmtElements } from "./format.ts";
import type { ComparedResult, RouteResult } from "./report.ts";

export const ACCEPTED_FILE = "renderdiff.accepted.json";

/**
 * One band or region, without its `y`: a change above it moves it down the page without
 * changing it. `hash` and `elements` tell a new change in the same spot from the accepted one.
 */
export interface Fingerprint {
  kind: "band" | "region";
  side?: "left" | "right";
  /** A region's box; a band's rows are in its hash. */
  x?: number;
  w?: number;
  h: number;
  /** The `dom` of each element under it, sorted; absent when they weren't looked at. */
  elements?: string[];
  /** Both sides' pixels under it, 4 bits a channel. */
  hash?: string;
}

/** A difference recorded as already there or intended, so later runs report it as accepted. */
export interface Accepted {
  /** The route as the summary names it: `/a`, `/a::/b`, `/a [.sel]`. */
  route: string;
  width: number;
  reason: string;
  fingerprint: Fingerprint;
}

type Change = { fp: Fingerprint; target: Region | Band };

function changes(r: ComparedResult): Change[] {
  const els = (g: Region | Band) =>
    g.elements && { elements: g.elements.map((e) => fmtElements([e], Infinity)).sort() };
  return [
    ...(r.bands ?? []).map((b) => ({
      fp: { kind: "band" as const, side: b.side, h: b.h, ...els(b), hash: b.hash },
      target: b,
    })),
    ...r.regions.map((g) => ({
      fp: { kind: "region" as const, x: g.x, w: g.w, h: g.h, ...els(g), hash: g.hash },
      target: g,
    })),
  ];
}

/** `a` is the accepted entry: elements it recorded must be named again, not merely unprobed. */
const same = (a: Fingerprint, b: Fingerprint) =>
  a.kind === b.kind &&
  a.side === b.side &&
  a.x === b.x &&
  a.w === b.w &&
  a.h === b.h &&
  a.hash === b.hash &&
  (!a.elements || a.elements.join("\n") === b.elements?.join("\n"));

/**
 * Padding no band or region covers: columns past the narrower page, or rows past the shorter
 * one when they didn't align. A shot with any, or with unstable pixels, is never accepted.
 */
const acceptable = (r: ComparedResult) => !unacceptable(r);

/** Why a shot can never be accepted, or null when it can. */
export const unacceptable = (r: ComparedResult) =>
  r.unstablePixels
    ? "unstable"
    : r.variesPixels
      ? "varies per load"
      : r.widthDelta
        ? "width change"
        : r.bands === null && r.heightDelta
          ? "unaligned height"
          : null;

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
 * when every change matched and it is `acceptable`. Returns the changes of acceptable results
 * nothing matched, and the entries for a measured route and width that matched nothing.
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
      if (hit) {
        used.add(hit);
        target.accepted = hit.reason;
      } else {
        delete target.accepted;
        missed++;
        if (acceptable(r)) unmatched.push({ route: name(r), width: r.width, fingerprint: fp });
      }
    }
    r.accepted = cs.length > 0 && !missed && acceptable(r);
  }
  const measured = new Set(
    results.filter((r) => r.status === "compared").map((r) => `${name(r)}@${r.width}`),
  );
  const stale = list.filter((a) => !used.has(a) && measured.has(`${a.route}@${a.width}`));
  return { unmatched, stale };
}

const key = (a: Accepted) => JSON.stringify([a.route, a.width, a.reason, a.fingerprint]);

/**
 * Drop `stale` and add `added` to the file as it is now, so a concurrent `--accept` isn't lost,
 * sorted by route then width, through a rename so a crash never leaves it half written.
 * Returns false, writing nothing, when there is nothing to change.
 */
export function updateAccepted(file: string, stale: Accepted[], added: Accepted[]): boolean {
  if (!stale.length && !added.length) return false;
  const drop = new Set(stale.map(key));
  const kept = readAccepted(file).filter((a) => !drop.has(key(a)));
  const have = new Set(kept.map(key));
  const list = [...kept, ...added.filter((a) => !have.has(key(a)))].sort((a, b) =>
    a.route < b.route ? -1 : a.route > b.route ? 1 : a.width - b.width,
  );
  // One entry per line, so a diff of the file reads as the differences it adds and drops.
  const rows = list.map((a) => `  ${JSON.stringify(a)}`).join(",\n");
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, rows ? `[\n${rows}\n]\n` : "[]\n");
  fs.renameSync(tmp, file);
  return true;
}
