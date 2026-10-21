/**
 * GUARD RAIL for masks.
 *
 * Models content that renders on both sides but whose value drifts — a live counter, a
 * clock, "N minutes ago". Unmasked it must score below parity; masked it must reach parity,
 * because both sides get painted over and the noise cancels.
 *
 * The drift comes from a server-side counter rather than `Date.now()` on purpose. A
 * timestamp is the more realistic source, but its low digits can coincide between two loads
 * and the test would then flake at a rate nobody would ever debug. One shared counter,
 * incremented per render, guarantees the left and right captures disagree every single time —
 * and the counter is multiplied out so that most of the digits change, not just the last one.
 *
 * Generated rather than static because a static file cannot drift.
 */

let renders = 0;

/** 13 digits, most of which change between consecutive renders. */
function driftValue(): string {
  renders += 1;
  return String(renders * 1234567891).padStart(13, "0").slice(-13);
}

function page(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Layout parity</title>
<link rel="stylesheet" href="/shared/base.css">
<style>
/* A fixed box, so masking it costs no reflow. That is the whole reason this is a mask and
   not a display:none — "9.9k" and "10.0k" size their boxes differently and would shove
   their neighbours around. */
.drift {
  width: var(--content); height: 160px; padding: 16px;
  background: var(--fill); border: 1px solid var(--line);
  font: 96px/128px ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow: hidden;
}
.band { height: 240px; padding: 16px; margin-top: var(--gap); background: var(--fill); border: 1px solid var(--line); overflow: hidden; }
@media (max-width: 480px) {
  .drift { width: 100%; font-size: 32px; line-height: 48px; }
}
</style>
</head>
<body>
<div class="page">
<h1>Drifting value guard rail</h1>
<p class="lede">The number below differs between the two origins by construction. Unmasked it must cost the score; masked it must cost nothing.</p>

<div class="drift" data-drift>${driftValue()}</div>

<section class="band">
<h2>Static content</h2>
<p>Everything on this page other than the counter is identical on both sides, so the whole of the difference is attributable to the one box.</p>
</section>

<section class="band">
<h2>More static content</h2>
<p>A second band, so the document is taller than the viewport and the shot is of the page rather than the fold.</p>
</section>

<section class="notes">
<h2>Notes</h2>
<p>Every mask is coverage given up, so the list should stay short and hold only what is proven to drift. Declaring them as data rather than as branches is what lets the report list the same reasons it actually masked, instead of restating them in prose that goes stale.</p>
<p>A mask paints over both sides, so the region can neither pass nor fail. That is the honest trade: the counter is excluded from the measurement rather than being quietly forgiven.</p>
</section>
</div>
</body>
</html>
`;
}

export const left = () => page();
export const right = () => page();
