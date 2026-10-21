/**
 * A TypeScript config. Exercises the type-stripping load path, which is the one that needs
 * Node >= 22.18 and has its own error hint in `loadConfig`.
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
