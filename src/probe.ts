import type { Page } from "playwright";
import { prepare } from "./capture.ts";
import { collapseInherited, pageError, SHOWN, type Snapshot } from "./computed.ts";
import { CONTEXT_OPTIONS, masksFor, type ResolvedConfig, type Route } from "./config.ts";
import { SNAP_PROPS, snapshot } from "./locate.ts";
import { COMPUTED_TIMEOUT, launch, shoot } from "./run.ts";

// ponytail: x/y also list the siblings a grown box pushes down; drop a y a previous sibling's height explains if it gets noisy
const FIELDS = [...SNAP_PROPS, "x", "y"];

interface Change {
  key: string;
  prop: string;
  values: string[];
}

/** One load in a fresh context, as a run loads a side: every element's styles, then its position in its parent. */
async function load(
  browser: Awaited<ReturnType<typeof launch>>["browser"],
  url: string,
  route: Route,
  width: number,
  cfg: ResolvedConfig,
  now: number,
): Promise<{ snap: Snapshot; row: Record<string, string[]> }> {
  const ctx = await browser.newContext({
    ...CONTEXT_OPTIONS,
    storageState: cfg.storageState.left ?? undefined,
  });
  try {
    const pages = { left: await ctx.newPage() } as Record<"left" | "right", Page>;
    await prepare(pages.left, cfg, now);
    const shot = await shoot(pages, url, route, "left", width, cfg, now);
    if (shot.blank) throw new Error(`page did not render (${shot.blank})`);
    const page = pages.left;
    const snap: Snapshot = await snapshot(page, masksFor(cfg, page, route), COMPUTED_TIMEOUT, null);
    const at = await page.evaluate(
      (keys) =>
        Object.fromEntries(
          keys.flatMap((k) => {
            const e = document.querySelector(k);
            if (!e?.parentElement) return [];
            const [r, p] = [e, e.parentElement].map((n) => n.getBoundingClientRect());
            return [[k, [String(Math.round(r!.x - p!.x)), String(Math.round(r!.y - p!.y))]]];
          }),
        ),
      Object.keys(snap).filter((k) => !k.includes("::")),
    );
    const row = Object.fromEntries(
      Object.entries(snap).map(([k, s]) => [k, [...s.styles, ...(at[k] ?? ["", ""])]]),
    );
    return { snap, row };
  } finally {
    await ctx.close().catch(() => {});
  }
}

/** `renderdiff probe`: what varies between loads of one URL, from computed styles and positions. */
export async function probe(
  url: string,
  route: Route,
  width: number,
  cfg: ResolvedConfig,
  loads: number,
): Promise<number> {
  const { browser } = await launch();
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  const done: { snap: Snapshot; row: Record<string, string[]> }[] = [];
  let next = 0;
  const worker = async () => {
    for (let k = next++; k < loads; k = next++) {
      try {
        done[k] = await load(browser, url, route, width, cfg, now);
      } catch (e) {
        throw new Error(`load ${k + 1}: ${pageError(e)}`);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(cfg.concurrency, loads) }, worker));
  } finally {
    await browser.close();
  }

  const rows = done.map((d) => d.row);
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const absent: string[] = [];
  const changes: Change[] = [];
  for (const key of keys) {
    const vs = rows.map((r) => r[key]);
    if (vs.some((v) => !v)) {
      if (!absent.some((a) => key.startsWith(a + " > ") || key.startsWith(a + "::"))) {
        absent.push(key);
        changes.push({ key, prop: "present", values: vs.map((v) => (v ? "yes" : "no")) });
      }
      continue;
    }
    FIELDS.forEach((prop, i) => {
      const values = vs.map((v) => v![i]!);
      if (new Set(values).size > 1) changes.push({ key, prop, values });
    });
  }
  const varying = collapseInherited(
    changes,
    done.map((d) => d.snap),
  );

  console.log(`Probe: ${url} @${width}, ${loads} loads`);
  if (!varying.length) {
    console.log(`stable over ${loads} loads (${keys.length} elements)`);
    return 0;
  }
  console.log(`${varying.length} varying:`);
  for (const c of varying.slice(0, SHOWN)) {
    const tally = new Map<string, number>();
    for (const v of c.values) tally.set(v, (tally.get(v) ?? 0) + 1);
    const counts = [...tally].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ×${n}`);
    console.log(`  ${c.key} ${c.prop} ${counts.join(", ")}`);
  }
  if (varying.length > SHOWN) console.log(`  (+${varying.length - SHOWN} more)`);
  return 1;
}
