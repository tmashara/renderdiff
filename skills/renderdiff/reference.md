# renderdiff reference

Left is your change, right is the reference: `+` is only/more on the left, `-` only/more on the right.

## Triage

| What you see | What it means |
| --- | --- |
| `h±N` | One side is taller (`+`: left). The shorter shot is padded with magenta, and the padding counts against the score on purpose. |
| `w±N` | One side is wider (`+`: left), usually horizontal overflow. The narrower shot is padded with magenta. |
| Everything on the `clean:` line | Suspect before you celebrate. Confirm both sides actually rendered: two identical error pages diff as clean. |
| `ERROR HTTP 404 at …` (or any status ≥ 400) | That side answered with an error status. Usually a route that doesn't exist on one origin, or a dev server not ready. |
| `ERROR page did not render on either side (…)` | Both sides had under 200 chars of text and no visible images, SVG, canvas, video, iframes or form controls, so renderdiff refused to score two blanks as a match. Usually a failed asset or an app that never mounted. One blank side isn't refused; it shows up as a low score. |
| `ERROR` rows | Unmeasured, not failed. They exit 3 because an unmeasured route isn't a verified one. Report them as unverified. |
| Uniform low score, whole page shifted | Almost always a height or font-loading difference near the top pushing everything down. A `band` names where; compare left and right at that `y`. No band means the shift is horizontal or the content itself changed. |
| `text -"x" +"y"` | Content differs: `-` lines are on the reference only, `+` on your change only. `(+N more)` means more lines; the report card or results.json lists them all. |
| `unaligned` | The pages differ in height but share too few identical rows to align, so no bands. Either they are very different, the edits total more than 2,000 rows, or sub-threshold noise touches every row. Use the height delta and regions. |
| `dom sel margin-left 24px→16px` | That element is on both sides and those computed values differ, left first. The value is a symptom: find the rule that sets it, and check it changed on purpose. |
| `dom +sel "x"` / `dom -sel "x"` | That element exists only on the left (your change) / only on the right. |
| `dom sel x+8` | It moved but no style of its own changed: the neighbour or parent listed after it is the cause; with none listed, look above it. |
| `dom sel` (nothing after it) | On both sides, and no compared style changed and it didn't move: its own pixels did (an image's source, a canvas, an SVG). Open the crop. |
| No `dom` line | Nothing was found under the change, a band whose rows hold nothing only one side has, past the first five bands and regions, or the probe timed out. Open the crop. |
| `band …@y~N` | Widths collapsed into one row put the band at different `y`; `N` is the first width's. |
| `unstable Npx` | Pixels that kept changing between shots of the same load on one origin (a ticker, a carousel, a video). Painted out on both sides and excluded from the score. A large number means a big area went unmeasured: look at the magenta on the full shots. Such a route is never on the `clean:` line. |
| `ERROR selector "…" matched N elements on left (/a), expected 1` | A selector must match exactly one element per side. Make it more specific (`>> nth=0`, an id, `data-test`), or list the route once per element. |
| `ERROR selector "…" has no box on …` | It matched an element that isn't rendered (`display: none`, zero size). |
| `ERROR page did not settle: Npx unstable at …` | More than 25% of the page kept changing between shots, so too little was measured to score. Mask or stop the moving part. |

Report colouring (`--open`, for a human): green above 99.5%, amber to 97%, red below.

## Rationalizations

| Thought | Reality |
| --- | --- |
| "Worst is 99.1%, no regressions." | You reported a number, not a check. Open the worst route's crops. |
| "99.6%, it's noise." | Check `text` and the region count first. A missing nav link is 99.6% and one `-` line. |
| "It's probably just fonts / antialiasing." | "Probably" is exactly what the crop resolves. Look. |
| "`dom` says margin, done." | It's a computed value. Confirm the source rule changed on purpose, and still open the crop when the region is large or `dom` names nothing. |
| "The crops looked fine, done." | There are at most three: bands, then the largest regions. Check the region count, any `clipped` crop in results.json, and open the diff PNG for the rest and for any height delta: padding is never cropped. |
| "Masking the header gets this to 100%." | Every mask is coverage surrendered. Mask only content *proven* to vary per load (clocks, star counts, rotating quotes), with a `reason`, which the report prints verbatim. |
| "I'll lower `--threshold` until it passes." | Threshold is a CI gate, not a dial for reaching green. |
| "That route errors, I'll drop it from the list." | Shrinking the route list shrinks what you verified. Fix it, or say it's unverified. |
| "One width is enough." | Migrations break at one width and not others. That's why there are five defaults. |
| "A `before` hook that hides that element on the left gets this clean." | That hook is a mask with no `reason` in the report. A hook brings both sides to the same *state* (opens the menu, dismisses a modal both show, logs in); it never edits one side to match the other. |

## results.json

Scripts, and drilling into one route: every score, region (`x,y,w,h,pixels`, left-page
px), band, their `elements` (`selector`, `side`, each side's box, `changed`, `text`, and
`rightSelector` when the right was found under another selector; absent when not looked
at, `[]` when nothing was named), full text diff, image path and crop (`kind`, each side's box with `h` 0 at an
insertion point, `layout` `stacked` = left on top or `side` = left on the left, `scale`,
`clipped`), `selector` (`{ left, right }` or null), one result per line, so `grep '"url":"/about"'` pulls a route.
Paths are relative to the out dir. `summary` has `compared`, `errors`, `mean`, `worst` and
`belowThreshold`; `meta` records origins, widths, threshold, the pinned clock, block
patterns, hidden selectors, mask reasons, the browser (`chromium`, or `chrome` when it fell
back to the system Chrome) and each side's storage state file name. `hook: true` marks a
route a `before` hook ran on. The normal loop doesn't need it.

## Config file

Flags cover a one-off run. A `renderdiff.config.{ts,mts,js,mjs}` in the working directory
covers a repo you diff repeatedly, and expresses what flags can't: masks, extra selectors
to hide, extra URLs to block. **CLI flag > config file > default.**

```js
// renderdiff.config.mjs
export default {
  left: "http://localhost:4000",
  right: "https://example.com",
  routes: ["/", "/about", "/pricing::/plans", { left: "/blog", right: "/posts" },
           { left: "/pricing", selector: "[data-test=plans]" }],
  widths: [1440, 896, 375],
  threshold: 0.97,
  hideSelectors: [".site-cookie-banner"],
  masks: [{ selector: "[data-star-count]", reason: "live star count", urlPath: "/pricing" }],
};
```

A mask takes exactly one of `selector` or `locate: (page) => Locator`; without `urlPath` it
applies to every route, and on a pair it matches either side's path and paints both. A plain
`export default {}` needs no import; a type import from "renderdiff" is for editor types only. [`renderdiff.config.example.ts`](https://github.com/tmashara/renderdiff/blob/main/renderdiff.config.example.ts)
annotates every field.

Two rules for `hideSelectors`: match the element **exactly** (consent scripts also stamp
classes on `<html>`, and a loose selector blanks the whole document; blank matches
blank, so everything "passes"), and these hide rather than remove (removing after the
cookie script ran wedges the renderer).

## Gotchas

- **stdout is compact when piped** (what an agent sees). `--progress` prints a line per
  shot instead; `--no-progress` forces the summary on a terminal.
- **The out dir is wiped at the start of every run.** To keep a previous run's evidence
  next to a new one, pass `--out renderdiff-before` / `--out renderdiff-after`. A
  directory holding files renderdiff didn't write is refused (exit 2).
- **Routes normalize** to no trailing slash; `/` stays `/`. Globs are rejected.
- **Route pairs** split on the first `::` followed by `/`: `/pricing::/plans` is a pair,
  `/q?x=std::vector` and `pricing::plans` are single routes. `--dry-run` shows how each was
  read. A pair is `/a::/b` in stdout and `url`; results.json also has `left` and `right`,
  and its files are `{slug(a)}~{slug(b)}.{width}.*.png`.
- **Component scope** (`--selector`, `--left-selector`, `--right-selector`, or a route
  object's `selector: ".x" | { left, right }`): use it when the question is one component
  (a migrated widget, a design-system swap), so page noise elsewhere can't hide or fake a
  change. Exactly one match per side, or the route errors. A CLI selector applies to every
  route and replaces the config's. A route is `/a [.x]` in the summary (`/a @1440` with a
  `selector` line under it in `--progress`), files are `{slug}@{sel}.{width}.*.png` (`@{l}~{r}` when the sides' selectors differ), and
  regions are in the element's own pixels. The whole page still loads and settles. It's
  shot at scroll 0, so fixed or sticky overlays over it are included (`hideSelectors`); inside
  a shorter scroll container, whatever paints below the container is too; a transformed
  element is shot at its axis-aligned box. `xpath=` and `>>` work and `::` is never split;
  pseudo-elements are rejected by Playwright; iframes can't be reached.
- **`before` hooks** (config only: `before: async (page, { side, route, width }) => …` on a
  route object, or top level for every route without its own) run after load and the HTTP
  check, before settle, masks and the shot. Legitimate: opening a menu or tab, dismissing a
  modal or banner *both* sides show, signing in, scrolling a carousel to slide 1 on both.
  Masking a real difference: branching on `side` to make the sides look alike, hiding or
  removing an element on one side, waiting out a bug on one side only. `side` is for markup
  that legitimately differs (the same button, a different selector). A throw is
  `ERROR before hook failed on left: …`, never retried. Say in the verdict that a hook ran;
  the report badges those cards and results.json has `hook: true`.
- **Signed-in pages:** `npx playwright codegen --save-storage=auth.json <login url>`, then
  `--storage-state auth.json` (or `--left-storage-state` / `--right-storage-state`, or
  config `storageState`, relative to the config file). Missing, non-JSON or not a storage state: exit 2.
  The file holds live session tokens: never commit it, add it to `.gitignore`, and don't
  paste it into a chat. renderdiff records only its file name. The out dir then holds
  signed-in screenshots and their text in results.json: don't publish or commit it either
  (add it to `.gitignore`).
- **Browser:** if the bundled Chromium won't launch, renderdiff uses the system Chrome on
  both sides and says so; else it prints the `npx playwright install chromium` hint.
- **Analytics, consent and A/B tooling are blocked at the network layer** on both sides,
  and animations are stilled. If something still flickers between runs, it's a candidate
  for `blockUrlPatterns`, not for a mask.
- Lower `--concurrency` (default half the cores, 2–8) when the right side is someone's live site.
