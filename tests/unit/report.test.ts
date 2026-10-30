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
  pixelFindings,
  verdict,
  writeEvidence,
  writeReport,
  writeResults,
  type ComparedResult,
  type Results,
  type RouteResult,
  type RunMeta,
} from "../../src/report.ts";
import { cleanupTempDirs, runCli, tempDir } from "../helpers/cli.ts";

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

describe("renderdiff report --markdown", () => {
  test("a section per route, right as before, left as after, links relative to the file", async () => {
    const out = path.join(tempDir(), "shot out");
    fs.mkdirSync(out);
    const imgs = (stem: string) => ({
      left: `${stem}.left.png`,
      right: `${stem}.right.png`,
      diff: `${stem}.diff.png`,
    });
    const results = [
      shot("/", { images: imgs("index.1440"), heightDelta: 24 }),
      shot("/", { width: 375, images: imgs("index.375") }),
      { ...shot("/b"), status: "error", error: "boom" } as RouteResult,
    ];
    writeResults(results, meta({ widths: [1440, 375] }), out, []);
    const md = path.join(out, "..", "pr", "pr.md");
    const r = await runCli(["report", out, "--markdown", md], { noOut: true });
    assert.equal(r.code, 0, r.stderr);
    const text = fs.readFileSync(md, "utf8");
    assert.deepEqual(text.match(/^## .*/gm), ["## /", "## /b"]);
    assert.match(text, /Before: https:\/\/example\.com\/ {2}\nAfter: http:\/\/localhost:3000\//);
    assert.deepEqual(text.match(/^\| \d+.*/gm), [
      "| 1440 (h+24px) | ![before](../shot%20out/index.1440.right.png) | ![after](../shot%20out/index.1440.left.png) |",
      "| 375 | ![before](../shot%20out/index.375.right.png) | ![after](../shot%20out/index.375.left.png) |",
      "| 1440 | error: boom | |",
    ]);
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

describe("pixelFindings", () => {
  const fonts = { added: [], removed: ["Inter 600"] };

  test("a face one side lacks on 2+ differing routes is a finding", () => {
    const f = pixelFindings([
      shot("/a", { diffPixels: 1, fonts }),
      shot("/b", { diffPixels: 1, fonts }),
    ]).find((f) => f.finding === 'fonts -"Inter 600"');
    assert.equal(f?.at.length, 2);
  });

  test("on clean routes it is not", () => {
    assert.deepEqual(pixelFindings([shot("/a", { fonts }), shot("/b", { fonts })]), []);
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

  test("a sidebar toggle swaps each card's three images for a left/right slider", async () => {
    const html = await report([at("/a", 1440)]);
    assert.match(html, /<input id="slide" type="checkbox">/);
    const card = html.match(/<article class="card"[\s\S]*?<\/article>/)![0];
    assert.match(
      card,
      /<div class="slider"[^>]*>\s*<img[^>]*src="a\.1440\.right\.png">\s*<div class="l"><img[^>]*src="a\.1440\.left\.png"><\/div>\s*<input type="range"/,
    );
    assert.deepEqual(
      [...card.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]),
      ["a.1440.left.png", "a.1440.right.png", "a.1440.diff.png"],
    );
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

describe("renderdiff merge", () => {
  const imgs = (stem: string) => ({
    left: `${stem}.left.png`,
    right: `${stem}.right.png`,
    diff: `${stem}.diff.png`,
  });
  const crop = (p: string) => ({ ...(differs("/") as ComparedResult).crops[0]!, path: p });
  const files = (r: RouteResult) =>
    r.status === "compared"
      ? [...Object.values(r.images), ...r.crops.map((c) => c.path)]
      : (r.frames ?? []);

  function outDir(tag: string, results: RouteResult[], m: Partial<RunMeta> = {}) {
    const d = path.join(tempDir(), "out");
    fs.mkdirSync(d);
    for (const r of results) for (const f of files(r)) fs.writeFileSync(path.join(d, f), tag);
    writeResults(results, meta({ generatedAt: `${tag}-at`, widths: [1440, 375], ...m }), d, []);
    return d;
  }

  const full = () =>
    outDir("full", [
      shot("/", {
        score: 0.9,
        diffPixels: 100,
        images: imgs("index.1440"),
        crops: [crop("index.1440.c1.png"), crop("index.1440.c2.png")],
      }),
      shot("/", { width: 375, images: imgs("index.375") }),
      shot("/a", { images: imgs("a.1440") }),
    ]);
  const partial = (extra: RouteResult[] = [], m: Partial<RunMeta> = {}) =>
    outDir(
      "partial",
      [
        shot("/", { images: imgs("index.1440") }),
        {
          ...shot("/b"),
          status: "error",
          error: "unsettled",
          frames: ["b.1440.left.unsettled-a.png", "b.1440.left.unsettled-b.png"],
        } as RouteResult,
        ...extra,
      ],
      { masks: [{ urlPath: "/", reason: "r" }], ...m },
    );
  const merge = (a: string, b: string, out: string) =>
    runCli(["merge", a, b, "--out", out], { noOut: true });

  test("replaces matching shots, adds the rest, and copies only what results.json references", async () => {
    const [a, b] = [full(), partial()];
    const out = path.join(tempDir(), "merged");
    const r = await merge(a, b, out);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /merged 2 shot\(s\) .*\(1 replaced, 1 added\)/);
    const got: Results = JSON.parse(fs.readFileSync(path.join(out, "results.json"), "utf8"));
    assert.deepEqual(
      got.results.map((x) => [x.url, x.width, x.from]),
      [
        ["/", 1440, "partial-at"],
        ["/", 375, undefined],
        ["/a", 1440, undefined],
        ["/b", 1440, "partial-at"],
      ],
    );
    assert.equal(got.summary.differing, 0);
    assert.deepEqual(got.meta.masks, [{ urlPath: "/", reason: "r" }]);
    assert.equal(got.meta.generatedAt, "full-at");
    const read = (f: string) => fs.readFileSync(path.join(out, f), "utf8");
    assert.equal(read("index.1440.left.png"), "partial");
    assert.equal(read("index.375.left.png"), "full");
    assert.equal(read("b.1440.left.unsettled-b.png"), "partial");
    assert.equal(fs.existsSync(path.join(out, "index.1440.c2.png")), false);
    assert.ok(fs.existsSync(path.join(out, "report.html")));
    assert.equal(banner(read("evidence.html")), "Not verified");
    assert.match(read("evidence.html"), /2 shot\(s\) merged from a later run/);
    assert.equal((await merge(a, b, out)).code, 0);
  });

  test("refuses other origins, an --out at or in an input, a directory it didn't write, and a missing file", async () => {
    const [a, b] = [full(), partial()];
    const other = partial([], { right: "https://other.example" });
    assert.match((await merge(a, other, path.join(tempDir(), "o"))).stderr, /✗ right differs/);
    const self = await merge(a, b, a);
    assert.equal(self.code, 2);
    assert.match(self.stderr, /is or is inside/);
    const link = path.join(tempDir(), "link");
    fs.symlinkSync(a, link);
    assert.match((await merge(a, b, `${link}/`)).stderr, /is or is inside/);
    assert.match((await merge(a, b, path.join(b, "sub"))).stderr, /is or is inside/);
    const kept = path.join(tempDir(), "kept");
    assert.equal((await merge(a, b, kept)).code, 0);
    fs.rmSync(path.join(b, "index.1440.left.png"));
    assert.match((await merge(a, b, kept)).stderr, /index\.1440\.left\.png is missing/);
    assert.ok(fs.existsSync(path.join(kept, "results.json")));
    const foreign = tempDir();
    fs.writeFileSync(path.join(foreign, "notes.txt"), "mine");
    const r = await merge(a, b, foreign);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /refusing to wipe/);
    assert.equal(fs.readFileSync(path.join(foreign, "notes.txt"), "utf8"), "mine");
  });

  test("refuses two kept shots writing one file before touching --out", async () => {
    const clash = shot("/A", { images: imgs("a.1440") });
    const out = path.join(tempDir(), "o");
    const r = await merge(full(), partial([clash]), out);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /\/a@1440 and \/A@1440 both write a\.1440\.left\.png/);
    assert.equal(fs.existsSync(out), false);
  });
});
