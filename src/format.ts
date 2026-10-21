/** Number formatting shared by the console summary (`run.ts`) and the HTML report. */
export const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
export const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);
