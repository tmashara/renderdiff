// Copy to `renderdiff.config.ts` in the directory you run `renderdiff` from.
//
// Everything here is optional, and CLI flags always win over it. The type import and
// `satisfies` are for editor types only: Node erases both, so this loads without
// renderdiff installed in the project.
import type { RenderdiffConfig } from "renderdiff";

export default {
  // The two origins. The tool has no notion of which is "prod" — it just diffs them.
  left: "http://localhost:3000",
  right: "https://example.com",

  // Diffed when you run bare `renderdiff` with no positional routes. `/a::/b` (or
  // `{ left: "/a", right: "/b" }`) loads /a on the left and /b on the right — for a page
  // the migration moved. `selector` compares one element instead of the page (a string,
  // or `{ left, right }`); it must match exactly one, and `--selector` replaces it. List a
  // route once per selector to compare several components of it.
  routes: [
    "/",
    "/about",
    "/pricing::/plans",
    { left: "/blog", right: "/posts" },
    { left: "/pricing", selector: { left: ".plans-v2", right: ".plans" } },
  ],

  // Replaces the default set (1440, 1152, 896, 704, 375).
  widths: [1440, 896, 375],

  // Non-zero exit if any comparison scores below this.
  threshold: 0.97,

  // Relative to the directory you run in. Wiped at the start of each run.
  outDir: "renderdiff-out",

  // Captures run in parallel. Keep it low if the right origin is someone's live site.
  concurrency: 2,

  // Appended to the built-in analytics/consent/A-B blocklist. Aborted at the network
  // layer on BOTH sides — blocking asymmetrically is itself a diff.
  blockUrlPatterns: ["**://*.my-tracker.example/**"],

  // Appended to the built-in consent-banner and dev-toolbar selectors.
  //
  // Two rules: match the element EXACTLY (consent scripts also stamp classes on <html>,
  // and a substring selector will hide the whole document — blank matches blank, so
  // every page then "passes"), and hide rather than remove (removing after the cookie
  // script has run wedges the renderer and screenshots hang).
  hideSelectors: [".site-cookie-banner", "#promo-ribbon"],

  // Raw CSS injected after the built-in rules. An escape hatch for the odd case that
  // a selector list cannot express.
  extraCss: `.hero video { visibility: hidden !important }`,

  // Content that renders on both sides but whose value drifts. Painted over on both,
  // so the noise cancels out instead of scoring against you.
  //
  // Masks rather than CSS because these occupy a box: hiding one reflows the page, and
  // `visibility:hidden` is no better — "9.9k" and "10.0k" size their box differently
  // and shove their flex neighbours around.
  //
  // Keep the list short. Every mask is coverage given up, so add only what is proven
  // to drift. Each `reason` is printed verbatim in the report, so the report stays
  // honest about what it did not measure.
  //
  // Each needs exactly one of `selector` (a Playwright selector) or `locate`. Without
  // `urlPath` it applies to every route; on a pair it matches either side's path.
  masks: [
    {
      // Baked in at build time from a nightly job, so a local tree and a production
      // build days apart legitimately disagree.
      urlPath: "/pricing",
      reason: "live star count on /pricing",
      selector: "[data-star-count]",
    },
    {
      // The escape hatch, for what a selector can't say: here, matching by text because
      // the element carries only utility classes. A clock rendered from `new Date()` in
      // the browser rarely needs a mask (both sides start at the same instant); this one
      // is rendered on the server.
      urlPath: "/events",
      reason: "server-rendered clock on /events",
      locate: (page) => page.getByText(/^\d{1,2}:\d{2}(AM|PM)$/),
    },
  ],
} satisfies RenderdiffConfig;
