/**
 * GUARD RAIL for `varies` mask suggestions.
 *
 * The sidebar's width changes on every render, so the column beside it moves and resizes
 * between two loads of the same side. The recheck paints both out, but a mask on either
 * would hide the page rather than one drifting value, so none may be suggested.
 *
 * A server-side counter, like `drifting`, so two consecutive loads never share a width.
 */

let renders = 0;

function page(): string {
  renders += 1;
  const side = 160 + (renders % 16) * 8;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Reflowing</title>
<link rel="stylesheet" href="/shared/base.css">
<style>
.cols { display: flex; width: var(--content); }
.side { flex: 0 0 ${side}px; height: 640px; background: var(--fill); }
.body { flex: 1 1 0; height: 640px; overflow: hidden; border: 1px solid var(--line); }
</style>
</head>
<body>
<div class="page">
<h1>Reflowing layout guard rail</h1>
<div class="cols">
<aside class="side">Sidebar</aside>
<div class="body">
<p>The sidebar beside this column takes a different width on every load, so this column starts and ends somewhere else each time. Masking it would paint over the page, not over one value that drifts.</p>
<p>Fixed heights keep the document the same height on every load, so only the boxes move.</p>
</div>
</div>
</div>
</body>
</html>
`;
}

export const left = () => page();
export const right = () => page();
