import { percentiles, type Quantity, type Range } from "./forecast.js";

const levels = [0, ...percentiles.map((p) => p / 100), 1];

export function distribution(stat: Quantity, range: Range) {
  const lower =
    stat === "fantasy_points" ? range[0] - (range[1] - range[0]) : 0;
  const values = [lower, ...range, range[6] + (range[6] - range[5])];
  function quantile(p: number) {
    if (!(p >= 0 && p <= 1)) throw Error("Invalid quantile level");
    const j = levels.findIndex((level) => level >= p);
    if (levels[j] === p) return values[j];
    return (
      values[j - 1] +
      (values[j] - values[j - 1]) *
        ((p - levels[j - 1]) / (levels[j] - levels[j - 1]))
    );
  }
  function probability(mark: number, inequality: ">" | ">=") {
    if (!Number.isFinite(mark)) throw Error("Invalid event threshold");
    let mass = 0;
    for (let j = 1; j < levels.length; j++) {
      const lo = values[j - 1],
        hi = values[j];
      const fraction =
        lo === hi
          ? Number(inequality === ">" ? lo > mark : lo >= mark)
          : Math.max(0, Math.min(1, (hi - mark) / (hi - lo)));
      mass += (levels[j] - levels[j - 1]) * fraction;
    }
    return Math.min(1, mass);
  }
  const mean = values
    .slice(1)
    .reduce(
      (s, x, i) => s + (x + values[i]) * 0.5 * (levels[i + 1] - levels[i]),
      0,
    );
  return { quantile, probability, mean };
}

export function minutes(p: number, range: Range) {
  const conditional = distribution("minutes", range);
  return {
    mean: p * conditional.mean,
    quantile: (t: number) =>
      t <= 1 - p || p === 0
        ? 0
        : conditional.quantile(Math.min(1, (t - (1 - p)) / p)),
  };
}
