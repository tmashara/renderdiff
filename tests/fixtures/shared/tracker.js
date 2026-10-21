/*
 * Stands in for third-party analytics / A/B tooling.
 *
 * The point it makes is the one `DEFAULT_BLOCK_URL_PATTERNS` exists for: this script
 * rewrites the DOM, so CSS cannot pre-empt it — the only reliable answer is to stop the
 * request. It prepends an opaque 120px band, which pushes the whole page down and is
 * therefore impossible to miss in a diff.
 *
 * Loaded only by `pages/tracker/left.html`. When the request is aborted, none of this runs.
 */
(() => {
  const inject = () => {
    const band = document.createElement("div");
    band.id = "tracker-band";
    band.textContent = "experiment cohort B";
    band.setAttribute(
      "style",
      "height:120px;background:#c62828;color:#ffffff;font:16px/120px ui-monospace,monospace;text-align:center",
    );
    document.body.insertBefore(band, document.body.firstChild);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", inject);
  } else {
    inject();
  }
})();
