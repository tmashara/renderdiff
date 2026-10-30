import { setTimeout as sleep } from "node:timers/promises";
import type { Locator, Page, Request, Response } from "playwright";
import sharp from "sharp";
import { label, MASK_COLOR, masksFor, type ResolvedConfig, type Route } from "./config.ts";

/** Loads a page, settles it, and screenshots it. */

export interface Shot {
  png: Buffer;
  /** One byte per pixel of `png`, set where the last two shots of this load disagreed. */
  unstable: Uint8Array | null;
  /** The frame before `png`, set only when the two differed. */
  prev?: Buffer;
  /** Why this side looks blank, or null. Only an error when both sides do. */
  blank: string | null;
  /**
   * `document.body.innerText` (the element's, with a selector), whitespace collapsed per
   * line, empty lines dropped.
   */
  text: string[];
  /** Page px of the shot's top-left: the element's for a selector route, else 0,0. */
  origin: { x: number; y: number };
  /** Stylesheets and font faces that failed to load, e.g. `font Inter 700 italic`, `stylesheet https://…`. */
  failed: string[];
  /** Web font faces requested (loaded or still loading), e.g. `Inter 600 italic`. Sorted. */
  fonts: string[];
  /** Reasons of the page's `data-renderdiff-mask` elements, e.g. `rotating quote (data-renderdiff-mask)`. */
  marked: string[];
}

/**
 * Runs in the page, behind `prepare`'s init script: pause every video, open shadow roots
 * included. Once its metadata loads (waited for up to 2s), each is seeked to 0, so it shows
 * frame 0 at its own aspect ratio; one that never loads keeps its poster.
 */
function freezeVideo() {
  const videos = (root: Document | ShadowRoot): HTMLVideoElement[] => [
    ...Array.from(root.querySelectorAll("video")),
    ...Array.from(root.querySelectorAll("*")).flatMap((e) =>
      e.shadowRoot ? videos(e.shadowRoot) : [],
    ),
  ];
  return Promise.all(
    videos(document).map(async (v) => {
      v.autoplay = false;
      v.pause();
      const until = (...events: string[]) =>
        new Promise((r) => {
          for (const e of events) v.addEventListener(e, r, { once: true });
          setTimeout(r, 2_000);
        });
      if (!v.readyState && v.networkState === v.NETWORK_LOADING)
        await until("loadedmetadata", "error");
      if (!v.readyState) return;
      const seeked = until("seeked");
      v.currentTime = 0;
      return seeked;
    }),
  );
}

/**
 * Runs in the page: each element's box, plus every descendant's that paints outside it,
 * each cut to the overflow of the ancestors that clip it. Null inside a frame.
 */
function maskRects(els: Element[]) {
  if (window !== window.top) return null;
  const clipped = (e: Element) => {
    let { left, top, right, bottom } = e.getBoundingClientRect();
    let pos = getComputedStyle(e).position;
    // body's overflow belongs to the viewport, which paintBoxes already clamps to.
    for (
      let a = e.parentElement;
      a && a !== document.body && pos !== "fixed";
      a = a.parentElement
    ) {
      const s = getComputedStyle(a);
      if (s.display === "contents") continue;
      // An absolute box escapes the overflow of ancestors below its containing block.
      if (pos === "absolute" && s.position === "static" && s.transform === "none") continue;
      pos = s.position;
      if (s.display === "inline") continue;
      const r = a.getBoundingClientRect();
      if (s.overflowX !== "visible")
        [left, right] = [Math.max(left, r.left), Math.min(right, r.right)];
      if (s.overflowY !== "visible")
        [top, bottom] = [Math.max(top, r.top), Math.min(bottom, r.bottom)];
    }
    return { x: left, y: top, width: right - left, height: bottom - top };
  };
  type B = ReturnType<typeof clipped>;
  const outside = (b: B, o: B) =>
    b.x < o.x || b.y < o.y || b.x + b.width > o.x + o.width || b.y + b.height > o.y + o.height;
  return els.flatMap((e) => {
    const own = clipped(e);
    const spill = Array.from(e.querySelectorAll("*"))
      .filter((d) => {
        const r = d.getBoundingClientRect();
        return (
          r.width * r.height > 0 &&
          outside(r, own) &&
          d.checkVisibility({ opacityProperty: true, visibilityProperty: true })
        );
      })
      .map(clipped)
      .filter((b) => outside(b, own));
    return [own, ...spill].filter((b) => b.width > 0 && b.height > 0);
  });
}

/**
 * Runs in the page: once each light-DOM lottie-player loads (waited for up to 2s), stop it
 * and seek it to `frame`. One that never loads, or throws, is left alone.
 */
async function freezeLottie(frame: number) {
  type Player = Element & {
    getLottie?(): { isLoaded?: boolean } | null | undefined;
    stop(): void;
    seek(f: number): void;
  };
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await Promise.allSettled(
    Array.from(document.querySelectorAll<Player>("lottie-player")).map(async (p) => {
      for (let i = 0; i < 40 && !p.getLottie?.()?.isLoaded; i++) await tick(50);
      if (!p.getLottie?.()?.isLoaded) return;
      await tick(0); // lottie-web fires DOMLoaded, and with it autoplay's play(), a tick after isLoaded
      p.stop();
      p.seek(frame);
    }),
  );
}

/**
 * Chromium's screenshot backing store caps at this in any dimension; a single
 * `fullPage` or clip shot past it can come out truncated or wrapped. Rather than refuse, a
 * taller page or element is captured in vertical tiles of at most this height and stitched
 * back together (`captureTiled`), so it still diffs in full.
 */
const MAX_CAPTURE_HEIGHT = 16_384;

/** Tile height for the stitched path. Under the cap, with margin. */
const TILE_HEIGHT = 16_000;

/**
 * Sanity ceiling on the shot's area, so a narrow page may be taller than a wide one; never
 * under 40,000px tall, the old height ceiling, so a wide width loses nothing. Past
 * this a page is far likelier a broken/runaway layout than a real one, and we would rather
 * error than stitch a >200MB image. Named in the throw.
 */
const MAX_PAGE_AREA = 1440 * 40_000;

/** Requests still open per page, when the last one opened or closed, and stylesheets that failed. */
const network = new WeakMap<Page, { open: Set<Request>; last: number; failed: Set<string> }>();
/** Each page's last main-frame document response; redirect hops come first, so it is the final one. */
const doc = new WeakMap<Page, Response>();

const html = (r: Response) => {
  const type = r.headers()["content-type"];
  return !type || /^\s*(text\/html|application\/xhtml\+xml)\b/i.test(type);
};

/** The step each page's capture is on, for the shot deadline to name. */
export const step = new WeakMap<Page, string>();

/** Never finish, so they would hold network idle open until its timeout. */
const STREAMS = new Set(["eventsource", "websocket", "ping"]);

/** Playwright's `networkidle` waits a fixed 500ms; below 250ms, late request events under load slip past. */
async function networkIdle(page: Page, quiet: number, timeout: number): Promise<void> {
  const net = network.get(page)!;
  const end = Date.now() + timeout;
  while (Date.now() < end && (net.open.size || Date.now() - net.last < quiet)) await sleep(25);
}

/** A `before` or `beforeShot` hook threw. Never retried: the hook may have half-run against the page. */
export class HookError extends Error {}

/**
 * Install network blocking and tracking, the fake clock and seeded randomness. Once per
 * page, before any navigation.
 */
export async function prepare(page: Page, cfg: ResolvedConfig, now: number): Promise<void> {
  const net = { open: new Set<Request>(), last: Date.now(), failed: new Set<string>() };
  const blocked = new WeakSet<Request>();
  const sheet = (r: Request) => {
    if (r.resourceType() === "stylesheet" && !blocked.has(r))
      net.failed.add(`stylesheet ${r.url()}`);
  };
  network.set(page, net);
  page.on("request", (r) => {
    if (STREAMS.has(r.resourceType())) return;
    net.open.add(r);
    net.last = Date.now();
  });
  const done = (r: Request) => {
    if (net.open.delete(r)) net.last = Date.now();
  };
  page.on("requestfinished", done);
  page.on("requestfailed", (r) => {
    done(r);
    // Aborted: cancelled by the page or by the next navigation, not a load that failed.
    if (r.failure()?.errorText !== "net::ERR_ABORTED") sheet(r);
  });
  page.on("response", (r) => {
    if (r.status() >= 400) sheet(r.request());
    if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) doc.set(page, r);
  });
  // A request the old document left open never finishes or fails, so it can't hold the next load.
  page.on("framenavigated", (f) => {
    if (f !== page.mainFrame()) return;
    net.open.clear();
    net.last = Date.now();
  });
  for (const pattern of cfg.blockUrlPatterns) {
    await page.route(pattern, (route) => {
      blocked.add(route.request());
      return route.abort();
    });
  }
  // Time flows, so Date-based debounce and busy-waits work; `capture` rewinds it per load.
  await page.clock.install({ time: now });
  // From the first script on, so no video starts however fast it loads.
  if (cfg.freezeVideo)
    await page.addInitScript(() => {
      HTMLMediaElement.prototype.play = () => Promise.resolve();
      document.addEventListener(
        "loadstart",
        (e) => {
          if (e.target instanceof HTMLMediaElement) e.target.autoplay = false;
        },
        true,
      );
    });
  // mulberry32 with a fixed seed, re-seeded on every navigation.
  await page.addInitScript(() => {
    (window as unknown as { __RENDERDIFF__: boolean }).__RENDERDIFF__ = true;
    let s = 0x9e3779b9;
    Math.random = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  });
}

/** Not addStyleTag: it fails on any CSP violation logged meanwhile, and a <style> is subject to style-src. */
function adoptCss(css: string) {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

export async function capture(
  page: Page,
  url: string,
  route: Route,
  side: "left" | "right",
  width: number,
  cfg: ResolvedConfig,
  now: number,
): Promise<Shot> {
  step.set(page, "load");
  await page.setViewportSize({ width, height: 900 });
  const maxHeight = Math.max(40_000, Math.floor(MAX_PAGE_AREA / width));
  await page.clock.setSystemTime(now);
  // Here, not on framenavigated, which a pushState during hydration fires too.
  network.get(page)!.failed.clear();
  doc.delete(page);
  const res = await page
    .goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 })
    .catch((e: unknown) => {
      const d = doc.get(page);
      if (!d || html(d)) throw e;
      return d;
    });
  if (res && res.status() >= 400) {
    throw new Error(`HTTP ${res.status()} at ${url}`);
  }
  if (res && !html(res)) {
    const type = res.headers()["content-type"]!.split(";")[0]!.trim();
    throw new Error(`not an HTML page: server sent ${type} at ${url}`);
  }
  const hook = async (name: "before" | "beforeShot") => {
    const fn = route[name];
    if (!fn) return;
    step.set(page, `${name} hook`);
    try {
      await fn(page, { side, route: label(route), width });
    } catch (e) {
      throw new HookError(
        `${name} hook failed on ${side}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };
  await hook("before");
  step.set(page, "settle");
  await page.evaluate(adoptCss, cfg.neutralizeCss);
  // Before the scroll too, so autoplay never starts and page state driven by playback stays put.
  if (cfg.freezeVideo) await page.evaluate(freezeVideo);

  // Native lazy images go eager; JS lazy loaders see every viewport-height slice, one
  // frame each, since a scroll inside one synchronous loop never paints.
  await page.evaluate(async (maxHeight) => {
    // The fake clock drives rAF too, so add wall time for a real paint per slice.
    const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 32)));
    Array.from(document.images).forEach((img) => (img.loading = "eager"));
    for (
      let y = 0;
      y < Math.min(document.documentElement.scrollHeight, maxHeight);
      y += window.innerHeight
    ) {
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
  }, maxHeight);
  // fonts.ready also resolves when a face fails, so the failures are read off it below.
  const fonts = await page.evaluate(async () => {
    await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 5_000))]);
    const failed: string[] = [];
    const loaded: string[] = [];
    document.fonts.forEach((f) => {
      const weight =
        ({ normal: "400", bold: "700" } as Record<string, string>)[f.weight] ?? f.weight;
      const variant = [weight, f.style, f.stretch].filter(
        (v) => !["normal", "400", "100%"].includes(v),
      );
      // `new FontFace("My Face")` reports `"My Face"`; the same @font-face reports `My Face`.
      const name = [f.family.replace(/^"(.*)"$/, "$1"), ...variant].join(" ");
      if (f.status === "error") failed.push(`font ${name}`);
      // A face still loading at the timeout was requested; reading it as missing would be flaky.
      else if (f.status !== "unloaded") loaded.push(name);
    });
    return { failed, loaded };
  });
  await networkIdle(page, 250, 3_000);
  if (cfg.freezeVideo) await page.evaluate(freezeVideo);
  const failed = [...new Set([...network.get(page)!.failed, ...fonts.failed])];
  const loadedFonts = [...new Set(fonts.loaded)].sort();
  await page.evaluate(adoptCss, cfg.neutralizeCss); // anything injected late
  if (cfg.lottieFrame !== undefined) await page.evaluate(freezeLottie, cfg.lottieFrame);
  await hook("beforeShot");
  step.set(page, "settle");

  const selector = route.selector?.[side];
  const where = `on ${side} (${route[side]})`;
  // count() doesn't wait, so a wrong selector fails now rather than after a 30s timeout.
  const el = selector ? page.locator(selector) : null;
  const n = await el?.count();
  if (n !== undefined && n !== 1) {
    throw new Error(`selector "${selector}" matched ${n} elements ${where}, expected 1`);
  }

  // Masks only paint the PNG, so hide them for the text read too; visibility keeps layout.
  const masks = masksFor(cfg, page, route);
  const hidden: string[][] = [];
  for (const l of masks) {
    hidden.push(
      await l.evaluateAll((els) =>
        els.map((e) => {
          const prev = (e as HTMLElement).style.visibility;
          (e as HTMLElement).style.visibility = "hidden";
          return prev;
        }),
      ),
    );
  }
  const marked = await page.locator("[data-renderdiff-mask]").evaluateAll((els) =>
    els.map((e) => {
      const v = e.getAttribute("data-renderdiff-mask");
      return v ? `${v} (data-renderdiff-mask)` : "data-renderdiff-mask";
    }),
  );
  const { scrollHeight, innerText, pageText, media } = await (el ?? page.locator(":root")).evaluate(
    (root) => {
      const body = document.body ?? document.documentElement;
      return {
        scrollHeight: document.documentElement.scrollHeight,
        innerText:
          ((root === document.documentElement ? body : root) as HTMLElement).innerText || "",
        pageText: body.innerText?.length ?? 0,
        media: Array.from(
          document.querySelectorAll(
            "img, svg, canvas, video, iframe, input, textarea, select, [data-renderdiff-rendered]",
          ),
        ).some((e) => {
          const r = e.getBoundingClientRect();
          return r.width * r.height >= 1024;
        }),
      };
    },
  );
  // Reverse order, so an element two masks share gets its original value back.
  for (let i = masks.length - 1; i >= 0; i--) {
    await masks[i]!.evaluateAll(
      (els, prev) => els.forEach((e, j) => ((e as HTMLElement).style.visibility = prev[j] ?? "")),
      hidden[i]!,
    );
  }
  const text = innerText
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const blank = pageText < 200 && !media ? `height=${scrollHeight}, text=${pageText} chars` : null;

  step.set(page, "screenshot");
  const measure = async (l: Locator) => {
    const b = await l.boundingBox();
    if (!b?.width || !b.height) throw new Error(`selector "${selector}" has no box ${where}`);
    return b;
  };
  let clip: Box | undefined;
  // Brings in what lazy-loads near it; then scroll 0, so sticky chrome is as in a page shot.
  if (el) {
    await measure(el);
    await el.scrollIntoViewIfNeeded();
  }
  // At scroll 0 viewport coordinates are page coordinates, which every path shoots in.
  await page.evaluate(() => window.scrollTo(0, 0));
  if (el) {
    const b = await measure(el);
    const x = Math.max(0, Math.floor(b.x));
    const y = Math.max(0, Math.floor(b.y));
    clip = { x, y, width: Math.ceil(b.x + b.width) - x, height: Math.ceil(b.y + b.height) - y };
    if (clip.width <= 0 || clip.height <= 0) {
      throw new Error(`selector "${selector}" is off the page ${where}`);
    }
  }
  const read = async () =>
    (
      await Promise.all(
        masks.map(
          async (l) =>
            (await l.evaluateAll(maskRects)) ??
            // A frame's rects are in its own viewport; Playwright maps boxes to the page.
            (await Promise.all((await l.all()).map((m) => m.boundingBox()))),
        ),
      )
    )
      .flat()
      .filter((b) => b !== null)
      .map((b) => (clip ? { ...b, x: b.x - clip.x, y: b.y - clip.y } : b));
  const area = clip ?? { x: 0, y: 0, width, height: scrollHeight };
  if (area.height > maxHeight) {
    throw new Error(
      `${el ? "element" : "page"} is ${area.height}px tall at ${width}px wide, past the ${maxHeight}px sanity ceiling ` +
        `for that width (${MAX_PAGE_AREA.toLocaleString("en-US")} pixels) ` +
        `at ${url} — likely a broken layout, not a real page`,
    );
  }
  const tiled = area.height > MAX_CAPTURE_HEIGHT;
  // Read on both sides of the shot, so a box that moves while it is taken stays covered.
  const shoot = async () => {
    const before = await read();
    const png = tiled
      ? await captureTiled(page, area)
      : await page.screenshot({ fullPage: true, clip, animations: "disabled" });
    return paintBoxes(png, [...before, ...(await read())]);
  };

  // A tiled shot is expensive, so it gets one comparison.
  const tries = tiled ? 2 : 3;
  const origin = { x: clip?.x ?? 0, y: clip?.y ?? 0 };
  let prev = await shoot();
  for (let n = 2; ; n++) {
    await page.waitForTimeout(50);
    const png = await shoot();
    if (png.equals(prev))
      return { png, unstable: null, blank, text, origin, failed, fonts: loadedFonts, marked };
    if (n === tries)
      return {
        png,
        prev,
        unstable: await differing(prev, png),
        blank,
        text,
        origin,
        failed,
        fonts: loadedFonts,
        marked,
      };
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
  const { data, info } = await decode(png);
  const { width: W, height: H } = info;
  const px = Buffer.from(`${MASK_COLOR.slice(1)}ff`, "hex");
  for (const b of boxes) {
    const left = Math.max(0, Math.floor(b.x));
    const top = Math.max(0, Math.floor(b.y));
    const right = Math.min(W, Math.ceil(b.x + b.width));
    const bottom = Math.min(H, Math.ceil(b.y + b.height));
    if (right <= left) continue;
    for (let y = top; y < bottom; y++) data.fill(px, (y * W + left) * 4, (y * W + right) * 4);
  }
  return sharp(data, { raw: { width: W, height: H, channels: 4 } })
    .png()
    .toBuffer();
}

/**
 * Capture a page, or an element's box, taller than Chromium's one-shot limit as vertical
 * tiles, then stitch them into a single full-height PNG.
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
async function captureTiled(page: Page, box: Box): Promise<Buffer> {
  const client = await page.context().newCDPSession(page);
  try {
    const tiles: Buffer[] = [];
    for (let y = 0; y < box.height; y += TILE_HEIGHT) {
      const height = Math.min(TILE_HEIGHT, box.height - y);
      const { data } = await client.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: { x: box.x, y: box.y + y, width: box.width, height, scale: 1 },
      });
      tiles.push(Buffer.from(data, "base64"));
    }

    return sharp({
      create: {
        width: box.width,
        height: box.height,
        channels: 4,
        background: MASK_COLOR,
      },
    })
      .composite(tiles.map((input, i) => ({ input, left: 0, top: i * TILE_HEIGHT })))
      .png()
      .toBuffer();
  } finally {
    await client.detach();
  }
}
