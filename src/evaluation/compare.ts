import { isMidPeriod } from "../replay/diagnostics.js";
import { canonical } from "./record.js";
import {
  metrics,
  PRIMARY,
  spending,
  costFor,
  tally,
  unscoredReasons,
  type EvaluatedRun,
  type Metric,
} from "./evaluate.js";
import type { WindowResult } from "../replay/types.js";
export const DEFAULT_BOOTSTRAP = { resamples: 10_000, seed: 854_2026 };
export type Bootstrap = typeof DEFAULT_BOOTSTRAP;
export function validateBootstrap(options: Bootstrap) {
  if (
    !Number.isInteger(options.resamples) ||
    options.resamples < 1 ||
    options.resamples > 100000 ||
    !Number.isInteger(options.seed) ||
    options.seed < 0 ||
    options.seed > 0xffffffff
  )
    throw Error("bootstrap_options: resamples 1..100000; seed is uint32");
}
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const quantile = (sorted: number[], p: number) => {
  if (!sorted.length) return null;
  const x = (sorted.length - 1) * p,
    i = Math.floor(x);
  return (
    sorted[i] +
    (sorted[Math.min(i + 1, sorted.length - 1)] - sorted[i]) * (x - i)
  );
};
export function compatibility(a: EvaluatedRun, b: EvaluatedRun) {
  const x = a.descriptors,
    y = b.descriptors;
  const reasons: string[] = [];
  if ((x.jevContract ?? "prediction-v1") !== (y.jevContract ?? "prediction-v1"))
    reasons.push("jev_contract_mismatch");
  else if (canonical(x.swapContract) !== canonical(y.swapContract))
    reasons.push("jev_contract_prior_mismatch");
  if (canonical(x.dataset) !== canonical(y.dataset))
    reasons.push("decision_dataset_mismatch");
  if (x.state !== y.state) reasons.push("state_schema_mismatch");
  if (!x.jev || !y.jev) reasons.push("jev_identity_unavailable");
  else if (canonical(x.jev) !== canonical(y.jev))
    reasons.push("jev_model_or_settings_mismatch");
  if (
    canonical(x.games) !== canonical(y.games) ||
    canonical(x.selectedGames) !== canonical(y.selectedGames)
  )
    reasons.push("game_list_mismatch");
  const flags: string[] = [];
  if (x.harnessVersion !== y.harnessVersion)
    flags.push("harness_version_differs");
  if (canonical(x.budget) !== canonical(y.budget))
    flags.push("budget_profile_differs");
  const axes = [
    ...new Set([
      ...Object.keys(x.profile ?? {}),
      ...Object.keys(y.profile ?? {}),
    ]),
  ]
    .sort()
    // Baselines are predictors, not points on the memory axis.
    .filter(
      (k) => k !== "baseline" && (k !== "memory" || (a.variant && b.variant)),
    )
    .filter((k) => canonical(x.profile?.[k]) !== canonical(y.profile?.[k]));
  if (a.predictor !== b.predictor) axes.push("predictor");
  if (flags.includes("harness_version_differs")) axes.push("harnessVersion");
  if (flags.includes("budget_profile_differs")) axes.push("budget");
  return { reasons, flags, differingAxes: axes };
}
const key = (r: WindowResult) => `${r.window.gameId}:${r.window.id}`;
const stat = (rows: WindowResult[], metric: Metric) => {
  const summary = metrics(rows);
  return {
    value: summary[metric],
    n:
      metric === "timingBrier"
        ? summary.scored
        : metric === "setLogLoss"
          ? summary.setN
          : summary.actualSubstitutions,
  };
};
const pooled = (xs: { value: number | null; n: number }[]) => {
  const n = xs.reduce((s, x) => s + x.n, 0);
  return n ? xs.reduce((s, x) => s + (x.value ?? 0) * x.n, 0) / n : null;
};
function efficiency(value: number | null, cost: ReturnType<typeof spending>) {
  return {
    scorePerUsd:
      value !== null && cost.totalUsd !== null && cost.totalUsd > 0
        ? value / cost.totalUsd
        : null,
    scorePerRecordedSecond:
      value !== null &&
      cost.recordedSeconds !== null &&
      cost.recordedSeconds > 0
        ? value / cost.recordedSeconds
        : null,
  };
}
/** Right-minus-left cost; improvement is left-minus-right loss. Signed ratios
 * remain meaningful when the right side is cheaper; zero/unknown is undefined. */
function marginal(
  left: number | null,
  right: number | null,
  leftCost: ReturnType<typeof spending>,
  rightCost: ReturnType<typeof spending>,
) {
  const reduction = left !== null && right !== null ? left - right : null;
  const deltaUsd =
    leftCost.totalUsd !== null && rightCost.totalUsd !== null
      ? rightCost.totalUsd - leftCost.totalUsd
      : null;
  const deltaRecordedSeconds =
    leftCost.recordedSeconds !== null && rightCost.recordedSeconds !== null
      ? rightCost.recordedSeconds - leftCost.recordedSeconds
      : null;
  return {
    lossReduction: reduction,
    deltaUsd,
    deltaRecordedSeconds,
    lossReductionPerExtraUsd:
      reduction !== null && deltaUsd !== null && deltaUsd !== 0
        ? reduction / deltaUsd
        : null,
    lossReductionPerExtraHour:
      reduction !== null &&
      deltaRecordedSeconds !== null &&
      deltaRecordedSeconds !== 0
        ? (reduction * 3600) / deltaRecordedSeconds
        : null,
  };
}
function compareSubset(
  a: EvaluatedRun,
  b: EvaluatedRun,
  options: Bootstrap = DEFAULT_BOOTSTRAP,
  gameIds = a.games.map((g) => g.game.gameId),
  midPeriod = false,
) {
  validateBootstrap(options);
  const check = compatibility(a, b);
  const base = {
    left: a.id,
    right: b.id,
    direction: "right minus left; negative favors right for all primary losses",
    ...check,
    bootstrap: {
      ...options,
      unit: "game",
      interval: 0.9,
      method: "paired percentile, pooled-window estimand, Mulberry32",
    },
    gameIds,
  };
  if (check.reasons.length) return { ...base, status: "refused" as const };
  if (
    [a, b].some((run) =>
      run.games.some((g) => gameIds.includes(g.game.gameId) && !g.complete),
    )
  )
    return {
      ...base,
      status: "refused" as const,
      reasons: ["incomplete_replay"],
    };
  const left = new Map(
    a.games
      .filter((g) => gameIds.includes(g.game.gameId))
      .flatMap((g) => g.rows)
      .filter((r) => !midPeriod || isMidPeriod(r))
      .map((r) => [key(r), r]),
  );
  const right = new Map(
    b.games
      .filter((g) => gameIds.includes(g.game.gameId))
      .flatMap((g) => g.rows)
      .filter((r) => !midPeriod || isMidPeriod(r))
      .map((r) => [key(r), r]),
  );
  const pairs: { left: WindowResult; right: WindowResult }[] = [],
    dropped: { key: string; left: string[]; right: string[] }[] = [];
  for (const id of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const l = left.get(id),
      r = right.get(id);
    if (l && r && canonical(l.window) !== canonical(r.window))
      return {
        ...base,
        status: "refused" as const,
        reasons: ["window_identity_mismatch"],
        window: id,
      };
    if (!l?.scores || !r?.scores)
      dropped.push({
        key: id,
        left: l?.scores ? [] : unscoredReasons(l),
        right: r?.scores ? [] : unscoredReasons(r),
      });
    else pairs.push({ left: l, right: r });
  }
  const matchedGameIds = gameIds.filter((id) =>
    pairs.some((p) => p.left.window.gameId === id),
  );
  const dropReport = {
    count: dropped.length,
    reasons: tally(
      dropped.flatMap((d) => [
        ...d.left.map((r) => `left:${r}`),
        ...d.right.map((r) => `right:${r}`),
      ]),
    ),
    windows: dropped,
  };
  const leftCost = costFor(a, gameIds),
    rightCost = costFor(b, gameIds);
  const cost = {
    left: leftCost,
    right: rightCost,
    deltaUsd:
      leftCost.totalUsd !== null && rightCost.totalUsd !== null
        ? rightCost.totalUsd - leftCost.totalUsd
        : null,
    deltaRecordedSeconds:
      leftCost.recordedSeconds !== null && rightCost.recordedSeconds !== null
        ? rightCost.recordedSeconds - leftCost.recordedSeconds
        : null,
  };
  const stats = Object.fromEntries(
    PRIMARY.map((metric) => [
      metric,
      matchedGameIds.map((id) => ({
        gameId: id,
        left: stat(
          pairs.filter((p) => p.left.window.gameId === id).map((p) => p.left),
          metric,
        ),
        right: stat(
          pairs.filter((p) => p.left.window.gameId === id).map((p) => p.right),
          metric,
        ),
      })),
    ]),
  ) as Record<
    Metric,
    {
      gameId: string;
      left: ReturnType<typeof stat>;
      right: ReturnType<typeof stat>;
    }[]
  >;
  const draws: Record<Metric, number[]> = {
    setLogLoss: [],
    timingBrier: [],
    exitBrier: [],
    entryBrier: [],
  };
  const rng = random(options.seed);
  if (matchedGameIds.length)
    for (let i = 0; i < options.resamples; i++) {
      const indices = matchedGameIds.map(() =>
        Math.floor(rng() * matchedGameIds.length),
      );
      for (const metric of PRIMARY) {
        const l = pooled(indices.map((j) => stats[metric][j].left)),
          r = pooled(indices.map((j) => stats[metric][j].right));
        if (l !== null && r !== null) draws[metric].push(r - l);
      }
    }
  const scores = Object.fromEntries(
    PRIMARY.map((metric) => {
      const l = pooled(stats[metric].map((s) => s.left)),
        r = pooled(stats[metric].map((s) => s.right));
      const difference = l !== null && r !== null ? r - l : null;
      const ordered = draws[metric].sort((a, b) => a - b);
      const sensitivity = stats[metric]
        .map((s) => {
          const other = stats[metric].filter((x) => x.gameId !== s.gameId);
          const ll = pooled(other.map((x) => x.left)),
            rr = pooled(other.map((x) => x.right));
          const d = ll !== null && rr !== null ? rr - ll : null;
          const ids = gameIds.filter((id) => id !== s.gameId);
          const lc = costFor(a, ids),
            rc = costFor(b, ids);
          return {
            removedGame: s.gameId,
            left: ll,
            right: rr,
            difference: d,
            change: d !== null && difference !== null ? d - difference : null,
            cost: { left: lc, right: rc },
            marginal: marginal(ll, rr, lc, rc),
            efficiency: { left: efficiency(ll, lc), right: efficiency(rr, rc) },
          };
        })
        .sort(
          (a, b) =>
            Math.abs(b.change ?? 0) - Math.abs(a.change ?? 0) ||
            a.removedGame.localeCompare(b.removedGame),
        )
        .slice(0, 5);
      return [
        metric,
        {
          left: l,
          right: r,
          difference,
          interval90: [quantile(ordered, 0.05), quantile(ordered, 0.95)],
          validResamples: ordered.length,
          undefinedResamples: options.resamples - ordered.length,
          cost,
          marginal: marginal(l, r, leftCost, rightCost),
          efficiency: {
            left: efficiency(l, leftCost),
            right: efficiency(r, rightCost),
          },
          sensitivity,
        },
      ];
    }),
  );
  return {
    ...base,
    status: pairs.length
      ? ("compared" as const)
      : ("no_matched_windows" as const),
    metrics: {
      left: metrics(pairs.map((p) => p.left)),
      right: metrics(pairs.map((p) => p.right)),
    },
    matchedWindows: pairs.length,
    matchedGames: matchedGameIds.length,
    dropped: dropReport,
    scores,
  };
}

export function compareRuns(
  a: EvaluatedRun,
  b: EvaluatedRun,
  options: Bootstrap = DEFAULT_BOOTSTRAP,
  gameIds = a.games.map((g) => g.game.gameId),
) {
  return {
    ...compareSubset(a, b, options, gameIds),
    midPeriod: compareSubset(a, b, options, gameIds, true),
  };
}

export function replicateSpread(runs: EvaluatedRun[]) {
  const groups = new Map<string, EvaluatedRun[]>();
  for (const r of runs.filter((r) => r.variant)) {
    const d = r.descriptors;
    const group = canonical({
      profile: d.profile,
      budget: d.budget,
      harness: d.harnessVersion,
      dataset: d.dataset,
      state: d.state,
      jev: d.jev,
      games: d.games,
      selected: d.selectedGames,
    });
    groups.set(group, [...(groups.get(group) ?? []), r]);
  }
  return [...groups.values()]
    .filter((rs) => rs.length > 1)
    .map((rs) => {
      const ids = rs.map((r) => r.id);
      if (
        new Set(rs.map((r) => r.descriptors.replicateId)).size !== rs.length ||
        rs.some((r) => !r.descriptors.replicateId)
      )
        return { runs: ids, status: "duplicate_or_missing_replicate_id" };
      if (
        rs.some((r) =>
          r.games.some((g) => g.game.tag === "scored" && !g.complete),
        )
      )
        return { runs: ids, status: "incomplete_replay" };
      if (rs.some((r) => compatibility(rs[0], r).reasons.length))
        return { runs: ids, status: "incompatible_replicates" };
      const maps = rs.map(
        (r) =>
          new Map(
            r.games
              .filter((g) => g.game.tag === "scored")
              .flatMap((g) => g.rows)
              .map((row) => [key(row), row]),
          ),
      );
      const keys = [...maps[0].keys()].filter((k) =>
        maps.every((m) => m.get(k)?.scores),
      );
      if (
        keys.some((k) =>
          maps.some(
            (m) =>
              canonical(m.get(k)!.window) !== canonical(maps[0].get(k)!.window),
          ),
        )
      )
        return { runs: ids, status: "window_identity_mismatch" };
      const summaries = maps.map((m) => metrics(keys.map((k) => m.get(k)!)));
      return {
        runs: ids,
        variant: rs[0].descriptors.profile.memory,
        status: "matched_scored_windows",
        matchedWindows: keys.length,
        scores: Object.fromEntries(
          PRIMARY.map((metric) => {
            const values = summaries
                .map((s) => s[metric])
                .filter((v): v is number => v !== null),
              avg = mean(values);
            return [
              metric,
              {
                n: values.length,
                values,
                mean: avg,
                min: values.length ? Math.min(...values) : null,
                max: values.length ? Math.max(...values) : null,
                standardDeviation:
                  avg !== null && values.length > 1
                    ? Math.sqrt(
                        values.reduce((s, v) => s + (v - avg) ** 2, 0) /
                          (values.length - 1),
                      )
                    : null,
              },
            ];
          }),
        ),
      };
    });
}
