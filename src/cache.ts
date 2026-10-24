import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CONTEXT_OPTIONS, version, type ResolvedConfig, type Route } from "./config.ts";

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

interface Entry {
  request: { method: string; url: string; postData?: { text?: string } };
  response: { status: number };
}

/** When the recording was made, if it covers every shot and is under `REPLAY_TTL` old; else null. */
export function replayable(file: string, shots: string[], now = Date.now()): number | null {
  let rec: { recordedAt: number; shots: string[] };
  try {
    rec = JSON.parse(fs.readFileSync(`${file}.json`, "utf8"));
  } catch {
    return null;
  }
  if (!fs.existsSync(file) || !(now - rec.recordedAt >= 0 && now - rec.recordedAt < REPLAY_TTL))
    return null;
  return shots.every((s) => rec.shots.includes(s)) ? rec.recordedAt : null;
}

/**
 * Merge each worker's recording into `file` for `shots`, replacing every other recording in
 * its directory. The parts are removed.
 */
export function saveRecording(file: string, parts: string[], shots: string[], recordedAt: number) {
  try {
    const hars = parts
      .filter((p) => fs.existsSync(p))
      .map((p) => JSON.parse(fs.readFileSync(p, "utf8")) as { log: { entries: Entry[] } });
    if (!hars.length || !shots.length) return;
    const seen = new Set<string>();
    const har = hars[0]!;
    // Errors would answer every later load; a cancelled request (-1) replays as a hang.
    har.log.entries = hars
      .flatMap((h) => h.log.entries)
      .filter((e) => {
        const key = JSON.stringify([e.request.method, e.request.url, e.request.postData?.text]);
        const ok = e.response.status >= 200 && e.response.status < 400;
        if (!ok || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    const dir = path.dirname(file);
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith("right-")) fs.rmSync(path.join(dir, f), { force: true });
    }
    // It holds the right side's cookies and auth headers.
    fs.writeFileSync(path.join(dir, ".gitignore"), "*\n");
    fs.writeFileSync(file, JSON.stringify(har), { mode: 0o600 });
    // Written last: without it the recording is never replayed.
    fs.writeFileSync(`${file}.json`, JSON.stringify({ recordedAt, shots }), { mode: 0o600 });
  } finally {
    for (const p of parts) fs.rmSync(p, { force: true });
  }
}
