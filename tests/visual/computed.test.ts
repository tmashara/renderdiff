/**
 * `--computed`'s in-page walk, driven directly on hand-made pages rather than through the CLI:
 * how elements are keyed and matched across sides, what is skipped, and that pixel mode's
 * selectors are untouched by it.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { diffSnapshots } from "../../src/computed.ts";
import { locate, snapshot } from "../../src/locate.ts";
import type { Shot } from "../../src/capture.ts";
import type { Region } from "../../src/compare.ts";

let browser: Browser;
before(async () => {
  browser = await chromium.launch();
});
after(() => browser?.close());

const BUDGET = 15_000;

async function page(body: string, css = ""): Promise<Page> {
  const p = await browser.newPage();
  await p.setContent(`<!doctype html><style>${css}</style><body>${body}</body>`);
  return p;
}

async function diff(left: string, right: string, css: [string, string] = ["", ""]) {
  const [l, r] = await Promise.all([page(left, css[0]), page(right, css[1])]);
  const snaps = await Promise.all([snapshot(l, [], BUDGET, null), snapshot(r, [], BUDGET, null)]);
  await Promise.all([l.close(), r.close()]);
  return { snaps, d: diffSnapshots(...snaps) };
}

test("an element sharing an id with a sibling is still compared, subtree and all", async () => {
  const body = `<div id="x">a</div><div id="x"><p>b</p></div>`;
  const { d } = await diff(body, body, ["p { color: red }", ""]);
  assert.equal(d.dom, 0);
  // currentColor borders follow the colour.
  assert.deepEqual(
    d.changes.map((c) => [c.key, c.prop]),
    [
      ["body > div#x:nth-of-type(2) > p", "color"],
      ["body > div#x:nth-of-type(2) > p", "border-top-color"],
    ],
  );
});

test("every key names its element and no other, so querySelector takes it", async () => {
  const p = await page(
    `<ul><li>a</li><li class="on">b</li><li>c</li><li>d</li></ul>` +
      `<a href="#a">x</a><a href="#a">y</a><div class="b a"></div><div class="a b"></div>`,
  );
  const snap = await snapshot(p, [], BUDGET, null);
  const keys = Object.keys(snap).filter((k) => !k.includes("::"));
  const counts = await p.evaluate((ks) => ks.map((k) => document.querySelectorAll(k).length), keys);
  await p.close();
  assert.deepEqual(
    counts,
    keys.map(() => 1),
    keys.join("\n"),
  );
  assert.ok(keys.includes("body > ul > li.on"), keys.join("\n"));
});

test("a node injected on one side doesn't misalign what follows it", async () => {
  const main = `<main><h1>Title</h1><p class="lede">x</p></main>`;
  const { d } = await diff(main, `<div class="cookie">ok</div>${main}`);
  assert.deepEqual(
    d.changes.map((c) => `${c.key} ${c.prop}`),
    ["body height"],
  );
  assert.equal(d.dom, 1);
  assert.deepEqual(d.unmatched, { left: [], right: ["body > div.cookie"] });
});

test("a removed hiding rule is a display change, and the dom stays identical", async () => {
  const body = `<div class="promo"><p>Sale</p><p>Now</p></div><p>After</p>`;
  const { d } = await diff(body, body, [".promo { display: none }", ""]);
  assert.equal(d.dom, 0);
  assert.deepEqual(d.unmatched, { left: [], right: [] });
  assert.deepEqual(
    d.changes.map((c) => [c.key, c.prop, c.values]),
    [
      ["body", "height", d.changes[0]!.values],
      ["body > div.promo", "display", ["none", "block"]],
    ],
  );
});

test("with a selector the walk covers only that subtree, keyed from :scope", async () => {
  const p = await page(`<header><a href="/">Home</a></header><div class="card"><b>x</b></div>`);
  const snap = await snapshot(p, [], BUDGET, p.locator(".card"));
  await p.close();
  assert.deepEqual(Object.keys(snap), [":scope", ":scope > b"]);
});

test("ten thousand siblings walk well inside the budget; past it, the walk says so", async () => {
  const p = await page(`<ul>${"<li>x</li>".repeat(10_000)}</ul>`);
  const t = performance.now();
  const snap = await snapshot(p, [], BUDGET, null);
  assert.ok(performance.now() - t < 5_000, `${performance.now() - t}ms`);
  assert.ok(snap["body > ul > li:nth-of-type(10000)"]);
  await assert.rejects(snapshot(p, [], 1, null), /took over 1ms/);
  await p.close();
});

test("pixel mode's selectors keep the classes in source order", async () => {
  const body = `<div class="zeta alpha" style="width:200px;height:100px;background:red"></div>`;
  const pages: [Page, Page] = [await page(body), await page(body)];
  const shot = { origin: { x: 0, y: 0 } } as Shot;
  const box = { x: 0, y: 0, w: 200, h: 100 };
  const [els] = await locate(
    pages,
    [shot, shot],
    [{ kind: "region", left: box, right: box, target: {} as Region }],
    [[], []],
  );
  await Promise.all(pages.map((p) => p.close()));
  assert.equal(els?.[0]?.selector, "div.zeta.alpha");
});
