export default {
  routes: ["/alpha", "/beta"],
  widths: [1440],
  threshold: 0.9,
  concurrency: 3,
  outDir: "from-config",
  hideSelectors: [".fixture-banner"],
  blockUrlPatterns: ["**://*.fixture.example/**"],
  extraCss: ".fixture-late { display: none !important }",
};
