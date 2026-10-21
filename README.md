# vdiff

Screenshot diff between two origins.

Give it a list of routes and two base URLs. It screenshots each route on both sides at
several viewport widths, pixel-diffs the pairs, and writes a scored HTML report with
left / right / diff side by side.

Useful for the "did I break anything?" question a test suite can't answer: a framework
migration, a CSS refactor, a dependency bump, a staging-vs-production check.

```
vdiff / /about /pricing --left http://localhost:3000 --right https://example.com
```

```
Routes: 3
Capturing 15 pair(s) with 2 worker(s)...

  [1/15] 99.98%  / @1440
  [2/15] 97.41%  /about @1440  (height -112px)
  …

mean 99.12%   worst 97.41% (/about @1440)
    97.41%  /about@1440  height -112px
    99.87%  /pricing@375

Report: /Users/you/site/vdiff-out/report.html
```

## Install

```bash
npm install -g vdiff
npx playwright install chromium   # once, if you don't already have it
```

Requires Node >= 20.11.

## Usage

```
vdiff <route…> --left <url> --right <url> [options]
```

| Flag | |
| --- | --- |
| `--left <url>` | Left origin. Required. |
| `--right <url>` | Right origin. Required. |
| `--width <n>` | Viewport width; repeatable. Replaces the defaults. |
| `--threshold <0..1>` | Exit non-zero if any comparison scores below this. |
| `--out <dir>` | Output directory. Default `./vdiff-out`. |
| `--concurrency <n>` | Parallel workers. Default 2. |
| `--config <path>` | Config file. Default: `vdiff.config.{ts,mts,js,mjs}` in cwd. |
| `--dry-run` | Print the URL pairs and exit. No browser. |
| `--open` | Open the report when the run finishes. |
| `-h, --help` / `-v, --version` | |

Routes are **literal paths** — there is no route discovery and globs are rejected. Both
origins get the same path appended, so the two sides must have matching URL structure.

Default widths are `1440, 1152, 896, 704, 375` — one inside each common responsive band
rather than on a breakpoint boundary, so a layout switch never flaps between captures.

Exit codes: `0` all good · `1` a route errored or scored below `--threshold` ·
`2` bad arguments, bad config, or an origin that isn't responding.

## Config file

Flags cover a one-off run. A `vdiff.config.ts` (or `.mjs`) in the working directory
covers a repo you diff repeatedly, and expresses the things flags can't: per-route
**masks** for content that legitimately drifts, extra selectors to hide, extra URLs to
block.

```ts
import { defineConfig } from "vdiff";

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

See [`vdiff.config.example.ts`](./vdiff.config.example.ts) for every field, annotated.

**Precedence: CLI flag > config file > built-in default.**

Two notes on the file itself:

- A `.ts` config relies on Node's built-in type stripping (Node >= 22.18). On older
  Node use `vdiff.config.mjs`.
- `import { defineConfig } from "vdiff"` is only for editor types, and only resolves if
  `vdiff` is *also* installed in that project — a globally-installed CLI is not
  importable from an arbitrary directory. `export default { … }` works everywhere.

## How it reads

The score is the share of pixels that match, per route per width. Green above 99.5%,
amber to 97%, red below. It is a triage signal, not a verdict — open the report and
look at the diff column.

**Magenta means padding.** When one side is taller or wider, the shorter image is padded
with magenta, and that padding counts against the score on purpose: a page 400px shorter
than the one it's compared against has not reached parity. The `height ±Npx` badge on the
row names the cause.

**Errors are not failures.** A route that threw produced no measurement, so it is
neither a pass nor a fail. It's listed separately in the report — and it still exits 1,
because an unmeasured route is not a verified one.

## What it does to make two loads comparable

- **Refuses to start** unless both origins answer a HEAD request. Two error pages diffed
  against each other score ~100%, which is the likeliest way a tool like this lies to you.
- **Refuses a shot** it can't trust: a page under 800px tall or with under 200 characters
  of text throws instead of quietly scoring as a match.
- **Blocks analytics, consent and A/B tooling** at the network layer on both sides —
  GTM, GA, Segment, Intercom, Hotjar, LinkedIn, Meta, OneTrust, CookieLaw, VWO. Blocked
  rather than hidden, because A/B tools rewrite arbitrary DOM and CSS can't pre-empt an
  experiment you haven't seen. Blocking must stay symmetric: doing it on one side only
  is itself a diff.
- **Kills animation, transitions and caret blink**, and hides common consent banners and
  dev toolbars.
- **Settles the page** — scrolls to trigger lazy images, waits for `document.fonts.ready`
  and network idle, then re-injects the stylesheet to catch late-injected chrome.
- **Isolates state** — one browser context per origin, so cookies and localStorage never
  cross.
- **Retries once** per shot; a live site can time out on a cold edge.
- **Stitches tall pages.** Chromium silently truncates a single screenshot past 16,384px,
  so taller pages are captured as tiles through CDP and stitched back together. Masks
  can't be overlaid on that path, so a masked route tall enough to tile warns loudly
  rather than scoring dishonestly. Past 40,000px it errors — that's a broken layout, not
  a page.

Every run's report ends with a "What was neutralized" section listing the actual block
patterns and mask reasons in effect, so the report can't drift from the config.

## Development

```bash
npm install        # builds via the prepare script
npm run build      # tsc → dist/
npm run typecheck  # src + tests, no emit
npm install -g .   # install this working copy globally
```

Source is TypeScript in `src/`, compiled to ESM in `dist/`. Import specifiers keep their
`.ts` extension in source (`rewriteRelativeImportExtensions` rewrites them on emit), so
`node src/cli.ts` also runs directly on Node >= 22.18.

## Tests

```bash
npm test           # unit tier — no browser, ~4s
npm run test:visual  # drives Chromium over the fixture corpus, ~50s
npm run test:all
```

Built on `node:test`, no test dependencies. Running them needs Node >= 22.18 for type
stripping (the package itself supports >= 20.11) and a Chromium for the visual tier:
`npx playwright install chromium`.

The suite is black-box: it spawns `node src/cli.ts` and reads results back from stdout,
`report.html`, and the written PNGs. Nothing under `src/` is imported, so what is asserted is
what a user gets. The two output formats it depends on are parsed in exactly one place,
`tests/helpers/parse.ts`.

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
- *Guard rails* — one per defence above: the blank-page refusal, the 18,000px tiled capture,
  animation stilling, lazy-image settling, consent hiding, masks, and network blocking. Masks
  and blocking each run twice, with and without their config, so the mechanism is shown doing
  something rather than a page merely happening to match.

Fixture authoring rules — integer-pixel geometry above all — are in
[`tests/fixtures/pages/README.md`](./tests/fixtures/pages/README.md), and
`tests/unit/fixtures.test.ts` enforces what can be enforced. Read them before adding a pair:
a fractional box is the difference between a clean comparison and sub-pixel noise.

## License

MIT
