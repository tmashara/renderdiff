import type { Page } from "playwright";
import sharp from "sharp";
import { MASK_COLOR, masksFor, type ResolvedConfig } from "./config.ts";

/** Loads a page, settles it, and screenshots it. */

export interface Shot {
  png: Buffer;
  /** One byte per pixel of `png`, set where the last two shots of this load disagreed. */
  unstable: Uint8Array | null;
  /** Why this side looks blank, or null. Only an error when both sides do. */
  blank: string | null;
  /** `document.body.innerText`, whitespace collapsed per line, empty lines dropped. */
  text: string[];
}

/**
 * Chromium's screenshot backing store caps at this in any dimension; a single
 * `fullPage` shot past it is silently truncated. Rather than refuse, a taller page is
 * captured in vertical tiles of at most this height and stitched back together
 * (`captureTiled`), so long pages still diff in full.
 */
const MAX_CAPTURE_HEIGHT = 16_384;

/** Tile height for the stitched path. Under the cap, with margin. */
const TILE_HEIGHT = 16_000;

/**
 * Sanity ceiling. Past this a page is far likelier a broken/runaway layout than a real
 * one, and we would rather error than stitch a >100MB image. Named in the throw.
 */
const MAX_PAGE_HEIGHT = 40_000;

/**
 * Install network blocking, the fake clock and seeded randomness. Once per page,
 * before any navigation.
 */
export async function prepare(
  page: Page,
  cfg: ResolvedConfig,
  now: number,
): Promise<void> {
  for (const pattern of cfg.blockUrlPatterns) {
    await page.route(pattern, (route) => route.abort());
  }
  // Time flows, so Date-based debounce and busy-waits work; `capture` rewinds it per load.
  await page.clock.install({ time: now });
  // mulberry32 with a fixed seed, re-seeded on every navigation.
  await page.addInitScript(() => {
    let s = 0x9e3779b9;
    Math.random = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  });
}

export async function capture(
  page: Page,
  url: string,
  urlPath: string,
  width: number,
  cfg: ResolvedConfig,
  now: number,
): Promise<Shot> {
  await page.setViewportSize({ width, height: 900 });
  await page.clock.setSystemTime(now);
  const res = await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  if (res && res.status() >= 400) {
    throw new Error(`HTTP ${res.status()} at ${url}`);
  }
  await page.addStyleTag({ content: cfg.neutralizeCss });

  // Native lazy images go eager; JS lazy loaders see every viewport-height slice, one
  // frame each, since a scroll inside one synchronous loop never paints.
  await page.evaluate(async (maxHeight) => {
    // The fake clock drives rAF too, so add wall time for a real paint per slice.
    const frame = () =>
      new Promise((r) => requestAnimationFrame(() => setTimeout(r, 32)));
    Array.from(document.images).forEach((img) => (img.loading = "eager"));
    document.querySelectorAll("video").forEach((v) => {
      v.pause();
      v.currentTime = 0;
    });
    const h = Math.min(document.documentElement.scrollHeight, maxHeight);
    for (let y = 0; y < h; y += window.innerHeight) {
      window.scrollTo(0, y);
      await frame();
    }
    window.scrollTo(0, 0);
    await frame();
    await new Promise((r) => setTimeout(r, 0));
    const decoded = Promise.all(
      Array.from(document.images).map((img) => img.decode().catch(() => {})),
    );
    await Promise.race([decoded, new Promise((r) => setTimeout(r, 5_000))]);
  }, MAX_PAGE_HEIGHT);
  await page.evaluate(() => document.fonts.ready);
  await page
    .waitForLoadState("networkidle", { timeout: 3_000 })
    .catch(() => {});
  await page.addStyleTag({ content: cfg.neutralizeCss }); // anything injected late

  const { scrollHeight, innerText, media } = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    innerText: document.body.innerText || "",
    media: Array.from(
      document.querySelectorAll(
        "img, svg, canvas, video, iframe, input, textarea, select",
      ),
    ).some((e) => {
      const r = e.getBoundingClientRect();
      return r.width * r.height >= 1024;
    }),
  }));
  const text = innerText
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const blank =
    innerText.length < 200 && !media
      ? `height=${scrollHeight}, text=${innerText.length} chars`
      : null;
  if (scrollHeight > MAX_PAGE_HEIGHT) {
    throw new Error(
      `page is ${scrollHeight}px tall, past the ${MAX_PAGE_HEIGHT}px sanity ceiling ` +
        `at ${url} — likely a broken layout, not a real page`,
    );
  }

  const tiled = scrollHeight > MAX_CAPTURE_HEIGHT;
  // At scroll 0 viewport coordinates are page coordinates, which both paths shoot in.
  await page.evaluate(() => window.scrollTo(0, 0));
  const boxes = (
    await Promise.all(
      (await Promise.all(masksFor(cfg, page, urlPath).map((l) => l.all())))
        .flat()
        .map((el) => el.boundingBox()),
    )
  ).filter((b) => b !== null);
  const shoot = async () =>
    paintBoxes(
      tiled
        ? await captureTiled(page, width, scrollHeight)
        : await page.screenshot({ fullPage: true, animations: "disabled" }),
      boxes,
    );

  // A tiled shot is expensive, so it gets one comparison.
  const tries = tiled ? 2 : 3;
  let prev = await shoot();
  for (let n = 2; ; n++) {
    await page.waitForTimeout(100);
    const png = await shoot();
    if (png.equals(prev)) return { png, unstable: null, blank, text };
    if (n === tries) return { png, unstable: await differing(prev, png), blank, text };
    prev = png;
  }
}

const decode = (png: Buffer) =>
  sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

/** Pixels that differ between two shots of the same load. Null if none, or if the size changed. */
async function differing(a: Buffer, b: Buffer): Promise<Uint8Array | null> {
  const [ra, rb] = await Promise.all([decode(a), decode(b)]);
  // A page whose size changed between shots isn't masked; that diff still counts.
  if (ra.info.width !== rb.info.width || ra.info.height !== rb.info.height) {
    return null;
  }
  const mask = new Uint8Array(ra.info.width * ra.info.height);
  const pa = new Uint32Array(ra.data.buffer, ra.data.byteOffset, mask.length);
  const pb = new Uint32Array(rb.data.buffer, rb.data.byteOffset, mask.length);
  let any = false;
  for (let i = 0; i < mask.length; i++) {
    if (pa[i] !== pb[i]) {
      mask[i] = 1;
      any = true;
    }
  }
  return any ? mask : null;
}

/**
 * Paint every pixel either side found unstable onto both sides, so that noise is left
 * out of the measurement. Rewrites `left.png` / `right.png`; returns the painted pixel count.
 */
export async function cancelUnstable(left: Shot, right: Shot): Promise<number> {
  if (!left.unstable && !right.unstable) return 0;
  const raws = await Promise.all([decode(left.png), decode(right.png)]);
  const w = Math.max(raws[0].info.width, raws[1].info.width);
  const h = Math.max(raws[0].info.height, raws[1].info.height);
  const union = new Uint8Array(w * h);
  let count = 0;
  [left, right].forEach((shot, s) => {
    const u = shot.unstable;
    if (!u) return;
    const sw = raws[s]!.info.width;
    for (let i = 0; i < u.length; i++) {
      if (!u[i]) continue;
      const j = Math.floor(i / sw) * w + (i % sw);
      if (!union[j]) {
        union[j] = 1;
        count++;
      }
    }
  });

  await Promise.all(
    [left, right].map(async (shot, s) => {
      const { data, info } = raws[s]!;
      for (let y = 0; y < info.height; y++) {
        for (let x = 0; x < info.width; x++) {
          if (!union[y * w + x]) continue;
          const o = (y * info.width + x) * 4;
          data[o] = 0xff;
          data[o + 1] = 0x00;
          data[o + 2] = 0xff;
          data[o + 3] = 0xff;
        }
      }
      shot.png = await sharp(data, {
        raw: { width: info.width, height: info.height, channels: 4 },
      })
        .png()
        .toBuffer();
    }),
  );
  return count;
}

type Box = { x: number; y: number; width: number; height: number };

async function paintBoxes(png: Buffer, boxes: Box[]): Promise<Buffer> {
  if (!boxes.length) return png;
  const { width: W = 0, height: H = 0 } = await sharp(png).metadata();
  const rects = boxes.flatMap((b) => {
    const left = Math.max(0, Math.floor(b.x));
    const top = Math.max(0, Math.floor(b.y));
    const width = Math.min(W, Math.ceil(b.x + b.width)) - left;
    const height = Math.min(H, Math.ceil(b.y + b.height)) - top;
    if (width <= 0 || height <= 0) return [];
    return [
      {
        input: {
          create: { width, height, channels: 4 as const, background: MASK_COLOR },
        },
        left,
        top,
      },
    ];
  });
  return rects.length ? sharp(png).composite(rects).png().toBuffer() : png;
}

/**
 * Capture a page taller than Chromium's one-shot limit as vertical tiles, then stitch
 * them into a single full-height PNG.
 *
 * Playwright's `page.screenshot({ clip })` clips against the viewport, so it cannot
 * reach a band below the fold. We drop to a raw CDP `Page.captureScreenshot` with
 * `captureBeyondViewport: true`, which renders the whole page offscreen and clips in
 * page coordinates — no per-tile scrolling. That matters here: the page renders at
 * scroll-0 for every tile, exactly as a `fullPage` shot would, so a pinned/sticky
 * element and its spacer stay put instead of shifting between tiles.
 *
 * `deviceScaleFactor` is 1 (`CONTEXT_OPTIONS` in config.ts), so clip coords are CSS px.
 */
async function captureTiled(
  page: Page,
  width: number,
  scrollHeight: number,
): Promise<Buffer> {
  const client = await page.context().newCDPSession(page);
  try {
    const tiles: Buffer[] = [];
    for (let y = 0; y < scrollHeight; y += TILE_HEIGHT) {
      const height = Math.min(TILE_HEIGHT, scrollHeight - y);
      const { data } = await client.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: { x: 0, y, width, height, scale: 1 },
      });
      tiles.push(Buffer.from(data, "base64"));
    }

    return sharp({
      create: {
        width,
        height: scrollHeight,
        channels: 4,
        background: MASK_COLOR,
      },
    })
      .composite(
        tiles.map((input, i) => ({ input, left: 0, top: i * TILE_HEIGHT })),
      )
      .png()
      .toBuffer();
  } finally {
    await client.detach();
  }
}
