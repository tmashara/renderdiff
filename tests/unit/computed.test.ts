/**
 * `--computed`: the snapshot diff, the inherited-cascade collapse and the grouping across
 * routes and widths. No browser: the snapshots are hand-written.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  collapseInherited,
  diffSnapshots,
  fmtComputed,
  groupFindings,
  normalizeAssets,
  pageError,
  type Snapshot,
} from "../../src/computed.ts";
import { PROPS } from "../../src/locate.ts";
import type { ComparedResult, RouteResult } from "../../src/report.ts";

const FIELDS = [...PROPS, "content"];
const el = (html: string, styles: Record<string, string> = {}) => ({
  html,
  styles: FIELDS.map((p) => styles[p] ?? (p === "content" ? "normal" : "x")),
});

describe("diffSnapshots", () => {
  test("one body font change is one finding, not one per descendant", () => {
    const font = (f: string): Snapshot => ({
      body: el("<body>", { "font-family": f }),
      "body > main": el("<main>", { "font-family": f }),
      "body > main > p": el("<p>Hi", { "font-family": f }),
      "body > main > p > b": el("<b>there", { "font-family": f }),
    });
    const d = diffSnapshots(font("Inter"), font("Arial"));
    assert.equal(d.dom, 0);
    assert.deepEqual(d.changes, [{ key: "body", prop: "font-family", values: ["Inter", "Arial"] }]);
  });

  test("a descendant that changed differently from its parent is kept", () => {
    const changes = collapseInherited([
      { key: "body", prop: "color", values: ["red", "blue"] },
      { key: "body > p", prop: "color", values: ["red", "green"] },
      { key: "body > p > a", prop: "color", values: ["red", "green"] },
    ]);
    assert.deepEqual(
      changes.map((c) => c.key),
      ["body", "body > p"],
    );
  });

  test("a property that doesn't inherit is never collapsed; a width only at its outermost box", () => {
    const changes = collapseInherited([
      { key: "body > div", prop: "margin-left", values: ["0px", "8px"] },
      { key: "body > div > p", prop: "margin-left", values: ["0px", "8px"] },
      { key: "body > div", prop: "width", values: ["100px", "92px"] },
      { key: "body > div > p", prop: "width", values: ["80px", "72px"] },
    ]);
    assert.deepEqual(
      changes.map((c) => `${c.key} ${c.prop}`),
      ["body > div margin-left", "body > div > p margin-left", "body > div width"],
    );
  });

  test("a height only at its innermost box: an auto height grows with what it holds", () => {
    // `.a { height: 50px }` removed: .a is the cause, its ancestors only follow.
    const changes = collapseInherited([
      { key: "body", prop: "height", values: ["50px", "18px"] },
      { key: "body > div", prop: "height", values: ["50px", "18px"] },
      { key: "body > div > div.a", prop: "height", values: ["50px", "18px"] },
    ]);
    assert.deepEqual(
      changes.map((c) => c.key),
      ["body > div > div.a"],
    );
  });

  test("a child whose own width changed inside a shrink-to-fit parent is kept", () => {
    // `.inner { width: 100px → 200px }` inside an inline-block span that follows it.
    const snap = (w: string): Snapshot => ({
      "body > span": el("<span>", { display: "inline-block", width: w }),
      "body > span > div.inner": { ...el("<div>", { width: w }), size: [w, "auto"] },
    });
    const d = diffSnapshots(snap("100px"), snap("200px"));
    assert.deepEqual(
      d.changes.map((c) => c.key),
      ["body > span", "body > span > div.inner"],
    );
  });

  test("a parent's own height change is kept over a height: 100% child that follows it", () => {
    const snap = (h: string): Snapshot => ({
      "body > div.box": { ...el("<div>", { height: h }), size: ["auto", h] },
      "body > div.box > div.fill": { ...el("<div>", { height: h }), size: ["auto", "100%"] },
    });
    const d = diffSnapshots(snap("50px"), snap("80px"));
    assert.deepEqual(
      d.changes.map((c) => c.key),
      ["body > div.box"],
    );
  });

  test("a height: 100% child in an auto-height parent sizes it, so the child is kept", () => {
    const snap = (h: string): Snapshot => ({
      "body > div.card": { ...el("<div>", { height: h }), size: ["auto", "auto"] },
      "body > div.card > div.inner": { ...el("<div>", { height: h }), size: ["auto", "100%"] },
    });
    assert.deepEqual(
      diffSnapshots(snap("50px"), snap("80px")).changes.map((c) => c.key),
      ["body > div.card > div.inner"],
    );
  });

  test("an element going display: none is one finding, not its pseudo-elements too", () => {
    const left: Snapshot = {
      body: el("<body>"),
      "body > p.tip": el("<p>Tip", { display: "none" }),
    };
    const right: Snapshot = {
      body: el("<body>"),
      "body > p.tip": el("<p>Tip", { display: "block" }),
      "body > p.tip::before": el("", { content: '"→"' }),
    };
    assert.deepEqual(diffSnapshots(left, right).changes, [
      { key: "body > p.tip", prop: "display", values: ["none", "block"] },
    ]);
  });

  test("an element one side hides is a display change, not a markup difference", () => {
    const left: Snapshot = {
      body: el("<body>"),
      "body > div.promo": el("<div>", { display: "none" }),
    };
    const right: Snapshot = {
      body: el("<body>"),
      "body > div.promo": el("<div>", { display: "block" }),
      "body > div.promo > p": el("<p>Sale"),
    };
    assert.deepEqual(diffSnapshots(left, right), {
      dom: 0,
      changes: [{ key: "body > div.promo", prop: "display", values: ["none", "block"] }],
      truncated: 0,
      unmatched: { left: [], right: [] },
    });
  });

  test("past 500 changes the rest are counted, not kept", () => {
    const side = (v: string): Snapshot =>
      Object.fromEntries(
        Array.from({ length: 600 }, (_, i) => [
          `body > p:nth-of-type(${i + 1})`,
          el("<p>", { opacity: v }),
        ]),
      );
    const d = diffSnapshots(side("1"), side("0.5"));
    assert.deepEqual([d.changes.length, d.truncated], [500, 100]);
  });

  test("a :: inside an attribute is not a pseudo-element", () => {
    const key = 'body > a[href="#std::vec"]';
    const d = diffSnapshots({ body: el("<body>") }, { body: el("<body>"), [key]: el("<a>") });
    assert.deepEqual([d.dom, d.unmatched.right], [1, [key]]);
  });

  test("a ::before only one side generates is a content change against none", () => {
    const left: Snapshot = { "body > a": el("<a>Go") };
    const right: Snapshot = {
      "body > a": el("<a>Go"),
      "body > a::before": el("", { content: '"→"' }),
    };
    assert.deepEqual(diffSnapshots(left, right), {
      dom: 0,
      changes: [{ key: "body > a::before", prop: "content", values: ["none", '"→"'] }],
      truncated: 0,
      unmatched: { left: [], right: [] },
    });
  });

  test("an element on one side is unmatched, outermost only, and the dom differs", () => {
    const left: Snapshot = { body: el("<body>"), "body > p": el("<p>A") };
    const right: Snapshot = {
      body: el("<body>"),
      "body > p": el("<p>A"),
      "body > aside": el("<aside>"),
      "body > aside > p": el("<p>B"),
    };
    const d = diffSnapshots(left, right);
    assert.equal(d.dom, 2);
    assert.deepEqual(d.unmatched, { left: [], right: ["body > aside"] });
  });

  test("asset hashes in URLs don't make the dom differ; other attributes and text do", () => {
    const page = (src: string, text = "Hi"): Snapshot => ({
      "body > img": el(`<img src="${src}">`),
      "body > p": el(`<p>${text}`),
    });
    assert.equal(diffSnapshots(page("/main.3f9a8c1d.png"), page("/main.d4e5f6a7.png")).dom, 0);
    assert.equal(
      diffSnapshots(page("/app.3f9a8c1d.chunk.js"), page("/app.d4e5f6a7.chunk.js")).dom,
      0,
    );
    assert.equal(diffSnapshots(page("/a.png?v=12"), page("/a.png?v=13")).dom, 0);
    assert.equal(diffSnapshots(page("/a.png"), page("/b.png")).dom, 1);
    assert.equal(diffSnapshots(page("/hero-image1.png"), page("/hero-image2.png")).dom, 1);
    assert.equal(diffSnapshots(page("/team_photo_2023.jpg"), page("/team_photo_2024.jpg")).dom, 1);
    assert.equal(diffSnapshots(page("/hero-banner2023.jpg"), page("/hero-banner2024.jpg")).dom, 1);
    assert.equal(diffSnapshots(page("/p/abcdef123456"), page("/p/abcdef123457")).dom, 1);
    assert.equal(diffSnapshots(page("/blog/20231015-a"), page("/blog/20231016-a")).dom, 1);
    assert.equal(diffSnapshots(page("/a.png", "20240101"), page("/a.png", "20240102")).dom, 1);
  });

  test("an origin that differs only by port is no finding and no dom difference", () => {
    const origins: [string, string] = ["http://127.0.0.1:4611/", "http://127.0.0.1:4612/a"];
    const page = (o: string, path = "/a.png"): Snapshot => ({
      body: el("<body>"),
      [`body > a[href="http://${o}/x"]`]: el(`<a href="http://${o}/x">X`),
      "body > img": el(`<img srcset="http://${o}${path} 1x, //${o}/b.png 2x">`, {
        "background-image": `url("http://${o}${path}")`,
      }),
    });
    assert.deepEqual(diffSnapshots(page("127.0.0.1:4611"), page("127.0.0.1:4612"), origins), {
      dom: 0,
      changes: [],
      truncated: 0,
      unmatched: { left: [], right: [] },
    });
    const port = diffSnapshots(page("127.0.0.1:46110"), page("127.0.0.1:4612"), origins);
    assert.deepEqual([port.dom, port.unmatched.left.length], [3, 1]);
    const path = diffSnapshots(page("127.0.0.1:4611", "/c.png"), page("127.0.0.1:4612"), origins);
    assert.deepEqual([path.dom, path.changes.map((c) => c.prop)], [1, ["background-image"]]);
  });
});

test("normalizeAssets leaves words alone", () => {
  assert.equal(
    normalizeAssets(' href="/site-header.png" src="/app-3f9a8c1d.png"'),
    ' href="/site-header.png" src="/app-#.png"',
  );
});

const shot = (url: string, width: number, over: Partial<ComparedResult>): RouteResult =>
  ({
    status: "compared",
    url,
    left: url,
    right: url,
    selector: null,
    width,
    accepted: false,
    ...over,
  }) as ComparedResult;
const margin = {
  key: "body > a",
  prop: "margin-left",
  values: ["24px", "16px"] as [string, string],
};

describe("groupFindings", () => {
  const diff = (dom = 0) => ({
    dom,
    changes: [margin],
    truncated: 0,
    unmatched: { left: [], right: [] },
  });
  const results = [
    shot("/a", 1440, { computed: diff() }),
    shot("/a", 375, { computed: diff() }),
    shot("/b", 1440, { computed: diff(1) }),
    shot("/c", 1440, { computed: diff(), accepted: true }),
  ];

  test("the same change across routes and widths is one finding, accepted shots included", () => {
    assert.deepEqual(groupFindings(results), [
      {
        ...margin,
        at: [
          { url: "/a", widths: [1440, 375] },
          { url: "/b", widths: [1440] },
          { url: "/c", widths: [1440] },
        ],
      },
    ]);
  });

  test("fmtComputed names the dom verdict, then one line per finding", () => {
    assert.deepEqual(
      fmtComputed(
        [
          ...results,
          shot("/d", 1440, { computed: null, computedError: "more than 50000 elements" }),
          shot("/e", 1440, { computed: { ...diff(), truncated: 7 } }),
        ],
        ["/a", "/b", "/c", "/d", "/e"],
      ),
      [
        "computed: 1 finding; dom identical on 3 of 4 route(s), differs /b (1), so findings there are hints; snapshot failed on /d@1440 (more than 50000 elements)",
        "  body > a margin-left 24px→16px  /a@1440,375 /b@1440 /c@1440 +1 routes",
        "  truncated: only the first 500 changes kept on /e@1440 (+7)",
      ],
    );
  });

  test("without --computed there is no block", () => {
    assert.deepEqual(fmtComputed([shot("/a", 1440, {})], ["/a"]), []);
  });
});

test("a snapshot error keeps the page's message, not page.evaluate's prefix or stack", () => {
  // As Playwright reported a throw inside the walk, message text included.
  const raw =
    "page.evaluate: Error: more than 3 elements: Error: nested\n" +
    "    at visit (eval at evaluate (:311:30), <anonymous>:1:66)\n" +
    "    at probe (eval at evaluate (:311:30), <anonymous>:1:133)\n" +
    "    at UtilityScript.evaluate (<anonymous>:313:16)";
  assert.equal(pageError(new Error(raw)), "more than 3 elements: Error: nested");
  const timeout =
    "locator.evaluate: Timeout 30000ms exceeded.\nCall log:\n  - waiting for locator('.x')";
  assert.equal(pageError(new Error(timeout)), timeout);
});
