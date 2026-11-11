export const DEFAULT_BOOTSTRAP = { resamples: 10_000, seed: 854_2026 };
export function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const quantile = (sorted: number[], p: number) => {
  if (!sorted.length) return null;
  const x = (sorted.length - 1) * p,
    i = Math.floor(x);
  return (
    sorted[i] +
    (sorted[Math.min(i + 1, sorted.length - 1)] - sorted[i]) * (x - i)
  );
};
