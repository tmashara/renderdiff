/**
 * The corpus manifest.
 *
 * Both the visual tests and the fixture lint import this, which is what keeps them honest:
 * the lint asserts these arrays list exactly the directories on disk, and the equivalence and
 * control suites iterate the arrays directly. Adding a directory without adding it here fails
 * the lint; adding it here without a test fails the guard-rail coverage check.
 */
import fs from "node:fs";
import path from "node:path";
import { PAGES_DIR, type Side } from "./server.ts";

/** Visually identical pairs built with different CSS. Must score a zero-pixel diff. */
export const EQUIVALENCE = [
  "home",
  "flex-vs-grid",
  "float-vs-flex",
  "table-vs-grid",
  "abs-vs-flex",
  "inline-block-vs-flex",
] as const;

/** Deliberately different. Must score low — otherwise the suite proves nothing. */
export const CONTROLS = ["shifted", "taller", "color", "tint", "nav", "margin", "divider"] as const;

/** One per defence in src/capture.ts and src/config.ts. */
export const GUARDRAILS = [
  "blank",
  "tall",
  "animated",
  "lazy",
  "lazy-deep",
  "lazy-js",
  "lazy-grow",
  "consent",
  "drifting",
  "tracker",
  "clock",
  "ticker",
  "unsettled",
  "unsettled-once",
  "sprite",
  "short",
  "tall-region",
  "reorder",
  "stripe",
  "frameset",
  "menu",
  "scroll-spy",
  "signed-in",
  "fixed",
  "inserted",
  "labelled",
  "broken-asset",
  "media",
  "long",
  "video",
  "video-seek",
  "hang",
  "origin",
  "cooperate",
  "mask-geometry",
] as const;

export const ALL: string[] = [...EQUIVALENCE, ...CONTROLS, ...GUARDRAILS];

/** Routes whose markup comes from a `page.ts` generator instead of static files. */
export const GENERATED = ["tall", "drifting", "unsettled-once"];

/** Routes that deliberately do not link `shared/base.css`. */
export const SELF_CONTAINED = ["blank", "sprite", "tall", "frameset"];

/** Routes under the 200-char text gate: `blank`, `sprite` and `frameset` must be refused, `short` passes on its form controls. */
export const BELOW_RENDER_GATE = ["blank", "sprite", "short", "frameset"];

/** `/` for the index, `/name` otherwise — the path to hand to the CLI. */
export const toPath = (dir: string) => (dir === "home" ? "/" : `/${dir}`);

/** The markup one origin serves for a route, static or generated. */
export async function sideHtml(dir: string, side: Side): Promise<string> {
  const staticFile = path.join(PAGES_DIR, dir, `${side}.html`);
  if (fs.existsSync(staticFile)) return fs.readFileSync(staticFile, "utf8");

  const gen = path.join(PAGES_DIR, dir, "page.ts");
  const mod = (await import(gen)) as Record<string, () => string>;
  return mod[side]!();
}

/**
 * The text a reader sees: tags gone, `<style>` and `<script>` bodies dropped, whitespace
 * collapsed. `<title>` text is kept and is identical across the corpus.
 *
 * This is what makes "identical content, different CSS" checkable. Class names and the
 * inline stylesheet are attributes and style bodies, so they drop out; prose does not.
 */
export function pageText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
