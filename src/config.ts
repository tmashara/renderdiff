import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Locator, Page } from "playwright";

/**
 * Configuration: built-in defaults, the user-facing `RenderdiffConfig` shape, and the
 * loader that merges a `renderdiff.config.*` file into a `ResolvedConfig`.
 *
 * Precedence is always: CLI flag > config file > built-in default.
 */

/** A route to diff — a URL path. Extensionless, no trailing slash. `/` for the index. */
export type Route = string;

/**
 * Viewports to compare at. Each value sits *inside* a common responsive band rather
 * than on a boundary (640/768/1024/1280/1536 are the usual breakpoints), so a layout
 * switch never flaps between the two captures.
 */
export const DEFAULT_WIDTHS = [1440, 1152, 896, 704, 375];

/** Directory a run writes its screenshots and `report.html` into. Relative to cwd. */
export const DEFAULT_OUT_DIR = "renderdiff-out";

/**
 * Captures run in parallel. Two by default — if one side points at a live site we are
 * a guest there. No extra rate limiting needed: each worker holds at most one load per
 * origin at a time, so this is also the most concurrent loads either origin sees.
 */
export const DEFAULT_CONCURRENCY = 2;

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
export interface Mask {
  /** Exact `urlPath` this applies to, e.g. `/pricing`. */
  urlPath: string;
  /** Why it drifts — surfaced verbatim in the report. */
  reason: string;
  locate: (page: Page) => Locator;
}

/** The shape a `renderdiff.config.*` file default-exports. Every field is optional. */
export interface RenderdiffConfig {
  /** Left origin, e.g. `http://localhost:3000`. A trailing slash is stripped. */
  left?: string;
  /** Right origin, e.g. `https://example.com`. A trailing slash is stripped. */
  right?: string;
  /** Routes to diff when none are passed on the command line. */
  routes?: Route[];
  /** Viewport widths. Replaces {@link DEFAULT_WIDTHS} outright. */
  widths?: number[];
  /** Fail the run if any comparison scores below this, 0..1. */
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

export function masksFor(
  cfg: ResolvedConfig,
  page: Page,
  urlPath: string,
): Locator[] {
  return cfg.masks
    .filter((m) => m.urlPath === urlPath)
    .map((m) => m.locate(page));
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
  return { config: config as RenderdiffConfig, path: file };
}

/** Reject a malformed config here, naming the key, rather than deep inside a run. */
function validate(c: Record<string, unknown>, file: string) {
  const bad = (key: string, expected: string): never => {
    throw new Error(`${file}: \`${key}\` must be ${expected}`);
  };

  for (const key of ["left", "right", "outDir", "extraCss"]) {
    if (c[key] !== undefined && typeof c[key] !== "string") bad(key, "a string");
  }
  for (const key of ["routes", "blockUrlPatterns", "hideSelectors"]) {
    if (c[key] !== undefined && !isStrArray(c[key])) {
      bad(key, "an array of strings");
    }
  }
  if (c.widths !== undefined) {
    if (
      !Array.isArray(c.widths) ||
      !c.widths.every((w) => typeof w === "number" && Number.isFinite(w) && w > 0)
    ) {
      bad("widths", "an array of positive numbers");
    }
  }
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
      if (typeof o.urlPath !== "string") bad(`masks[${i}].urlPath`, "a string");
      if (typeof o.reason !== "string") bad(`masks[${i}].reason`, "a string");
      if (typeof o.locate !== "function") {
        bad(`masks[${i}].locate`, "a function (page) => Locator");
      }
    });
  }
}

/** CLI-supplied values. `undefined` means "not passed", so the config file wins. */
export interface CliOverrides {
  left?: string;
  right?: string;
  widths?: number[];
  threshold?: number;
  outDir?: string;
  concurrency?: number;
}

/** Merge built-in defaults, the config file, and CLI flags into one resolved config. */
export function resolveConfig(
  file: RenderdiffConfig,
  cli: CliOverrides,
): ResolvedConfig {
  const left = cli.left ?? file.left;
  const right = cli.right ?? file.right;

  const missing = [!left && "--left", !right && "--right"].filter(
    Boolean,
  ) as string[];
  if (missing.length) {
    throw new Error(
      `${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} required ` +
        `(pass on the command line, or set left/right in renderdiff.config.*)`,
    );
  }

  const hideSelectors = [
    ...DEFAULT_HIDE_SELECTORS,
    ...(file.hideSelectors ?? []),
  ];

  return {
    left: left!.replace(/\/+$/, ""),
    right: right!.replace(/\/+$/, ""),
    widths: cli.widths ?? file.widths ?? [...DEFAULT_WIDTHS],
    threshold: cli.threshold ?? file.threshold ?? null,
    outDir: path.resolve(
      process.cwd(),
      cli.outDir ?? file.outDir ?? DEFAULT_OUT_DIR,
    ),
    concurrency: cli.concurrency ?? file.concurrency ?? DEFAULT_CONCURRENCY,
    blockUrlPatterns: [
      ...DEFAULT_BLOCK_URL_PATTERNS,
      ...(file.blockUrlPatterns ?? []),
    ],
    hideSelectors,
    neutralizeCss:
      STILL_CSS +
      `${hideSelectors.join(",")}{display:none!important}\n` +
      (file.extraCss ?? ""),
    masks: file.masks ?? [],
  };
}
