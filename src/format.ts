import type { ElementDiff } from "./locate.ts";

/** Number formatting shared by the console summary (`run.ts`) and the HTML report. */
/** Down to 4 decimals, so a shot that differs never reads as 100% or clears a threshold it missed. The epsilon absorbs float error like 0.29 * 1e4 = 2899.99…. */
export const floor4 = (n: number) => Math.floor(n * 1e4 + 1e-7) / 1e4;
export const pct = (n: number) => `${(floor4(n) * 100).toFixed(2)}%`;
export const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);
export const fmtRegion = (r: { x: number; y: number; w: number; h: number }) =>
  `${r.w}×${r.h} at (${r.x},${r.y})`;
/** Signed like the height delta: + when left has the extra rows, − when right does. */
export const fmtBand = (b: { side: "left" | "right"; y: number; h: number }) =>
  `${b.side === "left" ? "+" : "-"}${b.h}px at y=${b.y} (${b.side})`;

/** `+sel "text"` / `-sel "text"` for one side only, `sel prop l→r`, else its box deltas (left − right). */
export const fmtElements = (els: ElementDiff[], props = 2) =>
  els
    .map((e) => {
      if (e.side !== "both") return `${e.side === "left" ? "+" : "-"}${e.selector}${e.text ? ` "${e.text}"` : ""}`;
      const changed = Object.entries(e.changed)
        .slice(0, props)
        .map(([p, [l, r]]) => (p === "text" ? `"${l}"→"${r}"` : `${p} ${l}→${r}`));
      if (changed.length) return `${e.selector} ${changed.join(", ")}`;
      const moved = (["x", "y", "w", "h"] as const).flatMap((k) => {
        const d = e.left![k] - e.right![k];
        return d ? [`${k}${signed(d)}`] : [];
      });
      return [e.selector, ...moved].join(" ");
    })
    .join("; ");
