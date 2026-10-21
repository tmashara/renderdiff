# The fixture corpus

Each directory here is one route. The fixture server (`tests/helpers/server.ts`) serves
`left.html` to the left origin and `right.html` to the right origin at the same path, so a
directory *is* a comparison. Two routes generate their markup instead
(`page.ts` exporting `left()` / `right()`), because 18,000px of HTML is not worth writing by
hand.

Three groups:

- **Equivalence** — `home`, `flex-vs-grid`, `float-vs-flex`, `table-vs-grid`, `abs-vs-flex`,
  `inline-block-vs-flex`. The two sides are visually identical and built with different CSS.
  These must score ≈100%. They are the corpus's central claim: the score tracks pixels, not
  markup, so a CSS refactor that changed nothing visible reads as "nothing changed".
- **Controls** — `shifted`, `taller`, `color`. Deliberately different. These must score low.
  A corpus of only passing cases proves nothing; without these, a tool that returned 100%
  unconditionally would pass the suite.
- **Guard rails** — `blank`, `tall`, `animated`, `lazy`, `lazy-deep`, `lazy-js`, `consent`,
  `drifting`, `tracker`, `clock`, `ticker`, `unsettled`, `sprite`, `short`.
  One per defence in `src/capture.ts` / `src/config.ts`.

## Authoring rules

Breaking any of these produces a flaky suite, and the flake looks like a renderdiff bug.

1. **Integer pixels only.** Fixed widths, fixed gaps, fixed heights. No percentage that
   doesn't divide evenly. Float `33.333%` and grid `1fr` round leftover space differently,
   and that rounding is the single largest source of sub-pixel noise between two otherwise
   identical pages. The arithmetic in `shared/base.css` closes exactly — keep it that way.
2. **Any centred box gets an explicit even width and height.**
   `transform: translate(-50%, -50%)` only lands on whole pixels when the free space either
   side is an integer, whereas `place-items: center` rounds. Give both mechanisms an even
   box in an even container and they agree.
3. **No webfonts.** `shared/base.css` sets a local monospace stack. A webfont means a
   network fetch and a possible FOUT, which differs between two loads seconds apart.
4. **No external assets.** Images come from `/shared/img/` on the fixture origin. Nothing
   leaves localhost, so the suite works offline and in CI.
5. **Identical text on both sides.** Only the inline `<style>` and the class names differ.
   `tests/unit/fixtures.test.ts` strips tags, drops `<style>`/`<script>` bodies, collapses
   whitespace, and asserts the two sides are byte-equal for every equivalence fixture. That
   check is what stops the pair from quietly ceasing to be an equivalence test when someone
   edits one side.
6. **Clear the render gate.** A route errors when both sides have under 200 characters of
   text and no visible images, SVG, canvas, video, iframes or form controls, so every page
   needs real content. The `notes` tail exists partly for this. `blank` and `sprite` (a
   hidden SVG sprite only) are the intentional violations; `short`
   stays under 200 characters on purpose and passes on its form controls.
7. **No animation** except in `animated`, which exists to prove `STILL_CSS` kills it, `ticker`,
   whose timer exists to be caught by the stability check, and `unsettled`, which recolours
   the whole page to trip the unstable-pixel cap.

## Adding a route

1. Create `pages/<name>/{left,right}.html` from an existing pair.
2. Reference it from a test in `tests/visual/`. The fixture lint fails on any directory no
   visual test mentions, so a fixture cannot be added and then forgotten.
