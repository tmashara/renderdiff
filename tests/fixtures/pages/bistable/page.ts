/**
 * GUARD RAIL for `renderdiff probe`.
 *
 * A player box that is 366px tall on odd renders and 380px on even ones, the way an embed
 * that sometimes gets its controls bar does. Every load is still, so a run only sees it as a
 * base-vs-base difference; probe must name the box and its two heights. Generated because the
 * counter has to live on the server.
 */

let renders = 0;

const page = () => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Layout parity</title>
<link rel="stylesheet" href="/shared/base.css">
<style>
.player { height: ${++renders % 2 ? 366 : 380}px; background: var(--fill); border: 1px solid var(--line); }
.band { height: 480px; padding: 16px; margin-top: var(--gap); background: var(--fill); border: 1px solid var(--line); overflow: hidden; }
</style>
</head>
<body>
<div class="page">
<h1>Bistable guard rail</h1>
<p class="lede">The box below is one of two heights, alternating per render. Each load is still, but two loads of the same page disagree.</p>

<div class="player"></div>

<section class="band">
<h2>Static content</h2>
<p>Everything else on this page is fixed, so the only thing that varies between loads is the player's height and what it pushes down.</p>
</section>

<section class="notes">
<h2>Notes</h2>
<p>A difference between two builds of the same base can come from the page itself. Loading one side several times shows which elements vary on their own.</p>
</section>
</div>
</body>
</html>
`;

export const left = page;
export const right = page;
