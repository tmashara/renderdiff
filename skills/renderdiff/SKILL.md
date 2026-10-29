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
change, `-` only/more in the reference. Default widths 1440, 1152, 896, 704, 375. First run:
`npx playwright install chromium`. Flags: `--help`. Details: [reference.md](reference.md),
the § named at each step.

## Pick the mode

| Change | Run |
| --- | --- |
| CSS only, markup untouched (refactor, dead-CSS removal, token swap) | pixels + `--computed`. Expect `dom identical` on every route: then each `computed:` finding is a real style change, even on a clean route. `dom differs`: often a wrapper's class changed, re-keying its subtree (§ `--computed`). Hover menus and open menus aren't shot without a `before` hook, and dead-CSS removal breaks exactly those. |
| Markup changes (framework, template or component migration) | pixels, plus `--aria`: `aria: identical` means a screen reader gets the same page. `--computed` findings would only be hints. |
| Dependency or build upgrade | pixels, plus `--computed` if the markup should be identical. |
| One component | pixels with `--selector <sel>` or `'/route @sel'`. |

Pixels decide the score and the exit code in every mode.

## Loop

1. **Serve both sides as production builds**: the base commit in a `git worktree` on one
   port (right), your change on another (left), same data (static build:
   `npx serve -l 3002 dist`). Production as the reference is a later second pass. Routes:
   every page the change can reach (`--sitemap`); `--dry-run` prints the pairs.
   § Reference and routes; moved page, component, sign-in, click state: § Scoping.
2. **Baseline**: base vs base. Before changing code, the untouched change side against the
   reference; if the change is already made, the base build served on two ports. Whatever
   differs varies per load: mask it (a `varies` line prints the mask; `--mask-media` for
   iframes, `--mask <sel>` or a config mask with a `reason`; video is already frozen; a
   looping carousel: stop it with a `before` hook on both sides, or mask it), and rerun
   until clean. A difference with no `varies` line and nothing unstable:
   `renderdiff probe <right><route> --width <w>` names what varies between loads; mask that.
   Against production instead: open each difference, then
   `--accept "differs before the change"`. § Masks, accepts and thresholds.
3. **Change, run all routes at default widths, read each row in this order**: `ERROR` →
   `failed` (a missing stylesheet or font explains the whole row: fix, rerun) → `fonts` → `text` →
   `h`/`w`, `band`, `aligned`, `line` → `dom` (`sel prop l→r` is a computed value: find the
   *rule*) → `findings:` (one cause on many routes: fix it once) → `computed:` → `Read` the
   `crops` for what `dom` doesn't explain (multi-width row: widest and narrowest). Every
   token: § Output.
4. **Decide every band, region, line and text line:**

   | It is | Do |
   | --- | --- |
   | Caused by your change, not intended | Fix it. |
   | In the baseline too, or intended, and you opened it | `--accept "<why>"` on the OS that checks (Mac entries go stale on Linux CI). |
   | Varying per load (base vs base shows it) | Mask it, with a `reason`. |
   | `unstable`, a width change, or `unaligned` with a height change | Can't be accepted (§ Masks, accepts and thresholds): fix or report. |

   Before you mask, accept, set `--threshold`, drop a route or skip a width: § Rationalizations.
5. **Iterate** with `--rerun-failed` (same arguments) and optionally `--cache-right`
   (§ Iterating). **Finish** with a fresh full run: all routes, default widths, neither flag.
   All clean? Confirm both sides actually rendered.

Exit 0 is not verified: unstable pixels or a failed asset alone exit 0, so report them. 1: an
unaccepted difference. § Exit codes.

## Verdict (all four, in order)

1. **Numbers**: the `renderdiff:` line and each differing row.
2. **What you saw**: per route and width, element and property ("/pricing @1440: `.cta`
   margin-left 24px→16px").
3. **Not verified**: errors, unstable or failed-asset rows, skipped widths, masks, accepts,
   hooks, unshot states (hover on non-interactive elements, open menus, `:active`), unopened
   regions, unlisted pages, and the reference (base build or production).
4. **Call**: parity, regression, or expected change, and why.

A score without looking is not a verdict: 99.6% can be a missing nav link.

After a fresh final run (never after `--rerun-failed`), write the four parts to `verdict.md`, run
`npx renderdiff@latest report <out> --verdict verdict.md --title "<task>"` and hand over
`evidence.html`. Offer to publish it as an Artifact for a link that opens in a browser; a ticket
attachment is the archive copy. Accepted entries are OS-specific: build it on the OS that
recorded them.
