/** `mask-drifting.mjs` as a selector: no function, no `urlPath`, so it applies to every route. */
export default {
  masks: [{ selector: "[data-drift]", reason: "render counter, by selector" }],
};
