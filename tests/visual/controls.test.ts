/**
 * Negative controls: pages that must NOT score as parity.
 *
 * Without these the equivalence suite proves nothing — a tool that returned 100% for every
 * comparison would pass it completely. Each control isolates one kind of difference:
 *
 *   shifted  an 8px translation, nothing reflowed, heights identical
 *   taller   one extra section, so one side is padded with magenta
 *   color    one recoloured box, geometry untouched
 *   nav      one nav link missing on the left, so everything below it moves up 24px
 *
 * Bounds are set from measured values (recorded beside each assertion) and left loose enough
 * that font rendering cannot flip them, but far below parity. The point is direction, not a
 * particular percentage.
 *
 * The second half checks the other half of the contract: a low score is only a *failure* when
 * a threshold asked for one.
 */
import assert from "node:assert/strict";
import sharp from "sharp";
import { after, before, test } from "node:test";
import { CONTROLS, toPath } from "../helpers/corpus.ts";
import {
  cleanupTempDirs,
  context,
  runCli,
  renderdiffArgs,
  type CliResult,
} from "../helpers/cli.ts";
import {
  card,
  parseProgress,
  parseReport,
  result,
  results,
  row,
  type Report,
} from "../helpers/parse.ts";
import { startFixtureSite, type FixtureSite } from "../helpers/server.ts";

const WIDTHS = [1440, 375];

let site: FixtureSite;
let run: CliResult;
let report: Report;

before(
  async () => {
    site = await startFixtureSite();
    run = await runCli(
      renderdiffArgs({
        left: site.left,
        right: site.right,
        routes: CONTROLS.map(toPath),
        widths: WIDTHS,
        concurrency: 4,
      }),
    );
    const html = run.report();
    assert.ok(html, `no report was written${context(run)}`);
    report = parseReport(html);
  },
  { timeout: 300_000 },
);

after(async () => {
  await site?.close();
  cleanupTempDirs();
});

test("a difference is not an error — the run still exits 0 without a threshold", () => {
  // Scoring low is a measurement, not a failure. Only --threshold turns it into one.
  assert.equal(run.code, 0, `expected exit 0 with no threshold set${context(run)}`);
  assert.deepEqual(report.errors, []);
});

test("every control scores below parity", () => {
  const parity = report.cards.filter((c) => c.diffPixels === 0);
  assert.deepEqual(
    parity.map((c) => `${c.route}@${c.width}`),
    [],
    `these controls scored as identical, so they are testing nothing${context(run)}`,
  );
});

for (const width of WIDTHS) {
  test(`shifted @${width} is a pure translation: low score, no height change`, () => {
    const c = card(report, "/shifted", width);
    // Measured 97.61% @1440, 95.09% @375. An 8px shift leaves the interior of every solid
    // box identical, so the cost is edges and glyphs — which is exactly why it needs to be
    // caught rather than forgiven.
    assert.ok(c.score < 0.99, `expected < 0.99, got ${c.score}${context(run)}`);
    assert.ok(c.score > 0.85, `expected > 0.85, got ${c.score} — too different${context(run)}`);
    assert.equal(c.heightDelta, 0, `nothing should have reflowed${context(run)}`);
    assert.equal(c.widthDelta, 0);
    assert.ok(c.diffPixels > 0);
  });

  test(`taller @${width} is padded and the delta names the cause`, () => {
    const c = card(report, "/taller", width);
    // The right side has one more 240px band plus a 32px gap. Left is the shorter image, so
    // the delta is negative and left is the side that gets magenta padding.
    assert.equal(
      c.heightDelta,
      -272,
      `expected the left side to be 272px shorter${context(run)}`,
    );
    assert.equal(c.widthDelta, 0);
    // Measured 81.32% @1440, 83.18% @375. Padding counts against the score on purpose.
    assert.ok(c.score < 0.9, `expected < 0.9, got ${c.score}${context(run)}`);
    assert.equal(c.band, "bad");
  });

  test(`color @${width} catches a recolour with no geometry change`, () => {
    const c = card(report, "/color", width);
    // Measured 97.50% @1440, 93.17% @375. Nothing moves, so a comparison that tracked layout
    // instead of pixels would score this as parity.
    assert.equal(c.heightDelta, 0);
    assert.equal(c.widthDelta, 0);
    assert.ok(c.score < 0.99, `expected < 0.99, got ${c.score}${context(run)}`);
    assert.ok(c.score > 0.85, `expected > 0.85, got ${c.score}${context(run)}`);
  });
}

/** Top of the inserted fourth band on the right: 168 (@1440) / 208 (@375) to the first band, + 3 × (240 + 32). */
const FOURTH_BAND = { 1440: 984, 375: 1024 } as Record<number, number>;
/** Top of the Pricing link on the right: page padding + h1 + lede + two 24px links. */
const PRICING = { 1440: 192, 375: 232 } as Record<number, number>;

for (const width of WIDTHS) {
  test(`color @${width} is exactly one region, on the recoloured swatch`, () => {
    const r = row(parseProgress(run.stdout), "/color", width);
    assert.equal(r.regions, 1, context(run));
    // Swatch three of the first strip, 208×160 (343 wide at 375), snapped out to the 16px grid.
    const swatch =
      width === 1440
        ? { x: 736, y: 168, w: 208, h: 160 }
        : { x: 16, y: 576, w: 343, h: 160 };
    const g = r.largest!;
    assert.ok(g.x <= swatch.x && g.y <= swatch.y, `${JSON.stringify(g)}${context(run)}`);
    assert.ok(g.x + g.w >= swatch.x + swatch.w && g.y + g.h >= swatch.y + swatch.h);
    assert.ok(g.w - swatch.w < 32 && g.h - swatch.h < 32, `region too loose: ${JSON.stringify(g)}`);
    assert.deepEqual(r.bands, [], "a recolour moves no rows");
    assert.equal(r.added + r.removed, 0, "a recolour changes no text");
    const listed = card(report, "/color", width).regions;
    assert.equal(listed.length, 1, "the card lists the same single region");
    assert.deepEqual({ ...listed[0], pixels: undefined }, { ...g, pixels: undefined });
    assert.ok(listed[0]!.pixels > 0);
  });

  test(`taller @${width} aligns: one 272px band on the right, the rest identical`, () => {
    const r = row(parseProgress(run.stdout), "/taller", width);
    assert.equal(r.bands.length, 1, context(run));
    const [b] = r.bands;
    assert.equal(b!.side, "right");
    assert.equal(b!.delta, -272);
    // The 32px gap before the band is identical to the one after, so the band may start
    // anywhere along it. Measured: y=985 @1440, 1025 @375.
    assert.ok(Math.abs(b!.y - FOURTH_BAND[width]!) <= 32, `band at y=${b!.y}${context(run)}`);
    assert.equal(r.alignedScore, 1, "every paired row should match exactly");
    assert.equal(r.removed, 2, "Band four and its line exist on the right only");
    assert.equal(r.added, 0);
  });

  test(`shifted @${width} has no band: a horizontal shift moves no rows`, () => {
    const r = row(parseProgress(run.stdout), "/shifted", width);
    // Every row with a glyph or an edge differs, so rows either pair in place or (at 375)
    // differ past the edit-distance cap. Neither is a band.
    assert.deepEqual(r.bands, [], context(run));
    assert.equal(r.added + r.removed, 0, "same text on both sides");
  });

  test(`nav @${width} names the missing link and the 24px it took`, () => {
    const r = row(parseProgress(run.stdout), "/nav", width);
    assert.equal(r.heightDelta, -24, context(run));
    assert.deepEqual(r.bands.map((b) => [b.side, b.delta]), [["right", -24]], context(run));
    // The link's blank top rows match the line above, so the band may slide a few rows.
    // Measured: y=196 @1440, 236 @375.
    assert.ok(Math.abs(r.bands[0]!.y - PRICING[width]!) <= 8, `band at y=${r.bands[0]!.y}`);
    assert.equal(r.alignedScore, 1);
    const c = card(report, "/nav", width);
    assert.deepEqual(c.removed, ["Pricing"], context(run));
    assert.deepEqual(c.added, []);
    assert.equal(r.removed, 1);
  });
}

for (const route of ["/color", "/nav"]) {
  for (const width of WIDTHS) {
    test(`results.json agrees with the report card for ${route} @${width}`, () => {
      const r = result(results(run.outDir), route, width);
      const c = card(report, route, width);
      // The card rounds percentages to two places; the JSON has the full value.
      assert.equal(Number((r.score * 100).toFixed(2)) / 100, c.score, context(run));
      assert.equal(r.diffPixels, c.diffPixels);
      assert.equal(r.totalPixels, c.totalPixels);
      assert.equal(r.heightDelta, c.heightDelta);
      assert.equal(r.widthDelta, c.widthDelta);
      assert.equal(r.unstablePixels, c.unstablePixels);
      assert.deepEqual(r.regions.slice(0, 5), c.regions);
      assert.deepEqual(r.text, { added: c.added, removed: c.removed });
      assert.deepEqual(Object.values(r.images), c.images);
      assert.deepEqual(r.crops, c.crops);
    });
  }
}

test("results.json carries the run meta and a summary that matches the report", () => {
  const { meta, summary, results: rows } = results(run.outDir);
  assert.equal(meta.tool, "renderdiff");
  assert.match(meta.version, /^\d+\.\d+\.\d+/);
  assert.deepEqual([meta.left, meta.right, meta.widths], [site.left, site.right, WIDTHS]);
  assert.equal(meta.threshold, null);
  assert.ok(meta.blockUrlPatterns.length && meta.hideSelectors.length);
  assert.equal(rows.length, CONTROLS.length * WIDTHS.length);
  assert.equal(summary.compared, report.cards.length);
  assert.equal(summary.errors, 0);
  assert.equal(summary.belowThreshold, 0);
  assert.equal(Number((summary.worst!.score * 100).toFixed(2)) / 100, Math.min(...report.cards.map((c) => c.score)));
  assert.match(run.stdout, /^Results: .*results\.json$/m);
});

test("each region gets a crop: left | right | diff, padded, at most 1200px", async () => {
  const res = results(run.outDir);
  let seen = 0;
  for (const r of res.results) {
    assert.equal(r.status, "compared");
    if (r.status !== "compared") continue;
    assert.equal(r.crops.length, Math.min(5, r.regions.length), `${r.url}@${r.width}`);
    const left = await sharp(run.file(r.images.left)).metadata();
    const right = await sharp(run.file(r.images.right)).metadata();
    const cw = Math.min(left.width!, right.width!);
    const ch = Math.min(left.height!, right.height!);
    for (const [i, name] of r.crops.entries()) {
      assert.equal(name, `${r.url.slice(1)}.${r.width}.r${i + 1}.png`);
      const g = r.regions[i]!;
      // Three panels of the region padded by 48px and clipped, with 8px gaps, then scaled.
      const pw = Math.min(cw, g.x + g.w + 48) - Math.max(0, g.x - 48);
      const ph = Math.min(ch, g.y + g.h + 48) - Math.max(0, g.y - 48);
      const [w, h] = [3 * pw + 16, ph];
      const scale = Math.min(1, 1200 / Math.max(w, h));
      const m = await sharp(run.file(name)).metadata();
      assert.ok(Math.max(m.width!, m.height!) <= 1200, `${name} is ${m.width}×${m.height}`);
      assert.ok(Math.abs(m.width! - w * scale) <= 1 && Math.abs(m.height! - h * scale) <= 1,
        `${name} is ${m.width}×${m.height}, expected ${w}×${h} × ${scale}`);
      seen++;
    }
  }
  assert.ok(seen >= CONTROLS.length * WIDTHS.length, context(run));
});

test("the height badge is rendered on the taller and nav rows and nowhere else", () => {
  const moved = ["/taller", "/nav"];
  for (const c of report.cards) {
    const expected = moved.includes(c.route);
    assert.equal(
      c.heightDelta !== 0,
      expected,
      `${c.route}@${c.width} height delta ${c.heightDelta}${context(run)}`,
    );
  }
  // And on stdout, in the same places.
  for (const r of parseProgress(run.stdout)) {
    assert.equal(r.heightDelta !== 0, moved.includes(r.route));
  }
});

test("--threshold turns a low score into a failure", async () => {
  const r = await runCli(
    renderdiffArgs({
      left: site.left,
      right: site.right,
      routes: ["/shifted"],
      widths: [1440],
      threshold: 0.999,
    }),
  );
  assert.equal(r.code, 1, `expected exit 1 below threshold${context(r)}`);
  assert.match(r.stderr, /1 route\(s\) below 99\.90%/);
  // The report is still written — a failing run is the one you most want to look at.
  assert.ok(r.report(), "no report on a threshold failure");
});

test("the same run passes when no threshold is set", async () => {
  const r = await runCli(
    renderdiffArgs({
      left: site.left,
      right: site.right,
      routes: ["/shifted"],
      widths: [1440],
    }),
  );
  assert.equal(r.code, 0, context(r));
  assert.doesNotMatch(r.stderr, /below/);
});

test("a threshold the run clears does not fail it", async () => {
  const r = await runCli(
    renderdiffArgs({
      left: site.left,
      right: site.right,
      routes: ["/shifted"],
      widths: [1440],
      threshold: 0.9,
    }),
  );
  assert.equal(r.code, 0, context(r));
});
