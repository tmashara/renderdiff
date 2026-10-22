---
name: renderdiff
description: Visual-parity check for website migrations. Use when a framework migration, CSS or design-system refactor, template rewrite, CMS move or dependency/build upgrade should not change how pages look, to prove it by screenshot-diffing a local build against production (or any reference) across viewport widths. Also for "did I break the layout", visual regression checks, pixel diffs of two URLs, or running the renderdiff CLI.
---

# renderdiff

```bash
npx renderdiff@latest http://localhost:3000 https://example.com /about --width 1440
```

Left (first origin) = your change; right (second) = the reference. `+` means only/more in
your change, `-` only/more in the reference. First run: `npx playwright install chromium`.
Flags: `--help`. Moved page: `/old::/new`. One component: `--selector`. Click-gated state:
a config `before` hook. Signed in: `--storage-state auth.json`. When each is
legitimate: [reference.md](reference.md).

## Loop

1. **Baseline first.** Before changing code, run the unmodified build against the reference
   (`--out renderdiff-baseline`). Differences already there are not yours.
2. Both origins up, with the same content and data. `--dry-run` shows the URL pairs.
3. One route, one width. A row: score, `h±N`/`w±N` height/width delta,
   `band`, `aligned`, `N reg`, `unstable Npx` (moving pixels, unmeasured), `text`.
4. `text` first: `-"x"` is missing from your change, `+"x"` only in yours.
5. `band -24@y196`: 24 rows only the reference has. `aligned 100.00%`: the band is the
   whole difference. `unaligned`: see reference.md.
6. `dom` before crops. `sel prop l→r`: computed value, left first; find the *rule*.
   `+sel`/`-sel`: only left/right. `sel x+8`: moved; the cause is listed after it.
   Bare `sel`: its own pixels changed (image, canvas).
7. `Read` the crops under each row (next to results.json) for what `dom` doesn't explain.
   Left is on top or left; red box = change, red seam = missing rows.
8. Fix or justify every band, region and text line. Re-run after each migration step, then
   all routes at default widths; for a multi-width row, open the widest and narrowest crop.

Exit: 0 nothing below `--threshold` (**without it, a diff still exits 0**) · 1 below
threshold · 2 bad args/config/origin down · 3 a route errored (unmeasured) or crash.
All clean? Confirm both sides actually rendered.

**Before you mask, lower the threshold, drop a route or skip widths,** read
reference.md's Rationalizations.

## Verdict (all four, in order)

1. **Numbers**: the `renderdiff:` line and each differing row.
2. **What you saw**: per route and width, element and property ("/pricing @1440: `.cta` margin-left 24px→16px").
3. **Not verified**: errors, skipped widths, masks, unopened regions, unlisted routes, baseline drift.
4. **Call**: parity, regression, or expected change, and why.

A score without looking is not a verdict: 99.6% can be a missing nav link.
