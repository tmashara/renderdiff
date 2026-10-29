# renderdiff

**Did my migration change how the site renders? A visual-parity check for coding agents.**

![renderdiff output for a page missing a nav link, next to the crop it wrote](https://raw.githubusercontent.com/tmashara/renderdiff/main/docs/img/hero.png)

renderdiff screenshots the same routes on two running copies of a site (your change, and a
reference: a local build of the base commit, or production) at five viewport widths and
pixel-diffs each pair. For every
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

**Any difference exits 1.** `--threshold <0..1>` relaxes that to scores below it
(`--threshold 0` never fails on a difference). Read the summary either way.

### For coding agents

Install the skill so the agent runs the loop (base build vs change build, a baseline before
the change, pixels plus `--computed` for CSS-only work) and reports a verdict, not a bare score:

```
/plugin marketplace add tmashara/renderdiff     # Claude Code
/plugin install renderdiff@renderdiff
npx skills add tmashara/renderdiff              # Codex, Cursor, others (skills.sh)
```

### In CI

`uses: tmashara/renderdiff@v0` checks a preview deployment or a build in the job against
production on every pull request, with the result in the job summary:
[docs/github-action.md](https://github.com/tmashara/renderdiff/blob/main/docs/github-action.md).

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
| `--threshold <0..1>` | Exit 1 only if a comparison scores below this, instead of on any difference. `0` never fails on one. |
| `--out <dir>` | Output directory, wiped at the start of a run. Default `./renderdiff-out`. A directory holding files renderdiff didn't write is refused. |
| `--concurrency <n>` | Parallel workers. Default half the CPU cores, between 2 and 8. Lower it when one side is someone's live site. |
| `--config <path>` | Config file. Default: `renderdiff.config.{ts,mts,js,mjs}` in cwd. |
| `--selector <sel>` | Compare the one element this Playwright selector matches, on both sides, instead of the whole page. Applies to every route, over the config's per-route `selector`. |
| `--left-selector <sel>`, `--right-selector <sel>` | That side's selector, over `--selector`. One without the other side (or `--selector`) is an error. |
| `--mask <sel>` | Paint this Playwright selector over on both sides, on every route; repeatable. Added to the config's masks and listed in the report as coverage given up. |
| `--mask-media` | Mask every `iframe` on every route, as config `maskMedia: true` does. Video isn't masked: it is frozen by default, so the player's box is still compared. |
| `--no-freeze-video` | Leave videos playing and video.js overlays visible, as config `freezeVideo: false` does. By default every video shows its poster ([how it works](https://github.com/tmashara/renderdiff/blob/main/docs/how-it-works.md)); unfrozen, expect unstable pixels or `did not settle`. `--mask-media` doesn't mask them either. |
| `--storage-state <file>` | Start both sides with this Playwright storage state (cookies, localStorage), e.g. signed in. Relative to cwd. Over the config's `storageState`. |
| `--left-storage-state <file>`, `--right-storage-state <file>` | That side's storage state, over `--storage-state`. One side alone is fine. |
| `--accept <reason>` | Record this run's differences as accepted, with a reason. See **Accepted differences and reruns**. |
| `--rerun-failed` | Rerun only what the last run in `--out` didn't find clean or accepted, keeping the rest. |
| `--cache-right` | Replay the right side's network traffic from the last `--cache-right` run in `--out`, when it's under an hour old and covers every shot; otherwise load it live and record it. Keeps `<out>/.cache/` when the out dir is wiped. See **Accepted differences and reruns**. |
| `--computed` | Also diff the computed style of every rendered element and its `::before`/`::after`, and say per route whether the markup is identical apart from asset hashes and origin. Pixels still decide the score and exit code. See [docs/output.md](docs/output.md#computed-styles---computed). |
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
| `0` | No route errored and no shot differs (with `--threshold`: none scored below it). Accepted differences don't count; nor do unstable pixels or a failed asset alone, which still get their own row. |
| `1` | A shot differs, or with `--threshold` scored below it. Wins over `3` when both happen. A difference that can't be accepted (unstable pixels beside it, a width change, a height change whose rows don't align) exits 1 even on the `--accept` run. |
| `2` | Bad arguments or config, an origin that isn't responding, an unreadable storage state or `renderdiff.accepted.json`, an out dir holding files renderdiff didn't write, or a `--rerun-failed` that doesn't repeat the last run. |
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
covers a repo you diff repeatedly, and expresses what flags can't: **per-route masks** for content
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
`-` = only in or more in the right (the reference). A row reads: score, `h`/`w` height and
width delta, `band`s (rows only one side has), `aligned` (the score without them), `line`s
(a 1–2px border or divider), `N reg` (regions), `unstable` pixels, `text` lines. Under it,
`failed` assets, the `dom` elements and properties behind the changes, and the `crops`.

Read text first, then `dom`, then the crops for anything `dom` doesn't explain. Every token,
the `--computed` block, the `--progress` and report forms and `results.json`:
[docs/output.md](https://github.com/tmashara/renderdiff/blob/main/docs/output.md).

## Accepted differences and reruns

Run once before changing code. Against a local build of the base that is base vs base, so
whatever differs varies per load: mask it. Against production, the untouched build already
differs (deploy drift, one-sided embeds); look, record it once, then change code and re-check
only what's red:

```
renderdiff http://localhost:3000 https://example.com / /about --accept "differs before the migration"
# …change code…
renderdiff http://localhost:3000 https://example.com / /about --rerun-failed
```

`--accept "<reason>"` writes every difference the run saw to `renderdiff.accepted.json` (next
to the config, or in cwd); commit it. Later, a shot whose every difference matches an entry is
listed on an `accepted:` line and doesn't count toward the exit code; anything new on the same
page still shows. `--rerun-failed` reruns only what the last run in `--out` didn't find clean
or accepted. Against a slow reference, `--cache-right` replays the right side's recorded
traffic for up to an hour; drop it for the final run. Matching rules, why to accept on the
platform that checks, and the cache:
[docs/accepted.md](https://github.com/tmashara/renderdiff/blob/main/docs/accepted.md).

## Output

Everything lands in the out dir (`./renderdiff-out` by default):

- `report.html`: the scored report. A sidebar lists every route with a link per width,
  filterable, coloured green (clean or accepted), amber (differs within `--threshold`) or
  red (fails or errored); the summary on top lists only the shots that differ.
- `{slug}.{width}.{left,right,diff}.png`: full-page shots and the diff. `/` slugs to
  `index`, `/blog/foo` to `blog-foo`, other characters to `_`, a pair `/a::/b` to `a~b`; a
  clash gets a `-2` suffix.
- `{slug}.{width}.c{n}.png`: up to three crops per comparison, left on top or on the left,
  change boxed in red.
- `results.json`: everything above as data, written on every run, errors included, one
  result per line. Its types (`Results` and friends) are exported from the package; fields:
  [docs/output.md](https://github.com/tmashara/renderdiff/blob/main/docs/output.md#resultsjson).

`renderdiff report <out> --verdict verdict.md --title "<task>"` then rewrites `report.html`
and writes `evidence.html` there: one self-contained page (a Parity / Differs / Not verified
banner, your verdict, crops embedded) to attach to a ticket or publish as proof:
[docs/output.md](https://github.com/tmashara/renderdiff/blob/main/docs/output.md#evidencehtml).

## Why a clean result is trustworthy

- **Refuses to start** unless both origins answer: two error pages would score ~100%.
- **Refuses a shot** with an HTTP status ≥ 400, or where both sides look blank.
- **Blocks analytics, consent and A/B tooling** at the network layer, on both sides.
- **Pins what varies between loads**: clock, `Math.random`, timezone, locale, colour scheme, reduced motion, video frames and video.js overlays.
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
