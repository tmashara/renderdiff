/**
 * `--computed`'s in-page walk, driven directly on hand-made pages rather than through the CLI:
 * how elements are keyed and matched across sides, what is skipped, and that pixel mode's
 * selectors are untouched by it.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { diffSnapshots } from "../../src/computed.ts";
import { locate, PROPS, snapshot, snapshotStates } from "../../src/locate.ts";
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

test("an auto margin reads as auto, whatever px the layout resolves it to", async () => {
  const body = `<div class="c">x</div>`;
  const css = "body { margin: 0 } .c { width: 100px; margin: 0 auto }";
  const margins = (d: Awaited<ReturnType<typeof diff>>["d"]) =>
    d.changes.filter((c) => c.prop.startsWith("margin-")).map((c) => [c.key, c.prop, c.values]);
  // A grid item's auto margins resolve to 0px, a block's to the centring px.
  const centred = await diff(body, body, [css, `${css} body { display: grid }`]);
  assert.deepEqual(margins(centred.d), []);
  assert.equal(centred.snaps[0]["body > div.c"]!.styles[PROPS.indexOf("margin-left")], "auto");
  const fixed = await diff(body, body, [css, `${css} .c { margin: 0 60px }`]);
  assert.deepEqual(margins(fixed.d), [
    ["body > div.c", "margin-right", ["auto", "60px"]],
    ["body > div.c", "margin-left", ["auto", "60px"]],
  ]);
});

test("with a selector the walk covers only that subtree, keyed from :scope", async () => {
  const p = await page(`<header><a href="/">Home</a></header><div class="card"><b>x</b></div>`);
  const snap = await snapshot(p, [], BUDGET, p.locator(".card"));
  await p.close();
  assert.deepEqual(Object.keys(snap), [":scope", ":scope > b"]);
});

test("ten thousand siblings walk inside the budget; past it, the walk says so", async () => {
  const p = await page(`<ul>${"<li>x</li>".repeat(10_000)}</ul>`);
  // Keyed per sibling, this was quadratic and blew the budget; it throws if it still does.
  const snap = await snapshot(p, [], BUDGET, null);
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

async function states(body: string, css: [string, string]) {
  const [l, r] = await Promise.all([page(body, css[0]), page(body, css[1])]);
  const s = await Promise.all([l, r].map((p) => snapshotStates(p, [], BUDGET, null)));
  await Promise.all([l.close(), r.close()]);
  return diffSnapshots(s[0]!.snap, s[1]!.snap);
}

const LINK = `<nav><a href="#x">Go <span class="icon">></span></a></nav>`;
const A = `body > nav > a[href="#x"]`;
const changed = (d: ReturnType<typeof diffSnapshots>) => d.changes.map((c) => [c.key, c.prop]);

test("a hover colour one side drops is a finding on the link's :hover key alone", async () => {
  const d = await states(LINK, ["a:hover { color: red }", ""]);
  assert.equal(d.dom, 0);
  assert.deepEqual(d.unmatched, { left: [], right: [] });
  assert.deepEqual(changed(d), [
    [`${A}:hover`, "color"],
    [`${A}:hover`, "border-top-color"],
    [`${A}:hover > span.icon`, "border-top-color"],
  ]);
});

test("a dropped focus ring shows on :focus-visible as outline", async () => {
  const d = await states(LINK, ["a:focus-visible { outline: 2px solid blue }", ""]);
  assert.deepEqual(changed(d), [[`${A}:focus-visible`, "outline"]]);
});

test("a rule on a hovered link's child is keyed under the :hover", async () => {
  const d = await states(LINK, ["a:hover .icon { color: red }", ""]);
  assert.deepEqual(changed(d), [
    [`${A}:hover > span.icon`, "color"],
    [`${A}:hover > span.icon`, "border-top-color"],
  ]);
});

test("same states are no change, and a resting change isn't repeated per state", async () => {
  const css = "a:hover { color: red } a:focus-visible { outline: 1px solid }";
  assert.deepEqual(changed(await states(LINK, [css, css])), []);
  const d = await states(LINK, ["a { text-decoration: underline }", "a { text-decoration: none }"]);
  assert.deepEqual(changed(d), [[A, "text-decoration-line"]]);
});

test("past 500 links the rest are counted, and the page is left resting", async () => {
  const p = await page(
    `<a href="#x">x</a>${"<a href='#y'>y</a>".repeat(500)}`,
    "a:hover { color: red }",
  );
  const before = await snapshot(p, [], BUDGET, null);
  const { snap, unchecked } = await snapshotStates(p, [], BUDGET, null);
  assert.equal(unchecked, 1);
  assert.ok(snap[`body > a[href="#x"]:hover`]);
  assert.equal(await p.evaluate(() => "__renderdiffStates" in globalThis), false);
  assert.deepEqual(await snapshot(p, [], BUDGET, null), before);
  await p.close();
});
