# renderdiff

Screenshot diff between two origins.

Give it a list of routes and two base URLs. It screenshots each route on both sides at
several viewport widths, pixel-diffs the pairs, and writes a scored HTML report with
left / right / diff side by side, plus `results.json` and crops of the changes, sized to stay
legible to coding agents.

Useful for the "did I break anything?" question a test suite can't answer: a framework
migration, a CSS refactor, a dependency bump, a staging-vs-production check.

```
renderdiff / /about /pricing --left http://localhost:3000 --right https://example.com
```

On a terminal it prints a line per shot as it lands, then the worst scores and the paths
to `report.html` and `results.json`. Piped — to a file, CI or a coding agent — it prints
one summary at the end instead, listing only what differs:

```
Routes: 3
clean: /
/about  clean @1152,896,704,375
  @1440  97.41%  h-24  band -24@y196  aligned 100.00%  text -"Pricing"
/pricing
  @1440,1152,896,704,375  99.12%–99.87%  1 reg
renderdiff: 2 of 3 routes differ (6 of 15 shots), 0 errors, worst 97.41% /about@1440 — /Users/you/site/renderdiff-out/results.json
```

A row covers the widths that agree on everything but the score (shown as a range): height
delta (`h`), bands (`+` rows only left has, `-` rows only right has, at `y`; `~` when the
widths put it in different places), aligned score, region count, unstable pixels and up to
three text-diff lines (`-"x"` only on the right, `+"x"` only on the left). Errors print in
full, grouped across the widths that share a message. Clean means not one pixel differs
and none went unmeasured as unstable; a route with unstable pixels gets its own row. With
`--threshold`, the verdict line ends `, B below 97.00%`. `--progress` gets the per-shot
output when piped, `--no-progress` the summary on a terminal.

## Install

```bash
npm install -g renderdiff
npx playwright install chromium   # once, if you don't already have it
```

Requires Node >= 22.18.

### Agent skill

[`skills/renderdiff/SKILL.md`](./skills/renderdiff/SKILL.md) teaches a coding agent to use
renderdiff without fooling itself: run it with `npx renderdiff@latest`, read the summary
it prints, then the text diff, the bands and the region crops, and give a verdict that says
what it looked at — not just a score. The longer reference (triage, rationalizations,
config, gotchas) sits next to it in `reference.md` and is read only when needed.

In Claude Code, as a plugin:

```
/plugin marketplace add tmashara/renderdiff
/plugin install renderdiff@renderdiff
```

For other agents (Codex, Cursor and so on), with [skills](https://skills.sh):

```bash
npx skills add tmashara/renderdiff
```

Until renderdiff is on npm, `npx renderdiff@latest` won't resolve; install the CLI with
`npm install -g github:tmashara/renderdiff`.

## Usage

```
renderdiff <route…> --left <url> --right <url> [options]
```

| Flag | |
| --- | --- |
| `--left <url>` | Left origin. Required. |
| `--right <url>` | Right origin. Required. |
| `--width <n>` | Viewport width; repeatable. Replaces the defaults. |
| `--threshold <0..1>` | Exit non-zero if any comparison scores below this. |
| `--out <dir>` | Output directory, wiped at the start of a run. Default `./renderdiff-out`. A directory holding files renderdiff didn't write is refused. |
| `--concurrency <n>` | Parallel workers. Default 2. |
| `--config <path>` | Config file. Default: `renderdiff.config.{ts,mts,js,mjs}` in cwd. |
| `--dry-run` | Print the URL pairs and exit. No browser. |
| `--open` | Open the report when the run finishes. |
| `--progress` | A line per shot as it finishes, then the worst scores. The default on a terminal; piped, renderdiff prints one compact summary at the end. |
| `--no-progress` | The compact summary even on a terminal. |
| `-h, --help` / `-v, --version` | |

Routes are **literal paths** — there is no route discovery and globs are rejected. Both
origins get the same path appended, so the two sides must have matching URL structure.

Default widths are `1440, 1152, 896, 704, 375` — one inside each common responsive band
rather than on a breakpoint boundary, so a layout switch never flaps between captures.

Exit codes: `0` all good · `1` a route errored or scored below `--threshold` ·
`2` bad arguments, bad config, or an origin that isn't responding.

## Config file

Flags cover a one-off run. A `renderdiff.config.ts` (or `.mjs`) in the working directory
covers a repo you diff repeatedly, and expresses the things flags can't: per-route
**masks** for content that legitimately drifts, extra selectors to hide, extra URLs to
block.

```ts
import { defineConfig } from "renderdiff";

export default defineConfig({
  left: "http://localhost:3000",
  right: "https://example.com",
  routes: ["/", "/about", "/pricing"],
  widths: [1440, 896, 375],
  threshold: 0.97,

  hideSelectors: [".site-cookie-banner"],
  blockUrlPatterns: ["**://*.my-tracker.example/**"],

  masks: [
    {
      urlPath: "/pricing",
      reason: "live star count on /pricing",
      locate: (page) => page.locator("[data-star-count]"),
    },
  ],
});
```

See [`renderdiff.config.example.ts`](./renderdiff.config.example.ts) for every field, annotated.

**Precedence: CLI flag > config file > built-in default.**

`import { defineConfig } from "renderdiff"` is only for editor types, and only resolves if
`renderdiff` is *also* installed in that project — a globally-installed CLI is not
importable from an arbitrary directory; `export default { … }` works everywhere.

## How it reads

The score is the share of pixels that match, per route per width. Green above 99.5%,
amber to 97%, red below. It is a triage signal, not a verdict — open the report and
look at the diff column.

Under each score, `--progress` output and the report card say where to look:

```
  [3/8] 97.14%  /pricing @1440  (height -24px)
        band -24px at y=196 (right)
        aligned 100.00%
        text: 0 added, 1 removed
```

- **Regions** are connected patches of differing pixels, on a 16px grid, largest first. On
  a long page a missing link barely moves the score; it is still a region. Only the area
  both sides cover is searched: padding is reported by the height delta and the bands. With
  bands, regions come from the realigned rows, so content a band only pushed down isn't
  one (above, the band is the whole difference, so there are none). The
  card lists the top five with their pixel counts; up to three crops cover the bands first,
  then the largest regions.
- **Bands** are rows only one side has, found by aligning the two images row by row. `-24px
  at y=196 (right)` means the right side has 24 rows there that the left lacks — signed like
  the height delta. When rows of identical content repeat, the band's `y` can slide along
  them, so treat it as approximate. `aligned` is the score over the rows the alignment pairs,
  i.e. what the page would score if the bands were cut out; it only shows when there are
  bands. Pages of different heights that share too few identical rows say `rows too
  different to align`. A horizontal shift is never a band. Alignment works on exact row
  matches, so it gives up when the edits total more than 2,000 rows (a single inserted or
  removed block aligns at any height), or when sub-threshold shade noise touches every row.
- **Text** is a line diff of each side's `document.body.innerText`. Left is the changed
  version: *added* lines are on the left only, *removed* lines on the right only. The card
  lists the first 20. Masked elements are left out. Unmasked text that changes per load
  (a ticker, a clock) shows up here whenever the two sides differed at capture time, even
  when its pixels were painted out as unstable.

**Magenta means padding.** When one side is taller or wider, the shorter image is padded
with magenta, and that padding counts against the score on purpose: a page 400px shorter
than the one it's compared against has not reached parity. The `height ±Npx` badge on the
row names the cause.

**Errors are not failures.** A route that threw produced no measurement, so it is
neither a pass nor a fail. It's listed separately in the report — and it still exits 1,
because an unmeasured route is not a verified one.

## Output

Everything lands in the out dir (`./renderdiff-out` by default):

- `report.html` — the scored report.
- `{slug}.{width}.{left,right,diff}.png` — full-page shots and the diff. `/` slugs to
  `index`, `/blog/foo` to `blog-foo`, other characters to `_`; a clash gets a `-2` suffix.
- `{slug}.{width}.c{n}.png` — up to three crops per comparison: bands (rows only one side
  has), tallest first, then the largest regions. Each shows left and right at native scale,
  padded by 48px and at least 320px wide, with a 1px red box around the change; on the side
  that lacks a band's rows, a 2px red seam is inserted where they would be, hiding nothing.
  Left is always on top (`stacked`, for wide changes) or on the left (`side`, for tall
  ones). A crop stays within 1,568px on its long edge and 1,568 image tokens
  (⌈w/28⌉·⌈h/28⌉) and is never scaled below 0.75×; a change too big for that keeps its top
  rows (or left columns) and is marked `clipped`. Height padding is never cropped.
- `results.json` — everything above as data, written on every run, errors included, one
  result per line, scores rounded down to four decimals (so a shot that differs never
  reads as `1`). Its types (`Results` and friends) are exported
  from the package.

```jsonc
{
  "meta": {
    "tool": "renderdiff", "version": "0.1.0", "generatedAt": "…",
    "left": "http://localhost:3000", "right": "https://example.com",
    "widths": [1440, 375], "threshold": null,
    "clock": "…",                // the instant both sides' clocks start at
    "blockUrlPatterns": ["…"], "hideSelectors": ["…"],
    "masks": [{ "urlPath": "/pricing", "reason": "live star count on /pricing" }]
  },
  "results": [
    {
      "url": "/about", "width": 1440, "status": "compared",
      "score": 0.9714,           // share of measured pixels that match
      "alignedScore": 1,         // score over the aligned rows; null unless there are bands
      "diffPixels": 33120, "totalPixels": 1158000, "unstablePixels": 0,
      "heightDelta": -24, "widthDelta": 0,          // left − right
      "regions": [],             // left-page px; with bands, from the realigned rows
      "bands": [{ "side": "right", "y": 196, "h": 24 }],   // null: too different to align
      "text": { "added": [], "removed": ["Pricing"] },
      "images": { "left": "about.1440.left.png", "right": "about.1440.right.png", "diff": "about.1440.diff.png" },
      "crops": [{
        "path": "about.1440.c1.png", "kind": "band",          // or "region"
        "left": { "x": 256, "y": 196, "w": 68, "h": 0 },      // h 0: where the rows would go
        "right": { "x": 256, "y": 196, "w": 68, "h": 24 },
        "layout": "stacked", "scale": 1, "clipped": false     // left on top, or on the left ("side")
      }]
    },
    { "url": "/blank", "width": 1440, "status": "error", "error": "page did not render …" }
  ],
  "summary": {
    "compared": 1, "errors": 1, "mean": 0.9714,
    "worst": { "url": "/about", "width": 1440, "score": 0.9714 },
    "belowThreshold": 0
  }
}
```

Paths are relative to the out dir. Results are in route-then-width order.

## What it does to make two loads comparable

- **Refuses to start** unless both origins answer a HEAD request. Two error pages diffed
  against each other score ~100%, which is the likeliest way a tool like this lies to you.
- **Refuses a shot** it can't trust: an HTTP status of 400 or above on either side is an
  error naming the status. A route where *both* sides look blank — under 200 characters of
  text and no visible images, SVG, canvas, video, iframes or form controls — errors instead
  of quietly scoring as a match. If only one side is blank, the diff shows it.
- **Blocks analytics, consent and A/B tooling** at the network layer on both sides —
  GTM, GA, Segment, Intercom, Hotjar, LinkedIn, Meta, OneTrust, CookieLaw, VWO. Blocked
  rather than hidden, because A/B tools rewrite arbitrary DOM and CSS can't pre-empt an
  experiment you haven't seen. Blocking must stay symmetric: doing it on one side only
  is itself a diff.
- **Pins what varies between loads**, identically on both sides: the clock starts at one
  instant per run (floored to the minute) on every load and then runs, `Math.random` is
  seeded, timezone (UTC), locale (en-US), colour scheme
  (light) and `prefers-reduced-motion` are fixed, and videos are paused at frame 0. A clock
  that shows seconds can still tick between the two sides and may need a mask.
- **Kills animation, transitions and caret blink**, and hides common consent banners and
  dev toolbars.
- **Settles the page** — makes native lazy images eager, scrolls every viewport-height
  slice a frame at a time so script lazy loaders fire, waits for every image to decode,
  `document.fonts.ready` and up to 3s of network idle, then re-injects the stylesheet to
  catch late-injected chrome.
- **Shoots until stable** — repeats the screenshot until two in a row match (at most 3; 2
  for tiled pages). Pixels still changing between the last two shots of the same load are
  noise from that origin: they're painted magenta on both sides, reported per comparison
  as `unstable`, and excluded from the measurement — the score is over the remaining
  pixels. A route more than 25% unstable errors as `page did not settle`.
- **Isolates state** — one browser context per origin, so cookies and localStorage never
  cross. Both sides of a route load at the same time.
- **Retries once** per shot; a live site can time out on a cold edge.
- **Stitches tall pages.** Chromium silently truncates a single screenshot past 16,384px,
  so taller pages are captured as tiles through CDP and stitched back together. Masks are
  painted onto the final image from each element's bounding box, so they apply the same
  way on both paths. Past 40,000px it errors — that's a broken layout, not a page.

Every run's report ends with a "What was neutralized" section listing the actual block
patterns, mask reasons and pinned settings in effect, so the report can't drift from the
config.

## Development

```bash
npm install        # builds via the prepare script
npm run build      # tsc → dist/
npm run typecheck  # src + tests, no emit
npm install -g .   # install this working copy globally
```

Source is TypeScript in `src/`, compiled to ESM in `dist/`. Import specifiers keep their
`.ts` extension in source (`rewriteRelativeImportExtensions` rewrites them on emit), so
`node src/cli.ts` also runs directly.

## Tests

```bash
npm test           # unit tier — no browser, ~4s
npm run test:visual  # drives Chromium over the fixture corpus, ~40s
npm run test:all
```

Built on `node:test`, no test dependencies. Running them needs a Chromium for the visual tier:
`npx playwright install chromium`.

The suite is black-box: it spawns `node src/cli.ts` and reads results back from stdout,
`report.html`, `results.json`, and the written PNGs. Nothing under `src/` is imported at
runtime (only the `results.json` types), so what is asserted is what a user gets. The output
formats it depends on are parsed in exactly one place, `tests/helpers/parse.ts`.

**`tests/unit/`** — argument parsing, exit codes, route normalization, and config discovery,
validation and precedence. All of it through `--dry-run`, which exits before the browser.

**`tests/visual/`** — real captures against `tests/fixtures/`, a two-origin site served on
ephemeral ports. Three groups:

- *Equivalence* — six pairs of pages that are visually identical but built with different CSS:
  flex against grid, floats against flex, CSS tables against grid, transform-centring against
  `place-items`, inline-block against flex. These assert a **zero-pixel** diff, not a
  threshold. They are the corpus's central claim: the score tracks pixels, not markup, so a
  refactor that changed nothing visible reads as nothing changed.
- *Controls* — an 8px shift, an extra section, one recoloured box. These must score low.
  Without them a tool that returned 100% unconditionally would pass the suite.
- *Guard rails* — one per defence above: the blank-page refusal (and a short sign-in page
  that must not be refused), the 18,000px tiled capture with masks in both tiles, animation
  stilling, the shared clock start and seeded randomness, the unstable-pixel check, lazy-image
  settling (native and script-driven, 4,800px below the fold), consent hiding, masks, and
  network blocking. Masks
  and blocking each run twice, with and without their config, so the mechanism is shown doing
  something rather than a page merely happening to match.

Fixture authoring rules — integer-pixel geometry above all — are in
[`tests/fixtures/pages/README.md`](./tests/fixtures/pages/README.md), and
`tests/unit/fixtures.test.ts` enforces what can be enforced. Read them before adding a pair:
a fractional box is the difference between a clean comparison and sub-pixel noise.

## License

MIT
