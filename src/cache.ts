import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CONTEXT_OPTIONS, version, type ResolvedConfig, type Route } from "./config.ts";

/**
 * `--cache-right`: the right side's network traffic, recorded as a HAR and replayed on later
 * runs. The page still loads, settles and is shot live, so attribution and every refusal
 * work as on a live load; only the round trips to the reference are skipped.
 */

/** In the out dir, kept when it is wiped. */
export const CACHE_DIR = ".cache";

/** A recording older than this is recorded again, so prod can't drift unseen for long. */
export const REPLAY_TTL = 60 * 60_000;

/** A shot's identity in a recording: what decides which requests its load makes. */
export const shotId = (route: Route, width: number) =>
  JSON.stringify([route.right, width, route.before && String(route.before)]);

/** Everything that changes what the right origin serves, so one recording never answers another. */
export function cacheFile(cfg: ResolvedConfig, browser: { name: string; version: string }): string {
  const state = cfg.storageState.right && fs.readFileSync(cfg.storageState.right, "utf8");
  const key = createHash("sha256")
    .update(
      JSON.stringify([version(), browser, cfg.right, state, CONTEXT_OPTIONS, cfg.blockUrlPatterns]),
    )
    .digest("hex")
    .slice(0, 16);
  return path.join(cfg.outDir, CACHE_DIR, `right-${key}.har`);
}

interface Har {
  log: { entries: unknown[]; _renderdiff?: { recordedAt: number; shots: string[] } };
}

/** When the recording was made, if it covers every shot and is under `REPLAY_TTL` old; else null. */
export function replayable(file: string, shots: string[], now = Date.now()): number | null {
  let rec;
  try {
    rec = (JSON.parse(fs.readFileSync(file, "utf8")) as Har).log._renderdiff;
  } catch {
    return null;
  }
  if (!rec || !(now - rec.recordedAt >= 0 && now - rec.recordedAt < REPLAY_TTL)) return null;
  return shots.every((s) => rec.shots.includes(s)) ? rec.recordedAt : null;
}

/** Merge each worker's recording into `file`, for `shots` only; the parts are removed. */
export function saveRecording(file: string, parts: string[], shots: string[], recordedAt: number) {
  const hars = parts
    .filter((p) => fs.existsSync(p))
    .map((p) => JSON.parse(fs.readFileSync(p, "utf8")) as Har);
  for (const p of parts) fs.rmSync(p, { force: true });
  if (!hars.length || !shots.length) return;
  const har = hars[0]!;
  har.log.entries = hars.flatMap((h) => h.log.entries);
  har.log._renderdiff = { recordedAt, shots };
  // Renamed into place, so a run killed mid-write never leaves a half recording to replay.
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(har));
  fs.renameSync(`${file}.tmp`, file);
}
