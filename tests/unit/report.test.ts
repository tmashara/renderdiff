/**
 * `renderdiff report`: report.html and evidence.html from a hand-written results.json and one
 * generated crop. No browser.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";
import {
  verdict,
  writeEvidence,
  writeReport,
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

describe("verdict", () => {
  const error = { ...shot("/e"), status: "error", error: "boom" } as RouteResult;
  const at = (score: number) => shot("/a", { score, diffPixels: 1 });

  test("identical or accepted is green, an error is red", () => {
    assert.equal(verdict(shot("/"), 0.9), "good");
    assert.equal(verdict({ ...at(0.5), accepted: true } as RouteResult, 0.9), "good");
    assert.equal(verdict(error, null), "bad");
  });

  test("a diff is amber at or above the threshold, red below it or with no threshold", () => {
    assert.equal(verdict(at(0.9), 0.9), "warn");
    assert.equal(verdict(at(0.89), 0.9), "bad");
    assert.equal(verdict(at(0.9999), null), "bad");
  });
});

describe("writeReport", () => {
  const stem = (url: string, width: number) => `${url.slice(1) || "index"}.${width}`;
  const at = (url: string, width: number, over: Partial<ComparedResult> = {}) =>
    shot(url, {
      width,
      images: {
        left: `${stem(url, width)}.left.png`,
        right: `${stem(url, width)}.right.png`,
        diff: `${stem(url, width)}.diff.png`,
      },
      ...over,
    });

  async function report(results: RouteResult[], m: Partial<RunMeta> = {}) {
    return fs.readFileSync(await writeReport(results, meta(m), dir, []), "utf8");
  }

  const route = (html: string, rt: string) =>
    html.match(new RegExp(`<li data-route="${rt.toLowerCase()}">[\\s\\S]*?</li>`))![0];

  test("every card has an id, and the sidebar links each width to it", async () => {
    const html = await report([at("/", 1440), at("/", 375), at("/Docs", 1440)]);
    for (const id of ["index.1440", "index.375", "Docs.1440"]) {
      assert.match(html, new RegExp(`<article class="card" id="${id}">`));
    }
    assert.match(
      route(html, "/"),
      /href="#index\.1440" title="100\.00%">1440<\/a>.*href="#index\.375"[^>]*>375<\/a>/,
    );
    assert.match(route(html, "/Docs"), /href="#Docs\.1440"/);
  });

  test("the filter box filters lowercased route names, client-side", async () => {
    const html = await report([at("/Docs", 1440)]);
    assert.match(
      html,
      /<input id="q" type="search" aria-label="Filter routes" placeholder="Filter 1 route\(s\)"/,
    );
    assert.match(html, /<li data-route="\/docs">/);
    assert.match(html, /li\.dataset\.route\.includes\(v\)/);
  });

  test("a route takes its worst shot's colour; an error links to the errors list", async () => {
    const html = await report(
      [
        at("/a", 1440),
        at("/a", 375, { score: 0.95, diffPixels: 9 }),
        at("/b", 1440),
        { ...at("/b", 375), status: "error", error: "boom" } as RouteResult,
        at("/c", 1440, { score: 0.5, diffPixels: 9, accepted: true }),
      ],
      { threshold: 0.9 },
    );
    assert.match(
      route(html, "/a"),
      /class="rt warn"[\s\S]*class="good"[^>]*>1440[\s\S]*class="warn"/,
    );
    assert.match(
      route(html, "/b"),
      /class="rt bad" href="#b\.1440"[\s\S]*class="bad" href="#errors" title="boom">375/,
    );
    assert.match(route(html, "/c"), /class="rt good"/);
    assert.match(html, /class="warn"><b>1<\/b> differ/);
    assert.match(html, /<section id="errors">/);
  });

  test("the summary counts, links the worst shot, and lists only the differing ones", async () => {
    const html = await report(
      [at("/a", 1440, { score: 0.8, diffPixels: 9 }), at("/b", 1440), at("/c", 1440)],
      { threshold: 0.9 },
    );
    const summary = html.match(/<section class="summary">[\s\S]*?<\/section>/)![0];
    assert.match(summary, /<b>3<\/b> route\(s\)/);
    assert.match(summary, /class="bad"><b>1<\/b> differ/);
    assert.match(summary, /worst <b class="bad">80\.00%<\/b>\s*<a href="#a\.1440">\/a @1440<\/a>/);
    const differs = summary.match(/<ul class="differs">[\s\S]*?<\/ul>/)![0];
    assert.match(differs, /\/a/);
    assert.doesNotMatch(differs, /<code>\/[bc]</);
    assert.doesNotMatch(summary, /<details>/);
  });

  test("evidence.html carries no script or sidebar", async () => {
    const html = await evidence([differs("/a")]);
    assert.doesNotMatch(html, /<script|<nav|id="q"/);
  });
});
