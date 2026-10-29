import pixelmatch from "pixelmatch";
import sharp, { type OverlayOptions } from "sharp";
import type { Shot } from "./capture.ts";
import type { ElementDiff } from "./locate.ts";
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

/**
 * A connected patch of differing pixels, snapped outward to the 16px grid, in left page px.
 * With bands it comes from the realigned rows, so content a band merely pushed down isn't one.
 */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Differing pixels inside it. */
  pixels: number;
  /** When it is a thin horizontal run across the page: its row, height and the side that draws it. */
  line?: Line;
  /** The elements under it; absent when not looked at. */
  elements?: ElementDiff[];
  /** Both sides' pixels under it, hashed, for matching it against accepted ones. */
  hash?: string;
  /** The reason of the accepted difference it matched. */
  accepted?: string;
}

export interface Line {
  /** Top row, in left page px. */
  y: number;
  /** 1 or 2. */
  h: number;
  /** Which side draws it; null when both do, e.g. a recolour. */
  side: "left" | "right" | null;
}

/** Rows one side has that the other lacks, at `y` in that side's own coordinates. */
export interface Band {
  side: "left" | "right";
  y: number;
  h: number;
  /** The elements in its rows; absent when not looked at. */
  elements?: ElementDiff[];
  /** Its rows' pixels, hashed, for matching it against accepted ones. */
  hash?: string;
  /** The reason of the accepted difference it matched. */
  accepted?: string;
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
  /** What to crop: bands, largest first, then regions. */
  spots: Spot[];
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A change located on each side, in that side's page px. `h` 0 is where the other side's band would go. */
export interface Spot {
  kind: "band" | "region";
  left: Box;
  right: Box;
  /** The result entry it locates. */
  target: Region | Band;
}

/** Not pixelmatch's default 0.1: it passes Tailwind v3→v4 pink-500 (YIQ delta 117, cut-off 352). */
const PIXELMATCH = { threshold: 0.05, includeAA: false, alpha: 0.25 };

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
  const [lm, rm] = await Promise.all([sharp(left.png).metadata(), sharp(right.png).metadata()]);
  const lw = lm.width!,
    lh = lm.height!,
    rw = rm.width!,
    rh = rm.height!;

  const w = Math.max(lw, rw);
  const h = Math.max(lh, rh);

  const [l, r] = await Promise.all([toRaw(left.png, w, h), toRaw(right.png, w, h)]);

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

  const cw = Math.min(lw, rw);
  const aligned = diffPixels
    ? align(l, r, w, cw, lh, rh)
    : { bands: [], alignedScore: null, regions: [], spots: [] };
  const found = aligned.regions ?? regions(out, w, cw, Math.min(lh, rh), l, r);
  const spots = aligned.regions
    ? aligned.spots
    : [
        ...aligned.spots,
        ...found.map(({ x, y, w, h }, i): Spot => ({
          kind: "region",
          left: { x, y, w, h },
          right: { x, y, w, h },
          target: found[i]!,
        })),
      ];
  for (const s of spots) s.target.hash = pixelHash(l, r, w, [s.left, s.right]);
  // Padding is magenta against real content, so a height difference lands in
  // `diffPixels` and drags the score down. Intended: a page 400px shorter than the
  // one it's compared against has not reached parity. `heightDelta` names the cause.
  return {
    score: 1 - diffPixels / (w * h),
    diffPixels,
    totalPixels: w * h,
    heightDelta: lh - rh,
    widthDelta: lw - rw,
    regions: found,
    bands: aligned.bands,
    alignedScore: aligned.alignedScore,
    text,
    diffPng,
    spots,
  };
}

/**
 * Myers' O((N+M)·D) diff: the matched index pairs of a shortest edit script, in order.
 * Null once the edit distance passes `maxD`, unless the edit is one pure insertion or deletion.
 */
function myers<T>(a: ArrayLike<T>, b: ArrayLike<T>, maxD = MAX_EDIT): [number, number][] | null {
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
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
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

export function textDiff(a: string[], b: string[]): TextDiff {
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
 * within the top-left `w`×`h` of the `stride`-wide diff of `a` and `b`.
 */
function regions(
  out: Buffer,
  stride: number,
  w: number,
  h: number,
  a: Buffer,
  b: Buffer,
): Region[] {
  const cw = Math.ceil(w / CELL),
    ch = Math.ceil(h / CELL);
  const cells = new Uint32Array(cw * ch);
  for (let y = 0; y < h; y++) {
    const row = ((y / CELL) | 0) * cw;
    for (let x = 0, o = y * stride * 4; x < w; x++, o += 4) {
      // diffColor red; unchanged pixels are grey and AA ones yellow, so neither matches.
      if (red(out, o)) {
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
    const g: Region = {
      x: x0 * CELL,
      y: y0 * CELL,
      w: Math.min(w, (x1 + 1) * CELL) - x0 * CELL,
      h: Math.min(h, (y1 + 1) * CELL) - y0 * CELL,
      pixels,
    };
    const l = g.h <= 2 * CELL && line(g, out, stride, w, h, a, b);
    found.push(l ? { ...g, line: l } : g);
  }
  return found.sort((a, b) => b.pixels - a.pixels);
}

const red = (out: Buffer, o: number) => out[o] === 255 && out[o + 1] === 0 && out[o + 2] === 0;

/**
 * A region whose red pixels sit in 1–2 rows spanning at least half the width and filling most of
 * that run. A side draws it when its pixels there differ from the rows on both sides of it.
 */
function line(
  g: Region,
  out: Buffer,
  stride: number,
  w: number,
  h: number,
  a: Buffer,
  b: Buffer,
): Line | null {
  let x0 = w,
    y0 = h,
    x1 = -1,
    y1 = -1,
    n = 0;
  for (let y = g.y; y < g.y + g.h; y++)
    for (let x = g.x; x < g.x + g.w; x++)
      if (red(out, (y * stride + x) * 4)) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
        n++;
      }
  const lh = y1 - y0 + 1,
    lw = x1 - x0 + 1;
  // ponytail: half the compared width counts as across the page; full width only if it misfires
  if (lh > 2 || lw < w / 2 || n < 0.5 * lw * lh) return null;
  const around = [y0 - 1, y1 + 1].filter((y) => y >= 0 && y < h);
  if (!around.length) return null;
  const pa = new Uint32Array(a.buffer, a.byteOffset, (a.length / 4) | 0),
    pb = new Uint32Array(b.buffer, b.byteOffset, (b.length / 4) | 0);
  let da = 0,
    db = 0;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      if (!red(out, (y * stride + x) * 4)) continue;
      if (around.every((n) => pa[y * stride + x] !== pa[n * stride + x])) da++;
      if (around.every((n) => pb[y * stride + x] !== pb[n * stride + x])) db++;
    }
  const [sa, sb] = [da > n / 2, db > n / 2];
  return { y: y0, h: lh, side: sa === sb ? null : sa ? "left" : "right" };
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
 * restacked and pixelmatched for the aligned score and for regions, mapped back to each side.
 * `regions` is null when there is nothing realigned to take them from.
 */
function align(l: Buffer, r: Buffer, w: number, cw: number, lh: number, rh: number) {
  const ha = rowHashes(l, w, lh),
    hb = rowHashes(r, w, rh);
  const matched = myers(ha, hb);
  if (!matched) {
    return { bands: lh === rh ? [] : null, alignedScore: null, regions: null, spots: [] };
  }
  const ca = new Uint8Array(lh).fill(1),
    cb = new Uint8Array(rh).fill(1);
  for (const [i, j] of matched) ca[i] = cb[j] = 0;
  const raw = pairUp(ca, cb);
  compact(ha, ca);
  compact(hb, cb);
  const packed = pairUp(ca, cb);
  // Compacting each side alone can misalign their gaps and turn an in-place change into a band pair.
  const height = (p: typeof raw) => p.bands.reduce((t, b) => t + b.h, 0);
  const { bands, at, rows } = inPlace(height(packed) <= height(raw) ? packed : raw, ha, hb);
  // A band is rows on one side and a zero-height seam on the other, as wide as what's drawn in it.
  const spots = bands
    .map((b, i): Spot => {
      const { x, w: bw } = inkX(b.side === "left" ? l : r, w, cw, b.y, b.y + b.h);
      const here = { x, y: b.y, w: bw, h: b.h };
      const seam = { x, y: at[i]!, w: bw, h: 0 };
      return {
        kind: "band",
        left: b.side === "left" ? here : seam,
        right: b.side === "right" ? here : seam,
        target: b,
      };
    })
    .sort((a, b) => b.left.h + b.right.h - (a.left.h + a.right.h));
  if (!bands.length || !rows.length) return { bands, alignedScore: null, regions: null, spots };
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
  const out = Buffer.alloc(rows.length * stride);
  const diff = pixelmatch(a, b, out, w, rows.length, PIXELMATCH);
  const measured = rows.length * w - masked;
  const found = diff ? regions(out, w, cw, rows.length, a, b) : [];
  const side = (g: Region, s: 0 | 1) => {
    const y = rows[g.y]![s];
    return { y, h: rows[g.y + g.h - 1]![s] + 1 - y };
  };
  const regs = found.map((g) => ({
    ...g,
    ...side(g, 0),
    ...(g.line ? { line: { ...g.line, y: rows[g.line.y]![0] } } : {}),
  }));
  found.forEach((g, i) => {
    spots.push({
      kind: "region",
      left: { x: g.x, w: g.w, ...side(g, 0) },
      right: { x: g.x, w: g.w, ...side(g, 1) },
      target: regs[i]!,
    });
  });
  return {
    bands,
    alignedScore: measured > 0 ? 1 - diff / measured : null,
    regions: regs,
    spots,
  };
}

/**
 * A recolour inside a run of identical rows comes out of Myers as a left band and a right band
 * of the same height. When pairing the span straight leaves every row outside the two bands
 * identical, that is one change in place: pair it row for row, so it reads as a region. A
 * block removed at one place and another added elsewhere fails that test and stays two bands.
 */
function inPlace(p: ReturnType<typeof pairUp>, ha: Uint32Array, hb: Uint32Array) {
  let { bands, at, rows } = p;
  for (let i = 0; i + 1 < bands.length; i++) {
    const [a, b] = [bands[i]!, bands[i + 1]!];
    if (a.side === b.side || a.h !== b.h) continue;
    const ls = a.side === "left" ? a.y : at[i]!,
      rs = a.side === "right" ? a.y : at[i]!;
    const le = b.side === "left" ? b.y + b.h : at[i + 1]!,
      re = b.side === "right" ? b.y + b.h : at[i + 1]!;
    if (le - ls !== re - rs) continue;
    const span = Array.from({ length: le - ls }, (_, k): [number, number] => [ls + k, rs + k]);
    const inBand = (side: Band["side"], y: number) =>
      [a, b].some((n) => n.side === side && y >= n.y && y < n.y + n.h);
    // Matched rows always hash alike, so test the straight pairing about to replace them.
    if (!span.every(([ly, ry]) => inBand("left", ly) || inBand("right", ry) || ha[ly] === hb[ry]))
      continue;
    rows = [...rows.filter(([ly]) => ly < ls), ...span, ...rows.filter(([ly]) => ly >= le)];
    bands = bands.filter((_, j) => j !== i && j !== i + 1);
    at = at.filter((_, j) => j !== i && j !== i + 1);
    i--;
  }
  return { bands, at, rows };
}

/**
 * FNV-1a over every pixel of the change on both sides, 4 bits a channel, as hex: shade jitter
 * under one step survives, any other change to what is drawn there doesn't.
 */
function pixelHash(l: Buffer, r: Buffer, stride: number, boxes: [Box, Box]): string {
  let hash = 0x811c9dc5;
  for (const [raw, b] of [
    [l, boxes[0]],
    [r, boxes[1]],
  ] as const) {
    for (let y = b.y; y < b.y + b.h; y++) {
      for (let x = b.x, o = (y * stride + x) * 4; x < b.x + b.w; x++, o += 4) {
        hash = Math.imul(
          hash ^ ((raw[o]! >> 4) | (raw[o + 1]! & 0xf0) | ((raw[o + 2]! >> 4) << 8)),
          16777619,
        );
      }
    }
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Columns holding anything but each row's x=0 colour, over rows `y0..y1`; the full width if none. */
function inkX(raw: Buffer, stride: number, w: number, y0: number, y1: number) {
  const px = new Uint32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  let x0 = w,
    x1 = -1;
  for (let y = y0; y < y1; y++) {
    const bg = px[y * stride]!;
    for (let x = 0; x < w; x++) {
      if (px[y * stride + x] !== bg) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
      }
    }
  }
  return x1 < 0 ? { x: 0, w } : { x: x0, w: x1 - x0 + 1 };
}

/** Pair each side's kept rows in order; each gap pairs top-down and its leftover is a band. */
function pairUp(ca: Uint8Array, cb: Uint8Array) {
  const lh = ca.length,
    rh = cb.length;
  const ka = [...ca.keys()].filter((i) => !ca[i]),
    kb = [...cb.keys()].filter((j) => !cb[j]);
  const bands: Band[] = [];
  /** Where each band sits on the other side. */
  const at: number[] = [];
  const rows: [number, number][] = [];
  let x = 0,
    y = 0;
  for (const [px, py] of [...ka.map((i, n) => [i, kb[n]!] as const), [lh, rh] as const]) {
    const k = Math.min(px - x, py - y);
    for (let j = 0; j < k; j++) rows.push([x + j, y + j]);
    if (px - x > k) {
      bands.push({ side: "left", y: x + k, h: px - x - k });
      at.push(py);
    }
    if (py - y > k) {
      bands.push({ side: "right", y: y + k, h: py - y - k });
      at.push(px);
    }
    if (px < lh) rows.push([px, py]);
    x = px + 1;
    y = py + 1;
  }
  return { bands, at, rows };
}

const CROP_PAD = 48;
const CROP_GAP = 8;
/** Narrower than this, a crop loses the context that says where on the page it is. */
const CROP_MIN_W = 320;
/** Claude's image budget: past either limit, `Read` downscales the image. */
const CROP_EDGE = 1568;
const CROP_TOKENS = 1568;
const TILE = 28;
/** Below this, text stops being legible; clip the crop instead. */
const MIN_SCALE = 0.75;
const SEAM = 2;
export const MAX_CROPS = 3;

export interface Crop {
  png: Buffer;
  kind: Spot["kind"];
  left: Box;
  right: Box;
  /** Left on top (`stacked`) or on the left (`side`), always. */
  layout: "stacked" | "side";
  scale: number;
  /** Only the top rows (or left columns) of the change fit the budget at `MIN_SCALE`. */
  clipped: boolean;
}

const tokens = (w: number, h: number) => Math.ceil(w / TILE) * Math.ceil(h / TILE);

/** Largest scale ≤ 1 at which a `w`×`h` sheet fits the budget. */
function fit(w: number, h: number): number {
  let s = Math.min(1, CROP_EDGE / Math.max(w, h));
  while (tokens(Math.floor(w * s), Math.floor(h * s)) > CROP_TOKENS) s -= 0.005;
  return s;
}

/** The sheet size for two panels of `w` × `lh` / `rh`. */
const sheet = (stacked: boolean, w: number, lh: number, rh: number) =>
  stacked ? { w, h: lh + CROP_GAP + rh } : { w: 2 * w + CROP_GAP, h: Math.max(lh, rh) };
const fits = (s: { w: number; h: number }) => fit(s.w, s.h) >= MIN_SCALE;

/**
 * Up to `MAX_CROPS` PNGs, one per spot in order: left and right at native scale (never below
 * `MIN_SCALE`, clipped instead), each padded for context with a 1px red box around the change,
 * or a 2px red seam where the other side's band would go. A full-page shot Read by an agent is
 * downscaled past legibility; a crop isn't.
 */
export async function crops(left: Buffer, right: Buffer, spots: Spot[]): Promise<Crop[]> {
  if (!spots.length) return [];
  const [lm, rm] = await Promise.all([sharp(left).metadata(), sharp(right).metadata()]);
  const cw = Math.min(lm.width!, rm.width!);
  const heights = [lm.height!, rm.height!] as const;
  return Promise.all(
    spots.slice(0, MAX_CROPS).map(async (g): Promise<Crop> => {
      const boxes = [g.left, g.right] as const;
      const bx = Math.min(g.left.x, g.right.x);
      const bw = Math.max(g.left.x + g.left.w, g.right.x + g.right.w) - bx;
      const want = Math.min(cw, Math.max(CROP_MIN_W, bw + 2 * CROP_PAD));
      let x0 = Math.max(0, Math.min(cw - want, Math.round(bx + bw / 2 - want / 2)));
      let width = want;
      const top = boxes.map((b, i) => Math.max(0, Math.min(b.y, heights[i]! - 1) - CROP_PAD));
      const tall = boxes.map(
        (b, i) => Math.min(heights[i]!, b.y + b.h + CROP_PAD) - top[i]! + (b.h ? 0 : SEAM),
      );
      const stacked = width >= Math.max(...tall);
      let clipped = false;
      // Too wide even at MIN_SCALE: keep the left columns, starting at the change.
      const maxW = Math.floor((stacked ? CROP_EDGE : (CROP_EDGE - CROP_GAP) / 2) / MIN_SCALE);
      if (width > maxW) {
        x0 = Math.max(0, bx - CROP_PAD);
        width = Math.min(maxW, cw - x0);
        clipped = true;
      }
      // Too tall: keep the top rows, trimming the taller panel first.
      while (!fits(sheet(stacked, width, tall[0]!, tall[1]!))) {
        const i = tall[0]! >= tall[1]! ? 0 : 1;
        tall[i] = Math.floor(tall[i]! * 0.95);
        clipped = true;
      }
      const panels = await Promise.all(
        [left, right].map((png, i) => panel(png, boxes[i]!, x0, top[i]!, width, tall[i]!)),
      );
      const { w: W, h: H } = sheet(stacked, width, tall[0]!, tall[1]!);
      const scale = fit(W, H);
      let png = await sharp({ create: { width: W, height: H, channels: 4, background: "#808080" } })
        .composite([
          { input: panels[0]!, left: 0, top: 0 },
          {
            input: panels[1]!,
            ...(stacked
              ? { left: 0, top: tall[0]! + CROP_GAP }
              : { left: width + CROP_GAP, top: 0 }),
          },
        ])
        .png()
        .toBuffer();
      if (scale < 1)
        png = await sharp(png)
          .resize(Math.floor(W * scale), Math.floor(H * scale))
          .png()
          .toBuffer();
      return {
        png,
        kind: g.kind,
        left: g.left,
        right: g.right,
        layout: stacked ? "stacked" : "side",
        scale: Math.round(scale * 100) / 100,
        clipped,
      };
    }),
  );
}

/** One side's `width`×`height` panel from page row `top`: a box round the change, or a seam inserted at it. */
async function panel(png: Buffer, b: Box, x0: number, top: number, width: number, height: number) {
  const layers: OverlayOptions[] = [];
  if (b.h === 0) {
    // Rows above the seam, the seam, then rows from `b.y` down: nothing on the page is hidden.
    const above = Math.min(height, b.y - top);
    const below = Math.min(height - above - SEAM, (await sharp(png).metadata()).height! - b.y);
    if (above > 0)
      layers.push({
        input: await sharp(png).extract({ left: x0, top, width, height: above }).toBuffer(),
        left: 0,
        top: 0,
      });
    if (above + SEAM <= height) {
      layers.push({
        input: { create: { width, height: SEAM, channels: 4, background: "#ff0000" } },
        left: 0,
        top: above,
      });
    }
    if (below > 0)
      layers.push({
        input: await sharp(png).extract({ left: x0, top: b.y, width, height: below }).toBuffer(),
        left: 0,
        top: above + SEAM,
      });
  } else {
    const h = Math.min(height, (await sharp(png).metadata()).height! - top);
    layers.push({
      input: await sharp(png).extract({ left: x0, top, width, height: h }).toBuffer(),
      left: 0,
      top: 0,
    });
    // One pixel outside the change, so the outline covers none of it.
    const [rx, ry] = [b.x - x0 - 1, b.y - top - 1];
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<rect x="${rx + 0.5}" y="${ry + 0.5}" width="${b.w + 1}" height="${b.h + 1}" fill="none" stroke="#ff0000" stroke-width="1" shape-rendering="crispEdges"/></svg>`;
    layers.push({ input: Buffer.from(svg), left: 0, top: 0 });
  }
  return sharp({ create: { width, height, channels: 4, background: "#808080" } })
    .composite(layers)
    .png()
    .toBuffer();
}
