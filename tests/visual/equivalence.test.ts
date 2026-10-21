/**
 * The corpus's central claim: pages that look the same score the same, however they were
 * built.
 *
 * Each route serves visually identical markup through a different CSS mechanism — flex against
 * grid, floats against flex, CSS tables against grid, transform-centring against
 * `place-items`, inline-block against flex. If the score tracked markup rather than pixels,
 * every one of these would fail. That is the property the tool is sold on: a CSS refactor that
 * changed nothing visible should read as "nothing changed".
 *
 * The assertion is `diffPixels === 0`, not a threshold. These pairs are exactly identical, so
 * there is no tolerance to calibrate and nothing to drift — a single differing pixel is a real
 * finding, either in the fixture or in the comparison.
 *
 * One browser launch for the whole file: a single run covers every route at both widths, and
 * the tests below read its results.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import sharp from "sharp";
import { after, before, test } from "node:test";
import { EQUIVALENCE, toPath } from "../helpers/corpus.ts";
import {
  cleanupTempDirs,
  context,
  runCli,
  renderdiffArgs,
  type CliResult,
} from "../helpers/cli.ts";
import { card, parseProgress, parseReport, row, type Report } from "../helpers/parse.ts";
import { startFixtureSite, type FixtureSite } from "../helpers/server.ts";

/** One desktop, one mobile. Both sides switch layout at 480px, so 375 is a real second case. */
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
        routes: EQUIVALENCE.map(toPath),
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

test("the run succeeds and measures every pair", () => {
  assert.equal(run.code, 0, `expected a clean exit${context(run)}`);
  const rows = parseProgress(run.stdout);
  assert.equal(rows.length, EQUIVALENCE.length * WIDTHS.length, context(run));
  assert.equal(
    rows.filter((r) => r.score === null).length,
    0,
    `some routes errored${context(run)}`,
  );
});

test("the report contains no error section", () => {
  assert.deepEqual(report.errors, [], context(run));
  assert.equal(report.cards.length, EQUIVALENCE.length * WIDTHS.length);
});

for (const dir of EQUIVALENCE) {
  for (const width of WIDTHS) {
    const route = toPath(dir);

    test(`${dir} @${width} is pixel-identical`, () => {
      const c = card(report, route, width);
      assert.equal(
        c.diffPixels,
        0,
        `${dir} @${width}: ${c.diffPixels} of ${c.totalPixels} pixels differ — ` +
          `open the diff column before relaxing this${context(run)}`,
      );
      assert.equal(c.score, 1);
      assert.equal(c.band, "good");
    });

    test(`${dir} @${width} matches in both dimensions`, () => {
      const c = card(report, route, width);
      // A height or width delta means one side is padded with magenta, which the score would
      // already have caught — but the delta is what names the cause, so check it directly.
      assert.equal(c.heightDelta, 0, `${dir} @${width} differs in height${context(run)}`);
      assert.equal(c.widthDelta, 0, `${dir} @${width} differs in width${context(run)}`);
    });

    test(`${dir} @${width} reports the same score on stdout as in the report`, () => {
      // The console summary and the HTML report are generated separately; a disagreement
      // between them would mean one of the two is lying.
      assert.equal(row(parseProgress(run.stdout), route, width).score, card(report, route, width).score);
    });

    test(`${dir} @${width} has no regions, no bands and no text diff`, () => {
      const r = row(parseProgress(run.stdout), route, width);
      assert.equal(r.regions, 0, context(run));
      assert.deepEqual(r.bands, []);
      assert.equal(r.alignedScore, null);
      assert.equal(r.unaligned, false);
      assert.equal(r.added + r.removed, 0, `same text on both sides${context(run)}`);
      const c = card(report, route, width);
      assert.deepEqual([c.regions, c.added, c.removed], [[], [], []]);
    });

    test(`${dir} @${width} writes all three images`, () => {
      const c = card(report, route, width);
      assert.equal(c.images.length, 3, "expected left, right and diff");
      for (const name of c.images) {
        assert.ok(fs.existsSync(run.file(name)), `${name} was linked but not written`);
        assert.ok(fs.statSync(run.file(name)).size > 0, `${name} is empty`);
      }
    });
  }
}

test("a pixel-identical pair writes a fully transparent diff", async () => {
  const c = card(report, toPath(EQUIVALENCE[0]!), WIDTHS[0]!);
  const diff = c.images.find((n) => n.endsWith(".diff.png"));
  assert.ok(diff, `no diff image linked${context(run)}`);
  assert.equal((await sharp(run.file(diff)).stats()).channels[3]!.max, 0);
});

test("every comparison landed in the green band", () => {
  // Restates the group claim in one place, so a regression that only hits some routes still
  // produces one obvious failure alongside the specific ones.
  const bad = report.cards.filter((c) => c.diffPixels !== 0);
  assert.deepEqual(
    bad.map((c) => `${c.route}@${c.width}: ${c.diffPixels}px`),
    [],
    context(run),
  );
});
