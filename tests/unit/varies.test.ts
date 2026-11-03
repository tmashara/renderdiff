/** The `varies` block suggests masks only for selectors that name an element by id, class or attribute, and only where no box moved between loads. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ComparedResult } from "../../src/report.ts";
import { fmtVaries } from "../../src/run.ts";

const box = { x: 0, y: 0, w: 1240, h: 24 };

const shot = (url: string, selectors: string[], right = box, changed = {}) =>
  ({
    status: "compared",
    url,
    left: url,
    right: url,
    selector: null,
    width: 1440,
    variesPixels: 48263,
    varies: [
      {
        x: 0,
        y: 0,
        w: 1240,
        h: 1,
        elements: selectors.map((selector) => ({
          selector,
          side: "both",
          left: box,
          right,
          changed,
        })),
      },
    ],
  }) as unknown as ComparedResult;

test("bare-tag selectors are listed but not suggested as masks", () => {
  const out = fmtVaries(
    [shot("/a", ["p:nth-of-type(14)", "#main > p:nth-of-type(3)", ".card", '[data-testid="a b"]'])],
    ["/a"],
  );
  assert.equal(
    out[0],
    `varies /a @1440  48,263px painted out  p:nth-of-type(14) #main > p:nth-of-type(3) .card [data-testid="a b"]`,
  );
  assert.equal(out[1], `  --mask '.card' --mask '[data-testid="a b"]'`);
  assert.match(
    out[2]!,
    /^ {2}masks: \[\{ selector: "\.card".*selector: "\[data-testid=\\"a b\\"\]"/,
  );
});

test("no suggestion lines when every selector is bare", () => {
  assert.equal(fmtVaries([shot("/a", ["p:nth-of-type(14)", "div"])], ["/a"]).length, 1);
});

test("a box that moved between loads: listed as layout moved, no mask suggested", () => {
  const out = fmtVaries(
    [shot("/a", [".card"]), shot("/b", ["div.body", "aside.side"], { ...box, x: 37, w: 1203 })],
    ["/a", "/b"],
  );
  assert.deepEqual(out.slice(0, 2), [
    "varies /a @1440  48,263px painted out  .card",
    "varies /b @1440  48,263px painted out  div.body aside.side  layout moved",
  ]);
  assert.equal(out[2], "  --mask '.card'");
  assert.doesNotMatch(out[3]!, /div\.body|aside/);
});

test("a box that resized with its own text is still suggested", () => {
  const out = fmtVaries(
    [
      shot("/a", [".count"], { ...box, w: 1203 }, { text: ["9.9k", "10.0k"] }),
      shot("/b", [".hero"], { ...box, w: 1203, h: 40 }),
    ],
    ["/a", "/b"],
  );
  assert.equal(out[0], "varies /a @1440  48,263px painted out  .count");
  assert.equal(out[1], "varies /b @1440  48,263px painted out  .hero");
  assert.equal(out[2], "  --mask '.count' --mask '.hero'");
});
