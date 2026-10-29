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
  type Hook,
  type Mask,
  type ResolvedConfig,
  type Route,
  type RouteSpec,
  type Sides,
  type RenderdiffConfig,
} from "./config.ts";

export {
  type ComparedResult,
  type CropResult,
  type ErrorResult,
  type Results,
  type RouteResult,
  type RunMeta,
  type Summary,
} from "./report.ts";

export { type Band, type Box, type Region, type TextDiff } from "./compare.ts";
export { type ElementDiff } from "./locate.ts";
export { type AriaDiff, type ComputedDiff, type Finding, type StyleChange } from "./computed.ts";
export { type Accepted, type Fingerprint } from "./accept.ts";
