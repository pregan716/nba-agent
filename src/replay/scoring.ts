import { rank, validatePrediction } from "./contract.js";
import type { Failure, Scores, Window, WindowResult } from "./types.js";
const same = (a: string[], b: string[]) =>
  a.length === b.length && a.every((p) => b.includes(p));
const mean = (a: number[]) =>
  a.length ? a.reduce((s, n) => s + n, 0) / a.length : null;
export function scoreWindow(
  window: Window,
  raw: unknown,
  failure: Failure | null = null,
): WindowResult {
  const result: WindowResult = {
    window,
    raw,
    failure,
    validation: null,
    scores: null,
  };
  if (
    window.exclusions.length ||
    !window.state ||
    !window.actual ||
    failure === "provider_failure" ||
    failure === "invalid_package"
  )
    return result;
  const v = validatePrediction(
    failure === "assembler_error" ? {} : raw,
    window.state,
  );
  result.validation = v;
  const actual = window.actual,
    k = actual.players_in.length,
    y = Number(k > 0),
    p = v.answers.substitution.noul,
    q = Math.min(0.999, Math.max(0.001, p));
  const selection = (kind: "exit" | "entry", target: string[]) => {
    const probabilities = v.answers[kind].probabilities,
      keys = Object.keys(probabilities),
      order = rank(probabilities);
    return {
      brier: mean(
        keys.map(
          (id) => (k * probabilities[id] - Number(target.includes(id))) ** 2,
        ),
      ),
      top1: Number(target.includes(order[0])),
      topK: Number(same(order.slice(0, k), target)),
    };
  };
  const exit = selection("exit", actual.players_out),
    entry = selection("entry", actual.players_in);
  // Prefix direction distinguishes a wrong entry from a correct exit of the same player.
  const moved = (a: typeof actual) =>
    new Set([
      ...a.players_in.map((p) => `in:${p}`),
      ...a.players_out.map((p) => `out:${p}`),
    ]);
  const target = moved(actual),
    predicted = moved(v.action),
    union = new Set([...target, ...predicted]);
  result.scores = {
    timing: (p - y) ** 2,
    logLoss: -(y * Math.log(q) + (1 - y) * Math.log(1 - q)),
    logLossClipped: q !== p,
    probability: p,
    outcome: y,
    exit: k ? exit.brier : null,
    entry: k ? entry.brier : null,
    exitTop1: k ? exit.top1 : null,
    entryTop1: k ? entry.top1 : null,
    exitTopK: k ? exit.topK : null,
    entryTopK: k ? entry.topK : null,
    exact: Number(
      v.actionValidation.valid &&
        same(v.action.players_out, actual.players_out) &&
        same(v.action.players_in, actual.players_in),
    ),
    overlap: union.size
      ? [...target].filter((p) => predicted.has(p)).length / union.size
      : null,
  };
  return result;
}
export function summarize(results: WindowResult[]) {
  const eligible = results.filter(
      (r) => !r.window.exclusions.length && r.window.state && r.window.actual,
    ),
    scored = results.filter((r) => r.scores),
    scores = scored.map((r) => r.scores!);
  const avg = (key: keyof Scores) =>
    mean(
      scores
        .map((s) => s[key])
        .filter((v): v is number => typeof v === "number"),
    );
  const tp = scores.filter(
      (s) => s.probability >= 0.5 && s.outcome === 1,
    ).length,
    fp = scores.filter((s) => s.probability >= 0.5 && s.outcome === 0).length,
    fn = scores.filter((s) => s.probability < 0.5 && s.outcome === 1).length;
  const failures = eligible.filter(
    (r) => r.failure === "provider_failure",
  ).length;
  const tally = (xs: string[]) =>
    Object.fromEntries(
      [...new Set(xs)].sort().map((k) => [k, xs.filter((x) => x === k).length]),
    );
  return {
    windows: results.length,
    eligible: eligible.length,
    scored: scores.length,
    actualSubstitutions: scores.filter((s) => s.outcome).length,
    excluded: tally(results.flatMap((r) => r.window.exclusions)),
    informational: tally(scored.flatMap((r) => r.window.state!.flags)),
    failures: tally(eligible.flatMap((r) => (r.failure ? [r.failure] : []))),
    providerFailureRate: eligible.length ? failures / eligible.length : null,
    providerFailureFlag:
      eligible.length > 0 && failures / eligible.length > 0.05,
    invalidQuestions: tally(
      scored.flatMap((r) =>
        Object.entries(r.validation!.questions)
          .filter(([, v]) => !v.valid)
          .map(([k]) => k),
      ),
    ),
    invalidActions: scored.filter((r) => !r.validation!.actionValidation.valid)
      .length,
    timingBrier: avg("timing"),
    timingLogLoss: avg("logLoss"),
    clipped: scores.filter((s) => s.logLossClipped).length,
    precision: tp + fp ? tp / (tp + fp) : null,
    recall: tp + fn ? tp / (tp + fn) : null,
    exitBrier: avg("exit"),
    entryBrier: avg("entry"),
    exitTop1: avg("exitTop1"),
    entryTop1: avg("entryTop1"),
    exitTopK: avg("exitTopK"),
    entryTopK: avg("entryTopK"),
    exactAction: avg("exact"),
    partialOverlap: avg("overlap"),
    calibration: Array.from({ length: 10 }, (_, i) => {
      const bin = scores.filter(
        (s) => Math.min(9, Math.floor(s.probability * 10)) === i,
      );
      return {
        lower: i / 10,
        upper: (i + 1) / 10,
        n: bin.length,
        predicted: mean(bin.map((s) => s.probability)),
        observed: mean(bin.map((s) => s.outcome)),
      };
    }),
  };
}
