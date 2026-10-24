/**
 * `--cache-right`: when a recording of the right side may be replayed, and what keys it. No
 * browser: the recordings are hand-written HARs.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { cacheFile, replayable, REPLAY_TTL, saveRecording, shotId } from "../../src/cache.ts";
import { parseRoutes, resolveConfig } from "../../src/config.ts";
import { cleanupTempDirs, tempDir } from "../helpers/cli.ts";

after(cleanupTempDirs);

const browser = { name: "chromium", version: "1" };
const cfg = (over: Parameters<typeof resolveConfig>[1] = {}) =>
  resolveConfig({}, { left: "http://l.test", right: "http://r.test", outDir: "/tmp/o", ...over });
const [route] = parseRoutes(["/a"]);

function record(shots: string[], recordedAt: number) {
  const dir = tempDir();
  const parts = [0, 1].map((i) => path.join(dir, `${i}.part`));
  parts.forEach((p, i) =>
    fs.writeFileSync(p, JSON.stringify({ log: { version: "1.2", entries: [{ i }] } })),
  );
  const file = path.join(dir, "right.har");
  saveRecording(file, [...parts, path.join(dir, "missing.part")], shots, recordedAt);
  return { file, parts };
}

describe("replayable", () => {
  const now = Date.now();
  const a = shotId(route!, 1440);
  const b = shotId(route!, 375);

  test("a fresh recording covering every shot replays; the parts merge and go", () => {
    const { file, parts } = record([a, b], now - 1000);
    assert.equal(replayable(file, [a], now), now - 1000);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).log.entries, [{ i: 0 }, { i: 1 }]);
    assert.ok(parts.every((p) => !fs.existsSync(p)));
  });

  test("a shot it lacks, an expired or future recording, or none at all loads live", () => {
    assert.equal(replayable(record([a], now).file, [a, b], now), null);
    assert.equal(replayable(record([a], now - REPLAY_TTL).file, [a], now), null);
    assert.equal(replayable(record([a], now + 60_000).file, [a], now), null);
    assert.equal(replayable(path.join(tempDir(), "none.har"), [a], now), null);
  });

  test("a run where no shot succeeded writes nothing", () => {
    assert.equal(fs.existsSync(record([], now).file), false);
  });
});

describe("keys", () => {
  test("a hook, the right path or the width is a different shot", () => {
    const hooked = parseRoutes(["/a"], undefined, async () => {})[0]!;
    const paired = parseRoutes(["/b::/a"])[0]!;
    assert.notEqual(shotId(route!, 1440), shotId(hooked, 1440));
    assert.notEqual(shotId(route!, 1440), shotId(route!, 375));
    assert.equal(shotId(route!, 1440), shotId(paired, 1440), "the left path doesn't matter");
  });

  test("the right origin, its storage state and the browser change the file", () => {
    const dir = tempDir();
    const state = path.join(dir, "auth.json");
    fs.writeFileSync(state, JSON.stringify({ cookies: [], origins: [] }));
    const signed = cacheFile(cfg({ storageState: { right: state } }), browser);
    fs.writeFileSync(state, JSON.stringify({ cookies: [{ name: "s" }], origins: [] }));
    const files = [
      cacheFile(cfg(), browser),
      cacheFile(cfg({ right: "http://other.test" }), browser),
      cacheFile(cfg(), { ...browser, version: "2" }),
      signed,
      cacheFile(cfg({ storageState: { right: state } }), browser),
    ];
    assert.equal(new Set(files).size, files.length);
    assert.equal(cacheFile(cfg({ left: "http://x.test" }), browser), files[0]);
    assert.equal(path.dirname(files[0]!), "/tmp/o/.cache");
  });
});
