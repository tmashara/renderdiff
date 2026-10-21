/**
 * A TypeScript config. Exercises the type-stripping load path.
 */
interface FixtureConfig {
  routes: string[];
  widths: number[];
  threshold: number;
}

const config: FixtureConfig = {
  routes: ["/gamma"],
  widths: [896],
  threshold: 0.5,
};

export default config;
