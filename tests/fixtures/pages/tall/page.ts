/**
 * GUARD RAIL for the tiled capture path.
 *
 * Chromium silently truncates a single screenshot past 16,384px, so `capture()` drops to raw
 * CDP and stitches vertical tiles for anything taller. This page is exactly 18,000px, which
 * is past that cap and well under the 40,000px sanity ceiling, so it lands on the tiled path
 * and needs two tiles (16,000 + 2,000).
 *
 * The height is exact by construction — 100 blocks of exactly 180px, no margins, no page
 * padding — which is what lets the test assert the stitched PNG is 18,000px rather than
 * merely "tall". A stitch that dropped or double-counted a tile would still be tall.
 *
 * Generated rather than written out because 18,000px of markup is not worth keeping by hand.
 * The two sides differ in mechanism, like the equivalence fixtures: flex column against grid
 * auto-rows.
 */

const BLOCK_HEIGHT = 180;
const BLOCKS = 100;

/** The page's exact rendered height. Asserted against the stitched PNG. */
export const EXPECT_HEIGHT = BLOCK_HEIGHT * BLOCKS;

const ORDINALS = [
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];

function page(stack: string, mechanism: string): string {
  const blocks = Array.from({ length: BLOCKS }, (_, i) => {
    const word = ORDINALS[i % ORDINALS.length]!;
    return (
      `<div class="blk"><h3>Block ${i + 1}</h3>` +
      `<p>Section ${word} of a page tall enough to require tiling. ` +
      `Fixed at ${BLOCK_HEIGHT}px so the total height is exact.</p></div>`
    );
  }).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Layout parity</title>
<style>
/* Self-contained: no page padding and no margins anywhere, so the document height is
   exactly ${BLOCKS} x ${BLOCK_HEIGHT} = ${EXPECT_HEIGHT}px. Do not add spacing here without
   updating EXPECT_HEIGHT. */
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { background: #ffffff; color: #16202b; font: 16px/24px ui-monospace, SFMono-Regular, Menlo, monospace; }
h3 { font-size: 16px; line-height: 24px; margin: 0 0 8px; }
p { margin: 0; color: #4a5b6d; }
.blk { height: ${BLOCK_HEIGHT}px; padding: 16px; border-bottom: 1px solid #c9d4e2; overflow: hidden; }
/* ${mechanism} */
${stack}
</style>
</head>
<body>
<div class="stack">
${blocks}
</div>
</body>
</html>
`;
}

export const left = () =>
  page(".stack { display: flex; flex-direction: column; }", "LEFT: flex column");

export const right = () =>
  page(
    `.stack { display: grid; grid-auto-rows: ${BLOCK_HEIGHT}px; }`,
    "RIGHT: grid auto-rows",
  );
