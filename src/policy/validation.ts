import { digest } from "../runner/config.js";
import type { ObservableState } from "../replay/types.js";
import type { JevRequest } from "./request.js";

export interface ValidationInput {
  jev?: boolean;
  samples?: number;
}
export type ValidationJev = (
  request: JevRequest,
  signal: AbortSignal,
) => Promise<unknown>;
export interface Candidate {
  gameId: string;
  windowId?: string;
  state: ObservableState;
}
export const windowId = (sample: Candidate) =>
  sample.windowId ??
  `${sample.gameId}:${sample.state.sequence ?? digest(sample.state)}`;
export function stoppageType(state: ObservableState) {
  const kind = state.stoppage?.kind;
  return ["timeout", "between_periods", "foul", "dead_ball_turnover"].includes(
    kind,
  )
    ? kind
    : "other";
}
const kinds = [
  "timeout",
  "between_periods",
  "foul",
  "dead_ball_turnover",
  "other",
];
/** Round-robin by type, then half, then game; newest games break usage ties.
 * Hashes break window ties without consulting outcomes or input ordering.
 */
export function selectValidationSamples(
  pool: Candidate[],
  count: number,
  releases: Map<string, string>,
) {
  const remaining = [
    ...new Map(pool.map((s) => [`${s.gameId}:${windowId(s)}`, s])).values(),
  ];
  const hashes = new Map(
    remaining.map((s) => [s, digest([s.gameId, windowId(s)])]),
  );
  const selected: Candidate[] = [];
  const usedTypes = new Map<string, number>(),
    usedHalves = new Map<number, number>(),
    usedGames = new Map<string, number>();
  const half = (s: Candidate) => (s.state.period <= 2 ? 0 : 1);
  while (remaining.length && selected.length < count) {
    remaining.sort(
      (a, b) =>
        (usedTypes.get(stoppageType(a.state)) ?? 0) -
          (usedTypes.get(stoppageType(b.state)) ?? 0) ||
        kinds.indexOf(stoppageType(a.state)) -
          kinds.indexOf(stoppageType(b.state)) ||
        (usedHalves.get(half(a)) ?? 0) - (usedHalves.get(half(b)) ?? 0) ||
        (usedGames.get(a.gameId) ?? 0) - (usedGames.get(b.gameId) ?? 0) ||
        (releases.get(b.gameId) ?? "").localeCompare(
          releases.get(a.gameId) ?? "",
        ) ||
        hashes.get(a)!.localeCompare(hashes.get(b)!),
    );
    const next = remaining.shift()!;
    selected.push(next);
    usedTypes.set(
      stoppageType(next.state),
      (usedTypes.get(stoppageType(next.state)) ?? 0) + 1,
    );
    usedHalves.set(half(next), (usedHalves.get(half(next)) ?? 0) + 1);
    usedGames.set(next.gameId, (usedGames.get(next.gameId) ?? 0) + 1);
  }
  return selected;
}
export interface ValidationOutput {
  gameId: string;
  windowId: string;
  request: JevRequest | null;
  prediction?: unknown;
  defer?: unknown;
  predictionValid?: boolean;
  diagnostics: Record<string, unknown> | null;
  answers?: any;
  derived?: import("../replay/swap.js").SwapDerived;
  error?: string;
}
export interface ValidationSummary {
  samples: number;
  answered: number;
  meanSubstitutionProbability: number;
  byStoppage: Record<
    string,
    { n: number; meanSubstitutionProbability: number }
  >;
}
export interface ValidationResult {
  outputs: ValidationOutput[];
  summary: ValidationSummary | null;
  computeSeconds: number;
  error: string | null;
  note?: string;
}
