/** The `varies` block suggests masks only for selectors that name an element by id, class or attribute. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ComparedResult } from "../../src/report.ts";
import { fmtVaries } from "../../src/run.ts";

const shot = (url: string, selectors: string[]) =>
  ({
    status: "compared",
    url,
    left: url,
    right: url,
    selector: null,
    width: 1440,
    variesPixels: 48263,
    varies: [{ x: 0, y: 0, w: 1240, h: 1, elements: selectors.map((selector) => ({ selector })) }],
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
