/**
 * Aborts the fixture tracker script. Appended to DEFAULT_BLOCK_URL_PATTERNS, never
 * replacing it — the test asserts the built-in vendor globs are still listed in the report
 * alongside this one.
 */
export default {
  blockUrlPatterns: ["**/shared/tracker.js"],
};
