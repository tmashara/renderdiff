# Reading renderdiff's output

Left is your change, right is the reference. `+` means only in or more in your change,
`-` only in or more in the reference.

## The summary

On a terminal renderdiff prints a line per shot as it lands, then the worst scores and the
paths to `report.html` and `results.json`. Piped (to a file, CI or a coding agent) it
prints one summary at the end instead, listing only what differs:

```
Routes: 3
clean: /
/about  clean @1152,896,704,375
  @1440  97.41%  h-24  band -24@y196  aligned 100.00%  text -"Pricing"
    dom -nav > a[href="/pricing"] "Pricing"
    crops about.1440.c1.png
/pricing
  @1440,1152,896,704,375  99.12%–99.87%  1 reg
    dom @1440 div.plans > a.cta margin-left 24px→16px
    crops pricing.1440.c1.png pricing.1152.c1.png pricing.896.c1.png pricing.704.c1.png pricing.375.c1.png
renderdiff: 2 of 3 routes differ (6 of 15 shots), 0 errors, worst 97.41% /about@1440 — /Users/you/site/renderdiff-out/results.json
```

A row covers the widths that agree on height and width delta, bands (side and height), aligned
score and text; the score and region count are then shown as ranges, and `unstable` as the
largest. Under a row, `failed` lists stylesheets and font faces a side failed to load (fix
those first), `fonts` the web font faces only one side loaded, `dom` names up to three elements
behind the changes, two properties each, worst first, then `(+N more)` (`@w` when the row covers several widths: the first
one's), and `crops` lists that row's crop files. Errors print in full, grouped across the
widths that share a message. Clean means not one pixel differs, none went unmeasured as
unstable and no stylesheet or font failed; a route with unstable pixels or a failed asset gets
its own row. A route whose every shot is clean or has no differing pixel and at most 100
unstable ones (anti-aliased corners), with no failed asset or `varies`, goes on the
`unstable ≤100px:` line instead: unchanged, but not clean. A shot whose only difference varied
between two loads of the right side is clean, but listed under `varies`. `--progress` gets the
per-shot output when piped, `--no-progress` the summary on a terminal.

## Tokens

| Token | Meaning |
| --- | --- |
| `97.41%` | Share of measured pixels that match. A range (`99.12%–99.87%`) when one row covers several widths. A triage signal, not a verdict. |
| `@1440,1152` | The widths a row covers. They agree on height and width delta, bands, aligned score and text; score and region count are ranges. |
| `h-24` / `w+8` | Height / width delta, left − right. The smaller image is padded with magenta, and the padding counts against the score on purpose. |
| `band -24@y196` | 24 rows only the reference has, at y=196 (`+`: only your change has them). `@y~196`: the row's widths put it at different y; the first width's is shown. |
| `aligned 100.00%` | The score with the bands cut out. 100% means the band is the whole difference. |
| `unaligned` | Heights differ but too few rows match to find bands. Use the height delta and regions. |
| `line -1px@y812` | A 1–2px line across the page only the right draws (`+`: only the left; no sign: both, differently). A lost border or divider; not counted in `reg`. |
| `3 reg` | Regions: connected patches of differing pixels. A missing link barely moves the score, but it is still a region. |
| `unstable 1,204px within 928×160 at (256,168)` | Pixels that kept changing between shots of the same load (a ticker, a carousel), and the box holding them (`@w` when the row covers several widths: the one with the most). Excluded from the score, so the route is never clean. One box spans every unstable patch on the page, so scattered ones give a large box. |
| `varies /a @1440  148,480px painted out  div.drift` | After the routes: the right side differed between two fresh loads there (a counter, a rotating banner). Those elements' whole boxes are painted out on both sides like a mask and left out of the score, so the count can exceed the pixels that changed; the shot can't be accepted. `(not located)`: no element was named, its region was painted. `layout moved`: a named element sits somewhere else on the two loads with the same text, pushed by the layout rather than changed itself, so no mask is suggested. |
| `  --mask 'div.drift'` | The flag that masks the `varies` elements, for the next run. Only selectors ending in an id, class or attribute are suggested: a bare `p:nth-of-type(14)` would hide real changes too. None for a route marked `layout moved`. |
| `  masks: [{ selector: … }]` | The same as config `masks` entries, with `reason: "varies per load"`. |
| `failed left: font Inter 700` | A stylesheet or font face that side failed to load (blocked URLs aside). Fix that first: a fallback font changes every line of text. |
| `fonts -"Inter 600" +"Roboto"` | `@font-face` or `FontFace` faces only one side requested (`-`: only the reference, `+`: only your change), as family, weight, style and stretch, `normal` left out. One still loading when read counts as requested. Web fonts only: a system font a side fell back to isn't listed. Usually the same on every route, so see `findings`. |
| `text -"Pricing"` | A line of visible text only the reference has (`+`: only your change). Up to three, then `(+N more)`. |
| `dom sel prop a→b` | Element on both sides whose computed `prop` differs, left value first. |
| `dom +sel` / `-sel` | Element only on the left / only on the right. `+sel::before` / `-sel::after`: a pseudo-element only that side generates. |
| `dom sel x+8` | It moved or only resized (a width or height change alone is usually a consequence); a neighbour or parent that changed is listed after it. None listed: its own size rule or something higher up is the cause, so use `--computed`. |
| `dom sel` | On both sides and unchanged in style or position, so its own pixels changed (an image or canvas). |
| `(re-parented)` | After a `dom` entry: paired across a structure change, so its properties may not be the cause. |
| `1 accepted` | That many of the shot's changes are accepted; the rest are new. |
| `findings: N repeated on 2+ routes` | After the routes: the same `dom` entry, text line, `fonts` face or element-less band delta (`band -24px`) on two or more routes, once per line with `×N routes` and where (`/a@1440,375`, then `+N routes`), most widespread first, accepted ones aside. Text lines seen on exactly the same routes and widths share one line, `text -"Users" -"Billing" -"Docs" (+9 more)` (a nav folded into a menu button), and N counts lines as printed. Top 20; `summary.findings` in results.json has every finding, one per text line. One cause behind many rows: fix it once. A selector names an element per page, so the same path may be a different element on another route: check one crop. |
| `computed: N findings` | With `--computed`: each `key prop left→right` once, with the routes and widths it was seen at; `dom identical`: the markup matches apart from asset hashes and generated class names, so look at CSS or script. See [below](#computed-styles---computed). |
| `rules: N changed groups` | With `--computed`: style rules only one side has, by stylesheet and `@media`, and whether any shot had an element they could style. `matched nothing`: the run proved nothing about those rules. See [below](#rule-coverage). |
| `prefixes: N prefixed declarations only one side has` | With `--computed`: `-webkit-`, `-moz-`, `-ms-` and `-o-` declarations in one side's CSS source only, which Chrome's parsed rules can't show. See [below](#vendor-prefixes). |
| `aria: identical on N of M route(s)` | With `--aria`: routes whose accessibility tree matches at every width, then each differing route's lines, `+` left only, `-` right only. See [below](#aria-snapshots---aria). |
| `crops …` | Up to 3 PNGs per comparison, worst first, relative to `results.json`. Left is on top or on the left, and the change is boxed in red. |
| `ERROR …` | Unmeasured, which is neither a pass nor a fail. Exits 3. |
| `renderdiff: …` | The verdict line: routes and shots that differ (accepted ones aside), errors, `, U unstable (max Npx)` when any shot had unstable pixels, the worst score, and with `--threshold` how many scored below it. |
| `unstable ≤100px: /a /b` | Routes whose every shot is clean or has no differing pixel and at most 100 unstable ones, no failed asset and no `varies`. They get no row. Not clean: report them under Not verified. |
| `accepted:` / `stale accepted:` | Routes whose every difference was accepted, and accepted entries the run no longer saw. See [accepted.md](accepted.md). |
| `rerun:` | With `--rerun-failed`: how many shots were rerun and how many reused. |
| `right:` | With `--cache-right`: whether the right side was replayed, and from when, or loaded live and recorded. |

## Scores

The score is the share of measured pixels that match, per route per width. In the report
it's green above 99.5%, amber to 97%, red below. It is a triage signal, not a verdict: open
the crops and look.

**Magenta means padding.** When one side is taller or wider, the shorter image is padded
with magenta, and that padding counts against the score on purpose: a page 400px shorter
than the one it's compared against has not reached parity. The height and width deltas name
the cause.

**Errors are not failures.** A route that threw produced no measurement, so it is neither a
pass nor a fail. It's listed separately in the report, and it still exits non-zero (`3`),
because an unmeasured route is not a verified one.

## The same thing in each output

| | `--progress` | Summary | `results.json` |
| --- | --- | --- | --- |
| Height delta | `(height -24px)` | `h-24` | `heightDelta: -24` |
| Width delta | (not shown) | `w+8` | `widthDelta: 8` |
| Band | `band -24px at y=196 (right)` | `band -24@y196` | `bands: [{ side: "right", y: 196, h: 24 }]` |
| Can't align | `rows too different to align` | `unaligned` | `bands: null` |
| Text | `text: 0 added, 1 removed` | `text -"Pricing"` | `text: { added: [], removed: ["Pricing"] }` |
| Regions | `3 regions, largest 64×32 at (256,192)` | `3 reg` | `regions: [...]` |
| Line | `line -1px@y812` | `line -1px@y812` | `regions[i].line: { y: 812, h: 1, side: "right" }` |
| Unstable | `(unstable 1,204px)`, then `unstable within 928×160 at (256,168)` | `unstable 1,204px within 928×160 at (256,168)` | `unstablePixels: 1204, unstableBox: { x: 256, y: 168, w: 928, h: 160 }` |
| Failed assets | `failed left: font Inter 700` | `failed left: font Inter 700` | `failed: { left: ["font Inter 700"], right: [] }` |
| Font faces | `fonts -"Inter 600"` | `fonts -"Inter 600"` | `fonts: { added: [], removed: ["Inter 600"] }` |

Under each score, `--progress` output and the report card say where to look:

```
  [3/8] 97.14%  /pricing @1440  (height -24px)
        band -24px at y=196 (right)
        aligned 100.00%
        text: 0 added, 1 removed
```

Regions say *where* pixels differ, `dom` says *which element and property* caused it, and
crops are *pictures* of the worst three changes. Read in that order: text, `dom`, then crops
for anything `dom` doesn't explain.

## Regions

Connected patches of differing pixels, on a 16px grid, largest first. On a long page a
missing link barely moves the score; it is still a region. Only the area both sides cover is
searched: padding is reported by the height delta and the bands. With bands, regions come
from the realigned rows, so content a band only pushed down isn't one (above, the band is
the whole difference, so there are none). The card lists the top five with their pixel
counts; up to three crops cover the worst changes (see [Crops](#crops)).

A region whose differing pixels sit in one or two rows spanning at least half the page is a
line: a divider, border or focus ring that one side lost. `line -1px@y812` means only the
right (the reference) draws it, `+` only the left, and no sign that both do, differently.
A line barely moves the score, so `99.97%  line -1px@y812` is worth opening.

## Bands

Rows only one side has, found by aligning the two images row by row. `-24px at y=196
(right)` means the right side has 24 rows there that the left lacks, signed like the height
delta. When rows of identical content repeat, the band's `y` can slide along them, so treat
it as approximate. `aligned` is the score after cutting the bands out: how the page would
score if the inserted or removed rows weren't there. `aligned 100.00%` means the band is the
entire difference; it only shows when there are bands. Pages of different heights that share
too few identical rows can't be aligned (`unaligned`). A horizontal shift is never a band.
Alignment works on exact row matches, so it gives up when the edits total more than 2,000
rows (a single inserted or removed block aligns at any height), or when sub-threshold shade
noise touches every row.

## Elements (`dom`)

What is under the first 20 bands and regions, up to three each, read from the live pages
right after the shot. Each is a CSS selector unique on its side, so `--selector` takes it.

- `-sel "text"` exists only on the right, `+sel` only on the left.
- `sel margin-left 24px→16px` is on both, with the computed properties that differ, left
  first. A computed value is a symptom: find the rule that set it.
- `sel x+8` or `sel width 230px→254px` moved or only resized: a width or height change alone
  is usually a consequence. A neighbour or parent that changed is listed after it; for an
  element that resized, a parent whose only change is its width isn't. None listed, its own
  size rule or something higher up is the cause, so use `--computed`.
- `-sel::before` / `+sel::before` is a pseudo-element only the right / left generates, and
  `sel::after height 1px→2px` one on both whose `content`, size, background, top or bottom
  border, or `box-shadow` differ. It carries `(re-parented)` when its element does.
- `(re-parented)` after an entry means its ancestors' tags differ between the sides, so the
  pairing crossed a structure change: its properties may not be the cause.
- A bare `sel` is on both sides with nothing compared changed or moved, so its own pixels did
  (an image's source, a canvas).

An element without text is only paired when its box is the same size on both sides;
`rightSelector` is set when the right side was found by its text under another selector. A
band names what one side added, else what grew there (`h1 padding-top 60px→0px`), never what
it only pushed down, so it can name nothing; what
fixed chrome covers isn't named. Probing gives up after 5s, leaving the elements out. Shadow
DOM and iframes aren't searched.

## Computed styles (`--computed`)

With `--computed`, after the shot renderdiff reads the computed style of every rendered
element on both sides, and of `::before` and `::after` wherever they generate content.
Masked and `hideSelectors` elements, their subtrees, and `script`/`style`-like tags
are skipped; any other `display: none` element is read, its subtree isn't. So a hidden
banner one side lacks doesn't count against `dom identical`; if it comes wrapped on some
loads, hide the wrapper too. A hidden element still counts toward its siblings'
`:nth-of-type`, so one that moves among siblings sharing its tag and class still re-keys
them. Script-driven animations are finished first.

It reads a fixed list of properties, not every one, so `0 findings` means none of these
changed:

- Layout: `display`, `position`, `float`, `flex-direction`, `flex-wrap`,
  `justify-content`, `align-items`, `gap`, `grid-template-columns`, `z-index`.
- Box: `margin-*`, `padding-*`, `border-*-width`, `border-top-color`,
  `border-top-left-radius`, `outline`, `width`, `height`.
- Text: `font-family`, `font-size`, `font-weight`, `line-height`, `letter-spacing`,
  `text-align`, `text-transform`, `text-decoration-line`, `white-space`, `word-break`,
  `overflow-wrap`, `hyphens`, `text-wrap-style`, `color`.
- Paint: `background-color`, `background-image`, `box-shadow`, `opacity`, `transform`,
  `visibility`, `clip`, `clip-path`, `mask`, `content`.

A `linear-gradient` (or `repeating-`) in `background-image` compares by what it paints: a
side keyword and its angle (`to right`, `90deg`), an angle past 180° and the reversed stops,
a corner and its opposite with reversed stops, and default `0%`/`100%` positions are equal.
Stops in px, `calc()`, colour hints and `increasing`, `decreasing` or `longer` hue still
compare as written. A `clip` or `clip-path` change on an element fully clipped on both sides
is no finding; its other properties still are. Fully clipped is a `%` `clip-path: inset()`
with top + bottom ≥ 100% or left + right ≥ 100%, or a zero-area `clip` rect on an
absolutely or fixed positioned element.

The summary gets one block, after the rows:

```
computed: 2 findings; dom identical on 2 of 3 route(s), differs /pricing (1), so findings there are hints
  body > div.page > nav.chips > a[href="#blog"] margin-left 24px→16px  /about@1440,375 /@1440,375
  body > footer > a.cta::after content "→"→none  /about@1440
  unmatched /pricing@1440 -body > main > section.plans:nth-of-type(3)
```

- Each finding is `key property left→right`, left first like `dom`, followed by every
  route and width it was seen at. The same change on 300 pages is one line, most widespread
  first, accepted shots included. The summary shows 20; `summary.computed` in results.json
  has them all. Each result's `computed.changes` keeps its first 500, and `truncated`
  counts the rest (the summary says where).
- The key is a selector path from `body`, or from `:scope` with `--selector`, where only
  the selected element's subtree is walked. Each step is the id, or the tag with a naming
  attribute and up to two classes that don't look generated (sorted). `:nth-of-type` is
  added only where siblings would otherwise share the step, a duplicated id included. The
  key works with `querySelector`.
  - Elements are matched by key, not by position, so a cookie banner injected on one side
    doesn't misalign everything after it.
  - An inserted sibling of the same tag and classes still shifts the `:nth-of-type` of the
    ones after it.
  - A class added to, removed from or renamed on a wrapper re-keys its whole subtree. A
    style change under it then shows only as `dom differs` and `unmatched`, not as a
    finding.
- One change high in the tree is one finding. An inherited property (`font-*`,
  `line-height`, `letter-spacing`, `text-*`, `white-space`, `word-break`, `overflow-wrap`,
  `hyphens`, `color`, `visibility`) is
  dropped where the parent has the same change, so a `body` font change is one line, not
  one per element. A `width` is dropped inside a parent whose width changed, and a
  `height` around a child whose height changed, so the box that caused it is what's left.
  A box whose own width or height is set in px on either side is kept (so a child widened
  inside an `inline-block` is, at the cost of the odd fixed-size child a parent squeezed),
  and a `height: 100%` child is dropped instead of the px-height parent it follows.
- An element shown on one side and `display: none` on the other is one `display` finding;
  its subtree and its `::before`/`::after` count neither as findings, unmatched nor against
  `dom identical`.
- An `auto` margin reads as `auto`, not the px Chrome resolved it to, since that number
  changes with the layout (a grid item's reads `0px`). Centring swapped for a fixed margin
  is `margin-left auto→60px`.
- A `::before`/`::after` that only one side generates shows as `content` against `none`.
  That is how a removed rule that drew an icon shows up.
- `dom identical` means that on every width, each walked element's tag, attributes and own
  text are the same on both sides.
  - Bundler hashes in `src`/`href`/`srcset` are ignored (`hero.3f9a8c1d.png`, `?v=…`), and
    so are generated class names (`css-1q2w3e`, `Button_root__a1b2c`).
  - Absolute URLs on the left origin are read as the right origin's (keys, attributes,
    `url()` values), so two ports or a local build against production don't differ by
    origin alone.
  - A pixel difference on such a route comes from CSS or script, not from walked markup.
    SVG internals, shadow DOM, iframes and `display: none` subtrees aren't walked.
  - Hash-shaped tokens only: 8 or more letters and digits that alternate, between
    separators in a file name. `team_photo_2024.jpg` and `/p/abcdef123456` count as changes.
- `dom differs (N)` counts the elements that differ or that one side lacks. Treat that
  route's findings as hints. A re-keyed element counts once on each side, so one renamed
  wrapper with three descendants is `dom differs (8)`.
- `unmatched` lists the outermost elements only one side has: `+` left, `-` right. The
  summary shows five routes, five each.
- The HTML report shows the same block, collapsed, and puts `dom identical` /
  `dom differs (N)` on each card. A snapshot that fails, takes over 15s or meets more than
  50,000 elements is reported as failed, with why (`computed: null`, `computedError`), and
  the pixel result stands. Pixels still decide the score and the exit code.

Links and controls (`a[href]`, `button`, `input`, `select`, `textarea`, `summary`,
`[tabindex]`) are also read in `:hover` and `:focus-visible`, with their subtrees:

- The key gets the state: `body > nav > a[href="#x"]:hover > span.icon`. `:focus-visible`
  is keyboard focus, forced as `:focus` plus `:focus-visible`.
- Only what differs from resting is a finding: a resting change isn't repeated per state.
- The first 500 per page are read; `states:` in the summary says where there were more
  (`computed.unchecked` in results.json). One with more than 50 descendants is skipped.
- All of them are forced at once, so a rule relating two of them
  (`ul:has(a:hover) a:not(:hover)`) isn't seen, nor `:hover` on an ancestor (`li:hover`
  menus), `:active`, `:focus-within` or script hover handlers.

### Rule coverage

A clean run doesn't show that a changed rule ever applied. So `--computed` also reads every
style rule in each side's stylesheets and lists the groups of rules only one side has:

```
rules: 3 changed groups, 1 never matched, 2 matched on some shots
  +chat.css (1 rule)  matched nothing: /help@1440,375
  +docs.css @media (min-width: 60em) (5 rules)  matched /a@960,1440 /b@960; nothing /a@959,375
  -docs.css @media (min-width: 60em) (5 rules)  matched /a@960,1440 /b@960; nothing /a@959,375
```

- A rule is its enclosing at-rules, selector (nesting resolved) and declarations, as Chrome
  serializes them, compared by meaning. So notation Chrome normalizes (`rgb(0 0 0)` and
  `rgb(0, 0, 0)`, hex case, `0` and `0px`, merged shorthands) is no change, and neither is
  declaration order or `@media (min-width: 60em)` against `(width >= 60em)`, or `max-width:`
  against `<=`. A shorthand and longhand that swap order are a change, since that changes
  what the rule does. A rule with a logical (`margin-inline-start`) or `-webkit-` property
  keeps its order, since `-webkit-border-image` and `border-image` set the same thing and the
  later wins, so reordering one is a change even where it does nothing. The reversed
  `(60em <= width)` and the two-sided `(60em <= width <= 80em)` aren't read as `min-width:`.
  Asset hashes in `url()` and the left origin are read as on the other side. A rule moved to
  another file is no change. Only style rules count: not `@font-face`, `@keyframes` or
  `@property`.
- `+` rules only the left (your change) has, `-` only the right. A group is a stylesheet's file
  name (asset hash as `#`; a `<style>` is `inline#` and a hash of its text, so one block
  inlined into every page is one group) and its enclosing at-rules.
- A group matches on a shot when, on its side, every enclosing `@media` and `@supports` holds
  and a selector matches an element. Listed are groups that matched nothing anywhere, then
  those that matched on some shots only (the breakpoint above, at 960 and not 959). Groups
  matching on every shot are only counted (`, all matched`). 20 lines shown.
  `rules: no style rule differs between the sides`: once parsed, both sides' style rules are
  the same.
- Matching leans toward `matched`: `:hover`, `:focus`, `:active`, `:visited` and
  pseudo-elements match any element (so `::selection {}` matches), and `@container` is taken
  as holding. Other states lean the other way: `:checked`, `:target`, `[open]`, a class
  script adds, and a `<link media=print>` sheet count as unmatched unless the shot is in that
  state. A group's match can be any one of its rules: a never-matched rule among matched ones
  isn't singled out.
- Stylesheets a side can't read (cross-origin, such as Google Fonts) are left out of both,
  listed once in `meta.unreadableSheets`. One that failed to load shows as `failed`; its
  rules then show as one side's. renderdiff's own CSS (hidden selectors, stilled animations,
  `extraCss`) isn't read.

### Vendor prefixes

Chrome parses `-webkit-user-select: none` and `user-select: none` into the same rule, so a lint
autofix that drops a prefix Safari still needs is no pixel change and no rule change. So
`--computed` also reads each side's CSS as written and counts its prefixed properties:

```
prefixes: 3 prefixed declarations only one side has
  only left has: -webkit-background-clip: text; -webkit-text-size-adjust: 100%; -webkit-user-select: none  /a@1440,375
```

- The source is every stylesheet the page loaded, as served (cross-origin and `@import`ed ones
  too), and the text of every `<style>`, open shadow roots included. Frames aren't read.
- What counts is how many declarations of each prefixed property a side has; which selector,
  rule or file holds them, and their values, don't. So a dropped prefix is one fewer
  `-webkit-user-select` on that side, while minifying (`0.3s` → `.3s`), reordering, moving a
  declaration between files or a new asset hash is no change. The value is shown as context:
  that side's declarations of the property, ones the other side lacks as written first.
- Prefixed selectors (`::-webkit-scrollbar`), media features and values (`-webkit-box`) aren't
  read.
- Up to 10 declarations per side shown; results.json has them all. `prefixes: no prefixed
  declaration differs between the sides`: the sources hold the same ones.
- Informational, like `rules:`: it never changes the exit code.
- CSS with no source text isn't seen: rules a script adds with `insertRule`, constructed
  (adopted) stylesheets, and `style` attributes.
- A third-party sheet that changes between loads (an ad or chat widget) shows as prefixes
  either side has; block it with `blockUrlPatterns` in the config.

## ARIA snapshots (`--aria`)

With `--aria`, after the shot (and `--computed`) renderdiff takes Playwright's ARIA snapshot
of each side, the accessibility tree a screen reader gets, of `body` or the `--selector`
element, and diffs it line by line:

```
aria: identical on 2 of 3 route(s), differs /pricing
  /pricing@1440,375
    +- text: Buy now
    -- button "Buy now"
```

- `+` lines only the left (your change) has, `-` only the right. Above, a `div` styled like
  the button it replaced: the same pixels, and the button role lost.
- The same diff at several widths is one group; a mobile-only nav change gets its own.
  Ten lines per group, 20 groups; each result keeps up to 200 lines per side, and
  `truncated` counts the rest.
- Masked elements are left out (marked `aria-hidden` once the shot is taken), and so are
  bundler hashes in `/url:` values; the left origin reads as the right's, as with
  `--computed`.
- Lines keep their indentation, so a landmark added or removed around content (`main`
  swapped for a `div`) re-indents, and lists, every line under it.
- Iframes aren't descended into. A snapshot that fails or takes over 15s is reported as
  failed, with why (`aria: null`, `ariaError`), and the pixel result stands. Pixels still
  decide the score and the exit code.

## Text

A line diff of each side's visible text (`document.body.innerText`, or the element's with a
selector). `+` / `text.added`: lines only your change (left) has. `-` / `text.removed`:
lines only the reference (right) has. The card lists the first 20. Masked elements are left
out, and so are the ones a `varies` recheck painted out when it located them. Text that changes within one
load (a ticker) shows up here whenever the two sides differed at capture time, even when its
pixels were painted out as unstable.

## Unstable pixels

Pixels that changed between two shots of the *same* page load, so they're noise from that
origin (a ticker, a carousel). They're painted magenta on both sides and excluded from the
score, and a route with any is never on the `clean:` line. `unstableBox` in results.json (and
the row and `--progress`) gives the box holding them; masks are magenta too, so don't search
the PNG for it. A route with at most 100 on any shot and nothing else goes on the
`unstable ≤100px:` line rather than a row. More than 25% unstable is an
error, `page did not settle`, after one retry, with the two frames saved as
`{slug}.{width}.{side}.unsettled-a.png`/`-b.png`.

## Crops

`{slug}.{width}.c{n}.png`: up to three per comparison, worst first: rows or elements only one
side has (or whose text changed), then property changes, then shifts. A band with no element
named counts as one-sided, and a region with none (past the first 20, or nothing found) as a
property change, ahead of regions that only shifted. Ties keep bands tallest first, then
regions largest first. A change whose elements an earlier crop already names goes after the
others, so it gives up its crop only to one that names something new: two changes inside one
`svg` still get two crops. Each shows left and right at native scale, padded by 48px and at least 320px wide, with a 1px red box around the change; on the side that lacks a
band's rows, a 2px red seam is inserted where they would be, hiding nothing. Left is always on
top (`stacked`, for wide changes) or on the left (`side`, for tall ones). A crop stays within
1,568px on its long edge and 1,568 image tokens (⌈w/28⌉·⌈h/28⌉) and is never scaled below
0.75×; a change too big for that keeps its top rows (or left columns) and is marked
`clipped`. Height padding is never cropped.

## report.html

Written on every run, for browsing it; it loads the PNGs beside it. A sidebar lists every
route, filterable by substring, with a link per width to that shot's card
(`#{slug}.{width}`; an error links to the errors list). A width is green when the shot is
identical or accepted, amber when it differs but doesn't fail (at or above `--threshold`),
red when it fails or errored; a route takes its worst width's colour. Without a threshold
any difference fails, so there is no amber. The summary on top counts routes, shots,
differing shots, errors, accepted and stale accepted; gives the mean and the worst score,
linked to its card; and lists only the differing shots, by route. Findings repeated on two
or more routes, and with `--computed` the style findings, sit collapsed under it. Then a
card per shot, lowest score first, showing left, right and diff side by side; the sidebar's
**Slider view** toggle swaps those for both shots stacked, tops aligned, with a divider you
drag anywhere on the shot to reveal left on one side and right on the other.

## evidence.html

`renderdiff report <out-dir> [--verdict verdict.md] [--title "..."]` reads `results.json`,
rewrites `report.html` from it, and writes `evidence.html` beside it: one file with no
outside references, so it can be attached to a ticket or published on its own. It opens with
a banner: **Parity** (every shot clean or accepted, no errors), **Differs** (a shot that
would exit 1), or **Not verified** (errors, unstable pixels, failed assets, diffs under
`--threshold`, a `--rerun-failed` run that reused shots, or a merged run). Then the `renderdiff:` line,
the verdict file as plain text, coverage (clean and accepted routes, errors, stale accepts),
and a card per shot that isn't clean, then one per accepted shot, with crops embedded as
WebP. Crops past 12MB, or missing from the out dir, are left out and the banner says so.
Build it after a fresh full run.

## markdown

`renderdiff report <out-dir> --markdown <file>` also writes a Markdown file for documenting an
intended change: a `## <route>` section per route with the before (right) and after (left)
URLs, and a `| Width | Before | After |` table linking each width's full-page shots, with
`(h±Npx)` when the heights differ and the error in place of an errored shot. Links are
relative to the Markdown file, or `<url>/<shot>` with `--base-url <url>`: upload the out dir
anywhere, then pass its URL so the images render in a PR description. `evidence.html` is
self-contained and can go anywhere on its own.

Never upload `<out>/.cache/`: it holds `--cache-right`'s recorded traffic, cookies and auth
headers included. Upload a [pack](#pack) of the out dir instead, which leaves it out and is
smaller. Cloudflare Pages gives `report.html` a per-PR URL:

```bash
npx wrangler pages project create <p> --production-branch main   # once
renderdiff pack renderdiff-out --out renderdiff-site
npx wrangler pages deploy renderdiff-site --project-name <p> --branch pr-123
renderdiff report renderdiff-site --markdown pr.md --base-url https://pr-123.<p>.pages.dev
```

In CI, wrangler needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Keep branch names
simple like `pr-123`: the alias is lowercased, sanitized and truncated. Cloudflare Access can
keep `report.html` private, but then the images won't render in the PR: GitHub fetches
images through its anonymous camo proxy. For private inline images, use a reports repo:

```bash
git clone --depth 1 https://github.com/<owner>/<repo> reports
renderdiff pack renderdiff-out --out reports/pr-123
git -C reports add . && git -C reports commit -m pr-123 && git -C reports push
renderdiff report reports/pr-123 --markdown pr.md \
  --base-url https://github.com/<owner>/<repo>/raw/main/pr-123
```

Those links render for viewers signed in with read access to the reports repo. Don't copy
`raw.githubusercontent.com/...?token=` URLs instead: the token expires. Use a separate repo,
not a branch of the main one: every clone of the main repo would download the screenshots, and
its history keeps them after the branch is deleted.

## pack

`renderdiff pack <out-dir> --out <dir>` writes a copy to publish: `report.html`,
`results.json`, `evidence.html` and only the images `results.json` names, never `.cache/`.
No browser. `evidence.html` is the out dir's own, verdict included, unless it is older than
`results.json` (a later `--rerun-failed`): then a new one is written without the verdict, and
pack says so. Each image is re-encoded as lossless WebP, so every pixel is kept; one with a
side over 16,383px, WebP's limit, stays PNG. A shot whose two sides are byte-identical keeps
one image that both `left` and `right` name, and a shot with no differing pixel keeps no diff
image (its `images` has no `diff`; its card says so). On the test fixtures, WebP alone was
27% of the PNG size (10.9 MB to 3.0 MB over 195 images); with the shared and dropped images,
the run's 27.4 MB of images packed to 8.7 MB, 5.8 MB of it shots too tall for WebP.
`meta.packed` says when it was packed. Exits 2 when
`--out` is or is inside the out dir or holds files renderdiff didn't write, or a referenced
image is missing, before `--out` is touched. A packed dir is for publishing: `merge` and
`--rerun-failed` refuse it; `renderdiff report` works on it.

## merge

`renderdiff merge <full-out> <partial-out> --out <dir>` writes a new out dir: the full run's
results, each shot the partial run also took replaced by the partial run's (files included),
and the partial run's other shots added after them. No browser. Each shot taken from the
partial run gets `from`, that run's `generatedAt`. `meta` is the full run's, with `widths`,
`masks`, `hideSelectors` and `blockUrlPatterns` the union of both, and `rightReplayedFrom`
recomputed; the summary is recomputed against the full run's threshold. Each shot keeps the
`accepted` flag its own run gave it: `renderdiff.accepted.json` is not reread. The shots
were taken at different times, so `evidence.html` says Not verified; chain
`renderdiff report <dir> --verdict …` for one. Exits 2 when the two runs compare different
origins, `--out` is or is inside an input or holds files renderdiff didn't write, a referenced file is missing, or two shots would
write the same file (run both into one `--out` instead). A merged out dir can't be continued
with `--rerun-failed`: rerun into a new `--out` and merge again.

## results.json

Written on every run, errors included, one result per line (so `grep '"url":"/about"'`
pulls a route; the lines sit inside one JSON document and end in commas, so parse the whole
file, not each line), scores rounded down to four decimals (so a shot that differs never reads as
`1`). Paths are relative to the out dir; results are in route-then-width order. Its types
(`Results` and friends) are exported from the package.

```jsonc
{
  "meta": {
    "tool": "renderdiff", "version": "0.17.1", "generatedAt": "…",
    "left": "http://localhost:3000", "right": "https://example.com",
    "widths": [1440, 375], "threshold": null,
    "clock": "…",                // the instant both sides' clocks start at
    "blockUrlPatterns": ["…"], "hideSelectors": ["…"],
    "masks": [{ "urlPath": "/pricing", "reason": "live star count" }],   // no urlPath: every route
    "browser": { "name": "chromium", "version": "…" },   // "chrome" when it fell back; "webkit" with --browser webkit
    "storageState": { "left": "auth.json", "right": null },   // file names only
    "config": "…",              // hash of what decides a shot; --rerun-failed needs it unchanged
    "rightReplayedFrom": null,  // --cache-right: when the replayed recording was made
    "freezeVideo": true, "platform": "darwin",   // process.platform: pixels and accepts are OS-specific
    "rerun": null,              // --rerun-failed: { "rerun": 3, "reused": 12 }
    "unreadableSheets": { "left": [], "right": [] },  // --computed: stylesheets left out of rule coverage
    "packed": "…"               // renderdiff pack: when this copy was packed; absent otherwise
  },
  "results": [
    {
      "url": "/about", "left": "/about", "right": "/about",   // a pair: "/a::/b", "/a", "/b"
      "from": "…",               // renderdiff merge: generatedAt of the run this shot came from; absent otherwise
      "selector": null, "hook": false,                         // hook: a before or beforeShot hook ran
      "width": 1440, "status": "compared",
      "score": 0.9714,           // share of measured pixels that match
      "alignedScore": 1,         // score over the aligned rows; null unless there are bands
      "diffPixels": 33120, "totalPixels": 1158000, "unstablePixels": 0,
      "unstableBox": { "x": 256, "y": 168, "w": 928, "h": 160 },   // absent when unstablePixels is 0, and in older files
      "varies": [], "variesPixels": 0,   // absent unless a second right load differed: its regions, with elements, and the px painted out
      "heightDelta": -24, "widthDelta": 0,          // left − right
      "regions": [],             // left-page px; with bands, from the realigned rows
      "bands": [{ "side": "right", "y": 196, "h": 24,      // null: too different to align
        "elements": [{                                     // regions have them too; absent: not looked at
          "selector": "nav > a[href=\"/pricing\"]", "side": "right",   // or "left", "both"
          "left": null, "right": { "x": 256, "y": 192, "w": 928, "h": 24 },
          "changed": {},         // "margin-left": ["24px", "16px"], left first; "text" too
          "text": "Pricing"      // "rightSelector" when the right one differs
        }]
      }],
      "text": { "added": [], "removed": ["Pricing"] },   // added: left only; removed: right only
      "accepted": false,         // every band and region matched renderdiff.accepted.json
      "failed": { "left": [], "right": [] },   // stylesheets and font faces that didn't load: "font Inter 700", "stylesheet https://…"
      "fonts": { "added": [], "removed": ["Inter 600"] },   // web font faces one side loaded; absent when equal
      "masked": ["rotating quote (data-renderdiff-mask)"],   // absent unless a side marked elements data-renderdiff-mask
      "stopped": ["right"],   // WebKit only, absent unless a load still open after 5s was stopped for the shot
      "computed": { "dom": 1, "changes": [], "truncated": 0, "unmatched": { "left": [], "right": ["body > nav > a[href=\"/pricing\"]"] },
        "rules": [{ "side": "left", "sheet": "docs.css", "conditions": ["@media (min-width: 60em)"], "rules": 5, "elements": 67 }],
        "prefixes": { "left": ["-webkit-user-select: none"], "right": [] } },   // --computed only; null: snapshot failed, "computedError" says why; rules: one-sided rule groups, elements they could style here; prefixes: { left, right }, prefixed declarations only that side's CSS source has
      "aria": { "added": ["- text: Buy now"], "removed": ["- button \"Buy now\""], "truncated": 0 },   // --aria only; both empty: identical; null: snapshot failed, "ariaError" says why
      "images": { "left": "about.1440.left.png", "right": "about.1440.right.png", "diff": "about.1440.diff.png" },   // packed: .webp, right may name left's file, no diff when diffPixels is 0
      "crops": [{
        "path": "about.1440.c1.png", "kind": "band",          // or "region"
        "left": { "x": 256, "y": 196, "w": 68, "h": 0 },      // h 0: where the rows would go
        "right": { "x": 256, "y": 196, "w": 68, "h": 24 },
        "layout": "stacked", "scale": 1, "clipped": false     // left on top, or on the left ("side")
      }]
    },
    { "url": "/blank", "left": "/blank", "right": "/blank", "width": 1440, "status": "error", "error": "page did not render …" }
  ],
  "summary": {
    "compared": 1, "errors": 1, "mean": 0.9714,
    "worst": { "url": "/about", "width": 1440, "score": 0.9714 },
    "belowThreshold": 0,          // accepted shots aside
    "differing": 1,               // shots with any differing pixel, accepted ones aside
    "accepted": 0,                // shots whose every difference was accepted
    "stale": [],                  // accepted entries the run measured but didn't see
    "findings": [],               // { finding, selector?, at: [{ url, widths }] }, seen on 2+ routes
    "computed": [],               // --computed: { key, prop, values: [left, right], at: [{ url, widths }] }
    "rules": [],                  // --computed: { side, sheet, conditions, rules, matched: [{ url, widths }], unmatched: [{ url, widths }] }
    "prefixes": []                // --computed: { side, declaration, at: [{ url, widths }] }
  }
}
```
