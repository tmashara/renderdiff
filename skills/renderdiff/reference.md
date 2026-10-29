# renderdiff reference

Left is your change, right is the reference: `+` is only/more on the left, `-` only/more on
the right. Sections: Reference and routes · Output · Errors · `--computed` · Masks, accepts
and thresholds · Rationalizations · Exit codes · Iterating · Scoping · Config file ·
results.json · Gotchas.

## Reference and routes

- **Base build vs change build, both local, is the default.** The base commit in a
  `git worktree`, a production build of each on its own port, same content, data, fonts and
  CDN, so every difference is yours. Production as the reference mixes in deploy drift,
  one-sided embeds (job boards, ads) and CSP blocks: a second pass only, and say which you used.
- **Production builds on both sides.** Dev overlays exist on one side only; Next's and
  Astro's are hidden by default, others go in `hideSelectors`.
- **Static builds:** `npx serve -l 3002 dist` (or any static server). Match the real host's
  clean URLs and trailing slashes, or a route 404s or redirects on one side only. `serve`
  already maps `/about` to `about.html` and `/docs` to `docs/index.html`, but serves both
  `/docs` and `/docs/`: `{ "trailingSlash": true }` in a `serve.json` redirects `/docs` to
  `/docs/`, `false` the reverse. Pass it as `-c ../serve.json` (relative to `dist`, so the
  file sits outside it and survives rebuilds); restart after editing it. Docs dist under the
  marketing one: `ln -s "$PWD/docs/dist" dist/docs`, redone after each rebuild (`rewrites`
  only remap paths inside the served dir). `redirects` and more: serve-handler's README.
- **Routes** are literal (no globs, no discovery): every template or page the change can
  reach, from the sitemap or router; skip search results, pagination and admin. `--sitemap`
  adds the right side's sitemap paths (files dropped); still list what it misses: the 404
  page, states, moved pairs. For removed CSS, every page where its selectors could match.
  Pages you don't list go under Not verified.
  Routes normalize to no trailing slash (`/` stays `/`). `--dry-run` shows how each was read.
- **Baseline when the change is already made:** serve the base build twice, on two ports, and
  diff it against itself; whatever differs varies per load.
- **States:** only the loaded state is shot. Hover, focus, open menus and dialogs need a
  `before` hook (§ Scoping); dead-CSS removal often breaks exactly those.

## Output

Piped (what an agent sees), stdout is one compact summary; `--progress` prints a line per shot
instead, `--no-progress` forces the summary on a terminal.

```
Routes: 3
clean: /
accepted: /blog
/about  clean @1152,896,704
  @1440  97.41%  h-24  band -24@y196  aligned 100.00%  text -"Pricing"
    failed right: font Inter 700
    dom -nav > a[href="/pricing"] "Pricing"
    crops about.1440.c1.png
  @375  ERROR HTTP 404 at http://localhost:3001/about
findings: …                       (a change seen on 2+ routes)
computed: …                       (with --computed, see below)
renderdiff: 1 of 3 routes differ (1 of 15 shots), 1 error, worst 97.41% /about@1440 — …/results.json
```

Before the summary, when they apply: `Config: <path>`, `accepted N difference(s), pruned M
stale — <file>` and `not accepted: N differing shot(s) can't be (2 unstable, 1 width change)` (`--accept`), `rerun: …` (`--rerun-failed`), `right: replayed from …` or
`right: loaded live and recorded …` (`--cache-right`), `stale accepted: /a@1440 …`. After it,
on stderr: `✗ 2 routes differ (10 shots).` (`below 97.00%` with `--threshold`).

**Lines**

| Line | Meaning |
| --- | --- |
| `clean: /a /b` | Not one pixel differs, none unstable, no asset failed. Suspect it until you confirm both sides rendered: two identical error pages diff as clean. |
| `accepted: /a` | Every difference on every width matches `renderdiff.accepted.json`. Known, not re-verified: say so. |
| `/a  clean @… accepted @…` | A route with something to read; the widths that are clean or accepted. |
| `  @1440,896  <row>` | Widths agreeing on height and width delta, bands (side and height), aligned score and text; score and region count become ranges, `unstable` the largest. |
| `    failed left: …` | Stylesheets (`stylesheet <url>`) and font faces (`font Inter 700`) that side didn't load (404, CORS, a CDN refusing localhost). Fix first: a fallback font reflows every line. |
| `    dom …` | Up to three elements behind the changes, two properties each. `dom @1440 …`: from the first width of the row. |
| `    crops …` | At most three crop PNGs per shot (bands first, tallest first, then largest regions), relative to `results.json`. |
| `  @w  ERROR …` | Unmeasured. Grouped across widths sharing a message. See Errors. |
| `varies /a @1440  Npx  sel` | A differing shot's right side, reloaded in a fresh context, differed from its first load there. Painted out on both sides like a mask, left out of the score (clean if nothing else differs), never accepted. Then `  --mask '…'` and `  masks: [{ …, reason: "varies per load" }]`: confirm it with a base-vs-base baseline before you use either. Off with `--no-recheck` and under `--cache-right`. |
| `renderdiff: D of R routes differ (S of T shots), E errors, worst …` | `S` counts unaccepted shots with any differing pixel; `worst` leaves accepted shots out. With `--threshold`: `, K below 97.00%`. |

**Row tokens**, in order

| Token | Meaning |
| --- | --- |
| `97.41%` / `99.12%–99.87%` | Share of measured pixels that match, floored to 2 decimals (a differing shot never reads 100.00%). Triage, not a verdict. |
| `h-24` / `w+8` | Height / width delta, left − right. The smaller shot is padded magenta; padding counts against the score on purpose. `w±` is usually horizontal overflow. |
| `unaligned` | Heights differ but too few identical rows to align: very different pages, edits over 2,000 rows, or sub-threshold noise on every row. No bands; use the delta and regions. |
| `band -24@y196` | 24 rows only the right has, at y=196 (`+`: only the left). `@y~196`: widths put it at different y; the first width's. Repeated identical rows can slide a band's y. |
| `aligned 100.00%` | Score with the bands cut out; 100% = the bands are the whole difference. Only with bands. |
| `line -1px@y812` | A 1–2px line across at least half the page that only the right draws (`+`: only the left; no sign: both, differently). Barely moves the score, large visually: a lost border or divider. Look for a `::before`/`::after` in `dom`. Past three: `(+N more)`. Not counted in `reg`. |
| `3 reg` / `2–3 reg` | Regions: connected patches of differing pixels on a 16px grid. With bands, from the realigned rows, so content a band merely pushed isn't one. |
| `unstable 1,204px` | Pixels that kept changing between shots of the same load on one origin (ticker, carousel, video with `--no-freeze-video`). Painted out on both sides, excluded from the score; the route is never clean. Large: a big area went unmeasured, look at the magenta in the full shots. |
| `1 accepted` | That many of the shot's bands and regions are accepted; the rest are new. `dom` names only the new. |
| `text +"x" -"y"` | Lines of visible text only on the left (`+`) / right (`-`), added first. Up to three, then `(+N more)`. Masked elements are left out. |
| `findings: N repeated on 2+ routes` | After the routes: each `dom` entry, text line or element-less `band -24px` seen on 2+ routes once, `×N routes  /a@1440,375 …`, most widespread first, accepted aside; top 20, all in `summary.findings`. One cause: fix it once. The same selector can be a different element per route: check one crop. |

**`dom` entries** (left first, `;`-separated)

| Entry | Meaning |
| --- | --- |
| `sel margin-left 24px→16px` | On both sides; those computed values differ. A symptom: find the rule that sets it, check it changed on purpose. |
| `sel "old"→"new"` | Its text differs. |
| `+sel "x"` / `-sel "x"` | Only on the left / only on the right. |
| `+sel::before` / `-sel::after` | A pseudo-element only the left / right generates. `sel::before height 1px→2px`: on both, differing in `content`, size, background, top/bottom border or `box-shadow`. A lost divider often shows only here. |
| `sel x+8 y-4` | It moved or resized, no style of its own changed: the neighbour or parent listed after it is the cause; none listed, look above it. |
| `sel` (nothing after) | On both, unchanged and unmoved: its own pixels changed (image source, canvas, SVG). Open the crop. |
| `… (re-parented)` | Paired across a structure change (grandparent/parent tags differ); its properties may not be the cause. Open the crop. |
| no `dom` line | Nothing named: a band holds nothing only one side has, past the first five bands and regions, fixed chrome covering it, shadow DOM or iframe, or the 5s probe timed out. Open the crop. |

Each selector is unique on its side, so `--selector` takes it.

**Crops**: left on top (`stacked`) or on the left (`side`); 1px red box round the change; on
the side lacking a band's rows, a 2px red seam where they would be. Within 1,568px and 1,568
image tokens, never below 0.75×; too big keeps the top rows and is `clipped` in results.json.
Height padding is never cropped: for a height delta, open `{slug}.{width}.diff.png`.

Report (`--open`, for a human): green from 99.5%, amber to 97%, red below.

## Errors

`ERROR` rows are unmeasured, neither pass nor fail, and exit 3. Report them as unverified.

| Error | Cause and fix |
| --- | --- |
| `HTTP 404 at …` (any ≥ 400) | That side answered an error: a route missing on one origin, or a server not ready. |
| `not an HTML page: server sent … at …` | The route is a file (PDF, image, JSON, download), not a page. Drop it from the routes. Never retried. |
| `page did not render on either side (…)` | Both sides under 200 chars of text and no visible image, SVG, canvas, video, iframe or form control. Usually a failed asset or an app that never mounted. One blank side isn't refused; it scores low. |
| `page did not settle: Npx unstable at …` | Over 25% of the page kept changing, on two loads. `<shot>.<side>.unsettled-a/-b.png` are the two differing frames, and the message gives the box they differ in. Mask or stop the moving part. |
| `page is Npx tall at Wpx wide, past the …px sanity ceiling …` | Taller than 57,600,000px ÷ width (never under 40,000px): a runaway layout, not a page. |
| `selector "…" matched N elements on left (/a), expected 1` | Make it unique (an id, `data-test`, `>> nth=0`), or list the route once per element. |
| `selector "…" has no box on …` / `is off the page on …` | Matched an element not rendered (`display: none`, zero size) or outside the page. |
| `before hook failed on left: …` | The hook threw (`beforeShot hook failed …` for that hook). Never retried. |
| `timeout after 120s at settle on left` | That side never finished the step (`load`, `before hook`, `settle`, `beforeShot hook`, `screenshot`): a hung script, a dead renderer, a hook that never resolves. Retried once in a fresh page, except a hung hook. For a page that is just very slow, raise `RENDERDIFF_SHOT_TIMEOUT` (seconds). |

A failed `--computed` snapshot (`snapshot failed on /a@1440 (…)` on the `computed:` line) is
not a route error: the pixel result stands.

## `--computed`

After each shot, reads the computed style (the `dom` properties plus `content`) of every
rendered element and its `::before`/`::after`, on both sides, and compares the markup. One
block after the rows:

```
computed: 2 findings; dom identical on 2 of 3 route(s), differs /pricing (1), so findings there are hints
  body > div.page > nav > a[href="#blog"] margin-left 24px→16px  /about@1440,375 /@1440,375 +4 routes
  body > footer > a.cta::after content "→"→none  /about@1440
  (+N more in results.json)
  truncated: only the first 500 changes kept on /a@1440 (+12)
  unmatched /pricing@1440 -body > main > section.plans:nth-of-type(3)
```

- A finding is `key prop left→right`, then up to three `route@widths` (`+N routes`). One per
  distinct change across the run, most widespread first, accepted shots included; 20 shown.
  `--progress` rows say `computed dom identical, N change(s)` or `dom differs (N)`.
- `dom identical on X of Y`: every walked element's tag, attributes and own text match,
  bundler hashes in `src`/`href`/`srcset`/`poster` and generated class names (`css-1q2w3e`,
  `Button_root__a1b2c`) aside, and the left origin read as the right's. Then a pixel
  difference comes from CSS or script, and findings are exact causes.
- `differs /a (N)`: N elements differ or are one-sided; findings there are hints. A class
  renamed on a wrapper re-keys its whole subtree, so a style change under it shows only as
  `dom differs` and `unmatched`.
- `unmatched`: outermost elements only one side has, `+` left, `-` right.
- Keys are selector paths from `body` (`:scope` with `--selector`), usable with
  `querySelector`. Elements match by key, so an injected node doesn't misalign the rest; an
  inserted same-tag sibling still shifts `:nth-of-type` after it.
- Collapsed to the cause: an inherited property the parent has the same change for is
  dropped, and so is a width inside a parent whose width changed, or a height around a child
  whose height changed (unless set in px). Shown on one side and `display: none` on the other
  is one `display` finding. A pseudo-element one side no longer generates is `content` against
  `none`. An `auto` margin reads as `auto`, not the px it resolved to, which varies with
  layout.
- A finding on a clean route is a change you can't see in this state: a hidden element
  (closed menu), another breakpoint, `:hover`/`:focus` (not snapshotted). Decide it; a
  `before` hook can open the state.
- Fails per shot (reported, pixels stand) past 15s or 50,000 elements. Not walked: SVG
  internals, shadow DOM, iframes, masked and `display: none` subtrees.

## Masks, accepts and thresholds

| Tool | Legitimate for | Never for |
| --- | --- | --- |
| Mask (`--mask <sel>`, config `masks` with `reason`, `--mask-media`, `data-renderdiff-mask="<reason>"` in the page) | Content *proven* to vary per load: a base-vs-base baseline differs there (clocks, star counts, rotating quotes, embeds). | Anything that differs only after your change. |
| `--accept "<reason>"` | A difference you opened that exists before your change (baseline vs production) or is intended, with a reason saying which. | Getting green. |
| `--threshold <0..1>` | A CI gate on the exit code. | Reaching green; the difference is still there. |

- Every mask is coverage surrendered and listed in the report with its reason. `--mask-media`
  gives up every iframe. Video is not masked: it is frozen by default (no `video` plays, each
  shows frame 0, or its poster if it never loads, video.js captions and control bars hidden),
  so its box is still compared. `--no-freeze-video` lets it play: expect `unstable` or
  `did not settle`.
- Masks hide text too, so masked text leaves the text diff.
- A mask covers what its element's children paint outside it (a video.js poster), cut to the
  `overflow` ancestors that clip them, so one mask per player is enough. Boxes are read at
  every shot: a mask that moves between shots shows as `unstable`, not as a stale rect.
- Pages see `window.__RENDERDIFF__ === true` before their first script; anything hidden on it
  must be hidden in both builds.
- Accepted entries go to `renderdiff.accepted.json` next to the config (or cwd), one per band
  or region, scoped by the run's routes and widths. A match ignores `y` and needs the same
  kind, side, box, pixel hash (4 bits a channel) and named elements, so anything else drawn
  there still surfaces. Never accepted: a shot with unstable pixels, `varies`, a width delta,
  or a height delta without bands; `--accept` exits 1 on those. A new change can make an accepted one
  re-read as different (repeated rows aligning differently): look, then accept again.
- **Accept where you check.** The pixel hash isn't portable: entries accepted on macOS mostly
  come back stale on a Linux CI runner. For CI, accept in CI.
- `stale accepted: /a@1440`: an accepted difference wasn't seen (fixed, or the page changed
  under it). `--accept` over that route and width prunes it.
- Analytics, consent and A/B tooling are already blocked on both sides. Something
  that still flickers between runs is a candidate for `blockUrlPatterns` before a mask.

## Rationalizations

| Thought | Reality |
| --- | --- |
| "Worst is 99.1%, no regressions." | You reported a number, not a check. Open the worst route's crops. |
| "99.6%, it's noise." | Check `text`, `line` and the region count first. A missing nav link is 99.6% and one `-` line. |
| "It's probably just fonts / antialiasing." | "Probably" is exactly what the crop resolves. Look. |
| "`dom` says margin, done." | It's a computed value. Confirm the source rule changed on purpose, and still open the crop when the region is large or `dom` names nothing. |
| "The crops looked fine, done." | There are at most three. Check the region count, any `clipped` crop, and the diff PNG for the rest and for any height delta. |
| "`--computed` found nothing, so pixels don't matter." | Pixels decide. A finding list is only complete where `dom identical`. |
| "Masking the header gets this to 100%." | Mask only what a base-vs-base baseline shows varying, with a `reason`. |
| "I'll `--accept` it so the run is green." | Accept only differences you opened that predate your change or are intended. |
| "I'll lower `--threshold` until it passes." | It relaxes the exit code; the difference is still there. |
| "That route errors, I'll drop it." | Shrinking the route list shrinks what you verified. Fix it, or say it's unverified. |
| "One width is enough." | Migrations break at one width and not others. That's why there are five defaults. |
| "A `before` hook that hides that element on the left gets this clean." | That hook is a mask with no `reason`. A hook brings both sides to the same *state*; it never edits one side to match the other. |

## Exit codes

| Code | When |
| --- | --- |
| 0 | No unaccepted shot differs (with `--threshold`: none scores below it) and no route errored. Unstable pixels or a failed asset alone exit 0: read their rows. |
| 1 | An unaccepted shot differs (with `--threshold`: scores below it; `--threshold 0` never fails). Also on an `--accept` run for what can't be accepted. Wins over 3. |
| 2 | Bad arguments or config; an origin not responding; a bad storage state or `renderdiff.accepted.json`; an out dir holding files renderdiff didn't write; `--rerun-failed` that doesn't repeat the last run; `merge` refusing. |
| 3 | A route errored (unmeasured), or the run crashed (e.g. no browser). |

## Iterating

- **`--rerun-failed`** keeps the out dir and reruns only what wasn't clean or accepted
  (differences, unstable shots, failed assets, errors), merging back into results.json. Same
  origins, routes, widths, config (masks, hooks, hidden selectors, CSS, storage state,
  `--computed`) and version as the run it continues, or it exits 2.
- **Hand-picked reruns with a changed config** (a new mask for a few routes): run them into a
  new `--out`, then `renderdiff merge <full-out> <that-out> --out <dir>`.
- **`--cache-right`** replays the right side's recorded traffic (`<out>/.cache/`, kept by the
  wipe) for up to an hour, if the recording covers every shot; otherwise loads live and records.
  The page still renders live, so `dom` and the refusals hold, but a deploy to the reference
  goes unseen: never verdict from a replayed run. `failed right: N request(s) not in the
  recording, loaded live`: part replay, part live; drop the flag rather than trust or accept it.
- **The out dir is wiped** at the start of every run except `--rerun-failed`. Keep evidence
  with `--out renderdiff-before` / `--out renderdiff-after`.
- Lower `--concurrency` (default half the cores, 2–8) when the right side is someone's live site.

## Scoping

- **Moved pages:** `/pricing::/plans` loads `/pricing` left, `/plans` right. Splits on the
  first `::` followed by `/`, so `/q?x=std::vector` and `pricing::plans` are single routes. Named
  `/a::/b` in stdout and `url`; files `{a}~{b}.{width}.*.png`.
- **One component:** `--selector <sel>` (or `--left-selector` + `--right-selector`, or a route
  object's `selector: ".x" | { left, right }`) compares the one element it matches, exactly one
  per side, in its own pixels. A CLI selector applies to every route and replaces the config's.
  Named `/a [.x]`; files `{slug}@{sel}.{width}.*.png`. The whole page still loads; it's shot at
  scroll 0, so fixed or sticky overlays over it are included (`hideSelectors` them); a
  transformed element is shot at its axis-aligned box. `xpath=` and `>>` work; pseudo-elements
  are rejected; iframes can't be reached.
- **`before` hooks** (config only: `before: async (page, { side, route, width }) => …` on a
  route object, or top level for every route without its own) run after load and the HTTP
  check, before settle, masks and the shot. Legitimate: open a menu or tab, dismiss a modal or
  banner *both* sides show, sign in, set a carousel to slide 1 on both. Not: branching on
  `side` to make the sides look alike, hiding or removing an element on one side. `side` is for
  markup that legitimately differs. Say in the verdict that a hook ran (`hook: true`).
  `beforeShot` (same forms) runs after settle, right before masks and the shot: for state the
  settle's scroll pass changes, e.g. a scroll-spy nav. Nothing settles after it, so await it.
- **Signed-in pages:** `npx playwright codegen --save-storage=auth.json <login url>`, then
  `--storage-state auth.json` (or `--left-storage-state`/`--right-storage-state`, or config
  `storageState`, relative to the config file). The file holds live session tokens: never
  commit or paste it, add it to `.gitignore`. The out dir then holds signed-in screenshots and
  text: keep it out of git too.

## Config file

`renderdiff.config.{ts,mts,js,mjs}` in cwd (or `--config`) holds what flags can't. **CLI flag >
config file > default.** A plain `export default {}` needs no import.

```js
export default {
  left: "http://localhost:3001",
  right: "http://localhost:3002",
  routes: ["/", "/about", "/pricing::/plans", { left: "/pricing", selector: "[data-test=plans]" }],
  widths: [1440, 896, 375],
  hideSelectors: [".site-cookie-banner"],
  blockUrlPatterns: ["**://*.my-tracker.example/**"],
  masks: [{ selector: "[data-star-count]", reason: "live star count", urlPath: "/pricing" }],
  maskMedia: false,     // --mask-media
  freezeVideo: true,    // --no-freeze-video sets false
  lottieFrame: 60,      // hold lottie-player on frame 60; unset leaves it playing
  computed: false,      // --computed
};
```

A mask takes exactly one of `selector` or `locate: (page) => Locator`; without `urlPath` it
applies to every route, and on a pair it matches either side's path. `--mask <sel>` adds to the
config's masks. Also: `threshold`, `outDir`, `concurrency`, `extraCss`, `before`,
`beforeShot`, `storageState`. `hideSelectors`: match the element **exactly** (consent scripts stamp classes on
`<html>`; a loose selector blanks the whole document and blank matches blank), and they hide
rather than remove.

## `report`

`renderdiff report <out> [--verdict <file>] [--title <text>]` rewrites `<out>/report.html`
and writes `<out>/evidence.html` from `results.json`, no browser. `report.html` has a
filterable route sidebar coloured by `--threshold` and a summary of only the differing
shots. `evidence.html`: a Parity / Differs / Not verified banner, the `renderdiff:` line,
the verdict file as plain text, coverage, and cards for shots that aren't clean, then
accepted ones, with crops embedded (past 12MB or missing, left out and noted). No external
references. Exits 2 without `results.json` or a readable verdict file.

## `merge`

`renderdiff merge <full-out> <partial-out> --out <dir>`, no browser: the full run's results
with each shot the partial run also took replaced by its (files too), the rest added; each
such shot has `from` (that run's `generatedAt`). Masks, hidden selectors, blocked URLs and
widths are unioned in `meta`; accepted flags stay as each run set them. `evidence.html` says
Not verified. Exits 2 on different origins, an `--out` that is or is inside an input or holds foreign
files, or two shots writing one file. A merged out dir refuses `--rerun-failed`.

## `probe`

`renderdiff probe <url> [--width <n>] [--loads <n>]` loads one URL `--loads` times (default
8, in parallel up to `--concurrency`), each in a fresh context with a cold cache, through the
same capture as a run's left side (config masks, hooks, `--left-storage-state`). One line per
varying element and property, `<key> <prop> <value> ×<loads>, ...`, most frequent first; `x`
and `y` are its position in its parent, `present` means some loads lack it. First 20 shown.
One width (the first default without `--width`), no `--selector`, no `--out`. Exits 0 stable,
1 varies, 2 bad arguments or the origin down, 3 a load errored.

## results.json

For scripts and drilling into one route; the loop doesn't need it. One result per line, so
`grep '"url":"/about"'` pulls a route. Paths are relative to the out dir.

- **Each result:** `url`, `left`, `right`, `selector` (`{ left, right }` or null), `hook`,
  `width`, `status` (`compared`, or `error` with `error`, and `frames` when it did not settle); `score`, `alignedScore`,
  `diffPixels`, `totalPixels`, `unstablePixels`, `varies` and `variesPixels` (absent unless a
  recheck found some; regions with `elements`), `heightDelta`, `widthDelta`; `regions`
  (`x,y,w,h,pixels`, left-page px, `line` `{ y, h, side }`, `accepted` reason); `bands` (`side`,
  `y`, `h`, or null when unaligned); each with `elements` (`selector`, `side`, each side's box,
  `changed` `{ prop: [left, right] }`, `text`, `rightSelector`, `reparented`; absent when not
  looked at, `[]` when nothing was named); `text` `{ added, removed }`; `failed` `{ left, right }`;
  `masked` (reasons of `data-renderdiff-mask` elements, absent when none); `images`; `crops`
  (`kind`, each side's box with `h` 0 at an insertion point, `layout`, `scale`, `clipped`);
  `accepted`; `rightReplayedFrom`; with `--computed`, `computed` (`dom`, 0 = identical;
  `changes` `{ key, prop, values }`, first 500; `truncated`; `unmatched`) or null with
  `computedError`.
- **`summary`:** `compared`, `errors`, `mean` and `worst` (accepted shots aside),
  `belowThreshold`, `differing` (unaccepted shots with any differing pixel; without
  `--threshold`, any exits 1), `accepted`, `stale`, `findings` (each `dom` entry, text line
  or element-less band on 2+ routes once: `finding`, `selector?`, `at: [{ url, widths }]`),
  and with `--computed` `computed` (each change once with `at: [{ url, widths }]`).
- **`meta`:** origins, widths, threshold, `clock`, block patterns, hidden selectors, mask
  reasons, `browser` (`chromium`, or `chrome` after a fallback), storage state file names,
  `config` hash, `rightReplayedFrom`, `freezeVideo`, `lottieFrame` (only when set), `platform`, `rerun` (`{ rerun, reused }` or
  null).

## Gotchas

- **Browser:** if the bundled Chromium won't launch, the system Chrome is used on both sides
  and the run says so; otherwise it prints the `npx playwright install chromium` hint.
- **Pinned on both sides:** clock (one instant per run, floored to the minute), seeded
  `Math.random`, UTC, en-US, light scheme, reduced motion; animations and transitions stilled,
  animated images and SVG animations held on their first frame.
  A clock showing seconds can still tick between sides.
- **Pixel sensitivity:** pixelmatch threshold 0.05, anti-aliasing ignored. A half-pixel shift
  (`translate(-50%)` landing on `.5`) shows as a thin region.
