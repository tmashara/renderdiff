import type { Page } from "playwright";
import sharp from "sharp";
import { MASK_COLOR, masksFor, type ResolvedConfig } from "./config.ts";

/** Loads a page, settles it, and screenshots it. */

export interface Shot {
  png: Buffer;
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

/** Install network blocking. Once per page, before any navigation. */
export async function prepare(
  page: Page,
  cfg: ResolvedConfig,
): Promise<void> {
  for (const pattern of cfg.blockUrlPatterns) {
    await page.route(pattern, (route) => route.abort());
  }
}

export async function capture(
  page: Page,
  url: string,
  urlPath: string,
  width: number,
  cfg: ResolvedConfig,
): Promise<Shot> {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.addStyleTag({ content: cfg.neutralizeCss });

  // Nudge lazy images into loading before measuring.
  await page.evaluate(() => {
    const h = document.documentElement.scrollHeight;
    for (let y = 0; y < h; y += 400) window.scrollTo(0, y);
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(600);
  await page.evaluate(() => document.fonts.ready);
  await page
    .waitForLoadState("networkidle", { timeout: 8_000 })
    .catch(() => {});
  await page.addStyleTag({ content: cfg.neutralizeCss }); // anything injected late
  await page.waitForTimeout(300);

  // A blank page matches any other blank page. Refuse to return a shot we cannot
  // trust rather than let it read as a pass.
  const { scrollHeight, textLength } = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    textLength: (document.body.innerText || "").length,
  }));
  if (scrollHeight <= 800 || textLength < 200) {
    throw new Error(
      `page did not render (height=${scrollHeight}, text=${textLength} chars) at ${url}`,
    );
  }
  if (scrollHeight > MAX_PAGE_HEIGHT) {
    throw new Error(
      `page is ${scrollHeight}px tall, past the ${MAX_PAGE_HEIGHT}px sanity ceiling ` +
        `at ${url} — likely a broken layout, not a real page`,
    );
  }

  const mask = masksFor(cfg, page, urlPath);
  // The tiled path drops through raw CDP, which can't overlay locator masks — so a
  // masked route tall enough to tile would silently ship unmasked and its drift would
  // count against the score. Warn loudly instead of lying about the comparison.
  if (mask.length && scrollHeight > MAX_CAPTURE_HEIGHT) {
    console.warn(
      `  ⚠ ${urlPath} is ${scrollHeight}px (tiled) and has masks — masks are NOT ` +
        `applied on the tiled path, so their drift will count against the score.`,
    );
  }
  const png =
    scrollHeight <= MAX_CAPTURE_HEIGHT
      ? await page.screenshot({
          fullPage: true,
          animations: "disabled",
          mask,
          maskColor: MASK_COLOR,
        })
      : await captureTiled(page, width, scrollHeight);

  return { png };
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
 * Per-locator masks are not applied on this path (CDP can't overlay them); `capture()`
 * warns when a masked route is tall enough to land here.
 * `deviceScaleFactor` is 1 (set on the context in run.ts), so clip coords are CSS px.
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
