# renderdiff reference

## Triage

| What you see | What it means |
| --- | --- |
| `h±N` | One side is taller (`+`: left). The shorter shot is padded with magenta, and the padding counts against the score on purpose. |
| Everything on the `clean:` line | Suspect before you celebrate. Confirm both sides actually rendered: two identical error pages diff as clean. |
| `ERROR HTTP 404 at …` (or any status ≥ 400) | That side answered with an error status. Usually a route that doesn't exist on one origin, or a dev server not ready. |
| `ERROR page did not render on either side (…)` | Both sides had under 200 chars of text and no visible images, SVG, canvas, video, iframes or form controls, so renderdiff refused to score two blanks as a match. Usually a failed asset or an app that never mounted. One blank side isn't refused; it shows up as a low score. |
| `ERROR` rows | Unmeasured, not failed. They exit 1 because an unmeasured route isn't a verified one. Report them as unverified. |
| Uniform low score, whole page shifted | Almost always a height or font-loading difference near the top pushing everything down. A `band` names where; compare left and right at that `y`. No band means the shift is horizontal or the content itself changed. |
| `text -"x" +"y"` | Content differs: `-` lines are on the reference only, `+` on your change only. `(+N more)` means more lines; the report card or results.json lists them all. |
| `unaligned` | The pages differ in height but share too few identical rows to align, so no bands. Either they are very different, the edits total more than 2,000 rows, or sub-threshold noise touches every row. Use the height delta and regions. |
| `band …@y~N` | Widths collapsed into one row put the band at different `y`; `N` is the first width's. |
| `unstable Npx` | Pixels that kept changing between shots of the same load on one origin (a ticker, a carousel, a video). Painted out on both sides and excluded from the score. A large number means a big area went unmeasured: look at the magenta on the full shots. |
| `ERROR page did not settle: Npx unstable at …` | More than 25% of the page kept changing between shots, so too little was measured to score. Mask or stop the moving part. |

Report colouring (`--open`, for a human): green above 99.5%, amber to 97%, red below.

## Rationalizations

| Thought | Reality |
| --- | --- |
| "Worst is 99.1%, no regressions." | You reported a number, not a check. Open the worst route's crops. |
| "99.6%, it's noise." | Check `text` and the region count first. A missing nav link is 99.6% and one `-` line. |
| "It's probably just fonts / antialiasing." | "Probably" is exactly what the crop resolves. Look. |
| "The crops looked fine, done." | Crops cover the largest regions only. Check the region count, and open the diff PNG for the rest and for any height delta: padding is never cropped. |
| "Masking the header gets this to 100%." | Every mask is coverage surrendered. Mask only content *proven* to vary per load (clocks, star counts, rotating quotes), with a `reason`, which the report prints verbatim. |
| "I'll lower `--threshold` until it passes." | Threshold is a CI gate, not a dial for reaching green. |
| "That route errors, I'll drop it from the list." | Shrinking the route list shrinks what you verified. Fix it, or say it's unverified. |
| "One width is enough." | Migrations break at one width and not others. That's why there are five defaults. |

## results.json

Scripts, and drilling into one route: every score, region (`x,y,w,h,pixels`), band, full
text diff and image path, one result per line, so `grep '"url":"/about"'` pulls a route.
Paths are relative to the out dir. `summary` has `compared`, `errors`, `mean`, `worst` and
`belowThreshold`; `meta` records origins, widths, threshold, the pinned clock, block
patterns, hidden selectors and mask reasons. The normal loop doesn't need it.

## Config file

Flags cover a one-off run. A `renderdiff.config.{ts,mts,js,mjs}` in the working directory
covers a repo you diff repeatedly, and expresses what flags can't: per-route masks,
extra selectors to hide, extra URLs to block. **CLI flag > config file > default.**

```js
// renderdiff.config.mjs
export default {
  left: "http://localhost:4000",
  right: "https://example.com",
  routes: ["/", "/about", "/pricing"],
  widths: [1440, 896, 375],
  threshold: 0.97,
  hideSelectors: [".site-cookie-banner"],
  masks: [
    {
      urlPath: "/pricing",
      reason: "live star count on /pricing",
      locate: (page) => page.locator("[data-star-count]"),
    },
  ],
};
```

Run through `npx` or a global install, use a plain `export default {}`:
`import { defineConfig } from "renderdiff"` only resolves when renderdiff is also installed in
that project. [`renderdiff.config.example.ts`](https://github.com/tmashara/renderdiff/blob/main/renderdiff.config.example.ts)
annotates every field.

Two rules for `hideSelectors`: match the element **exactly** (consent scripts also stamp
classes on `<html>`, and a loose selector blanks the whole document; blank matches
blank, so everything "passes"), and these hide rather than remove (removing after the
cookie script ran wedges the renderer).

## Gotchas

- **stdout is compact when piped** (what an agent sees). `--progress` prints a line per
  shot instead.
- **The out dir is wiped at the start of every run.** To keep a previous run's evidence
  next to a new one, pass `--out renderdiff-before` / `--out renderdiff-after`. A
  directory holding files renderdiff didn't write is refused (exit 2).
- **Routes normalize** to no trailing slash; `/` stays `/`. Globs are rejected.
- **A migration that changed a URL** can't be diffed in one run: both sides get the
  same path.
- **Analytics, consent and A/B tooling are blocked at the network layer** on both sides,
  and animations are stilled. If something still flickers between runs, it's a candidate
  for `blockUrlPatterns`, not for a mask.
- Keep `--concurrency` low (default 2) when the right side is someone's live site.
