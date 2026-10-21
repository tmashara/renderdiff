/**
 * Negative controls: pages that must NOT score as parity.
 *
 * Without these the equivalence suite proves nothing — a tool that returned 100% for every
 * comparison would pass it completely. Each control isolates one kind of difference:
 *
 *   shifted  an 8px translation, nothing reflowed, heights identical
 *   taller   one extra section, so one side is padded with magenta
 *   color    one recoloured box, geometry untouched
 *
 * Bounds are set from measured values (recorded beside each assertion) and left loose enough
 * that font rendering cannot flip them, but far below parity. The point is direction, not a
 * particular percentage.
 *
 * The second half checks the other half of the contract: a low score is only a *failure* when
 * a threshold asked for one.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { CONTROLS, toPath } from "../helpers/corpus.ts";
import {
  cleanupTempDirs,
  context,
  runCli,
  renderdiffArgs,
  type CliResult,
} from "../helpers/cli.ts";
import { card, parseProgress, parseReport, type Report } from "../helpers/parse.ts";
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

test("the height badge is rendered on the taller rows and nowhere else", () => {
  for (const c of report.cards) {
    const expected = c.route === "/taller";
    assert.equal(
      c.heightDelta !== 0,
      expected,
      `${c.route}@${c.width} height delta ${c.heightDelta}${context(run)}`,
    );
  }
  // And on stdout, in the same places.
  for (const r of parseProgress(run.stdout)) {
    assert.equal(r.heightDelta !== 0, r.route === "/taller");
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
