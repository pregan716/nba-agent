import type { WindowResult, Scores } from "./types.js";
const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
export const isMidPeriod = (r: WindowResult) =>
  r.window.kind !== "between_periods" &&
  r.window.state?.stoppage?.kind !== "between_periods";
/** Deciles within each game; pooled terms are weighted by scored windows. */
export function diagnosticMetrics(rows: WindowResult[]) {
  const scored = rows.filter((r) => r.scores),
    scores = scored.map((r) => r.scores!);
  const average = (key: keyof Scores) =>
    mean(
      scores
        .map((s) => s[key])
        .filter((n): n is number => typeof n === "number"),
    );
  let reliability = 0,
    resolution = 0,
    uncertainty = 0;
  for (const game of new Set(scored.map((r) => r.window.gameId))) {
    const ss = scored
      .filter((r) => r.window.gameId === game)
      .map((r) => r.scores!);
    const rate = mean(ss.map((s) => s.outcome))!;
    uncertainty += ss.length * rate * (1 - rate);
    for (let i = 0; i < 10; i++) {
      const bin = ss.filter(
        (s) => Math.min(9, Math.floor(s.probability * 10)) === i,
      );
      if (!bin.length) continue;
      const p = mean(bin.map((s) => s.probability))!,
        y = mean(bin.map((s) => s.outcome))!;
      reliability += bin.length * (p - y) ** 2;
      resolution += bin.length * (y - rate) ** 2;
    }
  }
  const n = scores.length,
    brier = average("timing");
  const constant = n ? uncertainty / n : null;
  const decomposition = n
    ? {
        bins: 10,
        pooling: "window-weighted within-game deciles",
        reliability: reliability / n,
        resolution: resolution / n,
        uncertainty: constant!,
        binningError: brier! - (reliability - resolution + uncertainty) / n,
      }
    : null;
  return {
    n,
    timingBrier: brier,
    timingConstantBrier: constant,
    timingSkillVsConstant:
      constant !== null && constant > 0 ? 1 - brier! / constant : null,
    timingSkillVsConstantReason: !n
      ? "no_scored_windows"
      : constant === 0
        ? "zero_reference_loss"
        : null,
    timingSkillVsStatistical: null as number | null,
    timingSkillVsStatisticalReason: "baseline_not_supplied" as string | null,
    meanPredicted: average("probability"),
    observedRate: average("outcome"),
    brierDecomposition: decomposition,
    setLogLoss: average("setLogLoss"),
    setLogLossClips: scores.reduce((n, s) => n + (s.setLogLossClips ?? 0), 0),
    candidateHitRate: average("candidateHit"),
    setTop1: average("setTop1"),
    meanCandidates: average("candidateCount"),
    otherMass: average("otherMass"),
    setN: scores.filter((s) => typeof s.setLogLoss === "number").length,
    playerN: scores.filter((s) => s.outcome === 1).length,
    exitBrier: average("exit"),
    entryBrier: average("entry"),
    exitTop1: average("exitTop1"),
    entryTop1: average("entryTop1"),
    exitTopK: average("exitTopK"),
    entryTopK: average("entryTopK"),
    exitLogLoss: average("exitLogLoss"),
    entryLogLoss: average("entryLogLoss"),
    exitMRR: average("exitMRR"),
    entryMRR: average("entryMRR"),
    exitLogLossClips: scores.reduce((n, s) => n + (s.exitLogLossClips ?? 0), 0),
    entryLogLossClips: scores.reduce(
      (n, s) => n + (s.entryLogLossClips ?? 0),
      0,
    ),
  };
}
export function diagnosticBreakdowns(rows: WindowResult[]) {
  return {
    ...diagnosticMetrics(rows),
    midPeriod: diagnosticMetrics(rows.filter(isMidPeriod)),
    byStoppage: Object.fromEntries(
      [
        ...new Set(
          rows
            .filter((r) => r.scores)
            .map((r) => r.window.state?.stoppage?.kind ?? "unknown"),
        ),
      ]
        .sort()
        .map((kind) => [
          kind,
          diagnosticMetrics(
            rows.filter(
              (r) => (r.window.state?.stoppage?.kind ?? "unknown") === kind,
            ),
          ),
        ]),
    ),
  };
}
