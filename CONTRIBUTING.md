# Contributing

## Development

```bash
npm install        # builds via the prepare script
npm run build      # tsc → dist/
npm run typecheck  # src + tests, no emit
npm run lint       # oxlint
npm run format     # oxfmt
npm install -g .   # install this working copy globally
```

Source is TypeScript in `src/`, compiled to ESM in `dist/`. Import specifiers keep their
`.ts` extension in source (`rewriteRelativeImportExtensions` rewrites them on emit), so
`node src/cli.ts` also runs directly.

## Tests

```bash
npm test             # unit tier — no browser, ~4s
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
- *Controls* — an 8px shift, an extra section, one recoloured box, one changed margin. These
  must score low. Without them a tool that returned 100% unconditionally would pass the
  suite. They also pin the elements each change names.
- *Guard rails* — one per defence in [docs/how-it-works.md](docs/how-it-works.md): the
  blank-page refusal (and a short sign-in page that must not be refused), the 18,000px tiled
  capture with masks in both tiles, animation stilling, the shared clock start and seeded
  randomness, the unstable-pixel check, lazy-image settling (native and script-driven,
  4,800px below the fold), consent hiding, masks, network blocking, `before` hooks, storage
  state, and naming fixed chrome over what it covers. Masks and blocking each run twice,
  with and without their config, so the mechanism is shown doing something rather than a
  page merely happening to match.

Fixture authoring rules — integer-pixel geometry above all — are in
[`tests/fixtures/pages/README.md`](./tests/fixtures/pages/README.md), and
`tests/unit/fixtures.test.ts` enforces what can be enforced. Read them before adding a pair:
a fractional box is the difference between a clean comparison and sub-pixel noise.
