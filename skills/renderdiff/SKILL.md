---
name: renderdiff
description: Visual-parity check for website migrations. Use when a framework migration, CSS or design-system refactor, template rewrite, CMS move or dependency/build upgrade should not change how pages look, to prove it by screenshot-diffing your change against a local build of the base (or production, or any reference) across viewport widths. Also for "did I break the layout", visual regression checks, pixel diffs of two URLs, or running the renderdiff CLI.
allowed-tools: Bash(npx renderdiff:*), Bash(npx renderdiff@latest:*), Bash(renderdiff:*), Read
---

# renderdiff

```bash
npx renderdiff@latest http://localhost:3001 http://localhost:3002 / /about /pricing
```

First origin = left = your change; second = right = the reference. `+` is only/more in your
change, `-` only/more in the reference. First run: `npx playwright install chromium`. Flags:
`--help`. Details: [reference.md](reference.md), the § named at each step.

## Pick the mode

| Change | Run |
| --- | --- |
| CSS only, markup untouched (refactor, dead-CSS removal, token swap) | pixels + `--computed`. Expect `dom identical` on every route: then each `computed:` finding is a real style change, even on a clean route. `dom differs`: the markup changed after all; find out why. |
| Markup changes (framework, template or component migration) | pixels. `--computed` findings would only be hints. |
| Dependency or build upgrade | pixels, plus `--computed` if the markup should be identical. |
| One component | pixels with `--selector <sel>`. |

Pixels decide the score and the exit code in every mode.

## Loop

1. **Serve both sides as production builds**: the base commit in a `git worktree` on one
   port (right), your change on another (left), same content and data. Production as the
   reference is a later second pass. Routes: one per template or layout; `--dry-run` prints
   the pairs. Moved page, component, sign-in, click-gated state: § Scoping.
2. **Baseline before changing code**: the untouched change side against the reference.
   Base vs base, so whatever differs varies per load: mask it (`--mask-media` for iframes,
   `--mask <sel>` or a config mask with a `reason`; video is already frozen), rerun until
   clean. Against production: open each difference, then `--accept "differs before the change"`.
3. **Change, run all routes at default widths, read each row in this order** (§ Output):
   `ERROR` (unmeasured) → `failed` (a missing stylesheet or font explains the whole row: fix,
   rerun) → `text` → `h`/`w`, `band`, `aligned`, `line` → `dom` (`sel prop l→r` is a computed
   value: find the *rule*) → `computed:` → `Read` the `crops` for what `dom` doesn't explain
   (multi-width row: widest and narrowest). Common: `band -24@y196` = 24 rows only the
   reference has; `aligned 100.00%` = the bands are the whole difference; `line -1px@yN` = a
   lost border or divider; `+sel` / `-sel` = only left / right; `sel x+8` = moved, cause
   listed after it.
4. **Decide every band, region, line and text line:**

   | It is | Do |
   | --- | --- |
   | Caused by your change, not intended | Fix it. |
   | In the baseline too, or intended, and you opened it | `--accept "<why>"` |
   | Varying per load (base vs base shows it) | Mask it, with a `reason`. |
   | `unstable`, a width change, or `unaligned` with a height change | Can't be accepted: fix or report. |

   Before you mask, accept, set `--threshold`, drop a route or skip a width: § Rationalizations.
5. **Iterate** with `--rerun-failed` (same arguments; reruns only what isn't clean or
   accepted) and `--cache-right` (replays the reference's traffic, up to an hour). **Finish**
   with a fresh full run: all routes, default widths, neither flag. All clean? Confirm both
   sides actually rendered.

Exit: 0 nothing unaccepted differs, nothing errored · 1 a shot differs (with `--threshold`:
scores below it), wins over 3 · 2 bad arguments, config or out dir, or an origin down · 3 a
route errored or the run crashed. § Exit codes.

## Verdict (all four, in order)

1. **Numbers**: the `renderdiff:` line and each differing row.
2. **What you saw**: per route and width, element and property ("/pricing @1440: `.cta`
   margin-left 24px→16px").
3. **Not verified**: errors, skipped widths, masks, accepts, hooks, unopened regions, unlisted
   routes, and the reference (base build or production).
4. **Call**: parity, regression, or expected change, and why.

A score without looking is not a verdict: 99.6% can be a missing nav link.
