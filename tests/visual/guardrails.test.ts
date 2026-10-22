/**
 * One test per defence in `src/capture.ts` and `src/config.ts`.
 *
 * These are the promises that make the score mean anything. A screenshot diff that skipped
 * them would still produce numbers — it would just produce confident, wrong ones. Two error
 * pages match each other perfectly; so do two blank pages, and two pages whose lazy images
 * both failed to load.
 *
 * Most of these run as separate CLI invocations rather than one big run, because they expect
 * different exit codes. Each `run*()` helper does its own capture, so the file is the slowest
 * of the three visual suites.
 *
 * Where a defence can be checked by contrast, it is: `drifting` and `tracker` each run twice,
 * once without the relevant config and once with it, so the test shows the mechanism doing
 * something rather than just asserting a page happens to match.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { after, before, describe, test } from "node:test";
import {
  cleanupTempDirs,
  context,
  runCli,
  renderdiffArgs,
  tempDir,
  type CliResult,
} from "../helpers/cli.ts";
import { card, parseProgress, parseReport, parseSummary, result, results, row } from "../helpers/parse.ts";
import { PAGES_DIR, startFixtureSite, type FixtureSite } from "../helpers/server.ts";
import { EXPECT_HEIGHT } from "../fixtures/pages/tall/page.ts";

const CONFIGS = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "fixtures",
  "configs",
);

let site: FixtureSite;

before(async () => {
  site = await startFixtureSite();
});

after(async () => {
  await site?.close();
  cleanupTempDirs();
});

/** One CLI run against the fixture site. */
const capture = (routes: string[], opts: { widths?: number[]; config?: string; selector?: string } = {}) =>
  runCli([
    ...renderdiffArgs({
      left: site.left,
      right: site.right,
      routes,
      widths: opts.widths ?? [1440],
      concurrency: 2,
      config: opts.config,
    }),
    ...(opts.selector ? ["--selector", opts.selector] : []),
  ]);

/** The report card for a route, with the run's context attached to any failure. */
function cardFor(run: CliResult, route: string, width = 1440) {
  const html = run.report();
  assert.ok(html, `no report was written${context(run)}`);
  return card(parseReport(html), route, width);
}

describe("the render gate", () => {
  let run: CliResult;

  before(
    async () => {
      // Paired with a healthy route: one unusable page must not poison the others.
      run = await capture(["/blank", "/animated"]);
    },
    { timeout: 300_000 },
  );

  test("a page that did not render is an error, not a passing score", () => {
    // The failure mode this exists for: a blank page matches any other blank page perfectly,
    // so scoring it would report ~100% for two pages that rendered nothing at all.
    const html = run.report();
    assert.ok(html);
    const report = parseReport(html);
    assert.equal(report.errors.length, 1, `expected exactly one error${context(run)}`);
    assert.equal(report.errors[0]!.route, "/blank");
    assert.match(report.errors[0]!.message, /page did not render/);
    // The message carries the numbers that explain the refusal. Measured: text=17 chars.
    assert.match(report.errors[0]!.message, /text=\d+ chars/);
  });

  test("results.json lists the refused route as an error, beside the compared one", () => {
    const res = results(run.outDir);
    const blank = res.results.find((r) => r.url === "/blank");
    assert.equal(blank?.status, "error", context(run));
    assert.match(blank.status === "error" ? blank.error : "", /page did not render/);
    assert.equal(res.results.find((r) => r.url === "/animated")?.status, "compared");
    assert.deepEqual([res.summary.compared, res.summary.errors], [1, 1]);
  });

  test("an unmeasured route is neither a pass nor a fail, but still exits 3", () => {
    assert.equal(run.code, 3, `an errored route must exit 3${context(run)}`);
    const report = parseReport(run.report()!);
    assert.ok(
      !report.cards.some((c) => c.route === "/blank"),
      "the refused route must not appear as a score",
    );
  });

  test("a healthy route in the same run is unaffected", () => {
    assert.equal(cardFor(run, "/animated").diffPixels, 0, context(run));
  });

  test("an HTTP error status is an error that names the status", async () => {
    const run = await capture(["/no-such-route"]);
    assert.equal(run.code, 3, context(run));
    const report = parseReport(run.report()!);
    assert.equal(report.errors.length, 1, context(run));
    assert.match(report.errors[0]!.message, /HTTP 404/);
  });

  test("a document with no <body> is refused at once, not after a wait for one", async () => {
    const start = Date.now();
    const run = await capture(["/frameset"]);
    assert.match(run.stdout, /page did not render on either side/, context(run));
    assert.ok(Date.now() - start < 5_000, `took ${Date.now() - start}ms${context(run)}`);
  });

  test("a hidden SVG sprite does not count as rendered media", async () => {
    const run = await capture(["/sprite"]);
    assert.equal(run.code, 3, context(run));
    const report = parseReport(run.report()!);
    assert.equal(report.errors.length, 1, context(run));
    assert.match(report.errors[0]!.message, /page did not render/);
  });

  test("a short, nearly textless page with form controls is compared, not refused", async () => {
    // A sign-in form: under 200 chars of text, which the gate used to refuse on its own.
    const run = await capture(["/short"], { widths: [1440, 375] });
    assert.equal(run.code, 0, context(run));
    for (const width of [1440, 375]) {
      assert.equal(cardFor(run, "/short", width).diffPixels, 0, context(run));
    }
  });
});

describe("determinism", () => {
  test("new Date() and Math.random() render identically on both sides, unmasked", async () => {
    const run = await capture(["/clock"], { widths: [1440, 375] });
    assert.equal(run.code, 0, context(run));
    for (const width of [1440, 375]) {
      assert.equal(cardFor(run, "/clock", width).diffPixels, 0, context(run));
    }
  });
});

describe("the stability check", () => {
  test("a ticking element is reported as unstable and does not cost the score", async () => {
    const run = await capture(["/ticker"]);
    assert.equal(run.code, 0, context(run));
    const c = cardFor(run, "/ticker");
    assert.equal(c.diffPixels, 0, `unstable pixels counted against the score${context(run)}`);
    // Exactly the 928x160 box: every pixel of it changes between any two shots, nothing else does.
    assert.equal(c.unstablePixels, 928 * 160, context(run));
    assert.equal(result(results(run.outDir), "/ticker", 1440).unstablePixels, 928 * 160, context(run));
    // Unmeasured is not clean: the summary gives it a row that names the unstable pixels.
    const { clean, routes, verdict } = parseSummary(run.stdout);
    assert.deepEqual(clean, [], context(run));
    assert.match(routes.get("/ticker")!.rows[0]!.text, /unstable 148,480px/);
    assert.equal(verdict.differ, 0, "no pixel differs");
  });

  test("a page that is mostly unstable is an error, not a score", async () => {
    const run = await capture(["/unsettled"]);
    assert.equal(run.code, 3, context(run));
    const report = parseReport(run.report()!);
    assert.equal(report.errors.length, 1, context(run));
    assert.match(report.errors[0]!.message, /page did not settle: \d+px unstable at \/unsettled/);
  });

  test("a static page reports nothing unstable", async () => {
    const run = await capture(["/animated"]);
    assert.equal(cardFor(run, "/animated").unstablePixels, 0, context(run));
  });
});

describe("motion", () => {
  test("an animated page still compares as identical", async () => {
    // Both origins serve the same file, so any diff at all is motion that survived: a spinner
    // at 1.1s per revolution is at an arbitrary angle whenever the shot lands.
    const run = await capture(["/animated"], { widths: [1440, 375] });
    assert.equal(run.code, 0, context(run));
    for (const width of [1440, 375]) {
      assert.equal(cardFor(run, "/animated", width).diffPixels, 0, context(run));
    }
  });
});

describe("lazy images", () => {
  for (const route of ["/lazy-deep", "/lazy-js"]) {
    test(`${route}: images more than 4,000px below the fold load before the shot`, async () => {
      const run = await capture([route], { widths: [1440, 375] });
      assert.equal(run.code, 0, context(run));
      for (const width of [1440, 375]) {
        const c = cardFor(run, route, width);
        assert.equal(c.diffPixels, 0, `unloaded images at ${width}${context(run)}`);
        assert.equal(c.heightDelta, 0);
      }
    });
  }

  test("images below the fold are loaded before the shot", async () => {
    // The left side loads lazily, the right eagerly, and the fixture origin delays every image
    // by 150ms. Without the settle-scroll the left side would show empty boxes. Two pages that
    // were both blank would match, which is why the sides differ in loading strategy.
    const run = await capture(["/lazy"], { widths: [1440, 375] });
    assert.equal(run.code, 0, context(run));
    for (const width of [1440, 375]) {
      const c = cardFor(run, "/lazy", width);
      assert.equal(c.diffPixels, 0, `unloaded images at ${width}${context(run)}`);
      assert.equal(c.heightDelta, 0);
    }
  });
});

describe("consent chrome", () => {
  test("a vendor banner present on one side only is hidden", async () => {
    const run = await capture(["/consent"], { widths: [1440, 375] });
    assert.equal(run.code, 0, context(run));
    for (const width of [1440, 375]) {
      const c = cardFor(run, "/consent", width);
      assert.equal(
        c.diffPixels,
        0,
        `the #onetrust-consent-sdk banner reached the shot at ${width}${context(run)}`,
      );
      // Hidden, not removed — and it was `position: fixed`, so hiding it reflowed nothing.
      assert.equal(c.heightDelta, 0, `hiding the banner reflowed the page${context(run)}`);
    }
  });
});

describe("the tiled capture path", () => {
  let run: CliResult;

  before(
    async () => {
      run = await capture(["/tall"]);
    },
    { timeout: 300_000 },
  );

  test("a page past Chromium's one-shot cap is stitched to its exact height", async () => {
    assert.equal(run.code, 0, context(run));
    // The score alone would not prove the stitch: a truncated or double-counted tile can still
    // produce a matching pair, because both sides are truncated the same way. The height is
    // what pins it down — 18,000px is two tiles of 16,000 and 2,000.
    for (const side of ["left", "right", "diff"]) {
      const meta = await sharp(run.file(`tall.1440.${side}.png`)).metadata();
      assert.equal(
        meta.height,
        EXPECT_HEIGHT,
        `${side} image is ${meta.height}px, expected ${EXPECT_HEIGHT}${context(run)}`,
      );
    }
  });

  test("the stitched pair compares as identical", () => {
    // Flex column against grid auto-rows, at 18,000px.
    assert.equal(cardFor(run, "/tall").diffPixels, 0, context(run));
  });

  test("masks are applied in every tile", async () => {
    const masked = await capture(["/tall"], { config: path.join(CONFIGS, "mask-tall.mjs") });
    assert.equal(masked.code, 0, context(masked));
    const pixel = async (file: string, y: number) => [
      ...(await sharp(masked.file(file))
        .extract({ left: 720, top: y, width: 1, height: 1 })
        .removeAlpha()
        .raw()
        .toBuffer()),
    ];
    // Blocks are 180px: block 50 spans 8,820-9,000 (tile one), block 100 17,820-18,000 (tile two).
    for (const side of ["left", "right"]) {
      const file = `tall.1440.${side}.png`;
      assert.deepEqual(await pixel(file, 8_910), [255, 0, 255], `block 50 unmasked on ${side}`);
      assert.deepEqual(await pixel(file, 17_910), [255, 0, 255], `block 100 unmasked on ${side}`);
      assert.notDeepEqual(await pixel(file, 9_090), [255, 0, 255], `block 51 masked on ${side}`);
    }
  });

  test("the bottom tile is the page's own last rows, not padding or a repeat of the top", async () => {
    // A missing tile would be magenta padding; a wrapped one-shot repeats the top. The last
    // row is block 100's 1px #c9d4e2 border, which neither would give.
    for (const side of ["left", "right"]) {
      assert.deepEqual(await bottomRow(run.file(`tall.1440.${side}.png`)), [0xc9, 0xd4, 0xe2], `${side}${context(run)}`);
    }
  });

  test("an element taller than the cap is tiled too, down to its own last row", async () => {
    const el = await runCli([...renderdiffArgs({ left: site.left, right: site.right, routes: ["/tall"], widths: [1440] }), "--selector", ".stack"]);
    assert.equal(el.code, 0, context(el));
    for (const side of ["left", "right"]) {
      const file = el.file(`tall@_stack.1440.${side}.png`);
      assert.equal((await sharp(file).metadata()).height, EXPECT_HEIGHT, context(el));
      assert.deepEqual(await bottomRow(file), [0xc9, 0xd4, 0xe2], `${side}${context(el)}`);
    }
  });
});

/** The RGB of the last row's middle pixel. */
const bottomRow = async (file: string) => {
  const img = sharp(file);
  const { width = 0, height = 0 } = await img.metadata();
  return [...(await img.extract({ left: width >> 1, top: height - 1, width: 1, height: 1 }).removeAlpha().raw().toBuffer())];
};

describe("masks", () => {
  test("an unmasked drifting value costs the score", async () => {
    // Runs at 1440 only: the counter is rendered smaller at mobile, so it is a smaller share of
    // the page and the contrast with the masked run is less clear-cut.
    const run = await capture(["/drifting"]);
    const c = cardFor(run, "/drifting");
    // Measured 99.38%. What matters is that it is not parity.
    assert.ok(c.diffPixels > 0, `the fixture did not drift${context(run)}`);
    assert.ok(c.score < 0.999, `expected < 0.999, got ${c.score}${context(run)}`);
    assert.equal(c.heightDelta, 0, "masking should never have been about height");
    assert.deepEqual([c.added.length, c.removed.length], [1, 1], `the counter is text${context(run)}`);
  });

  test("masking it reaches parity, drops it from the text diff, and the report says what was masked", async () => {
    const run = await capture(["/drifting"], {
      config: path.join(CONFIGS, "mask-drifting.mjs"),
    });
    assert.equal(run.code, 0, context(run));
    assert.equal(
      cardFor(run, "/drifting").diffPixels,
      0,
      `the mask did not cover the drifting value${context(run)}`,
    );
    const c = cardFor(run, "/drifting");
    assert.deepEqual([c.added, c.removed], [[], []], `masked text leaked into the text diff${context(run)}`);

    // The report has to list the reasons it actually masked, or it can drift from the config.
    const report = parseReport(run.report()!);
    assert.deepEqual(report.maskReasons, [
      "render counter on /drifting differs between the two origins",
    ]);
  });
});

describe("selector masks", () => {
  test("a selector mask with no urlPath works like a locate mask", async () => {
    const run = await capture(["/drifting"], { config: path.join(CONFIGS, "mask-selector.mjs") });
    assert.equal(run.code, 0, context(run));
    const r = result(results(run.outDir), "/drifting", 1440);
    assert.equal(r.diffPixels, 0, `the selector mask did not cover the value${context(run)}`);
    assert.deepEqual([r.text.added, r.text.removed], [[], []], context(run));
  });
});

describe("route pairs", () => {
  const PAIR = "/flex-vs-grid::/float-vs-flex";

  test("each side loads its own path", async () => {
    const run = await capture([PAIR]);
    const r = result(results(run.outDir), PAIR, 1440);
    assert.deepEqual([r.left, r.right], ["/flex-vs-grid", "/float-vs-flex"]);
    assert.ok(r.text.added.includes("Card one"), `left did not load /flex-vs-grid${context(run)}`);
    assert.ok(r.text.removed.includes("Column one"), `right did not load /float-vs-flex${context(run)}`);
    assert.ok(parseSummary(run.stdout).routes.has(PAIR), context(run));
    assert.ok(r.images.left.startsWith("flex-vs-grid~float-vs-flex."), r.images.left);
    assert.ok(cardFor(run, PAIR), context(run));
  });

  test("a mask whose urlPath is only the left path, unnormalized, paints both sides", async () => {
    // The fixture server ignores the query, so the right side is /drifting under another path.
    const config = path.join(tempDir(), "mask.mjs");
    fs.writeFileSync(
      config,
      'export default { masks: [{ urlPath: "drifting/", reason: "drifts", selector: "[data-drift]" }] };\n',
    );
    const run = await capture(["/drifting::/drifting?pair"], { config });
    assert.equal(run.code, 0, context(run));
    const r = result(results(run.outDir), "/drifting::/drifting?pair", 1440);
    assert.equal(r.diffPixels, 0, `the mask missed a side${context(run)}`);
  });
});

describe("component scope", () => {
  const SWATCH = 'xpath=//h3[text()="Three"]/ancestor::div[1]';
  const scoped = (routes: string[], flags: string[], config?: string) =>
    runCli([...renderdiffArgs({ left: site.left, right: site.right, routes, widths: [1440], config }), ...flags]);

  test("a selector matching several elements, or none, errors at once with the count and side", async () => {
    assert.equal(
      (fs.readFileSync(path.join(PAGES_DIR, "flex-vs-grid", "left.html"), "utf8").match(/<article\b/g) ?? []).length,
      6,
    );
    const config = path.join(tempDir(), "counts.mjs");
    fs.writeFileSync(
      config,
      'export default { routes: [{ left: "/flex-vs-grid", selector: "article" }, { left: "/flex-vs-grid", selector: ".nope" }] };\n',
    );
    const start = Date.now();
    const run = await scoped([], [], config);
    // Not after Playwright's 30s wait.
    assert.ok(Date.now() - start < 5_000, `took ${Date.now() - start}ms${context(run)}`);
    assert.equal(run.code, 3, context(run));
    assert.match(run.stdout, /selector "article" matched 6 elements on left \(\/flex-vs-grid\), expected 1/, context(run));
    assert.match(run.stdout, /selector "\.nope" matched 0 elements on left/, context(run));
  });

  test("an element with no text that differs only in colour is scored, not refused as blank", async () => {
    const run = await scoped(["/stripe"], ["--selector", ".plain"]);
    assert.equal(run.code, 0, context(run));
    const r = result(results(run.outDir), "/stripe", 1440);
    assert.ok(r.score < 1 && r.diffPixels > 0, context(run));
  });

  test("an element whose only text is masked compares clean", async () => {
    const run = await scoped(["/drifting"], ["--selector", "[data-drift]"], path.join(CONFIGS, "mask-selector.mjs"));
    assert.equal(run.code, 0, context(run));
    assert.deepEqual(parseSummary(run.stdout).clean, ["/drifting [[data-drift]]"], context(run));
  });

  test("an element identical on both sides scores 100%, and its route reads as clean", async () => {
    const run = await scoped(["/flex-vs-grid"], ["--selector", "h1"]);
    assert.equal(run.code, 0, context(run));
    const r = result(results(run.outDir), "/flex-vs-grid", 1440);
    assert.equal(r.diffPixels, 0, context(run));
    assert.deepEqual(r.selector, { left: "h1", right: "h1" });
    assert.ok(r.totalPixels < 1440 * 100, `shot the page, not the h1${context(run)}`);
    assert.deepEqual(parseSummary(run.stdout).clean, ["/flex-vs-grid [h1]"], context(run));
  });

  test("the recoloured swatch alone scores low, with its region in the element's own pixels", async () => {
    const run = await scoped(["/color"], ["--selector", SWATCH, "--progress"]);
    assert.equal(run.code, 0, context(run));
    const r = result(results(run.outDir), "/color", 1440);
    assert.deepEqual(r.selector, { left: SWATCH, right: SWATCH });
    assert.equal(r.totalPixels, 208 * 160, context(run));
    assert.ok(r.score < 0.1, context(run));
    assert.deepEqual(r.regions.map(({ x, y, w, h }) => [x, y, w, h]), [[0, 0, 208, 160]], context(run));
    assert.deepEqual(r.regions[0]!.elements?.map((e) => [e.left, e.changed["background-color"]?.[1]]), [[{ x: 0, y: 0, w: 208, h: 160 }, "rgb(198, 40, 40)"]], "named in the element's own pixels");
    assert.equal(row(parseProgress(run.stdout), "/color", 1440).selector, SWATCH, context(run));
    assert.ok(cardFor(run, `/color [${SWATCH}]`), context(run));
    assert.ok(r.images.left.startsWith("color@xpath_"), r.images.left);
    // A rerun into the same out dir, so ours() accepts the `@` stems.
    const again = await runCli(
      [...renderdiffArgs({ left: site.left, right: site.right, routes: ["/color"], widths: [1440] }), "--selector", SWATCH, "--out", run.outDir],
      { noOut: true },
    );
    assert.equal(again.code, 0, context(again));
  });

  test("a mask is painted in the element's coordinates", async () => {
    const config = path.join(tempDir(), "mask.mjs");
    fs.writeFileSync(
      config,
      'export default { masks: [{ reason: "swatch", selector: ".strip:first-of-type > .swatch:nth-child(3)" }] };\n',
    );
    // The first strip sits below the page's top, so an untranslated mask would miss it.
    const run = await scoped(["/color"], ["--selector", ".strip >> nth=0"], config);
    assert.equal(run.code, 0, context(run));
    assert.equal(result(results(run.outDir), "/color", 1440).diffPixels, 0, context(run));
  });

  test("each side compares its own selector", async () => {
    const PAIR = "/color::/color?pair";
    const run = await scoped([PAIR], ["--left-selector", ".swatch >> nth=0", "--right-selector", ".swatch >> nth=1"]);
    assert.equal(run.code, 0, context(run));
    const r = result(results(run.outDir), PAIR, 1440);
    assert.deepEqual(r.selector, { left: ".swatch >> nth=0", right: ".swatch >> nth=1" });
    assert.deepEqual([r.text.added, r.text.removed], [["One"], ["Two"]], context(run));
    assert.match(r.images.left, /^color~color_pair@_swatch____nth_0~_swatch____nth_1\./);
  });

  test("a route listed once per selector compares each, into its own files", async () => {
    const config = path.join(tempDir(), "two.mjs");
    fs.writeFileSync(
      config,
      'export default { routes: [{ left: "/color", selector: ".swatch >> nth=2" }, { left: "/color", selector: "h1" }] };\n',
    );
    const run = await runCli([...renderdiffArgs({ left: site.left, right: site.right, routes: [], widths: [1440], config })]);
    const res = results(run.outDir);
    const [swatch, h1] = [result(res, "/color", 1440, ".swatch >> nth=2"), result(res, "/color", 1440, "h1")];
    assert.ok(swatch.diffPixels > 0 && h1.diffPixels === 0, context(run));
    assert.notEqual(swatch.images.left, h1.images.left);
    const summary = parseSummary(run.stdout);
    assert.deepEqual(summary.clean, ["/color [h1]"], context(run));
    assert.ok(summary.routes.has("/color [.swatch >> nth=2]"), context(run));
    assert.equal(summary.verdict.worst?.route, "/color [.swatch >> nth=2]", context(run));
  });
});

describe("before hooks", () => {
  const hooked = (config: string, routes: string[] = []) => {
    const file = path.join(tempDir(), "hook.mjs");
    fs.writeFileSync(file, `export default ${config};\n`);
    return capture(routes, { config: file });
  };

  test("without a hook the closed menu matches on both sides", async () => {
    const run = await capture(["/menu"]);
    assert.equal(run.code, 0, context(run));
    const r = result(results(run.outDir), "/menu", 1440);
    assert.equal(r.diffPixels, 0, context(run));
    assert.equal(r.hook, false);
    assert.equal(cardFor(run, "/menu").hook, false);
  });

  test("a route's hook opens the menu on both sides before the shot", async () => {
    const run = await hooked(
      '{ routes: [{ left: "/menu", before: async (page) => { await page.click("#toggle"); } }] }',
    );
    assert.equal(run.code, 0, context(run));
    const r = result(results(run.outDir), "/menu", 1440);
    // Each side's panel says something different, so this only differs if both opened.
    assert.ok(r.diffPixels > 0, `the hook did not run before the shot${context(run)}`);
    assert.deepEqual(r.text.added, ["Panel built by the left side"], context(run));
    assert.deepEqual(r.text.removed, ["Panel built by the right side, worded differently"], context(run));
    assert.equal(r.hook, true);
    assert.equal(cardFor(run, "/menu").hook, true, context(run));
  });

  test("a top-level hook runs for CLI routes, with the side, route and width", async () => {
    const run = await hooked(
      "{ before: async (page, { side, route, width }) => { " +
        'await page.locator("h1").evaluate((h, t) => (h.textContent = t), `${side} ${route} ${width}`); } }',
      ["/menu"],
    );
    assert.equal(run.code, 0, context(run));
    const r = result(results(run.outDir), "/menu", 1440);
    assert.deepEqual([r.text.added, r.text.removed], [["left /menu 1440"], ["right /menu 1440"]], context(run));
  });

  test("a route's own hook replaces the top-level one", async () => {
    const run = await hooked(
      '{ before: async () => { throw new Error("top-level ran"); }, routes: [{ left: "/menu", before: async () => {} }] }',
    );
    assert.equal(run.code, 0, context(run));
    assert.equal(result(results(run.outDir), "/menu", 1440).diffPixels, 0, context(run));
  });

  test("a hook that throws is a route error naming the hook, and is not retried", async () => {
    const before = site.hits("/menu");
    // A message the transient-error retry would otherwise match.
    const run = await hooked('{ before: async () => { throw new Error("net::ERR_FAKE from the hook"); } }', ["/menu"]);
    assert.equal(run.code, 3, context(run));
    const [r] = results(run.outDir).results;
    assert.equal(r?.status, "error", context(run));
    assert.equal(r?.status === "error" && r.error, "before hook failed on left: net::ERR_FAKE from the hook");
    assert.equal(r?.hook, true);
    assert.equal(site.hits("/menu") - before, 2, `the hook was retried${context(run)}`);
  });
});

describe("storage state", () => {
  const SECRET = "s3cret-session-token";
  const authIn = (dir: string) => {
    fs.writeFileSync(
      path.join(dir, "auth.json"),
      JSON.stringify({
        cookies: [{ name: "session", value: SECRET, domain: "127.0.0.1", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" }],
        origins: [],
      }),
    );
    return dir;
  };
  const leaks = (run: CliResult) =>
    [run.stdout, run.stderr, run.report() ?? "", fs.readFileSync(run.file("results.json"), "utf8")].some((s) => s.includes(SECRET));

  test("one side's file signs in that side only, and only its name is recorded", async () => {
    const cwd = authIn(tempDir("renderdiff-cwd-"));
    const run = await runCli(
      [...renderdiffArgs({ left: site.left, right: site.right, routes: ["/signed-in"], widths: [1440] }), "--left-storage-state", "auth.json"],
      { cwd },
    );
    assert.equal(run.code, 0, context(run));
    const res = results(run.outDir);
    const r = result(res, "/signed-in", 1440);
    assert.deepEqual([r.text.added, r.text.removed], [["Signed in as tester"], ["Signed out"]], context(run));
    assert.deepEqual(res.meta.storageState, { left: "auth.json", right: null });
    assert.ok(run.report()!.includes("left storage state <code>auth.json</code>"), context(run));
    assert.ok(!leaks(run), "the storage state's contents were written out");
  });

  test("a config's file, relative to the config, signs in both sides", async () => {
    const dir = authIn(tempDir());
    fs.writeFileSync(path.join(dir, "c.mjs"), 'export default { storageState: "auth.json" };\n');
    const run = await capture(["/signed-in"], { config: path.join(dir, "c.mjs") });
    assert.equal(run.code, 0, context(run));
    const res = results(run.outDir);
    const r = result(res, "/signed-in", 1440);
    assert.deepEqual([r.text.added, r.text.removed], [["Signed in as tester"], ["Signed in as tester (right)"]], context(run));
    assert.deepEqual(res.meta.storageState, { left: "auth.json", right: "auth.json" });
    assert.ok(!leaks(run), "the storage state's contents were written out");
  });
});

describe("the browser", () => {
  test("results.json records the browser", async () => {
    const run = await capture(["/short"]);
    assert.equal(run.code, 0, context(run));
    const { browser } = results(run.outDir).meta;
    assert.equal(browser.name, "chromium");
    assert.match(browser.version, /^\d+\./);
  });

  test("without the bundled Chromium it falls back to the system Chrome, or names the fix", async () => {
    // An empty browsers path hides the bundled Chromium. Which branch runs depends on whether
    // this machine has Chrome installed.
    const run = await runCli(renderdiffArgs({ left: site.left, right: site.right, routes: ["/tall"], widths: [1440] }), {
      env: { PLAYWRIGHT_BROWSERS_PATH: tempDir() },
    });
    if (run.code === 1 && !fs.existsSync(run.file("results.json"))) {
      assert.match(run.stderr, /npx playwright install chromium/, context(run));
      return;
    }
    assert.equal(run.code, 0, context(run));
    assert.match(run.stdout, /^Bundled Chromium failed to launch; using the system Chrome \d/m, context(run));
    assert.equal(results(run.outDir).meta.browser.name, "chrome");
    // Chrome wraps a one-shot capture past 16,384px, so this pins the tiled path there too.
    assert.deepEqual(await bottomRow(run.file("tall.1440.left.png")), [0xc9, 0xd4, 0xe2], context(run));
    const el = await runCli(
      [...renderdiffArgs({ left: site.left, right: site.right, routes: ["/tall"], widths: [1440] }), "--selector", ".stack"],
      { env: { PLAYWRIGHT_BROWSERS_PATH: tempDir() } },
    );
    assert.equal(el.code, 0, context(el));
    assert.deepEqual(await bottomRow(el.file("tall@_stack.1440.left.png")), [0xc9, 0xd4, 0xe2], context(el));
  });
});

describe("network blocking", () => {
  test("an unblocked third-party script rewrites the page and costs the score", async () => {
    const run = await capture(["/tracker"]);
    const c = cardFor(run, "/tracker");
    // Measured 78.42%. The injected band is 120px and pushes everything below it down, so the
    // left side is taller by exactly the band.
    assert.ok(c.score < 0.9, `expected < 0.9, got ${c.score}${context(run)}`);
    assert.equal(
      c.heightDelta,
      120,
      `expected the left side to be taller by the 120px band${context(run)}`,
    );
  });

  test("blocking the request reaches parity", async () => {
    const run = await capture(["/tracker"], {
      config: path.join(CONFIGS, "block-tracker.mjs"),
    });
    assert.equal(run.code, 0, context(run));
    const c = cardFor(run, "/tracker");
    assert.equal(c.diffPixels, 0, `the tracker band reached the shot${context(run)}`);
    assert.equal(c.heightDelta, 0);
  });

  test("a configured pattern is appended to the built-in list, not substituted for it", async () => {
    const run = await capture(["/tracker"], {
      config: path.join(CONFIGS, "block-tracker.mjs"),
    });
    const report = parseReport(run.report()!);
    assert.ok(
      report.blockPatterns.includes("**/shared/tracker.js"),
      `the configured pattern is missing from the report${context(run)}`,
    );
    // Losing the vendor defaults because a config added one pattern would be silent and bad.
    for (const builtin of [
      "**://*.googletagmanager.com/**",
      "**://*.onetrust.com/**",
      "**://*.visualwebsiteoptimizer.com/**",
    ]) {
      assert.ok(
        report.blockPatterns.includes(builtin),
        `${builtin} was dropped when the config added a pattern${context(run)}`,
      );
    }
  });
});

describe("crops", () => {
  test("a change too tall for one legible crop is clipped to its top, not shrunk or split", async () => {
    const run = await capture(["/tall-region"]);
    assert.equal(run.code, 0, context(run));
    const r = result(results(run.outDir), "/tall-region", 1440);
    assert.equal(r.crops.length, 1, context(run));
    const [c] = r.crops;
    assert.equal(c!.clipped, true);
    assert.ok(c!.scale >= 0.75, `scaled to ${c!.scale}`);
    const m = await sharp(run.file(c!.path)).metadata();
    assert.ok(Math.ceil(m.width! / 28) * Math.ceil(m.height! / 28) <= 1568, `${m.width}×${m.height}`);
  });
});

describe("element attribution", () => {
  test("a region names the element that fills it, not the page around it", async () => {
    const run = await capture(["/tall-region"]);
    const [e] = result(results(run.outDir), "/tall-region", 1440).regions[0]!.elements!;
    assert.equal(e!.selector, "div.column", context(run));
  });

  test("under fixed chrome, the element painted on top is named first", async () => {
    const run = await capture(["/fixed"], { widths: [1440, 375] });
    for (const width of [1440, 375]) {
      const els = result(results(run.outDir), "/fixed", width).regions[0]!.elements!;
      assert.equal(els[0]!.selector, "header.bar", context(run));
      assert.ok(!els.some((e) => e.selector === "div.under"), "the covered block is unchanged, so not named");
    }
  });

  test("an empty block inserted is named on its side only, not paired by nth-of-type", async () => {
    const run = await capture(["/inserted"], { widths: [1440, 375] });
    for (const width of [1440, 375]) {
      const band = result(results(run.outDir), "/inserted", width).bands!.find((b) => b.side === "left")!;
      // The right's first block sits where the inserted one does, under the same selector, but is 100px, not 80.
      assert.deepEqual(band.elements?.map((e) => [e.side, e.left?.h, e.right]), [["left", 80, null]], context(run));
    }
  });

  test("a selector built from an attribute with a newline escapes it as CSS, so --selector takes it", async () => {
    const run = await capture(["/labelled"]);
    const [e] = result(results(run.outDir), "/labelled", 1440).regions[0]!.elements!;
    assert.match(e!.selector, /aria-label="Second\\a block"/, context(run));
    const again = await capture(["/labelled"], { selector: e!.selector });
    assert.equal(again.code, 0, context(again));
    assert.equal(result(results(again.outDir), "/labelled", 1440).selector?.left, e!.selector);
  });
});

describe("band pairing", () => {
  test("a block removed at the top and another added at the bottom stay two bands", async () => {
    const run = await capture(["/reorder"]);
    const r = result(results(run.outDir), "/reorder", 1440);
    assert.deepEqual(r.bands?.map((b) => [b.side, b.h]), [["left", 96], ["right", 96]], context(run));
    assert.deepEqual(r.crops.map((c) => c.kind), ["band", "band"]);
  });

  test("a stripe recoloured inside identical rows is one region, not a band pair", async () => {
    const run = await capture(["/stripe"]);
    const r = result(results(run.outDir), "/stripe", 1440);
    assert.deepEqual(r.bands, [], context(run));
    assert.equal(r.regions.length, 1);
    assert.deepEqual(r.crops.map((c) => c.kind), ["region"]);
  });
});

describe("the run summary", () => {
  test("errors are listed separately from scores on stdout", async () => {
    const run = await capture(["/blank", "/animated"]);
    const { clean, routes, verdict } = parseSummary(run.stdout);
    assert.deepEqual(clean, ["/animated"], context(run));
    const blank = routes.get("/blank")!;
    assert.deepEqual(blank.rows, []);
    assert.equal(blank.errors.length, 1);
    // In full: the reason is what tells a blank page from a broken asset pipeline.
    assert.match(blank.errors[0]!.message, /^page did not render on either side \(left: .+; right: .+\) at \/blank$/);
    assert.deepEqual([verdict.differ, verdict.routes, verdict.errors], [0, 2, 1]);
  });

  test("a route that only errored doesn't count as differing, and one message covers its widths", async () => {
    const run = await capture(["/blank"], { widths: [1440, 375] });
    const { routes, verdict } = parseSummary(run.stdout);
    assert.deepEqual([verdict.differ, verdict.routes, verdict.shots, verdict.total, verdict.errors], [0, 1, 0, 2, 2], context(run));
    const errors = routes.get("/blank")!.errors;
    assert.equal(errors.length, 1, context(run));
    assert.deepEqual(errors[0]!.widths, [1440, 375]);
  });

  test("a threshold failure is on the verdict line even when another route errored", async () => {
    const run = await runCli(
      renderdiffArgs({ left: site.left, right: site.right, routes: ["/color", "/blank"], widths: [1440], threshold: 0.99 }),
    );
    assert.equal(run.code, 1, context(run));
    assert.deepEqual(parseSummary(run.stdout).verdict.below, { count: 1, threshold: 0.99 }, context(run));
    assert.match(run.stderr, /1 route\(s\) below 99\.00%/);
  });
});

describe("the output directory", () => {
  const into = (outDir: string, routes = ["/animated"]) =>
    runCli(
      [
        ...renderdiffArgs({
          left: site.left,
          right: site.right,
          routes,
          widths: [1440],
        }),
        "--out",
        outDir,
      ],
      { noOut: true },
    );

  test("a non-empty directory that is not a previous run is left alone", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "keep.txt"), "mine");
    const run = await into(dir);
    assert.equal(run.code, 2, context(run));
    assert.match(run.stderr, /refusing to wipe/);
    assert.ok(fs.existsSync(path.join(dir, "keep.txt")), "the directory was wiped");
  });

  test("a previous run's directory is wiped and reused", async () => {
    const dir = path.join(tempDir(), "out");
    const first = await into(dir);
    assert.equal(first.code, 0, context(first));
    fs.writeFileSync(path.join(dir, "stale.375.diff.png"), "");
    const second = await into(dir);
    assert.equal(second.code, 0, context(second));
    assert.ok(!fs.existsSync(path.join(dir, "stale.375.diff.png")), "the old run was not wiped");
  });

  test("a previous run with region crops and results.json is wiped and reused", async () => {
    const dir = path.join(tempDir(), "out");
    const first = await into(dir, ["/color"]);
    assert.equal(first.code, 0, context(first));
    assert.ok(fs.existsSync(path.join(dir, "color.1440.c1.png")), context(first));
    assert.ok(fs.existsSync(path.join(dir, "results.json")));
    const second = await into(dir, ["/color"]);
    assert.equal(second.code, 0, context(second));
  });

  test("a previous run of a route pair is wiped and reused", async () => {
    const dir = path.join(tempDir(), "out");
    const first = await into(dir, ["/flex-vs-grid::/float-vs-flex"]);
    assert.equal(first.code, 0, context(first));
    const second = await into(dir, ["/flex-vs-grid::/float-vs-flex"]);
    assert.equal(second.code, 0, context(second));
    assert.doesNotMatch(second.stderr, /refusing to wipe/, context(second));
  });

  test("an interrupted run's directory, with images but no report, is reused", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "x.1440.left.png"), "");
    const run = await into(dir);
    assert.equal(run.code, 0, context(run));
    assert.ok(!fs.existsSync(path.join(dir, "x.1440.left.png")), "the old run was not wiped");
  });
});

describe("image filenames", () => {
  test("routes that slug alike, or carry a query, still get their own images", async () => {
    // Both of these slugged to `color?a-b` once, so the second pair overwrote the first.
    const run = await capture(["/color?a/b", "/color?a-b"]);
    const html = run.report();
    assert.ok(html, `no report was written${context(run)}`);
    const images = parseReport(html).cards.flatMap((c) => c.images);
    assert.equal(images.length, 6, context(run));
    assert.equal(new Set(images).size, 6, `images shared between routes: ${images}`);
    for (const name of images) {
      assert.match(name, /^[a-z0-9_.-]+$/, `${name} is not a safe filename`);
      assert.ok(fs.existsSync(run.file(name)), `${name} was not written`);
    }
  });
});

describe("retries", () => {
  test("a page that did not render is not retried", async () => {
    const before = site.hits("/blank");
    const run = await capture(["/blank"]);
    assert.match(run.stdout, /page did not render/, context(run));
    // Both sides load once, concurrently; a retry would make this 4.
    assert.equal(site.hits("/blank") - before, 2, context(run));
  });

  test("an HTTP error status is not retried", async () => {
    const before = site.hits("/no-such-route");
    const run = await capture(["/no-such-route"]);
    assert.match(run.stdout, /HTTP 404/, context(run));
    assert.equal(site.hits("/no-such-route") - before, 2, context(run));
  });
});
