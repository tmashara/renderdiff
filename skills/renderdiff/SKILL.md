---
name: renderdiff
description: Use when verifying that a framework migration, CSS refactor, template rewrite, dependency bump, or build-config change did not alter how pages render — comparing a local build against production or a reference deploy. Also when asked to screenshot-diff two origins, check for visual regressions, or run the renderdiff CLI.
---

# renderdiff

`renderdiff` screenshots the same routes on two origins at several viewport widths,
pixel-diffs each pair, and writes `report.html` plus per-shot PNGs.

```
renderdiff / /about /pricing --left http://localhost:3000 --right https://example.com
```

`renderdiff --help` is the flag reference. This skill is how to use it to answer "did my
change break the rendering?" without lying to yourself.

Check it's there: `renderdiff --version`. If not:
`npm install -g renderdiff && npx playwright install chromium` (Node >= 22.18).

## What a renderdiff verdict is

A finished check has these four parts, in this order:

1. **Scores** — the mean and worst lines from stdout, with each route's regions, bands
   and text-diff counts.
2. **What you saw in the diff PNGs you opened** — named per route and width, e.g.
   "/pricing @1440: footer block sits 40px lower on the left; nav identical."
3. **What you did not verify** — errored routes, widths you skipped, regions under a
   mask, routes not in the list.
4. **The call** — parity, regression, or expected change, and why.

**A score without part 2 is not a verdict.** The score says *where to look*, never
*whether it's fine*. A page scores 99.6% with a nav link missing, and 97% because one
font loaded a frame late. You cannot tell those apart from a number.

Reading the diff means `Read`ing the PNG, not reasoning about the percentage.

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
renderdiff /about --left http://localhost:4000 --right https://example.com --width 1440
```

**4. Read the detail lines, then open the diff.** Under each score stdout prints what
changed and where:

```
  [1/1] 97.14%  /about @1440  (height -24px)
        3 regions, largest 1440×33 at (0,1104)
        band -24px at y=196 (right)
        aligned 100.00%
        text: 0 added, 1 removed
```

- **text** — read it first. `removed` lines are on the right (reference) only, `added` on
  the left (your change) only; the report card lists them. A removed line is missing
  content whatever the score says.
- **band** — rows one side has that the other lacks (`-` = only right has them, `+` = only
  left). Everything below a band is pushed down, so the red below it is one cause, not
  many. `aligned` near 100% means the band *is* the whole difference. `y` is approximate
  where identical rows repeat.
- **regions** — where the differing pixels are, largest first, as `w×h at (x,y)`. Go to
  each one in the diff PNG. Many regions plus a band: look at the band first.

Output lands in `./renderdiff-out/` as
`{slug}.{width}.{left,right,diff}.png` — `/` slugs to `index`, `/blog/foo` to
`blog-foo`, other characters to `_`, and a clash gets a `-2` suffix:

```
Read renderdiff-out/about.1440.diff.png
```

Read `left.png` and `right.png` too when the diff alone doesn't explain itself.
Working with a human present? Add `--open` so they see the report as well.

**5. Explain every region, band and text line before widening.** Each one is a real regression, content
that legitimately drifts, or a height difference. Don't move on with an unexplained band.

**6. Widen.** All routes, default widths, and `--threshold` once you know what clean
looks like. Keep `--concurrency` low (default 2) when the right side is someone's live
site — you're a guest there.

## Triage

| What you see | What it means |
| --- | --- |
| Magenta bands | One side is taller/wider; the shorter image is padded, and the padding counts against the score on purpose. The `height ±Npx` badge names it. |
| Score ~100% on every route | Suspect before you celebrate. Confirm both sides actually rendered — two identical error pages diff at ~100%. |
| `HTTP 404 at …` (or any status ≥ 400) | That side answered with an error status. Usually a route that doesn't exist on one origin, or a dev server not ready. |
| `page did not render on either side (…)` | Both sides had under 200 chars of text and no visible images, SVG, canvas, video, iframes or form controls, so renderdiff refused to score two blanks as a match. Usually a failed asset or an app that never mounted. One blank side isn't refused — it shows up as a low score. |
| `ERROR` rows | Unmeasured, not failed. They exit 1 because an unmeasured route isn't a verified one. Report them as unverified. |
| Uniform low score, whole page shifted | Almost always a height or font-loading difference near the top pushing everything down. A `band` line names where; compare left and right at that `y`. No band means the shift is horizontal or the content itself changed. |
| `text: N added, M removed` | Content differs. Read the lines on the report card: a removed line is something the reference shows and your change doesn't. |
| `rows too different to align` | The pages share too few identical rows to align, so no bands. Fine for a horizontal shift; otherwise the pages are very different. |
| `unstable Npx` badge | Pixels that kept changing between shots of the same load on one origin (a ticker, a carousel, a video). Painted out on both sides and excluded from the measurement, so the score covers only the rest. A large number means a big region went unmeasured — look at the magenta on the images. |
| `page did not settle: Npx unstable at …` | More than 25% of the page kept changing between shots, so too little was measured to score. Mask or stop the moving part (a carousel, a background video). |

Report colouring: green above 99.5%, amber to 97%, red below.

## Rationalizations

| Thought | Reality |
| --- | --- |
| "Mean 99.1%, no regressions." | You reported a number, not a check. Open the worst diff. |
| "99.6%, it's noise." | Check the text diff and region count first. A missing nav link is 99.6% and one `removed` line. |
| "It's probably just fonts / antialiasing." | "Probably" is exactly what the diff PNG resolves. Look. |
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

With a globally-installed CLI, use a plain `export default {}` —
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
