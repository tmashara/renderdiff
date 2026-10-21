/**
 * Masks the drifting counter on `/drifting`.
 *
 * No `left` / `right` here: the fixture origins bind to ephemeral ports, so the test passes
 * them as flags. That is also a live check of the documented precedence — a config file that
 * omits a value leaves the flag in charge.
 */
export default {
  masks: [
    {
      urlPath: "/drifting",
      reason: "render counter on /drifting differs between the two origins",
      locate: (page) => page.locator("[data-drift]"),
    },
  ],
};
