# Design note: which routes a change can affect, and which removed rules mattered

Status: proposal, nothing built. Two framework-agnostic signals, neither reads the git diff.

## Why not map the git diff to routes

Mapping source files to routes is framework-specific (Next, Astro, Hugo and Jekyll all resolve
templates differently). For global CSS, the most common refactor, it answers "every route"
anyway, so a mapper that skips routes produces false confidence. The two signals below look
at what the build produced and what the browser actually applied. Neither is a reason to drop
a route. The first orders the route list. The second turns "no pixel diff" into evidence about
the CSS itself.

## 1. Build-output diff: `renderdiff impact <base-dir> <change-dir>`

For static sites. A subcommand with no browser, like `report`.

**What it does**

1. Walks both dirs for `*.html` and maps each file to a route the way `npx serve` does
   (`about/index.html` → `/about/`, `about.html` → `/about`). Pages on one side only are listed
   separately. A page missing from the change will 404.
2. Compares each pair after `normalizeAssets` from `src/computed.ts`, the same normaliser
   behind `--computed`'s `dom identical`. Two outcomes: `markup` (differs with inline
   `<script>` bodies stripped) or `script` (only inline scripts differ, usually a build id or
   a chunk manifest).
3. Collects each page's linked bundles: `<link rel=stylesheet|modulepreload|preload>` and
   `<script src>`. Bundles are paired across sides by their normalised path. A bundle counts as
   changed when its bytes differ. A renamed hash with identical bytes counts as unchanged.
4. Lists changed files that no page links: dynamic chunks, `@import`ed CSS, fonts and images
   referenced from CSS. Their reach is unknown, so it can be every route.

**Output**: a prioritised route list, never a filter.

```
impact: 116 pages; markup differs on 2, inline script only on 0, identical on 114; 0 one-sided
changed bundles: /_astro/main.#.css (116 routes)  /_astro/docs.#.js (59 routes)
changed, unlinked: 3 files (/_astro/Search.#.js …): reach unknown
  1 markup   /pricing /features
  2 bundle   59 routes linking only changed bundles shared by ≤59 routes
  3 bundle   57 routes linking main.#.css (every route)
  4 none     0 routes: no linked file changed (still run them; see "unlinked")
```

`--routes` prints the routes alone, one per line and tier by tier, so they can be passed
straight to a run. `--json` prints the full structure.

**Where it plugs in**

- `src/cli.ts`: a third subcommand next to `report`. The new code is a file walk, a
  link-attribute regex and a byte compare, about 150 lines in a new `src/impact.ts`. It reuses
  `normalizeAssets` unchanged.
- `src/run.ts`, `src/capture.ts`: untouched.
- `results.json` and `evidence.html`: untouched in v1. If it proves useful, `impact --out <dir>`
  could write `impact.json`, and `report` would add the tier table and the unlinked-files line
  to "Not verified".
- Skill, Loop step 1: "static build: `renderdiff impact <base-dist> <change-dist>`. Run tier
  1 first as the fast loop, but the finish (step 5) is still every route". A `markup` hit on a
  change meant to be CSS-only is a finding before any screenshot is taken.

**Cost**: zero per shot. One pass over both dist dirs, well under a second for 116 pages.

**Failure modes**

- Non-deterministic builds (timestamps, `useId`-style ids, random CSS-module hashes) make every
  page differ. That shows as a flood rather than a silent miss. The `script` tier absorbs the
  common case.
- The normaliser only rewrites double-quoted `src|href|srcset|poster`. Unquoted or
  single-quoted attributes from an HTML minifier make every page differ, again as a flood.
  Extend the regex when a real build shows it.
- Route mapping differs from the host (`trailingSlash`, i18n rewrites, redirects). `--dry-run`
  on the real server is the check.
- SPAs and SSR: an identical HTML shell with everything in JS. The bundle tier says "all of
  them", which is correct.
- Runtime data (fetched JSON, CMS, third-party embeds) is invisible to it.
- No dist dir (a server-rendered app): not applicable.

## 2. Removed-rule coverage: `--removed-rules`

For CSS-deletion work. On the right (reference) side, record which rules applied during each
shot, `before` hooks included. On the left (change) side, record which selectors the loaded
stylesheets contain. Report every rule that applied on the reference and whose selector
doesn't exist on the change, with routes and widths.

A spike in Chromium confirmed the CDP behaviour:

- After `DOM.enable`, `CSS.enable` and `CSS.startRuleUsageTracking`, `CSS.takeCoverageDelta`
  returns only the rules used since the last call (`styleSheetId`, offsets, `used: true`).
- `CSS.getStyleSheetText` plus the offsets gives each rule's text, for example
  `.h:hover{color:pink}`. A rule nested in `@media` comes back without its `@media` wrapper.
- A rule whose every declaration is overridden still counts as used.
- An `@media` block that doesn't match the viewport, `@media print`, an un-hovered `:hover`, and
  a class nobody has added yet are not counted as used. Once the hover or the class happens,
  the next delta includes them.

**What it does, per shot**

1. In `prepare()` (once per page), open a CDP session, run `DOM.enable` and `CSS.enable`, and
   keep `CSS.styleSheetAdded` headers in a per-page map, as `network` is kept. On the right
   side, also call `CSS.startRuleUsageTracking`.
2. In `capture()`, take and discard a delta just before `goto` (the same spot where
   `network.get(page).failed` is cleared), so each shot's delta covers only its own load, hook,
   scroll and late injections. Skip sheets whose text is renderdiff's own `neutralizeCss`.
3. At the end of `capture()`, on the right: take the delta and slice each used rule's text, then
   split selector lists into single selectors (`.a,.b` → `.a`, `.b`), since minifiers merge and
   split lists. On the left: fetch every live sheet's text and collect its set of single
   selectors. Normalise both sides the same way: collapse whitespace and map `:before` to
   `::before`. Both go on `Shot`.
4. In `run.ts`, next to the `--computed` diff, compute `removedRules` = right's used selectors
   minus left's selectors, for that same route and width. That catches code-split CSS, where a
   selector still exists in the change but in a sheet this route no longer loads.
5. Also count the **unexercised removals** in the same shot: selectors in the right's sheets,
   absent on the left, that never applied here. Each is tagged with its at-rule context
   (`@media print`, `prefers-color-scheme: dark`, `(min-width: 768px) and (max-width: 895px)`,
   no context). That needs the right side's full sheet text, which step 3 already fetches for
   the left.

**Output**

- `results.json`, per compared result: `removedRules: { selector, sheet, media? }[]`, plus
  `unexercised: number`. In `summary`: `removedRules` grouped by `(selector, sheet)` with
  `at: { url, widths }[]`, in the same shape and order as `groupFindings`, and
  `unexercised: { context, count, examples }[]`.
- Console, after the `computed:` block:

  ```
  removed rules: 2 applied on the reference and are gone from the change
    .navbar-toggler:hover  main.#.css  /@375 /pricing@375 +40 routes
    .dropdown-menu.show    main.#.css  /docs@1440 (hook)
  unexercised removals: 3,612 (2,980 no matching context, 410 @media print, 222 (min-width: 1600px))
  ```

- `evidence.html`: a "Removed CSS rules" section beside `computedSection`. An empty list is
  stated explicitly ("0 of 3,612 removed selectors applied on any shot"), and the unexercised
  contexts go into "Not verified".
- Pixels still decide the score and the exit code, as with `--computed`. The flag joins
  `configHash`, so `--rerun-failed` refuses a mismatch.
- Skill: in "Pick the mode", the dead-CSS row becomes pixels + `--computed` +
  `--removed-rules`. In Loop step 1, the hooks chosen for routes are the coverage. In the
  Verdict, "Not verified" lists the unexercised contexts.

**Reading it**

- **Non-empty: likely regression, not proof.** An overridden rule counts as used (confirmed
  above), so removing one can be a no-op. Check each selector against `--computed` on that route
  and width. With `dom identical` and no computed change on the matched elements, the rule
  was dead weight. Otherwise it's the cause of the diff, already named.
- **Empty: strong evidence for dead-CSS removal, bounded by coverage.** It holds for the states
  the run reached: these routes, these widths, these hooks. Whatever was never reached is the
  unexercised list, and the verdict says so.

**Cost**: estimated, to be measured on metabase.com before shipping.

- `CSS.enable` and rule tracking add a little to every style recalc.
- Each shot needs one `getStyleSheetText` per live sheet per side. A 500 KB bundle over a
  local CDP pipe should cost milliseconds. Cache the selector parse by a text hash, since the
  same bundle loads on every route.
- Expect tens of milliseconds per shot on top of a multi-second capture. `results.json` grows
  only by the findings and the per-context counts, never by the used-rule sets.

**Failure modes**

- **Runtime-only classes** (`.is-open`, `.scrolled`, validation errors) count only if
  something triggers them. The scroll pass in `capture()` triggers scroll-driven classes for
  free. The rest need a `before` hook, just as for pixels.
- **`:hover`, `:focus`, `:active`** count only when hovered or focused. A hook that hovers covers
  one element per shot. `CSS.forcePseudoState` (the `--computed` idea in `feedback.md`) could
  force these states in bulk later. Until then, removed `:hover` selectors are the bulk of the
  unexercised list, and that should be visible rather than hidden.
- **Media queries at untested widths**: default widths 1440, 1152, 896, 704 and 375 leave
  768–895 and anything over 1440 untested. The unexercised-by-context count names those
  queries. The fix is a `--width` pass, not an accept.
- **Selector rewritten, not removed**: a minifier rewriting `:is()` or nesting, or CSS-module
  hashes changing between builds, makes the selector look removed. That surfaces as a flood of
  findings, never a miss. Normalise with `hashy` if CSS modules show up.
- **Selector kept, declarations removed**: not this signal's job. `--computed` and pixels catch
  it.
- **Iframes and shadow roots**: separate targets or scopes, out of scope for v1. Iframes are
  usually masked anyway.
- **Chromium only**: renderdiff already is.

## Recommendation: build removed-rule coverage first

The work at hand is dead-CSS removal across about 116 routes × 5 widths. For a global bundle,
build-output diff says "all routes", which is honest but changes nothing about the run. Its
markup signal also duplicates what `--computed`'s `dom identical` already reports per route.
Removed-rule coverage answers the question that's actually open: did any of the deleted rules
matter on a state we reached, and which states didn't we reach? It plugs into code that already
runs per shot (`prepare`, `capture`, the `--computed` slot in `run.ts`, and `computedSection`).

Build-output diff is the cheaper, more generic follow-up. Its distinct value is pre-run:
catching an accidental markup change, one-sided pages and unlinked changed chunks before any
browser starts.
