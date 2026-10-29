/** Thin horizontal regions come out labelled as lines, with the side that draws them. */
import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { compare } from "../../src/compare.ts";
import { fmtLine } from "../../src/format.ts";

const W = 400,
  H = 200;
const png = (paint: (px: Buffer) => void) => {
  const px = Buffer.alloc(W * H * 4, 255);
  paint(px);
  return sharp(px, { raw: { width: W, height: H, channels: 4 } })
    .png()
    .toBuffer();
};
const rect = (px: Buffer, x: number, y: number, w: number, h: number) => {
  for (let j = y; j < y + h; j++)
    for (let i = x; i < x + w; i++) px.fill(0x33, (j * W + i) * 4, (j * W + i) * 4 + 3);
};
const shot = async (paint: (px: Buffer) => void) => ({
  png: await png(paint),
  unstable: null,
  blank: null,
  text: [],
  origin: { x: 0, y: 0 },
  failed: [],
});

test("a lost 1px divider is a line drawn by the right side", async () => {
  const d = await compare(await shot(() => {}), await shot((px) => rect(px, 0, 100, W, 1)));
  assert.deepEqual(d.regions[0]!.line, { y: 100, h: 1, side: "right" });
  assert.equal(fmtLine(d.regions[0]!.line!), "line -1px@y100");
});

test("a 2px line only the left draws is +2px", async () => {
  const d = await compare(await shot((px) => rect(px, 20, 47, 360, 2)), await shot(() => {}));
  assert.deepEqual(d.regions[0]!.line, { y: 47, h: 2, side: "left" });
});

test("a box is not a line", async () => {
  const d = await compare(await shot(() => {}), await shot((px) => rect(px, 40, 40, 40, 40)));
  assert.equal(d.regions.length, 1);
  assert.equal(d.regions[0]!.line, undefined);
});

test("a divider lost above a dark footer is still the right side's", async () => {
  const footer = (px: Buffer) => {
    for (let i = 101 * W * 4; i < px.length; i += 4) px.fill(0x60, i, i + 3);
  };
  const d = await compare(
    await shot(footer),
    await shot((px) => {
      footer(px);
      rect(px, 0, 100, W, 1);
    }),
  );
  assert.deepEqual(d.regions[0]!.line, { y: 100, h: 1, side: "right" });
});
