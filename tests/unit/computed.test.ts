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

  test("a property that doesn't inherit is never collapsed; a size only at its outermost box", () => {
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

  test("a ::before only one side generates is a content change against none", () => {
    const left: Snapshot = { "body > a": el("<a>Go") };
    const right: Snapshot = {
      "body > a": el("<a>Go"),
      "body > a::before": el("", { content: '"→"' }),
    };
    assert.deepEqual(diffSnapshots(left, right), {
      dom: 0,
      changes: [{ key: "body > a::before", prop: "content", values: ["none", '"→"'] }],
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
    assert.equal(diffSnapshots(page("/main.a1b2c3.png"), page("/main.d4e5f6.png")).dom, 0);
    assert.equal(diffSnapshots(page("/a.png?v=12"), page("/a.png?v=13")).dom, 0);
    assert.equal(diffSnapshots(page("/a.png"), page("/b.png")).dom, 2);
    assert.equal(diffSnapshots(page("/a.png", "20240101"), page("/a.png", "20240102")).dom, 2);
  });
});

test("normalizeAssets leaves words alone", () => {
  assert.equal(
    normalizeAssets(' href="/site-header.css" src="/app-3f9a8c1d.js"'),
    ' href="/site-header.css" src="/app-#.js"',
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
  const diff = (dom = 0) => ({ dom, changes: [margin], unmatched: { left: [], right: [] } });
  const results = [
    shot("/a", 1440, { computed: diff() }),
    shot("/a", 375, { computed: diff() }),
    shot("/b", 1440, { computed: diff(1) }),
    shot("/c", 1440, { computed: diff(), accepted: true }),
  ];

  test("the same change across routes and widths is one finding; accepted shots are left out", () => {
    assert.deepEqual(groupFindings(results), [
      {
        ...margin,
        at: [
          { url: "/a", widths: [1440, 375] },
          { url: "/b", widths: [1440] },
        ],
      },
    ]);
  });

  test("fmtComputed names the dom verdict, then one line per finding", () => {
    assert.deepEqual(
      fmtComputed([...results, shot("/d", 1440, { computed: null })], ["/a", "/b", "/c", "/d"]),
      [
        "computed: 1 finding; dom identical on 2 of 3 route(s), differs /b (1), so findings there are hints; snapshot failed on /d",
        "  body > a margin-left 24px→16px  /a@1440,375 /b@1440",
      ],
    );
  });

  test("without --computed there is no block", () => {
    assert.deepEqual(fmtComputed([shot("/a", 1440, {})], ["/a"]), []);
  });
});
