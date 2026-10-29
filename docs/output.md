# Reading renderdiff's output

Left is your change, right is the reference. `+` means only in or more in your change,
`-` only in or more in the reference. The [README](../README.md#reading-the-output) has the
short glossary; this is the full version.

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

A row covers the widths that agree on height and width delta (`h`, `w`), bands, aligned
score and text; the score and region count are then shown as ranges, and `unstable` as the
largest. Bands are `+` for rows only the left has and `-` for rows only the right has, at
`y`, with `~` when the widths put it in different places. Up to three text-diff lines
follow (`-"x"` only on the right, `+"x"` only on the left, `(+N more)` past that). Under a
row, `failed` lists stylesheets and font faces a side failed to load (fix those first),
`dom` names up to three elements behind the changes (`@w` when the row covers several
widths: the first one's), and `crops` lists that row's crop files, relative to the
directory `results.json` is in. Errors print in full, grouped across the widths that share
a message. Clean means not one pixel differs, none went unmeasured as unstable and no
stylesheet or font failed; a route with unstable pixels or a failed asset gets its own row. With `--threshold`, the verdict line ends
`, B below 97.00%`. `--progress` gets the per-shot output when piped, `--no-progress` the
summary on a terminal.

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
| Regions | (on the report card) | `3 reg` | `regions: [...]` |
| Unstable | `(unstable 1,204px)` | `unstable 1,204px` | `unstablePixels: 1204` |
| Failed assets | `failed left: font Inter 700` | `failed left: font Inter 700` | `failed: { left: ["font Inter 700"], right: [] }` |

Under each score, `--progress` output and the report card say where to look:

```
  [3/8] 97.14%  /pricing @1440  (height -24px)
        band -24px at y=196 (right)
        aligned 100.00%
        text: 0 added, 1 removed
```

Regions say *where* pixels differ, `dom` says *which element and property* caused it, and
crops are *pictures* of the first three changes. Read in that order: text, `dom`, then crops
for anything `dom` doesn't explain.

## Regions

Connected patches of differing pixels, on a 16px grid, largest first. On a long page a
missing link barely moves the score; it is still a region. Only the area both sides cover is
searched: padding is reported by the height delta and the bands. With bands, regions come
from the realigned rows, so content a band only pushed down isn't one (above, the band is
the whole difference, so there are none). The card lists the top five with their pixel
counts; up to three crops cover the bands first, then the largest regions.

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

What is under the first five bands and regions, up to three each, read from the live pages
right after the shot. Each is a CSS selector unique on its side, so `--selector` takes it.

- `-sel "text"` exists only on the right, `+sel` only on the left.
- `sel margin-left 24px→16px` is on both, with the computed properties that differ, left
  first. A computed value is a symptom: find the rule that set it.
- `sel x+8` moved without a style of its own changing, so the cause is a neighbour or its
  parent, which is listed after it when one of them changed.
- A bare `sel` is on both sides with nothing compared changed or moved, so its own pixels did
  (an image's source, a canvas).

An element without text is only paired when its box is the same size on both sides;
`rightSelector` is set when the right side was found by its text under another selector. A
band names only what one side added, not what it pushed down, so it can name nothing; what
fixed chrome covers isn't named. Probing gives up after 5s, leaving the elements out. Shadow
DOM and iframes aren't searched.

## Computed styles (`--computed`)

With `--computed`, after the shot renderdiff reads the computed style of every rendered
element on both sides: the properties `dom` compares, plus `content`, and `::before` and
`::after` wherever they generate content. Masked subtrees and `script`/`style`-like tags
are skipped; a `display: none` element is read, its subtree isn't. Script-driven
animations are finished first. The summary gets one block, after the rows:

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
  - A class renamed on an ancestor unmatches its whole subtree.
- One change high in the tree is one finding. An inherited property (`font-*`,
  `line-height`, `letter-spacing`, `text-*`, `white-space`, `color`, `visibility`) is
  dropped where the parent has the same change, so a `body` font change is one line, not
  one per element. A `width` is dropped inside a parent whose width changed, and a
  `height` around a child whose height changed, so the box that caused it is what's left.
- An element shown on one side and `display: none` on the other is one `display` finding;
  its subtree counts neither as unmatched nor against `dom identical`.
- A `::before`/`::after` that only one side generates shows as `content` against `none`.
  That is how a removed rule that drew an icon shows up.
- `dom identical` means that on every width, each walked element's tag, attributes and own
  text are the same on both sides.
  - Bundler hashes in `src`/`href`/`srcset` are ignored (`hero.3f9a8c1d.png`, `?v=…`), and
    so are generated class names (`css-1q2w3e`, `Button_root__a1b2c`).
  - A pixel difference on such a route comes from CSS or script, not from walked markup.
    SVG internals, shadow DOM, iframes and `display: none` subtrees aren't walked.
  - Hash-shaped tokens only: 8 or more letters and digits that alternate, between
    separators in a file name. `team_photo_2024.jpg` and `/p/abcdef123456` count as changes.
- `dom differs (N)` counts the elements that differ or that one side lacks. Treat that
  route's findings as hints.
- `unmatched` lists the outermost elements only one side has: `+` left, `-` right. The
  summary shows five routes, five each.
- The HTML report shows the same block and puts `dom identical` / `dom differs (N)` on each
  card. A snapshot that fails, takes over 15s or meets more than 50,000 elements is
  reported as failed, with why (`computed: null`, `computedError`), and the pixel result
  stands. Pixels still decide the score and the exit code.

`:hover`/`:focus` states aren't snapshotted.

## Text

A line diff of each side's visible text (`document.body.innerText`, or the element's with a
selector). `+` / `text.added`: lines only your change (left) has. `-` / `text.removed`:
lines only the reference (right) has. The card lists the first 20. Masked elements are left
out. Unmasked text that changes per load (a ticker, a clock) shows up here whenever the two
sides differed at capture time, even when its pixels were painted out as unstable.

## Unstable pixels

Pixels that changed between two shots of the *same* page load, so they're noise from that
origin (a ticker, a carousel). They're painted magenta on both sides and excluded from the
score, and a route with any is never on the `clean:` line. More than 25% unstable is an
error, `page did not settle`.

## Crops

`{slug}.{width}.c{n}.png`: up to three per comparison, bands (rows only one side has) first,
tallest first, then the largest regions. Each shows left and right at native scale, padded by
48px and at least 320px wide, with a 1px red box around the change; on the side that lacks a
band's rows, a 2px red seam is inserted where they would be, hiding nothing. Left is always on
top (`stacked`, for wide changes) or on the left (`side`, for tall ones). A crop stays within
1,568px on its long edge and 1,568 image tokens (⌈w/28⌉·⌈h/28⌉) and is never scaled below
0.75×; a change too big for that keeps its top rows (or left columns) and is marked
`clipped`. Height padding is never cropped.
