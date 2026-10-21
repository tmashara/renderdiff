/** Number formatting shared by the console summary (`run.ts`) and the HTML report. */
export const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
export const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);
export const fmtRegion = (r: { x: number; y: number; w: number; h: number }) =>
  `${r.w}×${r.h} at (${r.x},${r.y})`;
/** Signed like the height delta: + when left has the extra rows, − when right does. */
export const fmtBand = (b: { side: "left" | "right"; y: number; h: number }) =>
  `${b.side === "left" ? "+" : "-"}${b.h}px at y=${b.y} (${b.side})`;
