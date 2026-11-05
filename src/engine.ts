import { setTimeout as sleep } from "node:timers/promises";
import type { Browser, CDPSession, Page } from "playwright";
import type { Box } from "./capture.ts";
import type { ResolvedConfig } from "./config.ts";

export interface Engine {
  name: "chromium" | "webkit";
  outDir: string;
  acceptedFile: string;
  statesNote?: string;
  /** `name` is what results.json records: `chrome` when Chromium fell back to it. */
  launch(): Promise<{ browser: Browser; name: string }>;
  grab(page: Page, clip: Box, beyond: boolean): Promise<Buffer>;
  shot(page: Page, take: () => Promise<Buffer>): Promise<{ png: Buffer; stopped: boolean }>;
  /** Forces `globalThis.__renderdiffStates` into pseudo-classes; null where that can't be done. */
  states(
    page: Page,
  ): Promise<{ force(pseudo: readonly string[]): Promise<void>; close(): Promise<void> } | null>;
}

// Replaces Playwright's own headless --blink-settings, so its hover/pointer values are repeated.
const ARGS = [
  "--blink-settings=imageAnimationPolicy=2,primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
];

const sessions = new WeakMap<Page, Promise<CDPSession>>();

async function stateNodes(client: CDPSession): Promise<number[]> {
  await Promise.all([client.send("DOM.enable"), client.send("CSS.enable")]);
  await client.send("DOM.getDocument", { depth: 0 });
  const { result } = await client.send("Runtime.evaluate", {
    expression: "globalThis.__renderdiffStates",
  });
  const { result: own } = await client.send("Runtime.getProperties", {
    objectId: result.objectId!,
    ownProperties: true,
  });
  return Promise.all(
    own
      .filter((p) => /^\d+$/.test(p.name))
      .map((p) =>
        client.send("DOM.requestNode", { objectId: p.value!.objectId! }).then((r) => r.nodeId),
      ),
  );
}

const chromium: Engine = {
  name: "chromium",
  outDir: "renderdiff-out",
  acceptedFile: "renderdiff.accepted.json",
  // Both sides share the fallback, so the comparison stays symmetric.
  async launch() {
    const { chromium } = await import("playwright");
    try {
      return { browser: await chromium.launch({ args: ARGS }), name: "chromium" };
    } catch (e) {
      try {
        const browser = await chromium.launch({ channel: "chrome", args: ARGS });
        console.log(
          `Bundled Chromium failed to launch; using the system Chrome ${browser.version()}.`,
        );
        return { browser, name: "chrome" };
      } catch {
        throw new Error(
          `could not launch Chromium, or the system Chrome:\n  ${e instanceof Error ? e.message : e}\n\n` +
            `  Install the browser with:  npx playwright install chromium`,
        );
      }
    }
  },
  async grab(page, clip, beyond) {
    let s = sessions.get(page);
    if (!s) sessions.set(page, (s = page.context().newCDPSession(page)));
    const { data } = await (
      await s
    ).send("Page.captureScreenshot", {
      format: "png",
      // Lossless either way, and sharp re-encodes every shot kept.
      optimizeForSpeed: true,
      captureBeyondViewport: beyond,
      clip: { ...clip, scale: 1 },
    });
    return Buffer.from(data, "base64");
  },
  shot: async (_, take) => ({ png: await take(), stopped: false }),
  async states(page) {
    const client = await page.context().newCDPSession(page);
    let nodeIds: number[] | undefined;
    return {
      async force(pseudo) {
        nodeIds ??= await stateNodes(client);
        // A new force replaces the last; detaching clears them all.
        await Promise.all(
          nodeIds.map((nodeId) =>
            client.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [...pseudo] }),
          ),
        );
      },
      async close() {
        await client
          .send("Runtime.evaluate", { expression: "delete globalThis.__renderdiffStates" })
          .catch(() => {});
        await client.detach().catch(() => {});
      },
    };
  },
};

const webkit: Engine = {
  name: "webkit",
  outDir: "renderdiff-out-webkit",
  // An engine's pixels never match the other's, so neither may prune the other's entries.
  acceptedFile: "renderdiff.accepted.webkit.json",
  statesNote:
    "--computed on webkit: links and controls aren't forced into :hover/:focus-visible (that needs Chromium)",
  async launch() {
    const { webkit } = await import("playwright");
    try {
      return { browser: await webkit.launch(), name: "webkit" };
    } catch (e) {
      throw new Error(
        `could not launch WebKit:\n  ${e instanceof Error ? e.message : e}\n\n  Install the browser with:  npx playwright install webkit  (--with-deps on Linux)`,
      );
    }
  },
  grab: (page, clip) => page.screenshot({ fullPage: true, clip }),
  async shot(page, take) {
    const shot = take();
    const png = await Promise.race([shot, sleep(5_000, null, { ref: false })]);
    if (png) return { png, stopped: false };
    // WebKit's fonts.ready, which its screenshot waits on, holds until the load event; a stalled frame never fires it.
    const stop = page
      .evaluate(() => {
        const open = document.readyState !== "complete";
        if (open) window.stop();
        return open;
      })
      .catch(() => false);
    const done = await shot;
    // A hung evaluate must not cost a finished shot, and it stopped nothing we can vouch for.
    return { png: done, stopped: await Promise.race([stop, false]) };
  },
  states: async () => null,
};

export const engines: Record<Engine["name"], Engine> = { chromium, webkit };
export const engineOf = (cfg: ResolvedConfig) => engines[cfg.browser ?? "chromium"];
