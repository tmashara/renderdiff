/**
 * GUARD RAIL for the settle retry.
 *
 * `unsettled`'s page, except that only the first render, on whichever side loads first,
 * recolours. The first attempt trips the unstable-pixel cap; the retry renders two static
 * pages and must compare clean. Generated because the counter has to live on the server.
 */

let renders = 0;

const RECOLOUR = `<script>
let n = 0;
setInterval(() => {
  n++;
  document.body.style.background = "rgb(" + ((n * 53) % 256) + ", " + ((n * 97) % 256) + ", " + ((n * 29) % 256) + ")";
}, 10);
</script>`;

const page = () => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Layout parity</title>
<link rel="stylesheet" href="/shared/base.css">
</head>
<body>
<div class="page">
<h1>Unsettled once guard rail</h1>
<p class="lede">On its first load the page background changes colour every ten milliseconds. Every later load is still, so a second attempt has a page to measure.</p>

<section class="notes">
<h2>Notes</h2>
<p>A page that did not settle may only have been slow once. The pair is shot again before it is refused, and a still second attempt scores like any other page.</p>
</section>
</div>
${++renders === 1 ? RECOLOUR : ""}
</body>
</html>
`;

export const left = page;
export const right = page;
