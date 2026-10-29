/**
 * Negative controls: pages that must NOT score as parity.
 *
 * Without these the equivalence suite proves nothing — a tool that returned 100% for every
 * comparison would pass it completely. Each control isolates one kind of difference:
 *
 *   shifted  an 8px translation, nothing reflowed, heights identical
 *   taller   one extra section, so one side is padded with magenta
 *   color    one recoloured box, geometry untouched
 *   tint     the same, but a pink a few units off: the per-pixel threshold must see it
 *   nav      one nav link missing on the left, so everything below it moves up 24px
 *   margin   one chip's margin-left changed, so it and the chip after it move 8px
 *
 * Bounds are set from measured values (recorded beside each assertion) and left loose enough
 * that font rendering cannot flip them, but far below parity. The point is direction, not a
 * particular percentage.
 *
 * The second half checks the other half of the contract: any difference fails the run, unless
 * a threshold relaxes that.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { after, before, test } from "node:test";
import { fmtLine } from "../../src/format.ts";
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
  parseSummary,
  result,
  results,
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

test("a difference exits 1 without a threshold, and is not an error", () => {
  assert.equal(run.code, 1, `expected exit 1 with no threshold set${context(run)}`);
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
    assert.equal(c.heightDelta, -272, `expected the left side to be 272px shorter${context(run)}`);
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
    const r = result(results(run.outDir), "/color", width);
    assert.equal(r.regions.length, 1, context(run));
    // Swatch three of the first strip, 208×160 (343 wide at 375), snapped out to the 16px grid.
    const swatch =
      width === 1440 ? { x: 736, y: 168, w: 208, h: 160 } : { x: 16, y: 576, w: 343, h: 160 };
    const g = r.regions[0]!;
    assert.ok(g.x <= swatch.x && g.y <= swatch.y, `${JSON.stringify(g)}${context(run)}`);
    assert.ok(g.x + g.w >= swatch.x + swatch.w && g.y + g.h >= swatch.y + swatch.h);
    assert.ok(g.w - swatch.w < 32 && g.h - swatch.h < 32, `region too loose: ${JSON.stringify(g)}`);
    assert.deepEqual(r.bands, [], "a recolour moves no rows");
    assert.deepEqual(r.text, { added: [], removed: [] }, "a recolour changes no text");
    const listed = card(report, "/color", width).regions;
    assert.deepEqual(
      listed.map(({ dom, line, ...b }) => b),
      [{ x: g.x, y: g.y, w: g.w, h: g.h, pixels: g.pixels }],
      "the card lists the same single region",
    );
    assert.ok(g.pixels > 0);
  });

  test(`taller @${width} aligns: one 272px band on the right, the rest identical`, () => {
    const r = result(results(run.outDir), "/taller", width);
    assert.equal(r.bands?.length, 1, context(run));
    const [b] = r.bands!;
    assert.equal(b!.side, "right");
    assert.equal(b!.h, 272);
    // The 32px gap before the band is identical to the one after, so the band may start
    // anywhere along it. Measured: y=985 @1440, 1025 @375.
    assert.ok(Math.abs(b!.y - FOURTH_BAND[width]!) <= 32, `band at y=${b!.y}${context(run)}`);
    assert.equal(r.alignedScore, 1, "every paired row should match exactly");
    assert.equal(r.text.removed.length, 2, "Band four and its line exist on the right only");
    assert.equal(r.text.added.length, 0);
  });

  test(`shifted @${width} has no band: a horizontal shift moves no rows`, () => {
    const r = result(results(run.outDir), "/shifted", width);
    // Every row with a glyph or an edge differs, so rows either pair in place or (at 375)
    // differ past the edit-distance cap. Neither is a band.
    assert.deepEqual(r.bands, [], context(run));
    assert.deepEqual(r.text, { added: [], removed: [] }, "same text on both sides");
  });

  test(`nav @${width} names the missing link and the 24px it took`, () => {
    const r = result(results(run.outDir), "/nav", width);
    assert.equal(r.heightDelta, -24, context(run));
    assert.deepEqual(
      r.bands?.map((b) => [b.side, b.h]),
      [["right", 24]],
      context(run),
    );
    // The link's blank top rows match the line above, so the band may slide a few rows.
    // Measured: y=196 @1440, 236 @375.
    assert.ok(Math.abs(r.bands![0]!.y - PRICING[width]!) <= 8, `band at y=${r.bands![0]!.y}`);
    assert.equal(r.alignedScore, 1);
    const c = card(report, "/nav", width);
    assert.deepEqual(c.removed, ["Pricing"], context(run));
    assert.deepEqual(c.added, []);
    assert.deepEqual(r.text, { added: [], removed: ["Pricing"] });
  });
}

for (const route of ["/color", "/nav", "/divider"]) {
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
      assert.deepEqual(
        r.regions
          .slice(0, 5)
          .map(({ elements, hash, line, ...g }) => ({ ...g, line: line ? fmtLine(line) : null })),
        c.regions.map(({ dom, ...g }) => g),
      );
      assert.deepEqual(r.text, { added: c.added, removed: c.removed });
      assert.deepEqual(Object.values(r.images), c.images);
      assert.deepEqual(
        r.crops.map((x) => x.path),
        c.crops,
      );
    });
  }
}

for (const width of WIDTHS) {
  test(`margin @${width} names the chip whose margin changed, and the value on each side`, () => {
    const r = result(results(run.outDir), "/margin", width);
    const named = r.regions.flatMap((g) => g.elements ?? []);
    const blog = named.find((e) => /a\[href="#blog"\]/.test(e.selector));
    assert.ok(blog, `${JSON.stringify(r.regions)}${context(run)}`);
    assert.equal(blog.side, "both");
    assert.deepEqual(blog.changed["margin-left"], ["24px", "16px"]);
    // Contact moved with it but has no style of its own that changed.
    const contact = named.find((e) => /#contact/.test(e.selector));
    assert.deepEqual(
      contact && [contact.changed, contact.left!.x - contact.right!.x],
      [{}, 8],
      context(run),
    );
  });

  test(`nav @${width} names the link only the right has, in its band`, () => {
    const r = result(results(run.outDir), "/nav", width);
    assert.deepEqual(
      r.bands![0]!.elements?.map((e) => [e.side, e.text, e.left]),
      [["right", "Pricing", null]],
      context(run),
    );
    assert.match(r.bands![0]!.elements![0]!.selector, /a\[href="#pricing"\]/);
  });

  test(`color @${width} names the swatch and its new background`, () => {
    const [e] = result(results(run.outDir), "/color", width).regions[0]!.elements!;
    assert.match(e!.selector, /swatch/, context(run));
    assert.deepEqual(e!.changed, { "background-color": ["rgb(31, 111, 235)", "rgb(198, 40, 40)"] });
  });

  test(`tint @${width} catches a pink a few units off, the swatch only`, () => {
    const r = result(results(run.outDir), "/tint", width);
    assert.equal(r.regions.length, 1, context(run));
    assert.deepEqual(r.regions[0]!.elements![0]!.changed, {
      "background-color": ["rgb(246, 51, 154)", "rgb(236, 72, 153)"],
    });
  });
}

for (const width of WIDTHS) {
  test(`divider @${width} names the lost ::before line, and the card's re-parented pairing`, () => {
    const r = result(results(run.outDir), "/divider", width);
    const line = r.regions.find((g) => g.line);
    assert.deepEqual(line && [line.line!.side, line.line!.h], ["right", 1], context(run));
    const named = r.regions.flatMap((g) => g.elements ?? []);
    const rule = named.find((e) => e.selector.endsWith(".rule::before"));
    assert.equal(rule?.side, "right", JSON.stringify(named));
    const card = named.find((e) => e.selector.endsWith(".card"));
    assert.equal(card?.reparented, true, JSON.stringify(named));
    const border = named.find((e) => e.selector.endsWith(".card::after"));
    assert.deepEqual(border?.changed["border-top-width"], ["0px", "1px"], JSON.stringify(named));
    assert.equal(border?.reparented, true);
    const rows = parseSummary(run.stdout).routes.get("/divider")!.rows;
    assert.ok(
      rows.some((x) => /line -1px@y/.test(x.text)),
      context(run),
    );
    assert.match(run.stdout, /-div\.rule::before/, context(run));
    assert.match(run.stdout, /\(re-parented\)/, context(run));
  });
}

test("a named element's selector is unique on both sides, so --selector takes it", async () => {
  const [blog] = result(results(run.outDir), "/margin", 1440)
    .regions.flatMap((g) => g.elements ?? [])
    .filter((e) => /#blog/.test(e.selector));
  const r = await runCli([
    ...renderdiffArgs({ left: site.left, right: site.right, routes: ["/margin"], widths: [1440] }),
    "--selector",
    blog!.selector,
  ]);
  assert.equal(r.code, 0, context(r));
  assert.equal(result(results(r.outDir), "/margin", 1440).selector?.left, blog!.selector);
});

test("the piped summary and the report card show the same elements", () => {
  const { routes } = parseSummary(run.stdout);
  assert.match(
    routes.get("/margin")!.rows[0]!.dom ?? "",
    /a\[href="#blog"\] margin-left 24px→16px/,
    context(run),
  );
  assert.equal(
    routes.get("/nav")!.rows[0]!.dom,
    '@1440 -a[href="#pricing"] "Pricing"',
    context(run),
  );
  const dom = routes.get("/color")!.rows[0]!.dom;
  assert.equal(`@1440 ${card(report, "/color", 1440).regions[0]!.dom}`, dom, context(run));
  assert.equal(
    `@1440 ${card(report, "/nav", 1440).bands[0]!.dom}`,
    routes.get("/nav")!.rows[0]!.dom,
  );
});

test("results.json carries the run meta and a summary that matches the report", () => {
  const { meta, summary, results: rows } = results(run.outDir);
  assert.equal(meta.tool, "renderdiff");
  assert.match(meta.version, /^\d+\.\d+\.\d+/);
  assert.deepEqual([meta.left, meta.right, meta.widths], [site.left, site.right, WIDTHS]);
  assert.equal(meta.threshold, null);
  assert.ok(meta.blockUrlPatterns.length && meta.hideSelectors.length);
  assert.equal(rows.length, CONTROLS.length * WIDTHS.length);
  for (const r of rows) {
    if (r.status === "compared")
      assert.ok(
        r.score < 1 && r.score * 1e4 === Math.round(r.score * 1e4),
        `${r.url}@${r.width}: ${r.score}`,
      );
  }
  assert.equal(summary.compared, report.cards.length);
  assert.equal(summary.errors, 0);
  assert.equal(summary.belowThreshold, 0);
  assert.equal(summary.differing, rows.filter((r) => r.status === "compared").length);
  assert.equal(
    Number((summary.worst!.score * 100).toFixed(2)) / 100,
    Math.min(...report.cards.map((c) => c.score)),
  );
  // Each control is a different change, so none groups with another.
  assert.deepEqual(summary.findings, [], context(run));
  assert.doesNotMatch(run.stdout, /^findings:/m);
});

test("piped stdout is one compact summary: no clean routes, widths collapsed, a verdict", () => {
  const { clean, routes, verdict } = parseSummary(run.stdout);
  const res = results(run.outDir);
  assert.deepEqual(clean, [], context(run));
  assert.deepEqual([...routes.keys()], CONTROLS.map(toPath));
  const worst = res.summary.worst!;
  assert.deepEqual(verdict, {
    differ: CONTROLS.length,
    routes: CONTROLS.length,
    shots: CONTROLS.length * WIDTHS.length,
    total: CONTROLS.length * WIDTHS.length,
    errors: 0,
    worst: {
      score: Number((worst.score * 100).toFixed(2)) / 100,
      route: worst.url,
      width: worst.width,
    },
    below: null,
    results: run.file("results.json"),
  });
  // Both widths agree on everything but the score, so they share one row.
  const nav = routes.get("/nav")!;
  assert.deepEqual(
    nav.rows.map((r) => r.widths),
    [WIDTHS],
    context(run),
  );
  assert.match(
    nav.rows[0]!.text,
    /^[\d.]+%–[\d.]+%  h-24  band -24@y~\d+  aligned 100\.00%  .*text -"Pricing"$/,
  );
  assert.doesNotMatch(run.stdout, /\[\d+\/\d+\]|^Report:/m, "no per-shot lines when piped");
  for (const [route, { rows }] of routes) {
    for (const r of rows) {
      const want = r.widths.flatMap((w) => result(res, route, w).crops.map((c) => c.path));
      assert.ok(want.length, `${route}: no crops to list${context(run)}`);
      assert.deepEqual(r.crops, want, context(run));
      for (const c of r.crops)
        assert.ok(fs.existsSync(path.join(path.dirname(verdict.results), c)), c);
    }
  }
});

test("--progress prints a line per shot with the score results.json has", async () => {
  const r = await runCli([
    ...renderdiffArgs({ left: site.left, right: site.right, routes: ["/nav"], widths: [1440] }),
    "--progress",
  ]);
  assert.equal(r.code, 1, context(r));
  const [p] = parseProgress(r.stdout);
  const j = result(results(r.outDir), "/nav", 1440);
  assert.equal(p!.score, Number((j.score * 100).toFixed(2)) / 100, context(r));
  assert.deepEqual([p!.heightDelta, p!.bands.map((b) => b.delta), p!.removed], [-24, [-24], 1]);
  assert.match(r.stdout, /^Results: .*results\.json$/m);
});

const tokens = (w: number, h: number) => Math.ceil(w / 28) * Math.ceil(h / 28);

test("every crop fits Claude's image budget, at most three per comparison", async () => {
  let seen = 0;
  for (const r of results(run.outDir).results) {
    if (r.status !== "compared") continue;
    assert.ok(r.crops.length <= 3, `${r.url}@${r.width} has ${r.crops.length} crops`);
    for (const [i, c] of r.crops.entries()) {
      assert.equal(c.path, `${r.url.slice(1)}.${r.width}.c${i + 1}.png`);
      const m = await sharp(run.file(c.path)).metadata();
      assert.ok(Math.max(m.width!, m.height!) <= 1568, `${c.path} is ${m.width}×${m.height}`);
      assert.ok(
        tokens(m.width!, m.height!) <= 1568,
        `${c.path} is ${tokens(m.width!, m.height!)} tokens`,
      );
      assert.ok(c.scale >= 0.75 && c.scale <= 1, `${c.path} at ${c.scale}`);
      seen++;
    }
  }
  assert.ok(seen >= CONTROLS.length * WIDTHS.length, context(run));
});

test("/nav @1440 crops the missing link, not the content it pushed up", async () => {
  const r = result(results(run.outDir), "/nav", 1440);
  assert.equal(r.crops.length, 1, context(run));
  const [c] = r.crops;
  assert.equal(c!.kind, "band");
  assert.ok(Math.abs(c!.right.y - PRICING[1440]!) <= 8 && c!.right.h === 24, JSON.stringify(c));
  assert.equal(c!.left.h, 0, "the left side lacks the rows: an insertion point");
  assert.equal(c!.scale, 1);
  // As wide as the link plus context, not the page.
  assert.ok((await sharp(run.file(c!.path)).metadata()).width! <= 400);
});

test("/taller @1440 crops the extra band, left over right at native scale", () => {
  const r = result(results(run.outDir), "/taller", 1440);
  assert.equal(r.crops.length, 1, context(run));
  const [c] = r.crops;
  assert.deepEqual(
    [c!.kind, c!.right.h, c!.left.h, c!.layout, c!.scale],
    ["band", 272, 0, "stacked", 1],
  );
});

for (const width of WIDTHS) {
  test(`/color @${width} crops the one region, the same box on both sides`, () => {
    const r = result(results(run.outDir), "/color", width);
    assert.equal(r.crops.length, 1, context(run));
    const [c] = r.crops;
    const { x, y, w, h } = r.regions[0]!;
    const box = { x, y, w, h };
    assert.deepEqual(
      [c!.kind, c!.left, c!.right, c!.scale, c!.clipped],
      ["region", box, box, 1, false],
    );
  });
}

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
  // And in the compact stdout rows, in the same places.
  for (const [route, { rows }] of parseSummary(run.stdout).routes) {
    for (const r of rows) assert.equal(/  h[+-]\d+/.test(r.text), moved.includes(route), r.text);
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
  assert.match(r.stderr, /✗ 1 route below 99\.90% \(1 shot\)\./);
  // The report is still written — a failing run is the one you most want to look at.
  assert.ok(r.report(), "no report on a threshold failure");
});

test("any difference fails when no threshold is set, counted in routes and shots", async () => {
  const r = await runCli(
    renderdiffArgs({
      left: site.left,
      right: site.right,
      routes: ["/shifted", "/margin"],
      widths: [1440, 896],
    }),
  );
  assert.equal(r.code, 1, context(r));
  assert.match(r.stderr, /✗ 2 routes differ \(4 shots\)\./, context(r));
});

test("--threshold 0 never fails on a difference", async () => {
  const r = await runCli(
    renderdiffArgs({
      left: site.left,
      right: site.right,
      routes: ["/shifted"],
      widths: [1440],
      threshold: 0,
    }),
  );
  assert.equal(r.code, 0, context(r));
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

test("a finding repeated on two routes is listed once, with every route and width", async () => {
  const r = await runCli(
    renderdiffArgs({
      left: site.left,
      right: site.right,
      // The fixture server routes on the path, so both are /nav.
      routes: ["/nav", "/nav?again"],
      widths: WIDTHS,
    }),
  );
  assert.equal(r.code, 1, context(r));
  const at = [
    { url: "/nav", widths: WIDTHS },
    { url: "/nav?again", widths: WIDTHS },
  ];
  assert.deepEqual(
    results(r.outDir).summary.findings,
    [
      { finding: '-"Pricing"', at },
      { finding: '-a[href="#pricing"] "Pricing"', selector: 'a[href="#pricing"]', at },
    ],
    context(r),
  );
  assert.match(r.stdout, /^findings: 2 repeated on 2\+ routes$/m);
  assert.ok(
    r.stdout.includes(
      '\n  -a[href="#pricing"] "Pricing"  ×2 routes  /nav@1440,375 /nav?again@1440,375\n',
    ),
    context(r),
  );
  assert.match(r.report()!, /Findings: 2 repeated/);
});

test("--computed names the changed rule's property, once across widths, and the dom verdict", async () => {
  const r = await runCli([
    ...renderdiffArgs({
      left: site.left,
      right: site.right,
      routes: ["/margin", "/color", "/inserted", "/origin"],
      widths: WIDTHS,
    }),
    "--computed",
  ]);
  // Pixels decide the exit code: these routes differ, so 1, as without --computed.
  assert.equal(r.code, 1, context(r));
  const { results: rows, summary } = results(r.outDir);
  const dom = (route: string) =>
    rows.filter((x) => x.url === route).map((x) => x.status === "compared" && x.computed?.dom);
  assert.deepEqual(dom("/margin"), [0, 0], context(r));
  assert.deepEqual(dom("/color"), [0, 0]);
  assert.deepEqual(dom("/origin"), [0, 0], context(r));
  assert.ok(!summary.computed!.some((f) => f.at.some((a) => a.url === "/origin")), context(r));
  assert.ok(dom("/inserted").every((n) => typeof n === "number" && n > 0));
  const blog = summary.computed!.find((f) => f.key.endsWith(`a[href="#blog"]`));
  assert.deepEqual(blog && [blog.prop, blog.values, blog.at], [
    "margin-left",
    ["24px", "16px"],
    [{ url: "/margin", widths: WIDTHS }],
  ]);
  assert.ok(
    summary.computed!.some(
      (f) => /swatch/.test(f.key) && f.prop === "background-color" && f.at[0]!.url === "/color",
    ),
  );
  // /margin's Contact chip only moved, so it is no finding of its own.
  assert.ok(!summary.computed!.some((f) => /#contact/.test(f.key)), context(r));
  const inserted = rows.find((x) => x.url === "/inserted" && x.status === "compared");
  assert.ok(inserted?.status === "compared" && inserted.computed!.unmatched.left.length === 1);
  assert.match(
    r.stdout,
    /^computed: \d+ findings?; dom identical on 3 of 4 route\(s\), differs \/inserted/m,
  );
  assert.match(r.stdout, /a\[href="#blog"\] margin-left 24px→16px {2}\/margin@1440,375/);
});
