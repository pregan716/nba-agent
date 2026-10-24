import { digest } from "../runner/config.js";
import type { Report, ScoredQuestion } from "./report.js";
const average = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const key = (r: ScoredQuestion) =>
  JSON.stringify([r.gameId, r.questionId, r.player, r.stat, r.line, r.q]);
/** Deterministic PRNG: reproducible uncertainty, never model sampling. */
function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
export function compare(a: Report, b: Report, iterations = 10000, seed = 782) {
  if (!Number.isInteger(iterations) || iterations < 100)
    throw Error("At least 100 bootstrap samples required");
  const right = new Map(
    b.rows.filter((r) => r.skill !== null).map((r) => [key(r), r]),
  );
  const pairs = a.rows
    .filter((r) => r.skill !== null && right.has(key(r)))
    .map((r) => {
      const other = right.get(key(r))!;
      if (r.outcome !== other.outcome || r.actual !== other.actual)
        throw Error("Conflicting matched outcomes");
      return { game: r.gameId, delta: r.skill! - other.skill! };
    });
  const games = [...new Set(pairs.map((p) => p.game))].sort();
  const groups = games.map((g) =>
    pairs.filter((p) => p.game === g).map((p) => p.delta),
  );
  const difference = average(pairs.map((p) => p.delta));
  const rng = random(seed),
    samples: number[] = [];
  for (let i = 0; groups.length && i < iterations; i++) {
    let sum = 0,
      count = 0;
    for (let j = 0; j < groups.length; j++) {
      const group = groups[Math.floor(rng() * groups.length)];
      sum += group.reduce((a, b) => a + b, 0);
      count += group.length;
    }
    samples.push(sum / count);
  }
  samples.sort((a, b) => a - b);
  const influential = games
    .map((game) => {
      const without = average(
        pairs.filter((p) => p.game !== game).map((p) => p.delta),
      );
      return {
        game,
        without,
        change:
          without === null || difference === null ? null : without - difference,
      };
    })
    .sort(
      (a, b) =>
        Math.abs(b.change ?? 0) - Math.abs(a.change ?? 0) ||
        a.game.localeCompare(b.game),
    )
    .slice(0, 5);
  const axes = (
    ["profile", "budget", "harnessVersion", "devig"] as const
  ).filter((k) => digest(a[k]) !== digest(b[k]));
  const profileAxes = Object.keys(a.profile).filter(
    (k) =>
      digest(a.profile[k as keyof typeof a.profile]) !==
      digest(b.profile[k as keyof typeof b.profile]),
  );
  return {
    left: a.runId,
    right: b.runId,
    direction: "left minus right",
    matchedQuestions: pairs.length,
    matchedGames: games.length,
    difference,
    bootstrap: {
      unit: "game",
      iterations,
      seed,
      interval90: samples.length
        ? [
            samples[Math.floor((samples.length - 1) * 0.05)],
            samples[Math.ceil((samples.length - 1) * 0.95)],
          ]
        : null,
    },
    influential,
    withoutFive: average(
      pairs
        .filter((p) => !influential.some((g) => g.game === p.game))
        .map((p) => p.delta),
    ),
    axes,
    profileAxes,
    warnings: axes
      .filter((k) => k !== "profile")
      .map((k) => `Comparison differs in ${k}`),
    costs: { left: a.cost, right: b.cost },
    efficiency: { left: a.efficiency, right: b.efficiency },
  };
}
/** Compare replicate means on their common resolved questions, not changing coverage. */
export function replicateSpread(reports: Report[]) {
  const groups = new Map<string, Report[]>();
  for (const r of reports) {
    const id = digest([
      r.profile,
      r.budget,
      r.harnessVersion,
      r.devig,
      r.purpose,
    ]);
    groups.set(id, [...(groups.get(id) ?? []), r]);
  }
  return [...groups.entries()].map(([configuration, runs]) => {
    const common = runs[0].rows.filter(
      (r) =>
        r.skill !== null &&
        runs.every((run) =>
          run.rows.some((s) => s.skill !== null && key(s) === key(r)),
        ),
    );
    const means = runs.map((run) =>
      average(
        common.map((r) => run.rows.find((s) => key(s) === key(r))!.skill!),
      ),
    );
    const values = means.filter((n): n is number => n !== null),
      center = average(values);
    return {
      configuration,
      runs: runs.map((r) => r.runId),
      replicates: runs.map((r) => r.replicateId),
      matchedQuestions: common.length,
      means,
      standardDeviation:
        values.length > 1
          ? Math.sqrt(
              values.reduce((n, v) => n + (v - center!) ** 2, 0) /
                (values.length - 1),
            )
          : null,
      range: values.length ? Math.max(...values) - Math.min(...values) : null,
    };
  });
}
