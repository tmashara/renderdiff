/**
 * `renderdiff report`: evidence.html from a hand-written results.json and one generated crop.
 * No browser.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";
import {
  writeEvidence,
  type ComparedResult,
  type Results,
  type RouteResult,
  type RunMeta,
} from "../../src/report.ts";
import { cleanupTempDirs, tempDir } from "../helpers/cli.ts";

after(cleanupTempDirs);

let dir: string;
before(async () => {
  dir = tempDir();
  await sharp({ create: { width: 40, height: 20, channels: 3, background: "#c00" } })
    .png()
    .toFile(path.join(dir, "a.1440.c1.png"));
});

const shot = (url: string, over: Partial<ComparedResult> = {}): RouteResult =>
  ({
    status: "compared",
    url,
    left: url,
    right: url,
    selector: null,
    hook: false,
    width: 1440,
    score: 1,
    diffPixels: 0,
    totalPixels: 1000,
    heightDelta: 0,
    widthDelta: 0,
    unstablePixels: 0,
    regions: [],
    bands: [],
    alignedScore: null,
    text: { added: [], removed: [] },
    images: { left: "x.left.png", right: "x.right.png", diff: "x.diff.png" },
    crops: [],
    accepted: false,
    failed: { left: [], right: [] },
    ...over,
  }) as ComparedResult;

const differs = (url: string) =>
  shot(url, {
    score: 0.9,
    diffPixels: 100,
    crops: [
      {
        path: "a.1440.c1.png",
        kind: "region",
        left: { x: 0, y: 0, w: 1, h: 1 },
        right: { x: 0, y: 0, w: 1, h: 1 },
        layout: "side",
        scale: 1,
        clipped: false,
      },
    ],
  });

const meta = (over: Partial<RunMeta> = {}) =>
  ({
    tool: "renderdiff",
    version: "0.4.0",
    generatedAt: "2026-01-01T00:00:00.000Z",
    left: "http://localhost:3000",
    right: "https://example.com",
    widths: [1440],
    threshold: null,
    clock: "2026-01-01T00:00:00.000Z",
    blockUrlPatterns: [],
    hideSelectors: [],
    masks: [],
    browser: { name: "chromium", version: "1" },
    storageState: { left: null, right: null },
    config: "x",
    rightReplayedFrom: null,
    freezeVideo: true,
    platform: "linux",
    rerun: null,
    ...over,
  }) as RunMeta;

async function evidence(results: RouteResult[], m: Partial<RunMeta> = {}, verdict = "parity?") {
  const data = { meta: meta(m), results, summary: { stale: [] } } as unknown as Results;
  return fs.readFileSync(await writeEvidence(data, dir, verdict, "Task"), "utf8");
}

const banner = (html: string) => html.match(/<div class="banner \w+">([^<]+)</)![1];

describe("writeEvidence", () => {
  test("embeds crops, carries the verdict, and a diff turns the banner red", async () => {
    const html = await evidence(
      [shot("/"), differs("/a"), { ...shot("/b"), status: "error", error: "boom" } as RouteResult],
      {},
      "Call: regression on /a",
    );
    assert.match(html, /src="data:image\/webp;base64,/);
    assert.doesNotMatch(html, /src="(?!data:)[^"]*"/);
    assert.match(html, /Call: regression on \/a/);
    assert.equal(banner(html), "Differs");
    assert.match(html, /renderdiff: 1 of 3 routes differ/);
  });

  test("all clean is parity; a diff above the threshold still differs", async () => {
    assert.equal(banner(await evidence([shot("/")])), "Parity");
    const below = await evidence([differs("/a")], { threshold: 0.95 });
    assert.equal(banner(below), "Differs");
  });

  test("a diff under the threshold or a rerun is not verified", async () => {
    const under = await evidence([differs("/a")], { threshold: 0.5 });
    assert.equal(banner(under), "Not verified");
    assert.match(under, /1 shot\(s\) differ under threshold/);
    const rerun = await evidence([shot("/")], { rerun: { rerun: 1, reused: 4 } });
    assert.equal(banner(rerun), "Not verified");
    const full = await evidence([shot("/")], { rerun: { rerun: 5, reused: 0 } });
    assert.equal(banner(full), "Parity");
  });

  test("an accepted shot is parity and still gets a card with its crop", async () => {
    const html = await evidence([{ ...differs("/a"), accepted: true } as RouteResult]);
    assert.equal(banner(html), "Parity");
    assert.match(html, /<h2>Accepted<\/h2>[\s\S]*src="data:image\/webp/);
  });

  test("a missing crop file is noted, not fatal", async () => {
    const r = differs("/a") as ComparedResult;
    const html = await evidence([{ ...r, crops: [{ ...r.crops[0]!, path: "gone.png" }] }]);
    assert.match(html, /crop omitted/);
    assert.match(html, /1 crop\(s\) omitted/);
  });

  test("a script in the verdict or a route is escaped", async () => {
    const html = await evidence([differs("/<script>x</script>")], {}, "<script>alert(1)</script>");
    assert.doesNotMatch(html, /<script/);
    assert.match(html, /&lt;script&gt;alert\(1\)/);
  });
});
