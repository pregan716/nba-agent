import { compatibility } from "./compare.js";
import { metrics, type EvaluatedRun } from "./evaluate.js";
import { canonical, EvaluationError } from "./record.js";
import { isMidPeriod } from "../replay/diagnostics.js";
import type { WindowResult } from "../replay/types.js";
export const BASELINES = [
  "constant",
  "statistical",
  "generic-jev",
  "starter",
] as const;
export const baselineName = (run: EvaluatedRun) =>
  !run.variant
    ? BASELINES.find(
        (name) =>
          run.predictor === name || run.predictor.startsWith(name + "-v"),
      )
    : undefined;
const key = (r: WindowResult) => `${r.window.gameId}:${r.window.id}`;
export function referenceRuns(run: EvaluatedRun, runs: EvaluatedRun[]) {
  const candidates = runs.filter((r) => baselineName(r));
  for (const other of candidates) {
    const check = compatibility(run, other);
    if (check.reasons.length)
      throw new EvaluationError(check.reasons[0], `${run.id} / ${other.id}`);
  }
  for (const name of BASELINES)
    if (candidates.filter((r) => baselineName(r) === name).length > 1)
      throw new EvaluationError("ambiguous_baseline", name);
  return candidates;
}
export function withReferences(
  rows: WindowResult[],
  references: EvaluatedRun[],
) {
  const basic = (subset: WindowResult[]) => {
    const own = metrics(subset);
    const baselines: Record<
      string,
      {
        runId: string | null;
        reason: string | null;
        metrics: ReturnType<typeof metrics> | null;
      }
    > = Object.fromEntries(
      BASELINES.map((name) => {
        const run = references.find((r) => baselineName(r) === name);
        if (!run)
          return [
            name,
            { runId: null, reason: "baseline_not_supplied", metrics: null },
          ];
        const ids = new Set(subset.map((r) => r.window.gameId));
        const games = run.games.filter((g) => ids.has(g.game.gameId));
        const map = new Map(
          games.flatMap((g) => g.rows).map((r) => [key(r), r]),
        );
        const scored = subset.filter((r) => r.scores);
        for (const row of subset)
          if (
            map.has(key(row)) &&
            canonical(map.get(key(row))!.window) !== canonical(row.window)
          )
            throw new EvaluationError("window_identity_mismatch", key(row));
        const reason = games.some((g) => !g.complete)
          ? "incomplete_replay"
          : scored.some((r) => !map.get(key(r))?.scores)
            ? "baseline_missing_scored_windows"
            : !scored.length
              ? "no_scored_windows"
              : null;
        return [
          name,
          {
            runId: run.id,
            reason,
            metrics: reason
              ? null
              : metrics(scored.map((r) => map.get(key(r))!)),
          },
        ];
      }),
    );
    const statistical = baselines.statistical;
    const loss = statistical.metrics?.timingBrier;
    for (const ref of Object.values(baselines))
      if (ref.metrics) {
        ref.metrics.timingSkillVsStatistical =
          loss != null && loss > 0 && ref.metrics.timingBrier !== null
            ? 1 - ref.metrics.timingBrier / loss
            : null;
        ref.metrics.timingSkillVsStatisticalReason =
          statistical.reason ?? (loss === 0 ? "zero_reference_loss" : null);
      }
    return {
      ...own,
      baselines,
      timingSkillVsStatistical:
        loss != null && loss > 0 && own.timingBrier !== null
          ? 1 - own.timingBrier / loss
          : null,
      timingSkillVsStatisticalReason:
        statistical.reason ?? (loss === 0 ? "zero_reference_loss" : null),
    };
  };
  const full = basic(rows);
  return {
    ...full,
    midPeriod: basic(rows.filter(isMidPeriod)),
    byStoppage: Object.fromEntries(
      Object.keys(full.byStoppage).map((kind) => [
        kind,
        basic(
          rows.filter(
            (r) => (r.window.state?.stoppage?.kind ?? "unknown") === kind,
          ),
        ),
      ]),
    ),
  };
}
