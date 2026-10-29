/** Masks the three boxes of `/mask-geometry`: one that moves, one clipped, one overflowing. */
export default {
  masks: [
    { urlPath: "/mask-geometry", reason: "moves after settle", selector: ".moves" },
    { urlPath: "/mask-geometry", reason: "cut by its wrapper", selector: ".clipped" },
    { urlPath: "/mask-geometry", reason: "player with a poster above it", selector: ".player" },
  ],
};
