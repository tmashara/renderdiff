# How renderdiff makes two loads comparable

A clean result only means something if both sides were loaded the same way and measured
honestly. This is what renderdiff does to make sure of that.

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
  seeded, timezone (UTC), locale (en-US), colour scheme (light) and
  `prefers-reduced-motion` are fixed, and videos are paused at frame 0. A clock that shows
  seconds can still tick between the two sides and may need a mask.
- **Kills animation, transitions and caret blink**, and hides common consent banners and
  dev toolbars.
- **Settles the page** — makes native lazy images eager, scrolls every viewport-height
  slice a frame at a time so script lazy loaders fire, waits for every image to decode,
  `document.fonts.ready` (at most 5s) and up to 3s for the network to go 250ms with nothing in flight
  (server-sent events and beacons don't count), then re-injects the stylesheet to
  catch late-injected chrome. Stylesheets that failed or answered ≥ 400 (blocked URLs
  aside) and font faces that failed (blocked font files included) are recorded per side as
  `failed`, and keep the route off the `clean:` line.
- **Shoots until stable** — repeats the screenshot until two in a row match (at most 3; 2
  for tiled pages). Pixels still changing between the last two shots of the same load are
  noise from that origin: they're painted magenta on both sides, reported per comparison
  as `unstable`, and excluded from the measurement — the score is over the remaining
  pixels. A route more than 25% unstable errors as `page did not settle`.
- **Isolates state** — one browser context per origin, so cookies and localStorage never
  cross (a storage state file seeds each context on its own). Both sides of a route load at
  the same time.
- **Retries once** per shot; a live site can time out on a cold edge.
- **Replays, never reuses, a cached reference.** With `--cache-right`, the right side's network
  traffic comes from a HAR recorded by an earlier run, but the page is still loaded, settled and
  shot under this run's clock. Element attribution needs the live document anyway, so nothing
  measured is reused. A recording is used only while it's under an hour old, covers every shot in
  the run, and was made with the same right origin, right storage state, blocked URLs, pinned
  context options, renderdiff version and browser. Otherwise the right side loads live and is
  recorded again. A request the recording lacks goes to the network. Shots that errored aren't
  recorded, so an error is never replayed. The run says when it replayed (`right:` line,
  `meta.rightCache`), because a recording can't see a deploy to the reference.
- **Stitches tall pages.** A single screenshot past 16,384px can come out truncated or
  wrapped (Chrome repeats the top of the page; recent headless Chromium does not), so taller
  pages, and element shots taller than that, are captured as tiles through CDP and stitched
  back together. Masks are painted onto the final image from each element's bounding box,
  so they apply the same way on both paths. Past 40,000px it errors — that's a broken
  layout, not a page.

Every run's report ends with a "What was neutralized" section listing the actual block
patterns, mask reasons and pinned settings in effect, so the report can't drift from the
config.
