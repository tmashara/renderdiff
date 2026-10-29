---
name: renderdiff
description: Visual-parity check for website migrations. Use when a framework migration, CSS or design-system refactor, template rewrite, CMS move or dependency/build upgrade should not change how pages look, to prove it by screenshot-diffing your change against a local build of the base (or production, or any reference) across viewport widths. Also for "did I break the layout", visual regression checks, pixel diffs of two URLs, or running the renderdiff CLI.
allowed-tools: Bash(npx renderdiff:*), Bash(npx renderdiff@latest:*), Bash(renderdiff:*), Read
---

# renderdiff

```bash
npx renderdiff@latest http://localhost:3000 https://example.com /about --width 1440
```

Left (first origin) = your change; right (second) = the reference. `+` means only/more in
your change, `-` only/more in the reference. First run: `npx playwright install chromium`.
Flags: `--help`. Moved page: `/old::/new`. One component: `--selector`. Click-gated state:
a config `before` hook. Signed in: `--storage-state auth.json`. Per-load noise: `--mask <sel>`, `--mask-media`. When each is
legitimate: [reference.md](reference.md).

## Loop

1. **Reference: the base, built locally.** When the base can be built, it is the default
   reference: the base commit in a `git worktree`, a production build of it on another
   port as right, your change as left, both up with the same content. Same data, fonts and CDN, so every diff is yours.
   Production as right is a secondary check afterwards: it adds deploy drift, one-sided
   third-party content and CSP errors. Serve production builds on both sides: dev overlays
   exist only on one side (Next's and Astro's are hidden; others go in `hideSelectors`).
   Routes: one per template or layout, from the sitemap or router; skip search results,
   pagination and admin. `--dry-run` shows the URL pairs.
2. **Baseline first.** Before changing code, run the base against the reference. Against
   the base build that is base vs base, so whatever differs varies per load: mask it
   (`--mask-media` for iframes, video and video.js text tracks; `--mask <sel>` or a config
   mask with a `reason` for the rest), then rerun until the baseline is clean. Against
   production, `--accept "differs before the change"` what is stable drift. Mask or accept
   only what you looked at, never to get green.
3. One route, one width. A row: score, `h±N`/`w±N` height/width delta,
   `band`, `aligned`, `N reg`, `unstable Npx` (moving pixels, unmeasured), `text`.
4. `failed` first: a stylesheet or font one side didn't load explains the whole row; fix
   that and rerun. Then `text`: `-"x"` is missing from your change, `+"x"` only in yours.
5. `band -24@y196`: 24 rows only the reference has. `aligned 100.00%`: the band is the
   whole difference. `unaligned`: see reference.md.
6. `dom` before crops. `sel prop l→r`: computed value, left first; find the *rule*.
   `+sel`/`-sel`: only left/right. `sel x+8`: moved; the cause is listed after it.
   Bare `sel`: its own pixels changed (image, canvas).
   CSS refactor or dead-CSS removal: add `--computed`. Each `computed:` finding is
   `key prop left→right`, collapsed across routes and widths. `dom identical` means the
   cause is CSS or JS, not markup.
7. `Read` the crops under each row (next to results.json) for what `dom` doesn't explain.
   Left is on top or left; red box = change, red seam = missing rows.
8. Fix or justify every band, region and text line. After each migration step,
   `--rerun-failed` (same arguments) reruns only what isn't clean or accepted; add
   `--cache-right` to replay the reference's traffic from the last such run (an hour at most)
   instead of fetching it again. Finish with all routes at default widths, without
   `--cache-right`. For a multi-width row, open the widest and narrowest crop.
   `accepted:` routes are known; a row saying `1 accepted` still has something new.

Exit: 0 no differing pixels, or all accepted (unstable pixels or a failed asset alone still
exit 0: read their rows) · 1 a difference (with `--threshold`: below it), even on `--accept` for one it can't accept (unstable pixels, width change, unaligned height change) · 2 bad args/config/origin down · 3 a route errored (unmeasured) or crash. 1 wins over 3.
All clean? Confirm both sides actually rendered.

**Before you mask, lower the threshold, drop a route or skip widths,** read
reference.md's Rationalizations.

## Verdict (all four, in order)

1. **Numbers**: the `renderdiff:` line and each differing row.
2. **What you saw**: per route and width, element and property ("/pricing @1440: `.cta` margin-left 24px→16px").
3. **Not verified**: errors, skipped widths, masks, unopened regions, unlisted routes, baseline drift and its reference (base build or production).
4. **Call**: parity, regression, or expected change, and why.

A score without looking is not a verdict: 99.6% can be a missing nav link.
