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
