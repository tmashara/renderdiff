/**
 * Library entry point. The CLI (`dist/cli.js`) is the primary interface; this exists so
 * a config file can be type-checked:
 *
 *   import { defineConfig } from "renderdiff";
 *   export default defineConfig({ … });
 *
 * That import only resolves when `renderdiff` is also installed in the project (or linked) —
 * a globally-installed CLI is not importable from an arbitrary directory. A plain
 * object export works everywhere and needs nothing from this module.
 */
export {
  defineConfig,
  DEFAULT_BLOCK_URL_PATTERNS,
  DEFAULT_CONCURRENCY,
  DEFAULT_HIDE_SELECTORS,
  DEFAULT_OUT_DIR,
  DEFAULT_WIDTHS,
  MASK_COLOR,
  type Mask,
  type ResolvedConfig,
  type Route,
  type RenderdiffConfig,
} from "./config.ts";

export {
  type ComparedResult,
  type ErrorResult,
  type Results,
  type RouteResult,
  type RunMeta,
  type Summary,
} from "./report.ts";

export { type Band, type Region, type TextDiff } from "./compare.ts";
