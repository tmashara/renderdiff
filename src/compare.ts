import pixelmatch from "pixelmatch";
import sharp from "sharp";
import type { Shot } from "./capture.ts";
import { MASK_COLOR } from "./config.ts";

/**
 * Pixel diff between two shots. sharp decodes/pads/encodes, pixelmatch compares.
 *
 * No pngjs: it exists to bridge PNG<->raw RGBA, and sharp already is that bridge.
 *
 * pixelmatch rather than sharp's `composite({blend:"difference"})`, which yields a
 * per-channel mean rather than a thresholded count and has no anti-aliasing
 * tolerance. That tolerance is the point — two DOM structures painting the same text
 * in the same place still disagree on subpixels, so `includeAA:false` is what keeps
 * the score from being noise.
 */

export interface Diff {
  /** 0..1, share of pixels that match. */
  score: number;
  diffPixels: number;
  totalPixels: number;
  /** Painted-height and -width deltas (left − right), straight from the PNGs. */
  heightDelta: number;
  widthDelta: number;
  diffPng: Buffer;
}

/**
 * Pad a shot onto a common (w, h) canvas so both frames are the same size for
 * pixelmatch, with the image top-left and magenta everywhere else.
 *
 * Composited onto a created canvas rather than `sharp.extend()`, which rejects any
 * single edge past 10 000px. Two pages can easily differ by more than that — one long
 * scrolling page against a short one — and that is exactly the case worth diffing.
 */
const toRaw = (png: Buffer, w: number, h: number) =>
  sharp({
    create: { width: w, height: h, channels: 4, background: MASK_COLOR },
  })
    .composite([{ input: png, left: 0, top: 0 }])
    .raw()
    .ensureAlpha()
    .toBuffer();

export async function compare(left: Shot, right: Shot): Promise<Diff> {
  // Real PNG dimensions, not the `scrollHeight` we measured: that can disagree with
  // what Chromium actually painted.
  const [lm, rm] = await Promise.all([
    sharp(left.png).metadata(),
    sharp(right.png).metadata(),
  ]);
  const lw = lm.width!,
    lh = lm.height!,
    rw = rm.width!,
    rh = rm.height!;

  const w = Math.max(lw, rw);
  const h = Math.max(lh, rh);

  const [l, r] = await Promise.all([
    toRaw(left.png, w, h),
    toRaw(right.png, w, h),
  ]);

  const out = Buffer.alloc(w * h * 4);
  // `l`/`r`/`out` are Buffers, i.e. Uint8Arrays — pixelmatch takes them directly.
  const diffPixels = pixelmatch(l, r, out, w, h, {
    threshold: 0.1,
    includeAA: false,
    alpha: 0.25,
  });

  // Default zlib level: the diff PNG is a local intermediate (mostly transparent with
  // sparse red), so max compression buys little size for noticeably more CPU per job.
  const diffPng = await sharp(out, {
    raw: { width: w, height: h, channels: 4 },
  })
    .png()
    .toBuffer();

  // Padding is magenta against real content, so a height difference lands in
  // `diffPixels` and drags the score down. Intended: a page 400px shorter than the
  // one it's compared against has not reached parity. `heightDelta` names the cause.
  return {
    score: 1 - diffPixels / (w * h),
    diffPixels,
    totalPixels: w * h,
    heightDelta: lh - rh,
    widthDelta: lw - rw,
    diffPng,
  };
}
