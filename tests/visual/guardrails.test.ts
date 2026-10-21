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
import { card, parseProgress, parseReport } from "../helpers/parse.ts";
import { startFixtureSite, type FixtureSite } from "../helpers/server.ts";
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
const capture = (routes: string[], opts: { widths?: number[]; config?: string } = {}) =>
  runCli(
    renderdiffArgs({
      left: site.left,
      right: site.right,
      routes,
      widths: opts.widths ?? [1440],
      concurrency: 2,
      config: opts.config,
    }),
  );

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

  test("an unmeasured route is neither a pass nor a fail, but still exits 1", () => {
    assert.equal(run.code, 1, `an errored route must exit 1${context(run)}`);
    const report = parseReport(run.report()!);
    assert.ok(
      !report.cards.some((c) => c.route === "/blank"),
      "the refused route must not appear as a score",
    );
  });

  test("a healthy route in the same run is unaffected", () => {
    assert.equal(cardFor(run, "/animated").diffPixels, 0, context(run));
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
});

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
  });

  test("masking it reaches parity, and the report says what was masked", async () => {
    const run = await capture(["/drifting"], {
      config: path.join(CONFIGS, "mask-drifting.mjs"),
    });
    assert.equal(run.code, 0, context(run));
    assert.equal(
      cardFor(run, "/drifting").diffPixels,
      0,
      `the mask did not cover the drifting value${context(run)}`,
    );

    // The report has to list the reasons it actually masked, or it can drift from the config.
    const report = parseReport(run.report()!);
    assert.deepEqual(report.maskReasons, [
      "render counter on /drifting differs between the two origins",
    ]);
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

describe("the run summary", () => {
  test("errors are listed separately from scores on stdout", async () => {
    const run = await capture(["/blank", "/animated"]);
    const rows = parseProgress(run.stdout);
    assert.equal(rows.find((r) => r.route === "/blank")!.score, null);
    assert.equal(rows.find((r) => r.route === "/animated")!.score, 1);
    assert.match(run.stdout, /^Errors \(1\):$/m);
    assert.match(run.stdout, /\/blank@1440: page did not render/);
  });
});

describe("the output directory", () => {
  const into = (outDir: string) =>
    runCli(
      [
        ...renderdiffArgs({
          left: site.left,
          right: site.right,
          routes: ["/animated"],
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
    // The left side fails first and the right is never loaded, so a retry would make this 2.
    assert.equal(site.hits("/blank") - before, 1, context(run));
  });
});
