import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Locator, Page } from "playwright";

/**
 * Configuration: built-in defaults, the user-facing `RenderdiffConfig` shape, and the
 * loader that merges a `renderdiff.config.*` file into a `ResolvedConfig`.
 *
 * Precedence is always: CLI flag > config file > built-in default.
 */

/** A Playwright selector per side. */
export type Sides = { left: string; right: string };

/**
 * A route to diff: the path loaded on each side, normalized (no trailing slash, `/` for the
 * index). Both are the same path unless the route is a pair. With a selector, each side
 * compares that one element instead of the whole page.
 */
export interface Route {
  left: string;
  right: string;
  selector: Sides | null;
  before: Hook | null;
}

/**
 * Runs on each side after the page loads and before it settles and is shot, e.g. to open a
 * menu. `route` is the route's name (`/a`, or `/a::/b` for a pair), the same on both sides.
 */
export type Hook = (
  page: Page,
  ctx: { side: "left" | "right"; route: string; width: number },
) => Promise<void>;

/**
 * A route as written: `/a`, the pair `/a::/b`, or `{ left, right?, selector? }` (right
 * defaults to left).
 */
export type RouteSpec =
  | string
  | { left: string; right?: string; selector?: string | Sides; before?: Hook };

/** `pricing` / `/pricing/` -> `/pricing`; `/` stays `/`. */
export const normalize = (url: string) => {
  const trimmed = url.replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed ? `/${trimmed}` : "/";
};

/** `/a` for a plain route, `/a::/b` for a pair — the route's name in stdout and results.json. */
export const label = (r: Pick<Route, "left" | "right">) =>
  r.left === r.right ? r.left : `${r.left}::${r.right}`;

/** `.card`, or `.new | .old` when the sides differ. */
export const selectorText = (s: Sides) => (s.left === s.right ? s.left : `${s.left} | ${s.right}`);

/** The label plus ` [selector]`: unique per route in a run, so the compact summary's group key. */
export const name = (r: Pick<Route, "left" | "right" | "selector">) =>
  label(r) + (r.selector ? ` [${selectorText(r.selector)}]` : "");

/**
 * Specs -> normalized, deduplicated routes; throws on an empty side or a glob. A string is a
 * pair when it has a `::` followed by `/` (or ending it, so `/a::` is an empty side, not a
 * literal), which keeps `?q=std::vector` and `/wiki/Talk:Foo` single routes. A CLI
 * `selector` replaces every route's own; a route's own `before` replaces the top-level one.
 */
export function parseRoutes(specs: RouteSpec[], selector?: Sides, before?: Hook): Route[] {
  const out = new Map<string, Route>();
  for (const spec of specs) {
    let sides: [string, string];
    if (typeof spec === "string") {
      const i = spec.search(/::(?=\/|$)/);
      sides = i === -1 ? [spec, spec] : [spec.slice(0, i), spec.slice(i + 2)];
    } else {
      sides = [spec.left, spec.right ?? spec.left];
    }
    const shown = typeof spec === "string" ? spec : JSON.stringify(spec);
    if (!sides[0] || !sides[1]) throw new Error(`route ${shown} has an empty side`);
    // Its label would collide with the pair's, and dedupe would silently drop one of them.
    if (typeof spec !== "string" && sides.some((s) => /::(?=\/|$)/.test(s))) {
      throw new Error(`route ${shown}: a side containing "::/" reads as a pair`);
    }
    const glob = sides.find((s) => s.includes("*"));
    if (glob) throw new Error(`globs are not supported (${glob}) — pass literal paths.`);
    const own = typeof spec === "string" ? undefined : spec.selector;
    const route = {
      left: normalize(sides[0]),
      right: normalize(sides[1]),
      selector: selector ?? (typeof own === "string" ? { left: own, right: own } : (own ?? null)),
      before: (typeof spec === "string" ? undefined : spec.before) ?? before ?? null,
    };
    const same = out.get(name(route));
    // JSON drops a function but keeps a null, so `before` is compared on its own below.
    if (
      same &&
      JSON.stringify({ ...same, before: 0 }) !== JSON.stringify({ ...route, before: 0 })
    ) {
      throw new Error(`two routes both read as ${name(route)}; change one of their selectors`);
    }
    if (same && same.before !== route.before) {
      throw new Error(
        `two routes both read as ${name(route)}; they have different before hooks — merge them into one route`,
      );
    }
    out.set(name(route), route);
  }
  return [...out.values()];
}

/**
 * Viewports to compare at. Each value sits *inside* a common responsive band rather
 * than on a boundary (640/768/1024/1280/1536 are the usual breakpoints), so a layout
 * switch never flaps between the two captures.
 */
export const DEFAULT_WIDTHS = [1440, 1152, 896, 704, 375];

/** Directory a run writes its screenshots and `report.html` into. Relative to cwd. */
export const DEFAULT_OUT_DIR = "renderdiff-out";

/**
 * Captures run in parallel: half the cores, between 2 and 8. A run is bound by waiting on
 * pages, not CPU, and each worker holds two. No extra rate limiting needed: each worker
 * holds at most one load per origin at a time, so this is also the most concurrent loads
 * either origin sees — lower it when one side is someone's live site.
 */
export const DEFAULT_CONCURRENCY = Math.min(
  8,
  Math.max(2, Math.floor(os.availableParallelism() / 2)),
);

/**
 * Third-party origins aborted at the network layer. Must stay symmetric — blocking on
 * one side only is itself a diff.
 *
 * Blocked rather than hidden because A/B tooling rewrites arbitrary DOM to run
 * experiments, and CSS cannot pre-empt an experiment you have not seen.
 *
 * User config appends to this list; it never replaces it.
 */
export const DEFAULT_BLOCK_URL_PATTERNS = [
  "**://*.visualwebsiteoptimizer.com/**",
  "**://*.googletagmanager.com/**",
  "**://*.google-analytics.com/**",
  "**://cdn.segment.com/**",
  "**://*.intercom.io/**",
  "**://*.intercomcdn.com/**",
  "**://*.hotjar.com/**",
  "**://snap.licdn.com/**",
  "**://connect.facebook.net/**",
  "**://*.onetrust.com/**",
  "**://cdn.cookielaw.org/**",
];

/**
 * Consent banners and dev-server chrome to hide. Common vendors only — add your own
 * site's selectors via `hideSelectors` in the config file.
 *
 * Two constraints apply to anything added here:
 *
 *  1. Match the banner element EXACTLY. Consent scripts habitually also stamp a class
 *     on <html> (e.g. `…-notice-loaded`), so a substring selector like
 *     `[class*=cookie-notice]` hides the whole document — and blank matches blank, so
 *     every page then passes.
 *  2. Hide, never remove. Removing these after the page's cookie script has run wedges
 *     the renderer and screenshots hang.
 *
 * Only for chrome that should be absent on both sides. Content that exists on both but
 * drifts belongs in `masks`.
 */
export const DEFAULT_HIDE_SELECTORS = [
  "#onetrust-consent-sdk",
  ".osano-cm-window",
  "astro-dev-toolbar",
  "#astro-dev-toolbar-root",
  "nextjs-portal",
];

/** Kills motion so two captures taken seconds apart agree. Always applied. */
const STILL_CSS = `
*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}
html{scroll-behavior:auto!important}
`;

/**
 * Browser-context settings pinned on both sides, so locale, timezone, theme and motion
 * preferences can't differ between the two loads. Listed in the report.
 */
export const CONTEXT_OPTIONS = {
  deviceScaleFactor: 1,
  reducedMotion: "reduce",
  timezoneId: "UTC",
  locale: "en-US",
  colorScheme: "light",
} as const;

/** Fill colour for masks and for height/width padding. Loud on purpose. */
export const MASK_COLOR = "#FF00FF";

/**
 * Content that renders on both sides but whose value drifts — live counters, clocks,
 * "N minutes ago". Painted over on both sides, so the noise cancels.
 *
 * Masks rather than CSS: these occupy a box, and hiding one reflows the page.
 * `visibility:hidden` is no better — "9.9k" and "10.0k" size their box differently and
 * shove their flex neighbours around.
 *
 * Declared as data, not branches, so the report can list the same `reason`s it masks
 * instead of restating them in prose that silently goes stale.
 *
 * Keep the list short. Every mask is coverage given up, so add only what is proven to
 * drift.
 */
export type Mask = {
  /**
   * The route path this applies to, e.g. `/pricing`; every route when omitted. On a pair
   * it matches either side's path and paints both, so the noise still cancels.
   */
  urlPath?: string;
  /** Why it drifts — surfaced verbatim in the report. */
  reason: string;
} & (
  | { /** A Playwright selector, e.g. `[data-star-count]`. */ selector: string }
  | { /** The escape hatch for what a selector can't say. */ locate: (page: Page) => Locator }
);

/** The `maskMedia` / `--mask-media` preset: embeds that differ per load. Video is frozen instead. */
export const MEDIA_MASK: Mask = {
  selector: "iframe",
  reason: "iframes (--mask-media)",
};

/** The shape a `renderdiff.config.*` file default-exports. Every field is optional. */
export interface RenderdiffConfig {
  /** Left origin, e.g. `http://localhost:3000`. A trailing slash is stripped. */
  left?: string;
  /** Right origin, e.g. `https://example.com`. A trailing slash is stripped. */
  right?: string;
  /** Routes to diff when none are passed on the command line. A route object may take a `selector` and a `before`. */
  routes?: RouteSpec[];
  /** A {@link Hook} for every route without its own `before`, CLI routes included. */
  before?: Hook;
  /**
   * Playwright storage state files (cookies, localStorage) to start each side with, e.g. to be
   * signed in. One path for both sides, or per side. Relative to the config file.
   */
  storageState?: string | { left?: string; right?: string };
  /** Viewport widths. Replaces {@link DEFAULT_WIDTHS} outright. */
  widths?: number[];
  /** Fail only when a comparison scores below this (0..1), instead of on any diff. */
  threshold?: number;
  /** Where to write screenshots and `report.html`. Relative paths resolve from cwd. */
  outDir?: string;
  /** Parallel workers. */
  concurrency?: number;
  /** Extra URL globs to abort, appended to {@link DEFAULT_BLOCK_URL_PATTERNS}. */
  blockUrlPatterns?: string[];
  /** Extra selectors to hide, appended to {@link DEFAULT_HIDE_SELECTORS}. */
  hideSelectors?: string[];
  /** Raw CSS injected after the built-in rules. An escape hatch. */
  extraCss?: string;
  /** Per-route regions painted over on both sides. */
  masks?: Mask[];
  /** Also diff every element's computed style, and say whether the markup is identical. */
  computed?: boolean;
  /** Mask every `iframe` on every route. */
  maskMedia?: boolean;
  /** Keep every video from playing, so it shows its poster, and hide video.js overlays. Default true. */
  freezeVideo?: boolean;
}

/** A fully merged config. Everything the run needs, nothing optional. */
export interface ResolvedConfig {
  left: string;
  right: string;
  widths: number[];
  threshold: number | null;
  outDir: string;
  concurrency: number;
  blockUrlPatterns: string[];
  /** Built-in plus configured selectors hidden on both sides. */
  hideSelectors: string[];
  /** The complete stylesheet injected into every page. */
  neutralizeCss: string;
  masks: Mask[];
  /** Absolute storage state paths, checked to be JSON; null for a side without one. */
  storageState: { left: string | null; right: string | null };
  computed: boolean;
  freezeVideo: boolean;
}

/** package.json's version; the same relative path resolves from `src/` and `dist/`. */
export function version(): string {
  const pkg = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  try {
    return JSON.parse(fs.readFileSync(pkg, "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Identity helper — exists purely so editors type-check a config file. */
export function defineConfig(config: RenderdiffConfig): RenderdiffConfig {
  return config;
}

export function masksFor(cfg: ResolvedConfig, page: Page, route: Route): Locator[] {
  return [
    ...cfg.masks
      .filter(
        (m) => m.urlPath === undefined || m.urlPath === route.left || m.urlPath === route.right,
      )
      .map((m) => ("selector" in m ? page.locator(m.selector) : m.locate(page))),
    page.locator("[data-renderdiff-mask]"),
  ];
}

/** Config filenames probed in cwd, in order. */
const CONFIG_NAMES = [
  "renderdiff.config.ts",
  "renderdiff.config.mts",
  "renderdiff.config.js",
  "renderdiff.config.mjs",
];

const isStrArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * Load a config file. An explicit `--config` path must exist; otherwise cwd is probed
 * and finding nothing is fine — the CLI works with flags alone.
 */
export async function loadConfig(
  explicitPath?: string,
): Promise<{ config: RenderdiffConfig; path: string | null }> {
  let file: string | null = null;

  if (explicitPath) {
    file = path.resolve(process.cwd(), explicitPath);
    if (!fs.existsSync(file)) {
      throw new Error(`config file not found: ${file}`);
    }
  } else {
    for (const name of CONFIG_NAMES) {
      const candidate = path.resolve(process.cwd(), name);
      if (fs.existsSync(candidate)) {
        file = candidate;
        break;
      }
    }
  }

  if (!file) return { config: {}, path: null };

  let mod: { default?: unknown };
  try {
    mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`could not load ${file}:\n  ${msg}`);
  }

  const config = mod.default;
  if (config === undefined) {
    throw new Error(`${file} has no default export`);
  }
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error(`${file} must default-export an object`);
  }

  validate(config as Record<string, unknown>, file);
  const c = config as RenderdiffConfig;
  const s = c.storageState;
  if (s === undefined) return { config: c, path: file };
  const at = (p?: string) => p && path.resolve(path.dirname(file), p);
  const storageState = typeof s === "string" ? at(s)! : { left: at(s.left), right: at(s.right) };
  return { config: { ...c, storageState }, path: file };
}

/** Reject a malformed config here, naming the key, rather than deep inside a run. */
function validate(c: Record<string, unknown>, file: string) {
  const bad = (key: string, expected: string): never => {
    throw new Error(`${file}: \`${key}\` must be ${expected}`);
  };

  for (const key of ["left", "right", "outDir", "extraCss"]) {
    if (c[key] !== undefined && typeof c[key] !== "string") bad(key, "a string");
  }
  for (const key of ["blockUrlPatterns", "hideSelectors"]) {
    if (c[key] !== undefined && !isStrArray(c[key])) {
      bad(key, "an array of strings");
    }
  }
  const hook = "a function (page, { side, route, width }) => Promise<void>";
  if (c.before !== undefined && typeof c.before !== "function") bad("before", hook);
  const s = c.storageState as Record<string, unknown> | undefined;
  if (
    s !== undefined &&
    !(typeof s === "string" && s) &&
    !(
      typeof s === "object" &&
      s !== null &&
      Object.keys(s).length &&
      Object.entries(s).every(
        ([k, v]) => ["left", "right"].includes(k) && typeof v === "string" && v,
      )
    )
  ) {
    bad("storageState", "a non-empty path, or { left?, right? } of non-empty paths");
  }
  if (c.routes !== undefined) {
    if (!Array.isArray(c.routes)) bad("routes", "an array");
    (c.routes as unknown[]).forEach((r, i) => {
      if (typeof r === "string") return;
      if (typeof r !== "object" || r === null || Array.isArray(r)) {
        bad(`routes[${i}]`, "a string or an object { left, right?, selector?, before? }");
      }
      const o = r as Record<string, unknown>;
      for (const key of Object.keys(o)) {
        if (!["left", "right", "selector", "before"].includes(key)) {
          throw new Error(
            `${file}: \`routes[${i}].${key}\` is not a route key (left, right, selector, before)`,
          );
        }
      }
      if (o.before !== undefined && typeof o.before !== "function")
        bad(`routes[${i}].before`, hook);
      const sel = o.selector as Record<string, unknown> | undefined;
      if (
        sel !== undefined &&
        !(typeof sel === "string" && sel) &&
        !(
          typeof sel === "object" &&
          sel !== null &&
          Object.keys(sel).sort().join() === "left,right" &&
          [sel.left, sel.right].every((v) => typeof v === "string" && v)
        )
      ) {
        bad(`routes[${i}].selector`, "a non-empty string or { left, right } of non-empty strings");
      }
      if (typeof o.left !== "string" || !o.left) bad(`routes[${i}].left`, "a non-empty string");
      if (o.right !== undefined && (typeof o.right !== "string" || !o.right)) {
        bad(`routes[${i}].right`, "a non-empty string");
      }
    });
  }
  if (c.widths !== undefined) {
    if (
      !Array.isArray(c.widths) ||
      !c.widths.every((w) => typeof w === "number" && Number.isFinite(w) && w > 0)
    ) {
      bad("widths", "an array of positive numbers");
    }
  }
  if (c.computed !== undefined && typeof c.computed !== "boolean") bad("computed", "a boolean");
  if (c.threshold !== undefined) {
    const t = c.threshold;
    if (typeof t !== "number" || !Number.isFinite(t) || t < 0 || t > 1) {
      bad("threshold", "a number between 0 and 1");
    }
  }
  if (c.concurrency !== undefined) {
    const n = c.concurrency;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
      bad("concurrency", "a positive integer");
    }
  }
  if (c.masks !== undefined) {
    if (!Array.isArray(c.masks)) bad("masks", "an array");
    (c.masks as unknown[]).forEach((m, i) => {
      const o = m as Record<string, unknown> | null;
      if (typeof o !== "object" || o === null) {
        bad(`masks[${i}]`, "an object");
        return;
      }
      if (o.urlPath !== undefined && typeof o.urlPath !== "string") {
        bad(`masks[${i}].urlPath`, "a string");
      }
      if (typeof o.reason !== "string") bad(`masks[${i}].reason`, "a string");
      if ("selector" in o === "locate" in o) {
        throw new Error(`${file}: \`masks[${i}]\` needs exactly one of \`selector\` or \`locate\``);
      }
      if (o.selector !== undefined && typeof o.selector !== "string") {
        bad(`masks[${i}].selector`, "a string");
      }
      if (o.locate !== undefined && typeof o.locate !== "function") {
        bad(`masks[${i}].locate`, "a function (page) => Locator");
      }
    });
  }
  if (c.maskMedia !== undefined && typeof c.maskMedia !== "boolean") bad("maskMedia", "a boolean");
  if (c.freezeVideo !== undefined && typeof c.freezeVideo !== "boolean")
    bad("freezeVideo", "a boolean");
}

/** CLI-supplied values. `undefined` means "not passed", so the config file wins. */
export interface CliOverrides {
  left?: string;
  right?: string;
  widths?: number[];
  threshold?: number;
  outDir?: string;
  concurrency?: number;
  /** Per side, from --storage-state / --left-storage-state / --right-storage-state. */
  storageState?: { left?: string; right?: string };
  computed?: boolean;
  /** From --mask, appended to the config's masks. */
  masks?: string[];
  maskMedia?: boolean;
  freezeVideo?: boolean;
}

/** Merge built-in defaults, the config file, and CLI flags into one resolved config. */
export function resolveConfig(file: RenderdiffConfig, cli: CliOverrides): ResolvedConfig {
  const left = cli.left ?? file.left;
  const right = cli.right ?? file.right;

  if (!left || !right) {
    throw new Error(
      !left && !right
        ? "left and right origins are required (two positional URLs, --left and --right, " +
            "or left and right in renderdiff.config.*)"
        : !left
          ? "left origin is required (first positional URL, --left, or left in renderdiff.config.*)"
          : "right origin is required (second positional URL, --right, or right in renderdiff.config.*)",
    );
  }

  const fileState =
    typeof file.storageState === "string"
      ? { left: file.storageState, right: file.storageState }
      : file.storageState;

  const hideSelectors = [...DEFAULT_HIDE_SELECTORS, ...(file.hideSelectors ?? [])];
  const freezeVideo = cli.freezeVideo ?? file.freezeVideo ?? true;

  return {
    left: left.replace(/\/+$/, ""),
    right: right.replace(/\/+$/, ""),
    widths: cli.widths ?? file.widths ?? [...DEFAULT_WIDTHS],
    threshold: cli.threshold ?? file.threshold ?? null,
    outDir: path.resolve(process.cwd(), cli.outDir ?? file.outDir ?? DEFAULT_OUT_DIR),
    concurrency: cli.concurrency ?? file.concurrency ?? DEFAULT_CONCURRENCY,
    blockUrlPatterns: [...DEFAULT_BLOCK_URL_PATTERNS, ...(file.blockUrlPatterns ?? [])],
    hideSelectors,
    neutralizeCss:
      STILL_CSS +
      `${hideSelectors.join(",")}{display:none!important}\n` +
      // visibility, not display, so the player keeps its layout.
      (freezeVideo
        ? ".vjs-text-track-display,.vjs-control-bar,.vjs-control-bar *{visibility:hidden!important}\n"
        : "") +
      (file.extraCss ?? ""),
    masks: [
      ...(file.masks ?? []).map((m) =>
        m.urlPath === undefined ? m : { ...m, urlPath: normalize(m.urlPath) },
      ),
      ...(cli.masks ?? []).map((selector) => ({ selector, reason: `${selector} (--mask)` })),
      ...(cli.maskMedia || file.maskMedia ? [MEDIA_MASK] : []),
    ],
    storageState: {
      left: storageFile(cli.storageState?.left ?? fileState?.left),
      right: storageFile(cli.storageState?.right ?? fileState?.right),
    },
    computed: cli.computed ?? file.computed ?? false,
    freezeVideo,
  };
}

/** Absolute path to a storage state file that parses as a JSON object. Never echoes its contents. */
function storageFile(p: string | undefined): string | null {
  if (!p) return null;
  const file = path.resolve(process.cwd(), p);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new Error(`storage state file not found: ${file}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // Not the parse error's message: it quotes the file, which holds session tokens.
    throw new Error(`storage state file is not valid JSON: ${file}`);
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error(`storage state file is not a JSON object: ${file}`);
  }
  const { cookies = [], origins = [] } = json as Record<string, unknown>;
  if (!Array.isArray(cookies) || !Array.isArray(origins)) {
    throw new Error(
      `storage state file is not a Playwright storage state (cookies/origins must be arrays): ${file}`,
    );
  }
  return file;
}
