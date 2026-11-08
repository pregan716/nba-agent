import { pinSwapContract, candidateKey, combinations } from "./swap.js";
import { digest } from "../runner/config.js";
import { uniform } from "./contract.js";
import {
  COUNT_KEYS,
  type DecisionDataset,
  type ObservableState,
  type Prediction,
} from "./types.js";
export interface Baseline {
  id: string;
  training: {
    gameIds: string[];
    inputHashes: string[];
    windows: number;
    datasets?: {
      gameId: string;
      inputHash: string;
      trainingOnly: DecisionDataset["trainingOnly"] | null;
    }[];
  };
  parameters: unknown;
  predict: (state: ObservableState) => Prediction;
}
const features = (s: ObservableState) => {
  const floor = s.players.filter((p) => s.celtics.includes(p.playerId));
  return [
    1,
    Math.min(4, Math.max(...floor.map((p) => p.currentStintMinutes)) / 6),
    Math.min(3, Math.abs(s.margin) / 15),
    s.period / 4,
    Number(s.stoppage.kind === "timeout"),
    Number(s.stoppage.kind === "between_periods"),
    Math.max(...floor.map((p) => p.personalFouls)) / 6,
  ];
};
const sigmoid = (z: number) =>
  1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
function ranked(keys: string[], weight: (id: string) => number) {
  const sorted = [...keys].sort(
    (a, b) => weight(b) - weight(a) || a.localeCompare(b, "en"),
  );
  const total = (keys.length * (keys.length + 1)) / 2;
  return Object.fromEntries(
    sorted.map((id, i) => [id, (keys.length - i) / total]),
  );
}
export function fitBaselines(
  warmupDatasets: DecisionDataset[],
  statisticalDatasets = warmupDatasets,
): {
  constant: Baseline;
  statistical: Baseline;
} {
  const constant =
    statisticalDatasets !== warmupDatasets
      ? fitBaselines(warmupDatasets).constant
      : null;
  const inputs = [...statisticalDatasets].sort((a, b) =>
    a.gameId.localeCompare(b.gameId),
  );
  const windows = inputs
    .flatMap((d) => d.windows)
    .filter((w) => !w.exclusions.length && w.state && w.actual);
  if (!windows.length) throw Error("No qualified training windows");
  const training = {
    gameIds: inputs.map((d) => d.gameId).sort(),
    inputHashes: inputs.map((d) => d.inputHash).sort(),
    windows: windows.length,
    // Preserve the constant baseline's existing descriptor/id. Extra provenance
    // is needed only for the statistical fit with retrospective training inputs.
    ...(inputs.some((d) => d.trainingOnly)
      ? {
          datasets: inputs.map((d) => ({
            gameId: d.gameId,
            inputHash: d.inputHash,
            trainingOnly: d.trainingOnly ?? null,
          })),
        }
      : {}),
  };
  const rate =
    windows.filter((w) => w.actual!.players_in.length > 0).length /
    windows.length;
  const counts = Object.fromEntries(
    COUNT_KEYS.map((key, i) => [
      key,
      windows.filter((w) => Math.min(3, w.actual!.players_in.length) === i)
        .length / windows.length,
    ]),
  );
  const base = (s: ObservableState, p: number): Prediction => ({
    substitution: { type: "noul", noul: p },
    count: { type: "score", probabilities: uniform(COUNT_KEYS) },
    exit: { type: "choice", probabilities: uniform(s.celtics) },
    entry: { type: "choice", probabilities: uniform(s.eligibleBench) },
  });
  const weights = Array(7).fill(0) as number[];
  weights[0] = Math.log(Math.max(0.001, rate) / Math.max(0.001, 1 - rate));
  for (let iteration = 0; iteration < 500; iteration++) {
    const gradient = weights.map(() => 0);
    for (const w of windows) {
      const x = features(w.state!),
        error =
          sigmoid(x.reduce((sum, v, i) => sum + v * weights[i], 0)) -
          Number(w.actual!.players_in.length > 0);
      for (let j = 0; j < weights.length; j++)
        gradient[j] += (error * x[j]) / windows.length;
    }
    for (let j = 0; j < weights.length; j++)
      weights[j] -= 0.1 * (gradient[j] + (j ? 0.01 * weights[j] : 0));
  }
  return {
    constant: constant ?? {
      id: `constant-v1:${digest({ training, rate })}`,
      training,
      parameters: { rate },
      predict: (s) => base(s, rate),
    },
    statistical: {
      id: `statistical-v1:${digest({ training, weights, counts })}`,
      training,
      parameters: {
        weights,
        counts,
        iterations: 500,
        learningRate: 0.1,
        l2: 0.01,
      },
      predict: (s) => {
        const p = base(
          s,
          sigmoid(features(s).reduce((sum, v, i) => sum + v * weights[i], 0)),
        );
        p.count.probabilities = { ...counts };
        p.exit.probabilities = ranked(
          s.celtics,
          (id) => s.players.find((p) => p.playerId === id)!.currentStintMinutes,
        );
        p.entry.probabilities = ranked(
          s.eligibleBench,
          (id) =>
            s.players.find((p) => p.playerId === id)!.restMs ??
            Number.MAX_SAFE_INTEGER,
        );
        return p;
      },
    },
  };
}

/** Set candidates use the legacy hazard and rank weights, normalized within size.
 * Sizes 3–5 remain entirely in other; the expansion prior is pinned separately. */
export function fitSwapBaselines(warmup: DecisionDataset[], training = warmup) {
  const old = fitBaselines(warmup, training),
    contract = pinSwapContract(warmup);
  const sizeCounts = [0, 0, 0, 0, 0];
  for (const d of training)
    for (const w of d.windows)
      if (!w.exclusions.length && w.state && w.actual?.players_out.length)
        sizeCounts[w.actual.players_out.length - 1]++;
  const total = sizeCounts.reduce((a, b) => a + b, 0),
    prior = sizeCounts.map((n) => n / total);
  return Object.fromEntries(
    Object.entries(old).map(([name, b]) => [
      name,
      {
        ...b,
        id: `${name}-v2:${digest({ old: b.id, contract, prior })}`,
        parameters: {
          legacy: b.parameters,
          swapContract: contract,
          sizePrior: prior,
        },
        predict: (s: ObservableState) => {
          const p = b.predict(s);
          if (name === "constant")
            return {
              substitution: p.substitution,
              swap: { type: "choice", probabilities: { other: 1 } },
              candidates: [],
              degenerate: true,
            };
          const feasible = prior.map((v, i) =>
              i < Math.min(5, s.eligibleBench.length) ? v : 0,
            ),
            z = feasible.reduce((a, b) => a + b, 0);
          const candidates = [1, 2]
            .filter((k) => s.eligibleBench.length >= k)
            .flatMap((k) => {
              const sets = combinations(s.celtics, k).flatMap((out) =>
                combinations(s.eligibleBench, k).map((inside) => ({
                  out,
                  in: inside,
                })),
              );
              const weights = sets.map(
                (c) =>
                  c.out.reduce((a, id) => a * p.exit.probabilities[id], 1) *
                  c.in.reduce((a, id) => a * p.entry.probabilities[id], 1),
              );
              const sum = weights.reduce((a, b) => a + b, 0);
              return sets.map((c, i) => ({
                c,
                key: candidateKey(c),
                p:
                  ((z
                    ? feasible[k - 1] / z
                    : 1 / Math.min(5, s.eligibleBench.length)) *
                    weights[i]) /
                  sum,
              }));
            })
            .sort((a, b) => b.p - a.p || a.key.localeCompare(b.key))
            .slice(0, 8);
          return {
            substitution: p.substitution,
            candidates: candidates.map((x) => x.c),
            swap: {
              type: "choice",
              probabilities: {
                ...Object.fromEntries(candidates.map((x) => [x.key, x.p])),
                other: Math.max(0, 1 - candidates.reduce((a, x) => a + x.p, 0)),
              },
            },
          };
        },
      },
    ]),
  ) as Record<
    "constant" | "statistical",
    Omit<Baseline, "predict"> & { predict: (s: ObservableState) => unknown }
  >;
}
