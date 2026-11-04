/**
 * `--browser webkit`: both sides shot in Playwright's WebKit, which has no CDP. The capture,
 * the stalled-frame and tall-page guard rails and `--computed` still work there; the case
 * the option exists for is CSS Chromium reads one way and WebKit another.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import sharp from "sharp";
import {
  cleanupTempDirs,
  context,
  leftCss,
  renderdiffArgs,
  runCli,
  tempDir,
} from "../helpers/cli.ts";
import { result, results } from "../helpers/parse.ts";
import { startFixtureSite, type FixtureSite } from "../helpers/server.ts";
import { EXPECT_HEIGHT } from "../fixtures/pages/tall/page.ts";

let site: FixtureSite;

before(async () => {
  site = await startFixtureSite();
});

after(async () => {
  await site?.close();
  cleanupTempDirs();
});

const run = (routes: string[], extra: string[] = [], widths = [1440], engine = "webkit") =>
  runCli([
    ...renderdiffArgs({ left: site.left, right: site.right, routes, widths }),
    "--browser",
    engine,
    ...extra,
  ]);

test("a dropped -webkit- prefix is parity in Chromium and a diff in WebKit", async () => {
  const chromium = await run(["/box-decoration-break"], [], [1440], "chromium");
  assert.equal(chromium.code, 0, context(chromium));
  assert.equal(result(results(chromium.outDir), "/box-decoration-break", 1440).diffPixels, 0);
  const webkit = await run(["/box-decoration-break"]);
  assert.equal(webkit.code, 1, context(webkit));
  const out = results(webkit.outDir);
  assert.equal(out.meta.browser.name, "webkit");
  assert.ok(result(out, "/box-decoration-break", 1440).diffPixels > 0, context(webkit));
});

test("an equivalence pair scores 100% and a control does not", async () => {
  const r = await run(["/flex-vs-grid", "/color"], [], [1440, 375]);
  assert.equal(r.code, 1, context(r));
  for (const width of [1440, 375]) {
    assert.equal(result(results(r.outDir), "/flex-vs-grid", width).score, 1, context(r));
    assert.ok(result(results(r.outDir), "/color", width).score < 1, context(r));
  }
});

test("a page past the one-shot height is tiled and stitched to its full height", async () => {
  const r = await run(["/tall"]);
  assert.equal(r.code, 0, context(r));
  assert.equal(result(results(r.outDir), "/tall", 1440).diffPixels, 0, context(r));
  for (const side of ["left", "right"]) {
    const { height } = await sharp(r.file(`tall.1440.${side}.png`)).metadata();
    assert.equal(height, EXPECT_HEIGHT, context(r));
  }
});

test("a frame that never loads is skipped, not waited on", async () => {
  const t0 = Date.now();
  const r = await run(["/stalled-frame"]);
  assert.equal(r.code, 0, context(r));
  assert.ok(Date.now() - t0 < 30_000, `took ${Date.now() - t0}ms${context(r)}`);
});

test("an animated GIF isn't frozen: its pixels are unstable, not a difference", async () => {
  const r = await run(["/animated"]);
  assert.equal(r.code, 0, context(r));
  const shot = result(results(r.outDir), "/animated", 1440);
  assert.equal(shot.diffPixels, 0, context(r));
  assert.ok(shot.unstablePixels > 0, context(r));
});

test("--computed works without forced states, and says so", async () => {
  const r = await run(["/margin"], ["--computed"]);
  assert.equal(r.code, 1, context(r));
  assert.match(r.stdout, /--computed on webkit: links and controls aren't forced/);
  const shot = result(results(r.outDir), "/margin", 1440);
  assert.equal(shot.computed?.dom, 0, context(r));
  assert.ok(
    shot.computed!.changes.some((c) => c.prop === "margin-left"),
    context(r),
  );
});

test("--accept writes renderdiff.accepted.webkit.json and leaves Chromium's file alone", async () => {
  const cwd = tempDir("renderdiff-cwd-");
  const chromiumFile = path.join(cwd, "renderdiff.accepted.json");
  fs.writeFileSync(chromiumFile, "[]\n");
  const hook = leftCss(cwd, ".notes h2 { color: #2e7d32 }");
  const r = await runCli(
    [
      ...renderdiffArgs({ left: site.left, right: site.right, routes: ["/"], widths: [1440] }),
      ...hook,
      "--browser",
      "webkit",
      "--accept",
      "known",
    ],
    { cwd },
  );
  assert.equal(r.code, 0, context(r));
  const list = JSON.parse(
    fs.readFileSync(path.join(cwd, "renderdiff.accepted.webkit.json"), "utf8"),
  );
  assert.ok(list.length > 0, context(r));
  assert.equal(fs.readFileSync(chromiumFile, "utf8"), "[]\n");
});

test("without --out a webkit run writes renderdiff-out-webkit", async () => {
  const cwd = tempDir("renderdiff-cwd-");
  const r = await runCli(
    [
      ...renderdiffArgs({ left: site.left, right: site.right, routes: ["/"], widths: [375] }),
      "--browser",
      "webkit",
    ],
    { cwd, noOut: true },
  );
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.ok(fs.existsSync(path.join(cwd, "renderdiff-out-webkit", "results.json")));
  assert.ok(!fs.existsSync(path.join(cwd, "renderdiff-out")));
});
