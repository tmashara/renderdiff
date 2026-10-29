# Scoping a comparison

Left is your change, right is the reference. See the [README](../README.md) for the basics.

## Pages that moved

When a migration moved a page, give the route as a pair: `left::right`.

```
renderdiff http://localhost:3000 https://example.com /pricing::/plans /about::/company/about
```

`/pricing::/plans` loads `/pricing` on the left and `/plans` on the right. The split is
on the first `::` followed by `/`, so `/q?x=std::vector` and `/wiki/Talk:Foo` stay single
routes, and `pricing::plans` (no slash) is a literal path; `--dry-run` shows how each
route was read. Each side is normalized on its own, a pair with identical sides is the
plain route, and an empty side (`/pricing::`) is an error.

A pair is named `/pricing::/plans` in stdout, `results.json` (`url`, plus `left` and
`right`) and the report; its images are `pricing~plans.{width}.*.png`. A mask whose
`urlPath` is either side's path is painted on both sides. In a config file, a route can
also be an object, `{ left: "/pricing", right: "/plans" }`, where `right` defaults to
`left`.

## One component

To compare one component instead of the whole page, give a selector:

```
renderdiff http://localhost:3000 https://example.com /pricing --selector "[data-test=plans]"
renderdiff http://localhost:3000 https://example.com /pricing --left-selector .plans-v2 --right-selector .plans
```

Any Playwright selector works, `xpath=` and `>>` chains included, and it's never split on
`::`. It must match **exactly one** element on each side; otherwise the route errors at once
with the count (`selector ".card" matched 6 elements on left (/pricing), expected 1`). The
shot, the score, the regions and the text diff are that element's, in its own pixels; a
mask is painted where it overlaps the element.

A CLI selector applies to every route and replaces the config's. In a config file a route
object takes `selector: ".plans"` or `selector: { left: ".plans-v2", right: ".plans" }`;
to compare several components of one page, list the route once per selector. Such a route
is `/pricing [.plans]` in the summary and the report, keeps `/pricing @1440` on a
`--progress` row with the selector on the line under it, has `selector` in `results.json`
(`{ left, right }`, or `null` for a whole page), and its images are
`pricing@_plans.{width}.*.png`.

Things to know:

- The whole page still loads and settles first, so a component costs about what its page does.
- It's shot at scroll 0 with the rest of the page, so a fixed or sticky header over it is
  in the shot. Hide it with `hideSelectors`.
- An element inside a shorter scroll container includes whatever paints below the container.
- A transformed element is shot at its axis-aligned bounding box.
- Pseudo-elements (`::before`) are rejected by Playwright; elements inside iframes can't be
  reached. Open shadow roots are pierced.
- A selector that matches an element with no box (`display: none`) or one off the page is
  an error. The render gate stays page-level: a textless element on a rendered page is fine.

## Interactions

When the state worth comparing is behind a click (an open menu, a dismissed modal both
sides show), give the route a `before` hook in the config. It runs on each side after the
page loads and its HTTP status is checked, and before renderdiff settles, masks and shoots
it, with the clock and seeded `Math.random` already in force:

```ts
export default {
  routes: [
    { left: "/", before: async (page) => { await page.click("[aria-label=Menu]"); } },
    { left: "/docs", beforeShot: async (page) => { await page.click("[data-tab=intro]"); } },
  ],
  // For every route without its own `before` (which replaces it), CLI routes included;
  // a top-level `beforeShot` works the same way.
  before: async (page, { side, route, width }) => {
    const accept = page.getByRole("button", { name: "Accept" });
    if (await accept.isVisible()) await accept.click();
  },
};
```

`side` is `"left"` or `"right"`, `route` the route's name (`/a` or `/a::/b`), `width` the
viewport width. Use `side` only where the markup legitimately differs (the button has a
different selector on each side), never to make the sides look alike. A hook that throws
is a route error, `before hook failed on left: …` (or `beforeShot …`), and isn't retried.
A route that ran one has `"hook": true` in `results.json` and a `hook` badge on its report
card.
Actions in a hook use Playwright's 30s default timeout, so check before clicking what may
not be there (as above); `hideSelectors`, `extraCss` and `lottieFrame` apply after `before` and before `beforeShot`.

The settle scrolls the whole page to load lazy content, so a state the scroll changes (a
scroll-spy nav, a container re-measured on scroll) doesn't survive a `before` hook. Set it in
a `beforeShot` hook instead: same signature, but it runs after the settle, right before masks
and the shot. renderdiff doesn't settle again after it, so await whatever it changes. On a
`selector` route the element is still scrolled into view after it.

## Signed-in pages

Save a Playwright storage state once and pass it:

```
npx playwright codegen --save-storage=auth.json https://example.com/login
renderdiff http://localhost:3000 https://example.com /account --storage-state auth.json
```

`--left-storage-state` / `--right-storage-state` give each side its own file, and the
config takes `storageState: "auth.json"` or `{ left, right }`, relative to the config file.
A missing or non-JSON file, or one that isn't a storage state, exits 2 before the browser
starts. The file's contents are never printed; `meta.storageState` and the report name only
each side's file. It holds live session tokens: **never commit it**, and add it to
`.gitignore`. The out dir then holds signed-in screenshots, and their text in
`results.json`, so don't publish or commit that either; add the out dir to `.gitignore` too.

## Cooperating pages

Every page renderdiff loads has `window.__RENDERDIFF__` set to `true` before its first
script, so it can skip what it knows will differ (a live chat widget, a rotating quote).
Do it in both builds, or the side that doesn't is the one that differs.

An element marked `data-renderdiff-mask` is masked like a config mask, on every route and
both sides. The attribute's value is its reason in the report, `rotating quote
(data-renderdiff-mask)` for `data-renderdiff-mask="rotating quote"`, and in the result's
`masked` in `results.json`.
