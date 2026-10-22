# renderdiff

**Did my migration change how the site renders? A visual-parity check for coding agents.**

renderdiff screenshots the same routes on two running copies of a site (your branch on
localhost, and production) at five viewport widths and pixel-diffs each pair. For every
change it tells you where on the page it is, which DOM element and CSS property is behind
it, and what text differs. It also writes small crops sized for an LLM's context. It refuses
to score what it can't trust: blank pages, error pages, pages still moving. A clean result
means the pixels really matched.

### Who it's for

Developers who hand a **large website migration** to a coding agent (Claude Code, Codex,
Cursor), and the agents themselves. The goal of such a migration is *no visible change*, and
the agent needs a cheap, trustworthy loop: change → `renderdiff` → explain every difference
→ repeat.

**Use it for:**

- framework migrations (e.g. Gatsby → Next.js, Vue 2 → 3, jQuery templates → React)
- CSS or design-system refactors (Sass → Tailwind, BEM → CSS modules, a token swap)
- template or component rewrites, CMS moves, static-site-generator swaps
- dependency and build upgrades (bundler, PostCSS, font loading)
- pages that moved during the migration (`/pricing::/plans`), and one component at a time (`--selector`)

**Don't use it for:**

- intentional redesigns: when everything is meant to change, the score says nothing
- cross-browser testing (Chromium only) or stored-baseline snapshot tests (both origins must be live)
- discovering routes: you list them; there is no crawler
- component libraries in isolation; Storybook-based tools fit that better

### 30-second quickstart

```bash
npx playwright install chromium            # once per machine
npx renderdiff@latest http://localhost:3000 https://example.com / /about /pricing
```

**Left (first origin) is your change; right (second) is the reference.** Piped, which is
what an agent sees, renderdiff prints only what differs:

```
Routes: 3
clean: / /pricing
/about  clean @1152,896,704,375
  @1440  97.41%  h-24  band -24@y196  aligned 100.00%  text -"Pricing"
    dom -nav > a[href="/pricing"] "Pricing"
    crops about.1440.c1.png
renderdiff: 1 of 3 routes differ (1 of 15 shots), 0 errors, worst 97.41% /about@1440 — ./renderdiff-out/results.json
```

Read as: on `/about` at 1440px, your change is 24px shorter (`h-24`) because 24 rows that
only the reference has (`band -24`) are missing at y=196. With those rows cut out the page
matches exactly (`aligned 100.00%`). The missing rows are the "Pricing" nav link, which
exists only on the reference (`-`). Open `renderdiff-out/about.1440.c1.png` to see it.

**Without `--threshold`, a diff still exits 0**, so read the summary.

### For coding agents

Install the skill so the agent runs the loop and reports a verdict, not a bare score:

```
/plugin marketplace add tmashara/renderdiff     # Claude Code
/plugin install renderdiff@renderdiff
npx skills add tmashara/renderdiff              # Codex, Cursor, others (skills.sh)
```

### Requirements

Node >= 22.18 and Chromium (`npx playwright install chromium`). `npm install -g renderdiff`
installs it globally. If the bundled Chromium won't launch, renderdiff falls back to an
installed Google Chrome on both sides and says so; `meta.browser` in `results.json` records
which ran.

## Usage

```
renderdiff <left-origin> <right-origin> <route…> [options]
```

| Argument or flag | |
| --- | --- |
| `<origin>` | An argument starting with `http://` or `https://`. The first is left (your change), the second right (the reference); a third is an error. |
| `<route>` | A literal path, e.g. `/about`, or a pair `/pricing::/plans` (see below). |
| `--left <url>` | Left origin, instead of the first positional one. Giving both is an error. |
| `--right <url>` | Right origin, instead of the second positional one. |
| `--width <n>` | Viewport width; repeatable. Replaces the defaults. |
| `--threshold <0..1>` | Exit non-zero if any comparison scores below this. |
| `--out <dir>` | Output directory, wiped at the start of a run. Default `./renderdiff-out`. A directory holding files renderdiff didn't write is refused. |
| `--concurrency <n>` | Parallel workers. Default half the CPU cores, between 2 and 8. Lower it when one side is someone's live site. |
| `--config <path>` | Config file. Default: `renderdiff.config.{ts,mts,js,mjs}` in cwd. |
| `--selector <sel>` | Compare the one element this Playwright selector matches, on both sides, instead of the whole page. Applies to every route, over the config's per-route `selector`. |
| `--left-selector <sel>`, `--right-selector <sel>` | That side's selector, over `--selector`. One without the other side (or `--selector`) is an error. |
| `--storage-state <file>` | Start both sides with this Playwright storage state (cookies, localStorage), e.g. signed in. Relative to cwd. Over the config's `storageState`. |
| `--left-storage-state <file>`, `--right-storage-state <file>` | That side's storage state, over `--storage-state`. One side alone is fine. |
| `--accept <reason>` | Record this run's differences as accepted, with a reason. See **Accepted differences and reruns**. |
| `--rerun-failed` | Rerun only what the last run in `--out` didn't find clean or accepted, keeping the rest. |
| `--dry-run` | Print the URL pairs and exit. No browser. |
| `--open` | Open the report when the run finishes. |
| `--progress` | A line per shot as it finishes, then the worst scores. The default on a terminal; piped, renderdiff prints one compact summary at the end. |
| `--no-progress` | The compact summary even on a terminal. |
| `-h, --help` / `-v, --version` | |

Routes are **literal paths**: there is no route discovery and globs are rejected. Each
route is loaded on both origins, unless it's a pair.

Default widths are `1440, 1152, 896, 704, 375`: each sits mid-way inside a common breakpoint
range rather than on a boundary, so a layout switch never flaps between runs.

| Exit | Meaning |
| --- | --- |
| `0` | No route errored and none scored below `--threshold`. Without one, a diff still exits 0. |
| `1` | A route scored below `--threshold`. Wins over `3` when both happen. |
| `2` | Bad arguments, bad config, or an origin that isn't responding. |
| `3` | A route errored, so it went unmeasured, or the run crashed (e.g. no Chromium). |

### Moved pages, components, interactions, sign-in

```
renderdiff http://localhost:3000 https://example.com /pricing::/plans
renderdiff http://localhost:3000 https://example.com /pricing --selector "[data-test=plans]"
```

A pair `left::right` loads `/pricing` on the left and `/plans` on the right. `--selector`
compares one element, which must match exactly once per side (`--left-selector` /
`--right-selector` when the markup differs). A state behind a click takes a config `before`
hook. For pages behind a login:

```
npx playwright codegen --save-storage=auth.json https://example.com/login
renderdiff http://localhost:3000 https://example.com /account --storage-state auth.json
```

`auth.json` holds live session tokens: **never commit it**, and keep the out dir (signed-in
screenshots and text) out of git too. Details: [docs/scoping.md](https://github.com/tmashara/renderdiff/blob/main/docs/scoping.md).

## Config file

Flags cover a one-off run. A `renderdiff.config.{ts,mts,js,mjs}` in the working directory
covers a repo you diff repeatedly, and expresses what flags can't: **masks** for content
that legitimately drifts, extra selectors to hide, extra URLs to block, `before` hooks.

```ts
export default {
  left: "http://localhost:3000",   // your change
  right: "https://example.com",    // the reference
  routes: ["/", "/about", "/pricing::/plans", { left: "/pricing", selector: "[data-test=plans]" }],
  widths: [1440, 896, 375],
  threshold: 0.97,
  hideSelectors: [".site-cookie-banner"],
  blockUrlPatterns: ["**://*.my-tracker.example/**"],
  masks: [{ selector: "[data-star-count]", reason: "live star count", urlPath: "/pricing" }],
};
```

**Precedence: CLI flag > config file > built-in default.** Every field is annotated in
[`renderdiff.config.example.ts`](./renderdiff.config.example.ts). `export default { … }`
needs no import; `import type { RenderdiffConfig } from "renderdiff"` is for editor types
only.

## Reading the output

**Signs always point at your change:** `+` = only in or more in the left (your change);
`-` = only in or more in the right (the reference).

| Token | Meaning |
| --- | --- |
| `97.41%` | Share of measured pixels that match. A range (`99.12%–99.87%`) when one row covers several widths. A triage signal, not a verdict. |
| `@1440,1152` | The widths a row covers. They agree on height and width delta, bands, aligned score and text; score and region count are ranges. |
| `h-24` / `w+8` | Height / width delta, left − right. The smaller image is padded with magenta, and the padding counts against the score on purpose. |
| `band -24@y196` | 24 rows only the reference has, at y=196 (`+`: only your change has them). `@y~196`: the row's widths put it at different y; the first width's is shown. |
| `aligned 100.00%` | The score with the bands cut out. 100% means the band is the whole difference. |
| `unaligned` | Heights differ but too few rows match to find bands. Use the height delta and regions. |
| `3 reg` | Regions: connected patches of differing pixels. A missing link barely moves the score, but it is still a region. |
| `unstable 1,204px` | Pixels that kept changing between shots of the same load (a ticker, a carousel). Excluded from the score, so the route is never clean. |
| `text -"Pricing"` | A line of visible text only the reference has (`+`: only your change). Up to three, then `(+N more)`. |
| `dom sel prop a→b` | Element on both sides whose computed `prop` differs, left value first. |
| `dom +sel` / `-sel` | Element only on the left / only on the right. |
| `dom sel x+8` | It moved without its own style changing; the neighbour or parent listed after it is the cause. |
| `dom sel` | On both sides and unchanged in style or position, so its own pixels changed (an image or canvas). |
| `crops …` | Up to 3 PNGs per comparison, bands first, relative to `results.json`. Left is on top or on the left, and the change is boxed in red. |
| `ERROR …` | Unmeasured, which is neither a pass nor a fail. Exits 3. |
| `accepted:` / `stale accepted:` | Shots whose every difference was accepted, and accepted entries the run no longer saw. See below. |
| `rerun:` | With `--rerun-failed`: how many shots were rerun and how many reused. |

Read text first, then `dom`, then the crops for anything `dom` doesn't explain. Full
detail, including the `--progress` and report forms: [docs/output.md](https://github.com/tmashara/renderdiff/blob/main/docs/output.md).

## Accepted differences and reruns

A migration starts with differences that already exist between the untouched local build
and production. Record them once, then change code and re-check only what's red:

```
renderdiff http://localhost:3000 https://example.com / /about --accept "differs before the migration"
# …change code…
renderdiff http://localhost:3000 https://example.com / /about --rerun-failed
```

`--accept "<reason>"` writes every difference the run saw to `renderdiff.accepted.json` (next
to the config, or in cwd); commit it. Later, a shot whose every difference matches an entry is
listed on an `accepted:` line and counts neither as differing nor toward `--threshold`;
anything new on the same page still shows. `--rerun-failed` reruns only what the last run in
`--out` didn't find clean or accepted and merges it back; it exits 2 if the run differs from
the previous one. Matching rules, what can still hide, and stale entries:
[docs/accepted.md](https://github.com/tmashara/renderdiff/blob/main/docs/accepted.md).

## Output

Everything lands in the out dir (`./renderdiff-out` by default):

- `report.html`: the scored report.
- `{slug}.{width}.{left,right,diff}.png`: full-page shots and the diff. `/` slugs to
  `index`, `/blog/foo` to `blog-foo`, other characters to `_`, a pair `/a::/b` to `a~b`; a
  clash gets a `-2` suffix.
- `{slug}.{width}.c{n}.png`: up to three crops per comparison, left on top or on the left,
  change boxed in red.
- `results.json`: everything above as data, written on every run, errors included, one
  result per line, scores rounded down to four decimals (so a shot that differs never
  reads as `1`). Its types (`Results` and friends) are exported from the package.

```jsonc
{
  "meta": {
    "tool": "renderdiff", "version": "0.2.0", "generatedAt": "…",
    "left": "http://localhost:3000", "right": "https://example.com",
    "widths": [1440, 375], "threshold": null,
    "clock": "…",                // the instant both sides' clocks start at
    "blockUrlPatterns": ["…"], "hideSelectors": ["…"],
    "masks": [{ "urlPath": "/pricing", "reason": "live star count" }],   // no urlPath: every route
    "browser": { "name": "chromium", "version": "…" },   // "chrome" when it fell back
    "storageState": { "left": "auth.json", "right": null }   // file names only
  },
  "results": [
    {
      "url": "/about", "left": "/about", "right": "/about",   // a pair: "/a::/b", "/a", "/b"
      "selector": null, "hook": false,                         // hook: a before hook ran
      "width": 1440, "status": "compared",
      "score": 0.9714,           // share of measured pixels that match
      "alignedScore": 1,         // score over the aligned rows; null unless there are bands
      "diffPixels": 33120, "totalPixels": 1158000, "unstablePixels": 0,
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
      "images": { "left": "about.1440.left.png", "right": "about.1440.right.png", "diff": "about.1440.diff.png" },
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
    "accepted": 0,                // shots whose every difference was accepted
    "stale": []                   // accepted entries the run measured but didn't see
  }
}
```

Paths are relative to the out dir. Results are in route-then-width order.

## Why a clean result is trustworthy

- **Refuses to start** unless both origins answer: two error pages would score ~100%.
- **Refuses a shot** with an HTTP status ≥ 400, or where both sides look blank.
- **Blocks analytics, consent and A/B tooling** at the network layer, on both sides.
- **Pins what varies between loads**: clock, `Math.random`, timezone, locale, colour scheme, reduced motion, video frames.
- **Kills animation, transitions and caret blink**, and hides common consent banners and dev toolbars.
- **Settles the page**: lazy images, fonts and network idle before the shot.
- **Shoots until stable**, and excludes pixels still moving as `unstable`.
- **Isolates state** per origin, **retries once** per shot, and **stitches tall pages** past 16,384px.

Each run's report ends with a "What was neutralized" section listing what was in effect.
Full detail: [docs/how-it-works.md](https://github.com/tmashara/renderdiff/blob/main/docs/how-it-works.md).

## Contributing

Development and tests: [CONTRIBUTING.md](https://github.com/tmashara/renderdiff/blob/main/CONTRIBUTING.md).

## License

MIT
