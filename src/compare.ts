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

/** A connected patch of differing pixels, in page px, snapped outward to the 16px grid. */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Differing pixels inside it. */
  pixels: number;
}

/** Rows one side has that the other lacks, at `y` in that side's own coordinates. */
export interface Band {
  side: "left" | "right";
  y: number;
  h: number;
}

/** Left is the changed version, right the reference: `added` is on left only, `removed` on right only. */
export interface TextDiff {
  added: string[];
  removed: string[];
}

export interface Diff {
  /** 0..1, share of pixels that match. */
  score: number;
  diffPixels: number;
  totalPixels: number;
  /** Painted-height and -width deltas (left − right), straight from the PNGs. */
  heightDelta: number;
  widthDelta: number;
  /** Largest first, within the area both shots cover; padding is the deltas and bands. */
  regions: Region[];
  /** Null when the rows were too different to align. */
  bands: Band[] | null;
  /** Share of matching pixels over the rows the alignment pairs. Null unless there are bands. */
  alignedScore: number | null;
  text: TextDiff;
  diffPng: Buffer;
}

const PIXELMATCH = { threshold: 0.1, includeAA: false, alpha: 0.25 };

/** Edit-distance cap for `myers`: past it, memory is O(D²) and the answer is "unrelated" anyway. */
const MAX_EDIT = 2000;

const CELL = 16;

/** `MASK_COLOR` (#FF00FF, opaque) as one little-endian RGBA word. */
const MAGENTA = 0xffff00ff;

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

  const text = textDiff(left.text, right.text);
  const out = Buffer.alloc(w * h * 4);
  // Identical shots skip pixelmatch's grey drawing and leave the diff PNG fully transparent.
  // `l`/`r`/`out` are Buffers, i.e. Uint8Arrays — pixelmatch takes them directly.
  const diffPixels = l.equals(r) ? 0 : pixelmatch(l, r, out, w, h, PIXELMATCH);

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
    regions: diffPixels ? regions(out, w, Math.min(lw, rw), Math.min(lh, rh)) : [],
    ...(diffPixels ? align(l, r, w, lh, rh) : { bands: [], alignedScore: null }),
    text,
    diffPng,
  };
}

/**
 * Myers' O((N+M)·D) diff: the matched index pairs of a shortest edit script, in order.
 * Null once the edit distance passes `maxD`, unless the edit is one pure insertion or deletion.
 */
function myers<T>(
  a: ArrayLike<T>,
  b: ArrayLike<T>,
  maxD = MAX_EDIT,
): [number, number][] | null {
  const n = a.length,
    m = b.length;
  let p = 0,
    s = 0;
  while (p < n && p < m && a[p] === b[p]) p++;
  while (s < n - p && s < m - p && a[n - 1 - s] === b[m - 1 - s]) s++;
  if (p + s === n || p + s === m) {
    const pairs: [number, number][] = [];
    for (let i = 0; i < p; i++) pairs.push([i, i]);
    for (let i = s; i > 0; i--) pairs.push([n - i, m - i]);
    return pairs;
  }
  const max = Math.min(n + m, maxD),
    off = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d][k + d] is v[k] after round d.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!)
          ? v[off + k + 1]!
          : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) x++, y++;
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m, d);
    }
    trace.push(v.slice(off - d, off + d + 1));
  }
  return null;
}

function backtrack(trace: Int32Array[], n: number, m: number, D: number) {
  const pairs: [number, number][] = [];
  let x = n,
    y = m;
  for (let d = D; d > 0; d--) {
    const p = trace[d - 1]!;
    const at = (k: number) => p[k + d - 1]!;
    const k = x - y;
    const pk = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const px = at(pk),
      py = px - pk;
    while (x > px && y > py) pairs.push([--x, --y]);
    x = px;
    y = py;
  }
  while (x > 0 && y > 0) pairs.push([--x, --y]);
  return pairs.reverse();
}

function textDiff(a: string[], b: string[]): TextDiff {
  const pairs = myers(a, b);
  if (!pairs) {
    // Too different to align: fall back to plain membership.
    const inA = new Set(a),
      inB = new Set(b);
    return {
      added: a.filter((s) => !inB.has(s)),
      removed: b.filter((s) => !inA.has(s)),
    };
  }
  const ka = new Set(pairs.map((p) => p[0])),
    kb = new Set(pairs.map((p) => p[1]));
  return {
    added: a.filter((_, i) => !ka.has(i)),
    removed: b.filter((_, i) => !kb.has(i)),
  };
}

/**
 * Connected components (8-way) over 16px cells holding any pixel pixelmatch painted as a diff,
 * within the top-left `w`×`h` of the `stride`-wide diff.
 */
function regions(out: Buffer, stride: number, w: number, h: number): Region[] {
  const cw = Math.ceil(w / CELL),
    ch = Math.ceil(h / CELL);
  const cells = new Uint32Array(cw * ch);
  for (let y = 0; y < h; y++) {
    const row = ((y / CELL) | 0) * cw;
    for (let x = 0, o = y * stride * 4; x < w; x++, o += 4) {
      // diffColor red; unchanged pixels are grey and AA ones yellow, so neither matches.
      if (out[o] === 255 && out[o + 1] === 0 && out[o + 2] === 0) {
        cells[row + ((x / CELL) | 0)]!++;
      }
    }
  }
  const seen = new Uint8Array(cells.length);
  const found: Region[] = [];
  for (let s = 0; s < cells.length; s++) {
    if (!cells[s] || seen[s]) continue;
    let x0 = cw,
      y0 = ch,
      x1 = 0,
      y1 = 0,
      pixels = 0;
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const c = stack.pop()!,
        cx = c % cw,
        cy = (c / cw) | 0;
      pixels += cells[c]!;
      x0 = Math.min(x0, cx);
      x1 = Math.max(x1, cx);
      y0 = Math.min(y0, cy);
      y1 = Math.max(y1, cy);
      for (let ny = Math.max(0, cy - 1); ny <= Math.min(ch - 1, cy + 1); ny++) {
        for (let nx = Math.max(0, cx - 1); nx <= Math.min(cw - 1, cx + 1); nx++) {
          const nc = ny * cw + nx;
          if (cells[nc] && !seen[nc]) {
            seen[nc] = 1;
            stack.push(nc);
          }
        }
      }
    }
    found.push({
      x: x0 * CELL,
      y: y0 * CELL,
      w: Math.min(w, (x1 + 1) * CELL) - x0 * CELL,
      h: Math.min(h, (y1 + 1) * CELL) - y0 * CELL,
      pixels,
    });
  }
  return found.sort((a, b) => b.pixels - a.pixels);
}

/** FNV-1a over each row's RGBA words. */
function rowHashes(raw: Buffer, w: number, rows: number): Uint32Array {
  const px = new Uint32Array(raw.buffer, raw.byteOffset, w * rows);
  const out = new Uint32Array(rows);
  for (let y = 0; y < rows; y++) {
    let hash = 0x811c9dc5;
    for (let i = y * w, end = i + w; i < end; i++) {
      hash = Math.imul(hash ^ px[i]!, 16777619);
    }
    out[y] = hash;
  }
  return out;
}

/**
 * Myers can place an insertion anywhere along a stretch of identical rows (whitespace, a
 * repeated border) and split one insertion in two. As git does, slide each run of unmatched
 * rows up as far as it goes, then down, merging runs that meet, so it settles in one piece at
 * the bottom of that stretch. The matched rows still read the same values in the same order.
 */
function compact(hash: Uint32Array, changed: Uint8Array) {
  const n = changed.length;
  for (let s = 0; s < n; s++) {
    if (!changed[s]) continue;
    let e = s;
    while (e < n && changed[e]) e++;
    for (;;) {
      while (s > 0 && !changed[s - 1] && hash[s - 1] === hash[e - 1]) {
        changed[--s] = 1;
        changed[--e] = 0;
      }
      if (!(s > 0 && changed[s - 1])) break;
      while (s > 0 && changed[s - 1]) s--;
    }
    for (;;) {
      while (e < n && !changed[e] && hash[s] === hash[e]) {
        changed[s++] = 0;
        changed[e++] = 1;
      }
      if (!(e < n && changed[e])) break;
      while (e < n && changed[e]) e++;
    }
    s = e;
  }
}

/**
 * Pair rows across the two shots by Myers over row hashes. Each gap between matched rows
 * pairs its rows top-down; whatever one side has left over is a band. Paired rows are
 * restacked and pixelmatched for the aligned score.
 */
function align(l: Buffer, r: Buffer, w: number, lh: number, rh: number) {
  const ha = rowHashes(l, w, lh),
    hb = rowHashes(r, w, rh);
  const matched = myers(ha, hb);
  if (!matched) return { bands: lh === rh ? [] : null, alignedScore: null };
  const ca = new Uint8Array(lh).fill(1),
    cb = new Uint8Array(rh).fill(1);
  for (const [i, j] of matched) ca[i] = cb[j] = 0;
  const raw = pairUp(ca, cb);
  compact(ha, ca);
  compact(hb, cb);
  const packed = pairUp(ca, cb);
  // Compacting each side alone can misalign their gaps and turn an in-place change into a band pair.
  const height = (p: typeof raw) => p.bands.reduce((t, b) => t + b.h, 0);
  const { bands, rows } = height(packed) <= height(raw) ? packed : raw;
  if (!bands.length || !rows.length) return { bands, alignedScore: null };
  const stride = w * 4;
  const a = Buffer.alloc(rows.length * stride),
    b = Buffer.alloc(rows.length * stride);
  rows.forEach(([ly, ry], j) => {
    l.copy(a, j * stride, ly * stride, (ly + 1) * stride);
    r.copy(b, j * stride, ry * stride, (ry + 1) * stride);
  });
  // Unstable pixels and masks are magenta at page coordinates, which a band shifts apart.
  const pa = new Uint32Array(a.buffer, a.byteOffset, rows.length * w),
    pb = new Uint32Array(b.buffer, b.byteOffset, rows.length * w);
  let masked = 0;
  for (let i = 0; i < pa.length; i++) {
    if (pa[i] === MAGENTA || pb[i] === MAGENTA) {
      pa[i] = pb[i] = MAGENTA;
      masked++;
    }
  }
  const diff = pixelmatch(a, b, undefined, w, rows.length, PIXELMATCH);
  const measured = rows.length * w - masked;
  return { bands, alignedScore: measured > 0 ? 1 - diff / measured : null };
}

/** Pair each side's kept rows in order; each gap pairs top-down and its leftover is a band. */
function pairUp(ca: Uint8Array, cb: Uint8Array) {
  const lh = ca.length,
    rh = cb.length;
  const ka = [...ca.keys()].filter((i) => !ca[i]),
    kb = [...cb.keys()].filter((j) => !cb[j]);
  const bands: Band[] = [];
  const rows: [number, number][] = [];
  let x = 0,
    y = 0;
  for (const [px, py] of [...ka.map((i, n) => [i, kb[n]!] as const), [lh, rh] as const]) {
    const k = Math.min(px - x, py - y);
    for (let j = 0; j < k; j++) rows.push([x + j, y + j]);
    if (px - x > k) bands.push({ side: "left", y: x + k, h: px - x - k });
    if (py - y > k) bands.push({ side: "right", y: y + k, h: py - y - k });
    if (px < lh) rows.push([px, py]);
    x = px + 1;
    y = py + 1;
  }
  return { bands, rows };
}

const CROP_PAD = 48;
const CROP_GAP = 8;
const CROP_MAX = 1200;
export const MAX_CROPS = 5;

/**
 * One PNG per region (the largest `MAX_CROPS`): left | right | diff side by side, each the
 * padded region box clipped to the area both shots cover, scaled down to `CROP_MAX` on the
 * long side. A full-page diff Read by an agent is downscaled past legibility; a crop isn't.
 */
export async function crops(
  left: Buffer,
  right: Buffer,
  diff: Buffer,
  found: Region[],
): Promise<Buffer[]> {
  if (!found.length) return [];
  const [lm, rm] = await Promise.all([sharp(left).metadata(), sharp(right).metadata()]);
  const cw = Math.min(lm.width!, rm.width!);
  const ch = Math.min(lm.height!, rm.height!);
  return Promise.all(
    found.slice(0, MAX_CROPS).map(async (g) => {
      const x = Math.max(0, g.x - CROP_PAD);
      const y = Math.max(0, g.y - CROP_PAD);
      const box = {
        left: x,
        top: y,
        width: Math.min(cw, g.x + g.w + CROP_PAD) - x,
        height: Math.min(ch, g.y + g.h + CROP_PAD) - y,
      };
      const panels = await Promise.all(
        [left, right, diff].map((png) => sharp(png).extract(box).toBuffer()),
      );
      const sheet = await sharp({
        create: {
          width: 3 * box.width + 2 * CROP_GAP,
          height: box.height,
          channels: 4,
          background: "#808080",
        },
      })
        .composite(
          panels.map((input, i) => ({ input, left: i * (box.width + CROP_GAP), top: 0 })),
        )
        .png()
        .toBuffer();
      return sharp(sheet)
        .resize(CROP_MAX, CROP_MAX, { fit: "inside", withoutEnlargement: true })
        .png()
        .toBuffer();
    }),
  );
}
