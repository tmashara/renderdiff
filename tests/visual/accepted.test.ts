/**
 * Accepted differences and --rerun-failed: the loop a migration runs in. Record what already
 * differs, change code, re-check only what's red.
 *
 * A `before` hook that restyles the left side stands in for "changed code": the fixture pages
 * are static, and a hook is the one way to change a side between two runs of the same route.
 * Each acceptance is paired with a control, so the mechanism is shown hiding only what it was
 * told to: a new change elsewhere on an accepted page, and a different change in the same spot,
 * both still surface.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { cleanupTempDirs, context, renderdiffArgs, runCli, tempDir } from "../helpers/cli.ts";
import { card, parseReport, parseSummary, result, results } from "../helpers/parse.ts";
import { startFixtureSite, type FixtureSite } from "../helpers/server.ts";

let site: FixtureSite;

before(async () => {
  site = await startFixtureSite();
});

after(async () => {
  await site?.close();
  cleanupTempDirs();
});

const args = (routes: string[], extra: string[] = [], widths = [1440]) => [
  ...renderdiffArgs({ left: site.left, right: site.right, routes, widths, concurrency: 2 }),
  ...extra,
];

/** A config in `dir` whose hook restyles one side, so the accepted file is found beside it. */
function leftCss(dir: string, css: string, side = "left") {
  const file = path.join(dir, "hook.mjs");
  fs.writeFileSync(
    file,
    `export default { before: async (page, { side }) => { if (side === "${side}") await page.addStyleTag({ content: ${JSON.stringify(css)} }); } };\n`,
  );
  return ["--config", file];
}

const THIRD = ".strip:first-of-type > .swatch:nth-child(3)";

describe("accepted differences", () => {
  let dir: string;
  const file = () => path.join(dir, "renderdiff.accepted.json");

  before(async () => {
    dir = tempDir();
    const run = await runCli(args(["/", "/color", "/nav"], ["--accept", "known before the move"]), {
      cwd: dir,
    });
    assert.equal(run.code, 0, context(run));
    assert.match(run.stdout, /^accepted 2 difference\(s\), pruned 0 stale — .*$/m, context(run));
  });

  test("--accept records each change with its route, width, fingerprint and reason", () => {
    const list = JSON.parse(fs.readFileSync(file(), "utf8")) as {
      route: string;
      width: number;
      reason: string;
      fingerprint: { kind: string };
    }[];
    // /color is one region; /nav is one band.
    assert.deepEqual(
      list.map((a) => [a.route, a.width, a.fingerprint.kind, a.reason]),
      [
        ["/color", 1440, "region", "known before the move"],
        ["/nav", 1440, "band", "known before the move"],
      ],
      fs.readFileSync(file(), "utf8"),
    );
  });

  test("a later run reports them as accepted, not as differing, and passes the threshold", async () => {
    const run = await runCli(args(["/", "/color", "/nav"], ["--threshold", "0.999"]), {
      cwd: dir,
    });
    assert.equal(run.code, 0, context(run));
    const s = parseSummary(run.stdout);
    assert.deepEqual([s.clean, s.accepted, [...s.routes.keys()]], [["/"], ["/color", "/nav"], []]);
    assert.deepEqual([s.verdict.differ, s.verdict.shots, s.verdict.below?.count], [0, 0, 0]);
    const res = results(run.outDir);
    assert.equal(result(res, "/color", 1440).accepted, true);
    assert.equal(result(res, "/color", 1440).regions[0]!.accepted, "known before the move");
    assert.deepEqual([res.summary.accepted, res.summary.belowThreshold], [2, 0]);
    const report = parseReport(run.report()!);
    assert.equal(card(report, "/nav", 1440).accepted, "known before the move");
    assert.equal(card(report, "/", 1440).accepted, null);
  });

  test("a new change elsewhere on an accepted page still surfaces, the accepted one aside", async () => {
    const run = await runCli(args(["/color"], [...leftCss(dir, ".notes h2 { color: #2e7d32 }")]), {
      cwd: dir,
    });
    const s = parseSummary(run.stdout);
    assert.deepEqual(s.accepted, [], context(run));
    const [row] = s.routes.get("/color")!.rows;
    assert.match(row!.text, /  2 reg  1 accepted/, context(run));
    // The dom line names the new heading, not the swatch already accepted.
    assert.match(row!.dom ?? "", /h2 color/);
    assert.doesNotMatch(row!.dom ?? "", /rgb\(198, 40, 40\)/, "the accepted red swatch");
    const r = result(results(run.outDir), "/color", 1440);
    assert.equal(r.accepted, false);
    assert.deepEqual(r.regions.map((g) => g.accepted ?? null).sort(), [
      "known before the move",
      null,
    ]);
  });

  test("a different change in the accepted spot is not the accepted one", async () => {
    const run = await runCli(args(["/color"], leftCss(dir, `${THIRD} { background: #2e7d32 }`)), {
      cwd: dir,
    });
    const s = parseSummary(run.stdout);
    assert.deepEqual(s.accepted, [], context(run));
    const r = result(results(run.outDir), "/color", 1440);
    assert.equal(r.regions.length, 1, context(run));
    assert.equal(r.regions[0]!.accepted, undefined);
    assert.equal(s.verdict.differ, 1);
  });

  test("the accepted band redrawn at the same size and tone is not the accepted one", async () => {
    // Overlining the right-only link instead of underlining it changes no compared property, no text and no size, and
    // barely moves the band's mean colour: only its pixels say it is new.
    const run = await runCli(
      args(["/nav"], leftCss(dir, 'a[href="#pricing"] { text-decoration: overline }', "right")),
      { cwd: dir },
    );
    const r = result(results(run.outDir), "/nav", 1440);
    assert.deepEqual(
      r.bands?.map((b) => [b.side, b.h]),
      [["right", 24]],
      context(run),
    );
    assert.equal(r.accepted, false, context(run));
    assert.deepEqual(parseSummary(run.stdout).accepted, []);
  });

  test("an accepted difference no longer seen is listed as stale; unchecked routes aren't", async () => {
    const run = await runCli(args(["/color"], leftCss(dir, `${THIRD} { background: #c62828 }`)), {
      cwd: dir,
    });
    assert.equal(run.code, 0, context(run));
    const s = parseSummary(run.stdout);
    assert.deepEqual([s.clean, s.stale], [["/color"], ["/color@1440"]], context(run));
    assert.deepEqual(
      parseReport(run.report()!).stale.map((a) => [a.route, a.width, a.message]),
      [["/color", 1440, "known before the move"]],
    );
    assert.equal(results(run.outDir).summary.stale.length, 1);
  });

  test("--accept is scoped to the run's routes and widths, and prunes their stale entries", async () => {
    const dir2 = tempDir();
    fs.copyFileSync(file(), path.join(dir2, "renderdiff.accepted.json"));
    const hook = leftCss(dir2, `${THIRD} { background: #c62828 }`);
    const run = await runCli(args(["/color"], [...hook, "--accept", "fixed"]), { cwd: dir2 });
    assert.match(run.stdout, /^accepted 0 difference\(s\), pruned 1 stale/m, context(run));
    const at = path.join(dir2, "renderdiff.accepted.json");
    const list = JSON.parse(fs.readFileSync(at, "utf8")) as { route: string }[];
    assert.deepEqual(
      list.map((a) => a.route),
      ["/nav"],
    );
    const mtime = fs.statSync(at).mtimeMs;
    const again = await runCli(args(["/color"], [...hook, "--accept", "fixed"]), { cwd: dir2 });
    assert.match(again.stdout, /^accepted 0 difference\(s\), pruned 0 stale/m, context(again));
    assert.equal(fs.statSync(at).mtimeMs, mtime, "nothing to change, so the file isn't rewritten");
    assert.deepEqual(fs.readdirSync(dir2).sort(), ["hook.mjs", "renderdiff.accepted.json"]);
  });
});

describe("--rerun-failed", () => {
  test("reruns only what wasn't clean or accepted, and leaves the rest untouched", async () => {
    const dir = tempDir();
    const routes = ["/", "/color", "/nav"];
    const first = await runCli(args(routes, [], [1440, 375]));
    assert.equal(first.code, 0, context(first));
    // Accept /color elsewhere: the rerun reads it from cwd and matches it against results.json.
    const accepted = await runCli(args(["/color"], ["--accept", "known"], [1440, 375]), {
      cwd: dir,
    });
    assert.equal(accepted.code, 0, context(accepted));

    const index = first.file("index.1440.left.png");
    const mtime = fs.statSync(index).mtimeMs;
    const was = results(first.outDir);
    const hits = { home: site.hits("/"), color: site.hits("/color"), nav: site.hits("/nav") };

    const run = await runCli(args(routes, ["--rerun-failed"], [1440, 375]), {
      cwd: dir,
      outDir: first.outDir,
    });
    assert.equal(run.code, 0, context(run));
    assert.deepEqual(
      [site.hits("/"), site.hits("/color")],
      [hits.home, hits.color],
      "clean and accepted routes are not loaded again",
    );
    assert.ok(site.hits("/nav") > hits.nav, context(run));
    const s = parseSummary(run.stdout);
    assert.deepEqual(s.rerun, { shots: 2, routes: 1, reused: 4, untouched: 2 }, context(run));
    assert.deepEqual([s.clean, s.accepted, [...s.routes.keys()]], [["/"], ["/color"], ["/nav"]]);

    const now = results(run.outDir);
    assert.deepEqual(
      now.results.map((r) => `${r.url}@${r.width}`),
      ["/@1440", "/@375", "/color@1440", "/color@375", "/nav@1440", "/nav@375"],
    );
    assert.deepEqual(result(now, "/", 1440), result(was, "/", 1440));
    assert.equal(fs.statSync(index).mtimeMs, mtime, "a reused shot's files are not rewritten");
    assert.equal(parseReport(run.report()!).cards.length, 6);
    for (const r of now.results) {
      if (r.status === "compared") assert.ok(fs.existsSync(run.file(r.images.diff)), r.url);
    }
  });

  test("a run that doesn't repeat the previous one is refused", async () => {
    const first = await runCli(args(["/color"]));
    assert.equal(first.code, 0, context(first));
    const again = (a: string[]) => runCli(a, { outDir: first.outDir });
    for (const [a, needle] of [
      [args(["/color"], ["--rerun-failed"], [375]), /--rerun-failed: widths \[375\] differ/],
      [args(["/nav"], ["--rerun-failed"]), /--rerun-failed: routes \["\/nav"\] differ/],
      [
        [...args(["/color"], ["--rerun-failed"]), "--right", site.left],
        /--rerun-failed: right .* differ/,
      ],
      [
        args(["/color"], ["--rerun-failed", ...leftCss(tempDir(), "h1 { color: red }")]),
        /--rerun-failed: the config \(masks, hooks/,
      ],
    ] as const) {
      const r = await again([...a]);
      assert.equal(r.code, 2, context(r));
      assert.match(r.stderr, needle);
    }
    assert.ok(first.report(), "a refused rerun leaves the out dir alone");

    const fresh = await runCli(args(["/color"], ["--rerun-failed"]));
    assert.equal(fresh.code, 2, context(fresh));
    assert.match(fresh.stderr, /no .*results\.json to rerun from/);
  });
});

describe("--cache-right", () => {
  test("replays the right side's traffic on a repeat run, with the same results", async () => {
    const routes = ["/nav", "/color"];
    const first = await runCli(args(routes, ["--cache-right"]));
    assert.equal(first.code, 0, context(first));
    assert.match(first.stdout, /^right: loaded live and recorded for --cache-right/m);
    const was = results(first.outDir);
    assert.equal(was.meta.rightCache?.replayedFrom, null);

    const hits = site.hits("/nav");
    const again = await runCli(args(routes, ["--cache-right"]), { outDir: first.outDir });
    assert.equal(again.code, 0, context(again));
    assert.equal(site.hits("/nav"), hits + 1, "only the left side is loaded");
    assert.match(again.stdout, /^right: replayed from a recording of \S+ \(--cache-right\)$/m);
    const now = results(again.outDir);
    assert.ok(now.meta.rightCache?.replayedFrom, context(again));
    for (const route of routes) {
      assert.deepEqual(result(now, route, 1440), result(was, route, 1440));
    }
    assert.ok(
      result(now, "/nav", 1440).bands?.some((b) => b.elements?.[0]?.side === "right"),
      "elements are still named on a replayed right side",
    );

    const wider = await runCli(args([...routes, "/"], ["--cache-right"]), {
      outDir: first.outDir,
    });
    assert.equal(wider.code, 0, context(wider));
    assert.equal(site.hits("/nav"), hits + 3, "a shot the recording lacks loads it all live");
    assert.match(wider.stdout, /^right: loaded live and recorded/m);
  });
});
