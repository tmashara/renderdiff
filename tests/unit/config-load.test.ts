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
  const cwd = tempDir("renderdiff-cfg-");
  for (const [name, fixture] of Object.entries(files)) {
    fs.copyFileSync(path.join(CONFIGS, fixture), path.join(cwd, name));
  }
  return cwd;
}

const at = (fixture: string) => path.join(CONFIGS, fixture);

describe("discovery", () => {
  test("a renderdiff.config.mjs in the working directory is found and echoed", async () => {
    const cwd = cwdWith({ "renderdiff.config.mjs": "ok.mjs" });
    const r = await runCli(["--dry-run", "/a", "--left", L, "--right", R], {
      cwd,
      noOut: true,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Config: .*renderdiff\.config\.mjs$/m);
  });

  test("a renderdiff.config.ts is found — the type-stripping path", async () => {
    const cwd = cwdWith({ "renderdiff.config.ts": "ok.ts" });
    const r = await runCli(["--dry-run", "/a", "--left", L, "--right", R], {
      cwd,
      noOut: true,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Config: .*renderdiff\.config\.ts$/m);
  });

  test(".ts is probed before .mjs", async () => {
    const cwd = cwdWith({ "renderdiff.config.ts": "ok.ts", "renderdiff.config.mjs": "ok.mjs" });
    const r = await runCli(["--dry-run", "/a", "--left", L, "--right", R], {
      cwd,
      noOut: true,
    });
    assert.match(r.stdout, /^Config: .*renderdiff\.config\.ts$/m);
  });

  test("no config file is not an error — flags alone are enough", async () => {
    const r = await runCli(["--dry-run", "/a", "--left", L, "--right", R], { noOut: true });
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /^Config:/m);
  });

  test("an unrelated filename is not picked up", async () => {
    const cwd = cwdWith({ "renderdiff.conf.mjs": "ok.mjs" });
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
    const cwd = cwdWith({ "renderdiff.config.mjs": "ok.mjs" });
    const r = await runCli(["--dry-run", "/a", "--left", L, "--right", R, "--config", "nope.mjs"], {
      cwd,
      noOut: true,
    });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /config file not found: .*nope\.mjs/);
  });
});

describe("validation", () => {
  // Each of these must be refused with the offending key named. A config that is wrong in a
  // way the loader shrugs at becomes a confusing failure much later, or worse, a quiet one.
  const cases: Array<[fixture: string, needle: RegExp]> = [
    ["bad-left.mjs", /`left` must be a string/],
    [
      "bad-routes.mjs",
      /`routes\[0\]` must be a string or an object \{ left, right\?, selector\?, before\?, beforeShot\? \}/,
    ],
    ["bad-widths.mjs", /`widths` must be an array of positive numbers/],
    ["bad-threshold.mjs", /`threshold` must be a number between 0 and 1/],
    ["bad-concurrency.mjs", /`concurrency` must be a positive integer/],
    ["bad-mask-shape.mjs", /`masks` must be an array/],
    ["bad-mask-locate.mjs", /`masks\[0\]` needs exactly one of `selector` or `locate`/],
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

  // Inline rather than fixture files: each is one line, and the needle sits next to it.
  const inline: Array<[config: string, needle: RegExp]> = [
    ['{ routes: "/a" }', /`routes` must be an array/],
    ['{ routes: [{ right: "/b" }] }', /`routes\[0\]\.left` must be a non-empty string/],
    [
      '{ routes: ["/a", { left: "/a", right: 2 }] }',
      /`routes\[1\]\.right` must be a non-empty string/,
    ],
    ['{ routes: [{ left: "/a", path: "/b" }] }', /`routes\[0\]\.path` is not a route key/],
    ['{ routes: [{ left: "" }] }', /`routes\[0\]\.left` must be a non-empty string/],
    ['{ routes: [{ left: "/a", right: "" }] }', /`routes\[0\]\.right` must be a non-empty string/],
    ['{ routes: [{ left: "/a::/b" }] }', /a side containing "::\/" reads as a pair/],
    [
      '{ masks: [{ reason: "x", selector: undefined, locate: (p) => p.locator("a") }] }',
      /`masks\[0\]` needs exactly one of `selector` or `locate`/,
    ],
    [
      '{ masks: [{ reason: "x", selector: "a", locate: (p) => p.locator("a") }] }',
      /`masks\[0\]` needs exactly one of `selector` or `locate`/,
    ],
    ['{ masks: [{ reason: "x", selector: 1 }] }', /`masks\[0\]\.selector` must be a string/],
    [
      '{ routes: [{ left: "/a", selector: 1 }] }',
      /`routes\[0\]\.selector` must be a non-empty string or \{ left, right \}/,
    ],
    ['{ routes: [{ left: "/a", selector: "" }] }', /`routes\[0\]\.selector` must be/],
    [
      '{ routes: [{ left: "/a", selector: "xpath=//h1 | //h2" }, { left: "/a", selector: { left: "xpath=//h1", right: "//h2" } }] }',
      /two routes both read as \/a \[xpath=\/\/h1 \| \/\/h2\]; change one of their selectors/,
    ],
    ['{ routes: [{ left: "/a", selector: { left: ".a" } }] }', /`routes\[0\]\.selector` must be/],
    ['{ before: "click" }', /`before` must be a function/],
    [
      '{ routes: ["/a", { left: "/a", before: async () => {} }] }',
      /two routes both read as \/a; they have different hooks — merge them into one route/,
    ],
    ['{ routes: [{ left: "/a", before: {} }] }', /`routes\[0\]\.before` must be a function/],
    ['{ beforeShot: "x" }', /`beforeShot` must be a function/],
    [
      '{ routes: [{ left: "/a", beforeShot: {} }] }',
      /`routes\[0\]\.beforeShot` must be a function/,
    ],
    [
      '{ routes: ["/a", { left: "/a", beforeShot: async () => {} }] }',
      /different hooks — merge them/,
    ],
    ['{ maskMedia: "yes" }', /`maskMedia` must be a boolean/],
    ['{ freezeVideo: "no" }', /`freezeVideo` must be a boolean/],
    ["{ lottieFrame: 1.5 }", /`lottieFrame` must be a whole number/],
    ["{ lottieFrame: -1 }", /`lottieFrame` must be a whole number/],
    ["{ storageState: 1 }", /`storageState` must be a non-empty path/],
    [
      '{ storageState: { left: "a.json", center: "b.json" } }',
      /`storageState` must be a non-empty path/,
    ],
  ];
  for (const [config, needle] of inline) {
    test(`${config} exits 2 and names the problem`, async () => {
      const cwd = tempDir("renderdiff-cfg-");
      fs.writeFileSync(path.join(cwd, "renderdiff.config.mjs"), `export default ${config};\n`);
      const r = await runCli(["--dry-run", "--left", L, "--right", R], { cwd, noOut: true });
      assert.equal(r.code, 2, `expected exit 2\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, needle);
    });
  }

  test("a config storageState resolves from the config file's directory, not cwd", async () => {
    const dir = tempDir("renderdiff-cfg-");
    fs.writeFileSync(
      path.join(dir, "c.mjs"),
      'export default { storageState: { right: "auth.json" } };\n',
    );
    const r = await runCli(
      ["--dry-run", "/a", "--left", L, "--right", R, "--config", path.join(dir, "c.mjs")],
      { noOut: true },
    );
    assert.equal(r.code, 2, r.stderr);
    assert.ok(
      r.stderr.includes(`storage state file not found: ${path.join(dir, "auth.json")}`),
      r.stderr,
    );
    fs.writeFileSync(path.join(dir, "auth.json"), '{"cookies":[],"origins":[]}');
    const ok = await runCli(
      ["--dry-run", "/a", "--left", L, "--right", R, "--config", path.join(dir, "c.mjs")],
      { noOut: true },
    );
    assert.equal(ok.code, 0, ok.stderr);
  });

  test("object routes sit beside strings; right defaults to left", async () => {
    const cwd = tempDir("renderdiff-cfg-");
    fs.writeFileSync(
      path.join(cwd, "renderdiff.config.mjs"),
      'export default { routes: [{ left: "/a", right: "plans/" }, { left: "/c" }, "/d::/e", { left: "/a", right: "/plans" }] };\n',
    );
    const r = await runCli(["--dry-run", "--left", L, "--right", R], { cwd, noOut: true });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Routes: 3$/m);
    assert.match(
      r.stdout,
      /^  \/a::\/plans +http:\/\/left\.test\/a  \|  http:\/\/right\.test\/plans$/m,
    );
    assert.match(r.stdout, /^  \/c +http:\/\/left\.test\/c  \|  http:\/\/right\.test\/c$/m);
    assert.match(r.stdout, /^  \/d::\/e +http:\/\/left\.test\/d  \|  http:\/\/right\.test\/e$/m);
  });

  test("a route listed once per selector is one route each; a CLI selector replaces them", async () => {
    const cwd = tempDir("renderdiff-cfg-");
    fs.writeFileSync(
      path.join(cwd, "renderdiff.config.mjs"),
      'export default { routes: [{ left: "/a", selector: ".card" }, { left: "/a", selector: { left: ".x", right: ".y" } }, "/a"] };\n',
    );
    const r = await runCli(["--dry-run", "--left", L, "--right", R], { cwd, noOut: true });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Routes: 3$/m);
    assert.match(r.stdout, /right\.test\/a  \[\.card\]$/m);
    assert.match(r.stdout, /right\.test\/a  \[\.x \| \.y\]$/m);
    assert.match(r.stdout, /right\.test\/a$/m);
    const cli = await runCli(["--dry-run", "--left", L, "--right", R, "--selector", "h1"], {
      cwd,
      noOut: true,
    });
    assert.equal(cli.code, 0, cli.stderr);
    assert.match(cli.stdout, /^Routes: 1$/m);
    assert.match(cli.stdout, /right\.test\/a  \[h1\]$/m);
  });

  test("a plain object with a selector mask and no functions loads", async () => {
    const cwd = tempDir("renderdiff-cfg-");
    fs.writeFileSync(
      path.join(cwd, "renderdiff.config.mjs"),
      'export default { masks: [{ selector: "[data-star-count]", reason: "stars" }] };\n',
    );
    const r = await runCli(["--dry-run", "/a", "--left", L, "--right", R], { cwd, noOut: true });
    assert.equal(r.code, 0, r.stderr);
  });

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
    const cwd = tempDir("renderdiff-cfg-");
    fs.writeFileSync(
      path.join(cwd, "renderdiff.config.mjs"),
      'export default { routes: ["about", "/pricing/"] };\n',
    );
    const r = await runCli(["--dry-run", "--left", L, "--right", R], { cwd, noOut: true });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes(`${L}/about`));
    assert.ok(r.stdout.includes(`${L}/pricing`));
    assert.doesNotMatch(r.stdout, /\/pricing\//);
  });

  test("a glob in the config is refused as well as one on the command line", async () => {
    const cwd = tempDir("renderdiff-cfg-");
    fs.writeFileSync(
      path.join(cwd, "renderdiff.config.mjs"),
      'export default { routes: ["/blog/**"] };\n',
    );
    const r = await runCli(["--dry-run", "--left", L, "--right", R], { cwd, noOut: true });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /globs are not supported/);
  });

  test("left and right can come from the config alone", async () => {
    const cwd = tempDir("renderdiff-cfg-");
    fs.writeFileSync(
      path.join(cwd, "renderdiff.config.mjs"),
      `export default { left: "${L}", right: "${R}", routes: ["/a"] };\n`,
    );
    const r = await runCli(["--dry-run"], { cwd, noOut: true });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes(`${L}/a`));
  });

  test("a --left flag overrides the config's left", async () => {
    const cwd = tempDir("renderdiff-cfg-");
    fs.writeFileSync(
      path.join(cwd, "renderdiff.config.mjs"),
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

describe("--only", () => {
  /** A temp cwd with a config whose /b route has its own selector and hook. */
  function cwdOnly(): string {
    const cwd = tempDir("renderdiff-cfg-");
    fs.writeFileSync(
      path.join(cwd, "renderdiff.config.mjs"),
      'export default { routes: ["/a", { left: "/a", selector: ".x" }, { left: "/b", selector: ".card", before: async () => {} }, "/c::/d"] };\n',
    );
    return cwd;
  }
  const dryIn = (cwd: string, ...only: string[]) =>
    runCli(["--dry-run", "--left", L, "--right", R, ...only.flatMap((o) => ["--only", o])], {
      cwd,
      noOut: true,
    });

  test("keeps a config route's own selector when picked by path", async () => {
    const r = await dryIn(cwdOnly(), "/b/");
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Routes: 1$/m);
    assert.match(
      r.stdout,
      /^  \/b +http:\/\/left\.test\/b  \|  http:\/\/right\.test\/b  \[\.card\]$/m,
    );
  });

  test("a path picks every selector of it; ' @sel' narrows to one", async () => {
    const cwd = cwdOnly();
    const all = await dryIn(cwd, "/a");
    assert.equal(all.code, 0, all.stderr);
    assert.match(all.stdout, /^Routes: 2$/m);
    const one = await dryIn(cwd, "/a @.x");
    assert.equal(one.code, 0, one.stderr);
    assert.match(one.stdout, /^Routes: 1$/m);
    assert.match(one.stdout, /\[\.x\]$/m);
  });

  test("repeatable, pairs included, in config order", async () => {
    const r = await dryIn(cwdOnly(), "/c::/d", "/b");
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Routes: 2$/m);
    assert.ok(r.stdout.indexOf("/b") < r.stdout.indexOf("/c::/d"), r.stdout);
  });

  test("a file of blank lines is an error", async () => {
    const cwd = cwdOnly();
    fs.writeFileSync(path.join(cwd, "routes.txt"), "\n  \n");
    const r = await dryIn(cwd, "routes.txt");
    assert.equal(r.code, 2, r.stdout);
    assert.match(r.stderr, /--only routes\.txt lists no routes/);
  });

  test("a file in cwd lists routes one per line", async () => {
    const cwd = cwdOnly();
    fs.writeFileSync(path.join(cwd, "routes.txt"), "/a @.x\n\n  /b  \n");
    const r = await dryIn(cwd, "routes.txt");
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Routes: 2$/m);
  });

  test("each value that matches nothing is an error, even beside one that matches", async () => {
    const cwd = cwdOnly();
    const r = await dryIn(cwd, "/a", "/typo");
    assert.equal(r.code, 2, r.stdout);
    assert.match(
      r.stderr,
      /--only \/typo matches no config route; the config has: \/a, \/a \[\.x\], \/b \[\.card\], \/c::\/d/,
    );
    const typo = await dryIn(cwd, "rotes.txt");
    assert.equal(typo.code, 2);
    assert.match(typo.stderr, /--only rotes\.txt matches no config route \(and no such file\)/);
    fs.writeFileSync(path.join(cwd, "routes.txt"), "/a\n\n/x\n");
    const line = await dryIn(cwd, "routes.txt");
    assert.equal(line.code, 2);
    assert.match(line.stderr, /--only routes\.txt: "\/x" \(line 3\) matches no config route;/);
  });

  test("needs a config file, and says when it has no routes", async () => {
    const none = await dryIn(tempDir("renderdiff-cfg-"), "/a");
    assert.equal(none.code, 2);
    assert.match(none.stderr, /--only filters a config file's routes; none was found/);
    const cwd = tempDir("renderdiff-cfg-");
    fs.writeFileSync(
      path.join(cwd, "renderdiff.config.mjs"),
      "export default { widths: [800] };\n",
    );
    const empty = await dryIn(cwd, "/a");
    assert.equal(empty.code, 2);
    assert.match(empty.stderr, /--only \/a matches no config route; the config has no routes/);
  });
});
