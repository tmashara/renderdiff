// Copy to `renderdiff.config.ts` in the directory you run `renderdiff` from.
//
// Everything here is optional, and CLI flags always win over it. The type import and
// `satisfies` are for editor types only: Node erases both, so this loads without
// renderdiff installed in the project.
import type { RenderdiffConfig } from "renderdiff";

export default {
  // left: the build you changed. right: the reference you must match, best a local build
  // of the base commit (production adds deploy drift). The +/- signs in the output and
  // text.added/removed in results.json are written from left's point of view.
  left: "http://localhost:3001",
  right: "http://localhost:3002",

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
    // `before` runs on each side after the page loads, before it settles and is shot, so
    // the open menu is what gets measured. Replaces the top-level `before` for this route.
    {
      left: "/docs",
      before: async (page) => {
        await page.click("[aria-label=Menu]");
      },
    },
  ],

  // For every route without its own `before`, CLI routes included. Gets
  // `{ side, route, width }`; use `side` only for markup that legitimately differs per
  // side, never to make the two sides look alike. A throw is a route error, not retried.
  // Actions use Playwright's 30s default timeout, so check first for what may not be
  // there. hideSelectors and extraCss apply after the hook.
  before: async (page) => {
    const accept = page.getByRole("button", { name: "Accept" });
    if (await accept.isVisible()) await accept.click();
  },

  // Playwright storage state (cookies, localStorage) each side starts with, e.g. signed
  // in: `npx playwright codegen --save-storage=auth.json <url>`. One file, or
  // `{ left, right }`. Relative to this file. It holds live session tokens: never commit
  // it, and add it to .gitignore. The out dir then holds signed-in screenshots and text,
  // so keep it out of git and don't publish it either. `--storage-state` replaces it.
  storageState: "auth.json",

  // Replaces the default set (1440, 1152, 896, 704, 375).
  widths: [1440, 896, 375],

  // Exit 1 only when a comparison scores below this, instead of on any difference.
  // 0 never fails on one.
  threshold: 0.97,

  // Relative to the directory you run in. Wiped at the start of each run.
  outDir: "renderdiff-out",

  // Captures run in parallel. Default half the CPU cores, between 2 and 8. Keep it low if
  // the right origin is someone's live site.
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
  extraCss: `.chat-launcher { visibility: hidden !important }`,

  // Videos are kept from playing (each shows its poster) and video.js captions and
  // control bars are hidden. false, or --no-freeze-video, lets them play.
  freezeVideo: true,

  // Mask every iframe on every route (embeds that differ per load). Same as --mask-media.
  maskMedia: false,

  // Also diff every element's computed style, and say whether the markup is identical
  // apart from asset hashes. Same as --computed. Pixels still decide the score.
  computed: false,

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
  // `--mask <sel>` adds one for every route.
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
