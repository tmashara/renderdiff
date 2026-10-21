/**
 * Argument handling, exit codes, and route normalization.
 *
 * Everything here runs through `--dry-run`, which exits before the liveness check and before
 * the browser, so the whole file is sub-second and needs no Chromium. The one exception is the
 * preflight test at the bottom, which is the point: refusing to start when an origin is down
 * is a feature, and it has to be checked against a port that really is closed.
 *
 * Exit codes under test: 0 for help and version, 2 for anything the user got wrong.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { cleanupTempDirs, runCli, REPO_ROOT } from "../helpers/cli.ts";

after(cleanupTempDirs);

const L = "http://left.test";
const R = "http://right.test";

/** A dry run over one route. Never reaches the network. */
const dry = (extra: string[]) =>
  runCli(["--dry-run", "--left", L, "--right", R, ...extra], { noOut: true });

/** Asserts the CLI rejected its input: exit 2, and the reason names the problem. */
async function rejects(args: string[], needle: string) {
  const r = await runCli(args, { noOut: true });
  assert.equal(r.code, 2, `expected exit 2 for ${args.join(" ")}\n${r.stderr}`);
  assert.match(r.stderr, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  // A usage hint always follows, so a bad invocation is self-correcting.
  assert.match(r.stderr, /Try:\s+renderdiff --help/);
}

describe("help and version", () => {
  test("--help exits 0 and documents every flag", async () => {
    const r = await runCli(["--help"], { noOut: true });
    assert.equal(r.code, 0);
    for (const flag of [
      "--left",
      "--right",
      "--width",
      "--threshold",
      "--out",
      "--concurrency",
      "--config",
      "--dry-run",
      "--open",
    ]) {
      assert.ok(r.stdout.includes(flag), `--help does not mention ${flag}`);
    }
    assert.equal(r.stderr, "");
  });

  test("-h is the same as --help", async () => {
    const [long, short] = await Promise.all([
      runCli(["--help"], { noOut: true }),
      runCli(["-h"], { noOut: true }),
    ]);
    assert.equal(short.code, 0);
    assert.equal(short.stdout, long.stdout);
  });

  test("--version prints the package version", async () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
    ) as { version: string };
    const r = await runCli(["--version"], { noOut: true });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), pkg.version);

    const short = await runCli(["-v"], { noOut: true });
    assert.equal(short.stdout.trim(), pkg.version);
  });

  test("help wins over everything else, including bad flags elsewhere", async () => {
    const r = await runCli(["--help", "--threshold", "9"], { noOut: true });
    // Parsing happens first, so a bad --threshold still exits 2 — the check is that help
    // does not require --left/--right to be present.
    assert.equal(r.code, 2);
    const ok = await runCli(["--help", "--left", L], { noOut: true });
    assert.equal(ok.code, 0);
  });
});

describe("required arguments", () => {
  test("no routes exits 2", () =>
    rejects(["--left", L, "--right", R, "--dry-run"], "no routes given."));

  test("a missing --left is named, in the singular", () =>
    rejects(["/a", "--right", R, "--dry-run"], "--left is required"));

  test("a missing --right is named", () =>
    rejects(["/a", "--left", L, "--dry-run"], "--right is required"));

  test("both missing reads as plural", () =>
    rejects(["/a", "--dry-run"], "--left and --right are required"));
});

describe("flag validation", () => {
  test("an unknown flag is echoed back", () =>
    rejects(["/a", "--left", L, "--right", R, "--nope"], "unknown flag: --nope"));

  test("a flag with no value is rejected rather than swallowing the next flag", () =>
    rejects(["/a", "--left", L, "--width", "--right", R], "--width needs a value"));

  test("a trailing flag with no value is rejected", () =>
    rejects(["/a", "--left", L, "--right", R, "--out"], "--out needs a value"));

  test("a negative number is not mistaken for a value", () =>
    rejects(["/a", "--left", L, "--right", R, "--width", "-5"], "--width needs a value"));

  test("--width rejects non-numbers", () =>
    rejects(
      ["/a", "--left", L, "--right", R, "--width", "wide"],
      '--width expects a number, got "wide"',
    ));

  test("--width rejects zero and below", () =>
    rejects(
      ["/a", "--left", L, "--right", R, "--width", "0"],
      "--width expects a positive number",
    ));

  test("--concurrency rejects fractions", () =>
    rejects(
      ["/a", "--left", L, "--right", R, "--concurrency", "1.5"],
      "--concurrency expects a positive integer",
    ));

  test("--concurrency rejects zero", () =>
    rejects(
      ["/a", "--left", L, "--right", R, "--concurrency", "0"],
      "--concurrency expects a positive integer",
    ));

  test("--threshold rejects above 1", () =>
    rejects(
      ["/a", "--left", L, "--right", R, "--threshold", "2"],
      "--threshold expects 0..1, got 2",
    ));

  test("--threshold rejects below 0", () =>
    rejects(
      ["/a", "--left", L, "--right", R, "--threshold", "-0.5"],
      "--threshold needs a value",
    ));

  test("--threshold accepts the boundaries", async () => {
    for (const t of ["0", "1", "0.975"]) {
      const r = await dry(["/a", "--threshold", t]);
      assert.equal(r.code, 0, `--threshold ${t} should be accepted\n${r.stderr}`);
    }
  });

  test("--flag=value parses the same as --flag value", async () => {
    const [spaced, inline] = await Promise.all([
      runCli(["--dry-run", "--left", L, "--right", R, "/a"], { noOut: true }),
      runCli([`--dry-run`, `--left=${L}`, `--right=${R}`, "/a"], { noOut: true }),
    ]);
    assert.equal(inline.code, 0, inline.stderr);
    assert.equal(inline.stdout, spaced.stdout);
  });
});

describe("routes", () => {
  test("globs are refused, naming the offender", () =>
    rejects(
      ["/blog/*", "--left", L, "--right", R, "--dry-run"],
      "globs are not supported (/blog/*)",
    ));

  test("every spelling of a path normalizes to one route", async () => {
    const r = await dry(["pricing", "/pricing/", "//pricing//", "pricing/"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Routes: 1$/m);
    assert.equal(r.stdout.match(/http:\/\/left\.test\/pricing\b/g)?.length, 1);
    // No doubled or trailing slashes survive.
    assert.doesNotMatch(r.stdout, /left\.test\/\/|\/pricing\//);
  });

  test("the index route stays a bare slash", async () => {
    const r = await dry(["/"]);
    assert.match(r.stdout, /http:\/\/left\.test\/\s+\|\s+http:\/\/right\.test\//);
  });

  test("a trailing slash on an origin is stripped", async () => {
    const r = await runCli(
      ["--dry-run", "--left", "http://left.test/", "--right", "http://right.test///", "/a"],
      { noOut: true },
    );
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /http:\/\/left\.test\/a\s+\|\s+http:\/\/right\.test\/a/);
  });

  test("--dry-run reports the route count and one pair per route", async () => {
    const r = await dry(["/", "/about", "/pricing"]);
    assert.match(r.stdout, /^Routes: 3$/m);
    assert.equal(r.stdout.match(/\|/g)?.length, 3);
  });
});

describe("preflight", () => {
  // Port 1 is reserved and never listening, so this is a closed port rather than a race
  // against something we just shut down.
  const DEAD = "http://127.0.0.1:1";

  test("refuses to start when both origins are down, and says why", async () => {
    const r = await runCli(["/", "--left", DEAD, "--right", DEAD]);
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /left \(http:\/\/127\.0\.0\.1:1\) and right/);
    assert.match(r.stderr, /not responding/);
    // The hint that matters most: two error pages diff against each other at ~100%.
    assert.match(r.stderr, /local dev server/);
    assert.equal(r.report(), null, "no report should be written");
  });

  test("--dry-run skips preflight entirely", async () => {
    const r = await runCli(["--dry-run", "/", "--left", DEAD, "--right", DEAD], {
      noOut: true,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /not responding/);
  });
});
