/**
 * Config file discovery, validation, and precedence.
 *
 * All of it through `--dry-run`, so no browser. Each test gets its own temp cwd, because
 * discovery is "probe the working directory" and tests that shared one would see each other's
 * config files.
 *
 * The validation cases are the interesting half: a malformed config has to be refused up
 * front, naming the key, rather than surfacing as a strange failure deep inside a run.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import { cleanupTempDirs, runCli, tempDir } from "../helpers/cli.ts";

after(cleanupTempDirs);

const CONFIGS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "configs",
);

const L = "http://left.test";
const R = "http://right.test";

/** A temp cwd holding the given fixture configs under the given names. */
function cwdWith(files: Record<string, string>): string {
  const cwd = tempDir("vdiff-cfg-");
  for (const [name, fixture] of Object.entries(files)) {
    fs.copyFileSync(path.join(CONFIGS, fixture), path.join(cwd, name));
  }
  return cwd;
}

const at = (fixture: string) => path.join(CONFIGS, fixture);

describe("discovery", () => {
  test("a vdiff.config.mjs in the working directory is found and echoed", async () => {
    const cwd = cwdWith({ "vdiff.config.mjs": "ok.mjs" });
    const r = await runCli(["--dry-run", "/a", "--left", L, "--right", R], {
      cwd,
      noOut: true,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Config: .*vdiff\.config\.mjs$/m);
  });

  test("a vdiff.config.ts is found — the type-stripping path", async () => {
    const cwd = cwdWith({ "vdiff.config.ts": "ok.ts" });
    const r = await runCli(["--dry-run", "/a", "--left", L, "--right", R], {
      cwd,
      noOut: true,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Config: .*vdiff\.config\.ts$/m);
  });

  test(".ts is probed before .mjs", async () => {
    const cwd = cwdWith({ "vdiff.config.ts": "ok.ts", "vdiff.config.mjs": "ok.mjs" });
    const r = await runCli(["--dry-run", "/a", "--left", L, "--right", R], {
      cwd,
      noOut: true,
    });
    assert.match(r.stdout, /^Config: .*vdiff\.config\.ts$/m);
  });

  test("no config file is not an error — flags alone are enough", async () => {
    const r = await runCli(["--dry-run", "/a", "--left", L, "--right", R], { noOut: true });
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /^Config:/m);
  });

  test("an unrelated filename is not picked up", async () => {
    const cwd = cwdWith({ "vdiff.conf.mjs": "ok.mjs" });
    const r = await runCli(["--dry-run", "/a", "--left", L, "--right", R], {
      cwd,
      noOut: true,
    });
    assert.doesNotMatch(r.stdout, /^Config:/m);
  });

  test("--config takes a path outside the working directory", async () => {
    const r = await runCli(
      ["--dry-run", "/a", "--left", L, "--right", R, "--config", at("ok.mjs")],
      { noOut: true },
    );
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Config: .*fixtures\/configs\/ok\.mjs$/m);
  });

  test("--config at a missing path exits 2 rather than falling back", async () => {
    const cwd = cwdWith({ "vdiff.config.mjs": "ok.mjs" });
    const r = await runCli(
      ["--dry-run", "/a", "--left", L, "--right", R, "--config", "nope.mjs"],
      { cwd, noOut: true },
    );
    assert.equal(r.code, 2);
    assert.match(r.stderr, /config file not found: .*nope\.mjs/);
  });
});

describe("validation", () => {
  // Each of these must be refused with the offending key named. A config that is wrong in a
  // way the loader shrugs at becomes a confusing failure much later, or worse, a quiet one.
  const cases: Array<[fixture: string, needle: RegExp]> = [
    ["bad-left.mjs", /`left` must be a string/],
    ["bad-routes.mjs", /`routes` must be an array of strings/],
    ["bad-widths.mjs", /`widths` must be an array of positive numbers/],
    ["bad-threshold.mjs", /`threshold` must be a number between 0 and 1/],
    ["bad-concurrency.mjs", /`concurrency` must be a positive integer/],
    ["bad-mask-shape.mjs", /`masks` must be an array/],
    ["bad-mask-locate.mjs", /`masks\[0\]\.locate` must be a function/],
    ["no-default.mjs", /has no default export/],
    ["array-default.mjs", /must default-export an object/],
    ["throws.mjs", /could not load .*throws\.mjs/],
  ];

  for (const [fixture, needle] of cases) {
    test(`${fixture} exits 2 and names the problem`, async () => {
      const r = await runCli(
        ["--dry-run", "/a", "--left", L, "--right", R, "--config", at(fixture)],
        { noOut: true },
      );
      assert.equal(r.code, 2, `expected exit 2\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, needle);
    });
  }

  test("the failing file is named in the message", async () => {
    const r = await runCli(
      ["--dry-run", "/a", "--left", L, "--right", R, "--config", at("bad-widths.mjs")],
      { noOut: true },
    );
    assert.match(r.stderr, /bad-widths\.mjs/);
  });
});

describe("precedence", () => {
  test("config supplies the routes when none are passed", async () => {
    const r = await runCli(
      ["--dry-run", "--left", L, "--right", R, "--config", at("routes-only.mjs")],
      { noOut: true },
    );
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Routes: 3$/m);
    for (const route of ["/alpha", "/beta", "/gamma"]) {
      assert.ok(r.stdout.includes(`${L}${route}`), `missing ${route}`);
    }
  });

  test("positional routes beat the config's routes", async () => {
    const r = await runCli(
      ["/only-this", "--dry-run", "--left", L, "--right", R, "--config", at("routes-only.mjs")],
      { noOut: true },
    );
    assert.match(r.stdout, /^Routes: 1$/m);
    assert.ok(r.stdout.includes(`${L}/only-this`));
    assert.ok(!r.stdout.includes("/alpha"));
  });

  test("a config with no left/right leaves the flags in charge", async () => {
    // mask-drifting.mjs deliberately omits both origins; the visual suite relies on this.
    const r = await runCli(
      ["/a", "--dry-run", "--left", L, "--right", R, "--config", at("mask-drifting.mjs")],
      { noOut: true },
    );
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes(`${L}/a`));
  });

  test("routes from the config are normalized too", async () => {
    const cwd = tempDir("vdiff-cfg-");
    fs.writeFileSync(
      path.join(cwd, "vdiff.config.mjs"),
      'export default { routes: ["about", "/pricing/"] };\n',
    );
    const r = await runCli(["--dry-run", "--left", L, "--right", R], { cwd, noOut: true });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes(`${L}/about`));
    assert.ok(r.stdout.includes(`${L}/pricing`));
    assert.doesNotMatch(r.stdout, /\/pricing\//);
  });

  test("a glob in the config is refused as well as one on the command line", async () => {
    const cwd = tempDir("vdiff-cfg-");
    fs.writeFileSync(
      path.join(cwd, "vdiff.config.mjs"),
      'export default { routes: ["/blog/**"] };\n',
    );
    const r = await runCli(["--dry-run", "--left", L, "--right", R], { cwd, noOut: true });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /globs are not supported/);
  });

  test("left and right can come from the config alone", async () => {
    const cwd = tempDir("vdiff-cfg-");
    fs.writeFileSync(
      path.join(cwd, "vdiff.config.mjs"),
      `export default { left: "${L}", right: "${R}", routes: ["/a"] };\n`,
    );
    const r = await runCli(["--dry-run"], { cwd, noOut: true });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes(`${L}/a`));
  });

  test("a --left flag overrides the config's left", async () => {
    const cwd = tempDir("vdiff-cfg-");
    fs.writeFileSync(
      path.join(cwd, "vdiff.config.mjs"),
      'export default { left: "http://from-config.test", right: "http://cfg-right.test", routes: ["/a"] };\n',
    );
    const r = await runCli(["--dry-run", "--left", L], { cwd, noOut: true });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes(`${L}/a`), r.stdout);
    assert.ok(!r.stdout.includes("from-config.test"));
    // The config still supplies the side the flag did not.
    assert.ok(r.stdout.includes("http://cfg-right.test/a"));
  });
});
