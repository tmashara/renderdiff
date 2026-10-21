---
name: renderdiff
description: Use when verifying that a framework migration, CSS refactor, template rewrite, dependency bump, or build-config change did not alter how pages render — comparing a local build against production or a reference deploy. Also when asked to screenshot-diff two origins, check for visual regressions, or run the renderdiff CLI.
---

# renderdiff

`renderdiff` screenshots the same routes on two origins at several viewport widths,
pixel-diffs each pair, and writes `results.json`, `report.html`, per-shot PNGs and a crop
of each of the largest diff regions.

```bash
npx renderdiff@latest / /about /pricing --left http://localhost:3000 --right https://example.com
```

Needs Node >= 22.18 and, once, `npx playwright install chromium`. Until renderdiff is
published to npm, `npx renderdiff@latest` won't resolve: install it with
`npm install -g github:tmashara/renderdiff` (or `npm link` in a clone) and run `renderdiff …`.

`--help` is the flag reference. This skill is how to use it to answer "did my change break
the rendering?" without lying to yourself.

## What a renderdiff verdict is

A finished check has these four parts, in this order:

1. **Scores** — `summary.mean` and `summary.worst` from `results.json`, with each route's
   region count, bands and text-diff lines.
2. **What you saw in the crops and PNGs you opened** — named per route and width, e.g.
   "/pricing @1440: footer block sits 40px lower on the left; nav identical."
3. **What you did not verify** — errored routes, widths you skipped, regions past the five
   cropped that you didn't open, regions under a mask, routes not in the list.
4. **The call** — parity, regression, or expected change, and why.

**A score without part 2 is not a verdict.** The score says *where to look*, never
*whether it's fine*. A page scores 99.6% with a nav link missing, and 97% because one
font loaded a frame late. You cannot tell those apart from a number.

Reading the diff means `Read`ing the crop or PNG, not reasoning about the percentage.

## Workflow

**1. Get both origins genuinely up.** Left = your changed version, right = the
reference. renderdiff refuses to start unless both answer a HEAD request, but that only
proves the origin exists — a preview server that 404s the CSS still answers. Make sure
both sides serve the same asset pipeline, or every page collapses and the run is
garbage.

**2. Confirm the pairs.** `--dry-run` prints the URL pairs and exits without a browser.
Routes are literal paths (globs are rejected) and both origins get the same path
appended, so the two sides must share URL structure.

**3. Start narrow — one route, one width.**

```bash
npx renderdiff@latest /about --left http://localhost:4000 --right https://example.com --width 1440
```

**4. Read `results.json`.** stdout ends with its path (`Results: …/renderdiff-out/results.json`).
Every path in it is relative to the out dir. Per route and width:

```json
{
  "url": "/about", "width": 1440, "status": "compared",
  "score": 0.9714, "alignedScore": 1, "heightDelta": -24, "unstablePixels": 0,
  "regions": [{ "x": 0, "y": 1104, "w": 1440, "h": 33, "pixels": 9120 }],
  "bands": [{ "side": "right", "y": 196, "h": 24 }],
  "text": { "added": [], "removed": ["Pricing"] },
  "images": { "left": "about.1440.left.png", "right": "about.1440.right.png", "diff": "about.1440.diff.png" },
  "crops": ["about.1440.r1.png"]
}
```

Read it in this order:

- **`text`** first. `removed` lines are on the right (reference) only, `added` on the left
  (your change) only. A removed line is missing content whatever the score says. Masked
  elements are left out, but unmasked text that changes per load (a ticker, a clock)
  appears whenever the sides differed at capture.
- **`bands`** — rows one side has that the other lacks, at `y` in that side's own
  coordinates. Everything below a band is pushed down, so the red below it is one cause,
  not many. `alignedScore` near 1 means the band *is* the whole difference. `y` is
  approximate where identical rows repeat. `bands: null` means the rows were too different
  to align.
- **`crops`** — `Read` each one. A crop is one region (`crops[i]` is `regions[i]`, largest
  first, at most five) padded by 48px, as left | right | diff side by side, at most 1200px
  on its long side — legible, unlike a full-page PNG, which `Read` downscales to a blur.
- **`images`** — the full PNGs, only when a crop doesn't explain itself: more than five
  regions, a band's surroundings, or a height delta (padding is never cropped).

`status: "error"` entries carry `error` instead of metrics. `summary` has `compared`,
`errors`, `mean`, `worst` and `belowThreshold`; `meta` records the origins, widths,
threshold, pinned clock, block patterns, hidden selectors and mask reasons.

Working with a human present? Add `--open` so they see the report as well — it shows the
same crops, regions, bands and text per card.

**5. Explain every region, band and text line before widening.** Each one is a real
regression, content that legitimately drifts, or a height difference. Don't move on with
an unexplained band.

**6. Widen.** All routes, default widths, and `--threshold` once you know what clean
looks like. Keep `--concurrency` low (default 2) when the right side is someone's live
site — you're a guest there.

## Triage

| What you see | What it means |
| --- | --- |
| Magenta padding | One side is taller/wider; the shorter image is padded, and the padding counts against the score on purpose. `heightDelta` / `widthDelta` name it. |
| Score ~100% on every route | Suspect before you celebrate. Confirm both sides actually rendered — two identical error pages diff at ~100%. |
| `HTTP 404 at …` (or any status ≥ 400) | That side answered with an error status. Usually a route that doesn't exist on one origin, or a dev server not ready. |
| `page did not render on either side (…)` | Both sides had under 200 chars of text and no visible images, SVG, canvas, video, iframes or form controls, so renderdiff refused to score two blanks as a match. Usually a failed asset or an app that never mounted. One blank side isn't refused — it shows up as a low score. |
| `status: "error"` (stdout: `ERROR`) | Unmeasured, not failed. They exit 1 because an unmeasured route isn't a verified one. Report them as unverified. |
| Uniform low score, whole page shifted | Almost always a height or font-loading difference near the top pushing everything down. A band names where; compare left and right at that `y`. No band means the shift is horizontal or the content itself changed. |
| Non-empty `text` | Content differs: a removed line is something the reference shows and your change doesn't. |
| `bands: null` (stdout: `rows too different to align`) | The pages differ in height but share too few identical rows to align. Either they are very different, or the edits total more than 2,000 rows, or sub-threshold noise touches every row. Use the height delta and regions. |
| `unstablePixels` > 0 | Pixels that kept changing between shots of the same load on one origin (a ticker, a carousel, a video). Painted out on both sides and excluded from the measurement, so the score covers only the rest. A large number means a big region went unmeasured — look at the magenta on the images. |
| `page did not settle: Npx unstable at …` | More than 25% of the page kept changing between shots, so too little was measured to score. Mask or stop the moving part (a carousel, a background video). |

Report colouring: green above 99.5%, amber to 97%, red below.

## Rationalizations

| Thought | Reality |
| --- | --- |
| "Mean 99.1%, no regressions." | You reported a number, not a check. Open the worst route's crops. |
| "99.6%, it's noise." | Check the text diff and region count first. A missing nav link is 99.6% and one `removed` line. |
| "It's probably just fonts / antialiasing." | "Probably" is exactly what the crop resolves. Look. |
| "The crops looked fine, done." | Crops cover the five largest regions. Check `regions.length`, and open the diff PNG for the rest and for any height delta — padding is never cropped. |
| "Masking the header gets this to 100%." | Every mask is coverage surrendered. Mask only content *proven* to vary per load — clocks, star counts, rotating quotes — with a `reason`, which the report prints verbatim. |
| "I'll lower `--threshold` until it passes." | Threshold is a CI gate, not a dial for reaching green. |
| "That route errors, I'll drop it from the list." | Shrinking the route list shrinks what you verified. Fix it, or say it's unverified. |
| "One width is enough." | Migrations break at one band and not others. That's why there are five defaults. |

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

Run through `npx` or a global install, use a plain `export default {}` —
`import { defineConfig } from "renderdiff"` only resolves when renderdiff is also installed in
that project. [`renderdiff.config.example.ts`](https://github.com/tmashara/renderdiff/blob/main/renderdiff.config.example.ts)
annotates every field.

Two rules for `hideSelectors`: match the element **exactly** (consent scripts also stamp
classes on `<html>`, and a loose selector blanks the whole document — blank matches
blank, so everything "passes"), and these hide rather than remove (removing after the
cookie script ran wedges the renderer).

## Gotchas

- **The out dir is wiped at the start of every run.** To keep a previous run's evidence
  next to a new one, pass `--out renderdiff-before` / `--out renderdiff-after`. A
  directory holding files renderdiff didn't write is refused (exit 2).
- **Routes normalize** to no trailing slash; `/` stays `/`.
- **A migration that changed a URL** can't be diffed in one run — both sides get the
  same path.
- **Analytics, consent and A/B tooling are blocked at the network layer** on both sides,
  and animations are stilled. If something still flickers between runs, it's a candidate
  for `blockUrlPatterns`, not for a mask.
- **Exit codes:** `0` clean · `1` a route errored or scored below `--threshold` ·
  `2` bad arguments, bad config, or an origin not responding.
