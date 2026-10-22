---
name: renderdiff
description: Use to prove a framework migration, CSS refactor, template rewrite or dependency bump didn't change how pages render, by screenshot-diffing two origins (local build vs production or a reference). Also for visual-regression checks or running the renderdiff CLI.
---

# renderdiff

```bash
npx renderdiff@latest http://localhost:3000 https://example.com /about --width 1440
```

First origin = left = your change, second = right = the reference. Each route loads on
both; a page the change moved is a pair, `/pricing::/plans` (left path, then right).
To check one component rather than the page, `--selector "<playwright selector>"` (or
`--left-selector` / `--right-selector` when its markup differs); it must match exactly one
element per side, else the route errors with the count.
A state behind a click (open menu, a modal both sides show) takes a config `before` hook;
a page behind a login takes `--storage-state auth.json`. When either is legitimate: reference.md.
First run on a machine: `npx playwright install chromium`. Until renderdiff is on npm, install it with
`npm install -g github:tmashara/renderdiff` and run `renderdiff …`. Flags: `--help`.
Triage, rationalizations, config and gotchas: [reference.md](reference.md).

## Verdict (all four, in order)

1. **Numbers** — the `renderdiff:` verdict line and each differing route's rows.
2. **What you saw** in `dom` and the crops you opened, per route and width, naming the element ("/pricing @1440: `.cta` margin-left 24px→16px").
3. **Not verified** — errors, skipped widths, masked areas, regions you didn't open, routes not listed.
4. **Call** — parity, regression, or expected change, and why.

A score without looking is not a verdict: 99.6% can be a missing nav link.

## Loop

1. Both origins up and serving the same assets. `--dry-run` shows the URL pairs.
2. One route, one width. stdout lists clean routes on one line and every differing route
   with its widths; a row is score (a range across collapsed widths), `h±N` height delta,
   `band`, `aligned`, region count `reg`, and `text`.
3. Read `text` first: `-"x"` is only on the reference (missing in your change), `+"x"` only on yours.
4. A `band -24@y196` is 24 rows only the right has (`+` only the left) at that `y`;
   `aligned 100.00%` means the band is the whole difference. `unaligned`: no bands, see reference.md.
5. Read `dom` before any crop: `sel prop l→r` names the element and the computed property
   (left first); `+sel`/`-sel` exist only on the left/right; `sel x+8` moved with no style of
   its own changed, so look at the neighbour or parent listed after it; a bare `sel` changed
   only its own pixels (an image, a canvas). Find the rule, not the value. `--selector <sel>` scopes a rerun to it.
6. `Read` the crops for what `dom` doesn't explain (no `dom`, text, images): the `crops` line
   under each row names them, in the directory of the results.json on the verdict line, up to
   three per width, bands first. Left is always on top or on the left; the change is boxed in
   red, and a red seam marks where one side lacks the other's rows. Full shots (a crop's name
   with `left`, `right` or `diff` for `c{n}`) only when a crop doesn't explain itself.
7. Explain every band, region and text line, then widen to all routes and the default widths.
   For a row collapsed across widths, open the widest and the narrowest.

Exit: 0 nothing below `--threshold` and no errors — without `--threshold` a diff still exits 0,
so read the summary · 1 below `--threshold` · 2 bad args/config/origin down · 3 a route errored or the run crashed.
`ERROR` = unmeasured, report it as unverified. Everything clean? Confirm both sides actually rendered.

**Before you mask, lower the threshold, drop a route or skip widths,** read the
Rationalizations table in [reference.md](reference.md).
