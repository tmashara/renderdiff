/**
 * Lints the corpus itself.
 *
 * A visual suite is only as trustworthy as its fixtures, and fixtures rot in ways that make
 * the suite pass harder rather than fail: someone fixes a typo on one side of an equivalence
 * pair and it quietly stops being a test of anything. These checks encode the authoring rules
 * in `tests/fixtures/pages/README.md` so that kind of rot is a failure.
 *
 * No browser, no server — this is file reading.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import {
  ALL,
  BELOW_RENDER_GATE,
  CONTROLS,
  EQUIVALENCE,
  GENERATED,
  GUARDRAILS,
  SELF_CONTAINED,
  pageText,
  sideHtml,
} from "../helpers/corpus.ts";
import { listRoutes, PAGES_DIR } from "../helpers/server.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "..", "fixtures");
const VISUAL_DIR = path.join(HERE, "..", "visual");

/** `capture()` treats a page under this with no media or form controls as blank. */
const MIN_TEXT_CHARS = 200;

describe("manifest", () => {
  test("the manifest lists exactly the directories on disk", () => {
    assert.deepEqual(listRoutes(), [...ALL].sort());
  });

  test("the three groups do not overlap", () => {
    const all = [...EQUIVALENCE, ...CONTROLS, ...GUARDRAILS];
    assert.equal(new Set(all).size, all.length, "a route is in two groups");
  });

  test("every guard rail is named by the guard-rail suite", () => {
    // Equivalence and control routes are covered by iterating the manifest, so adding one is
    // self-covering. Guard rails are written out individually, so check each is mentioned.
    const source = fs
      .readdirSync(VISUAL_DIR)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => fs.readFileSync(path.join(VISUAL_DIR, f), "utf8"))
      .join("\n");
    for (const route of GUARDRAILS) {
      assert.ok(
        source.includes(`"${route}"`) || source.includes(`/${route}`),
        `no visual test mentions the ${route} fixture`,
      );
    }
  });
});

describe("every route", () => {
  for (const dir of ALL) {
    test(`${dir} serves both sides`, async () => {
      for (const side of ["left", "right"] as const) {
        const html = await sideHtml(dir, side);
        assert.match(html, /^<!doctype html>/i, `${dir}/${side} is not a document`);
        assert.match(html, /<html lang="en">/, `${dir}/${side} has no lang`);
      }
    });

    const gate = BELOW_RENDER_GATE.includes(dir);
    test(`${dir} ${gate ? "stays under" : "clears"} the render gate`, async () => {
      for (const side of ["left", "right"] as const) {
        const chars = pageText(await sideHtml(dir, side)).length;
        if (gate) {
          assert.ok(
            chars < MIN_TEXT_CHARS,
            `${dir}/${side} has ${chars} chars — it must stay under ${MIN_TEXT_CHARS} to test the gate`,
          );
        } else {
          assert.ok(
            chars >= MIN_TEXT_CHARS,
            `${dir}/${side} has only ${chars} chars; capture() treats anything under ${MIN_TEXT_CHARS} as possibly blank`,
          );
        }
      }
    });

    if (!SELF_CONTAINED.includes(dir)) {
      test(`${dir} links the shared stylesheet on both sides`, async () => {
        for (const side of ["left", "right"] as const) {
          assert.ok(
            (await sideHtml(dir, side)).includes('href="/shared/base.css"'),
            `${dir}/${side} does not link shared/base.css`,
          );
        }
      });
    }
  }
});

describe("equivalence pairs", () => {
  for (const dir of EQUIVALENCE) {
    test(`${dir} serves identical text on both sides`, async () => {
      const [left, right] = await Promise.all([
        sideHtml(dir, "left"),
        sideHtml(dir, "right"),
      ]);
      // Tags, class names and the inline stylesheet drop out; prose does not. If this fails,
      // one side was edited and the pair is no longer testing layout equivalence.
      assert.equal(
        pageText(left),
        pageText(right),
        `${dir}: the two sides no longer say the same thing`,
      );
    });

    test(`${dir} actually differs in CSS`, async () => {
      const style = (html: string) =>
        [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
          .map((m) => m[1])
          .join("\n");
      const [left, right] = await Promise.all([
        sideHtml(dir, "left"),
        sideHtml(dir, "right"),
      ]);
      assert.notEqual(
        style(left).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim(),
        style(right).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim(),
        `${dir}: both sides use the same CSS, so the pair proves nothing`,
      );
    });
  }
});

describe("authoring rules", () => {
  test("no page references an off-origin asset", async () => {
    for (const dir of ALL) {
      for (const side of ["left", "right"] as const) {
        const html = await sideHtml(dir, side);
        for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
          const url = m[1]!;
          assert.ok(
            url.startsWith("/shared/") || url.startsWith("#") || url.startsWith("data:"),
            `${dir}/${side} references ${url} — fixtures must not leave the fixture origin`,
          );
        }
      }
    }
  });

  test("every referenced shared asset exists", async () => {
    for (const dir of ALL) {
      for (const side of ["left", "right"] as const) {
        const html = await sideHtml(dir, side);
        for (const m of html.matchAll(/(?:src|href)="\/shared\/([^"]+)"/g)) {
          const file = path.join(FIXTURES, "shared", m[1]!);
          assert.ok(fs.existsSync(file), `${dir}/${side} references missing ${m[1]}`);
        }
      }
    }
  });

  test("no webfont is loaded or declared", async () => {
    const css = fs.readFileSync(path.join(FIXTURES, "shared", "base.css"), "utf8");
    assert.doesNotMatch(css, /@font-face|fonts\.googleapis|@import/);
    for (const dir of ALL) {
      for (const side of ["left", "right"] as const) {
        assert.doesNotMatch(
          await sideHtml(dir, side),
          /@font-face|fonts\.googleapis/,
          `${dir}/${side} declares a webfont`,
        );
      }
    }
  });

  test("only the animated fixture animates", async () => {
    for (const dir of ALL) {
      if (dir === "animated") continue;
      for (const side of ["left", "right"] as const) {
        const html = await sideHtml(dir, side);
        assert.doesNotMatch(
          html,
          /@keyframes|animation\s*:|transition\s*:/,
          `${dir}/${side} declares motion; only the animated fixture may`,
        );
      }
    }
  });

  test("the generated routes are the only ones without static files", () => {
    for (const dir of ALL) {
      const hasStatic = fs.existsSync(path.join(PAGES_DIR, dir, "left.html"));
      assert.equal(
        hasStatic,
        !GENERATED.includes(dir),
        `${dir}: static files and the generated list disagree`,
      );
    }
  });

  test("the tall fixture's declared height matches its block arithmetic", async () => {
    const mod = (await import(path.join(PAGES_DIR, "tall", "page.ts"))) as {
      EXPECT_HEIGHT: number;
      left: () => string;
    };
    const html = mod.left();
    const blocks = [...html.matchAll(/class="blk"/g)].length;
    const each = Number(/\.blk \{ height: (\d+)px/.exec(html)![1]);
    assert.equal(mod.EXPECT_HEIGHT, blocks * each);
    // Past Chromium's one-shot cap so it lands on the tiled path, under the sanity ceiling
    // so it is not refused outright.
    assert.ok(mod.EXPECT_HEIGHT > 16_384, "not tall enough to require tiling");
    assert.ok(mod.EXPECT_HEIGHT < 40_000, "past the sanity ceiling — would error, not tile");
  });

  test("the drifting fixture really drifts, and carries the mask hook", async () => {
    const mod = (await import(path.join(PAGES_DIR, "drifting", "page.ts"))) as {
      left: () => string;
      right: () => string;
    };
    const a = mod.left();
    const b = mod.right();
    assert.ok(a.includes("data-drift"), "no [data-drift] element for the mask to target");
    const value = (html: string) => /data-drift>([^<]+)</.exec(html)![1];
    assert.notEqual(value(a), value(b), "two renders produced the same value");
  });
});
