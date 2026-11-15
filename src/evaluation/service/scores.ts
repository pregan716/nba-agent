import { DEFAULT_BOOTSTRAP, quantile, random } from "../compare.js";
import { nonMarketMetrics, type Metrics } from "../forecast/metrics.js";
import { scoreGame, summarizePlayers } from "../../projection/scoring.js";
import type { TeamGame } from "../../game-loop/replay.js";

type Score = ReturnType<typeof scoreGame>;
type Side = "agent" | "reference";
export type ScoredGame = TeamGame & {
  costUsd?: number;
  unresolvedUsd?: number;
  wallClockMs?: number;
  score: Score | { gameId: string; status: "excluded"; reason: string };
};
const key = (g: TeamGame) => JSON.stringify([g.gameId, g.teamId]);
function accumulate(acc: Metrics, input: Metrics) {
  for (const [name, [sum, n]] of Object.entries(input)) {
    const pair = (acc[name] ??= [0, 0]);
    pair[0] += sum;
    pair[1] += n;
  }
}
function means(m: Metrics) {
  return Object.fromEntries(
    Object.entries(m).map(([k, [s, n]]) => [k, n ? s / n : null]),
  );
}
export function summarize(games: ScoredGame[], side: Side) {
  const all: Metrics = {},
    teams = new Map<string, Metrics>(),
    tiers = new Map<string, Metrics>(),
    players = new Map<string, Metrics>();
  function add(group: Map<string, Metrics>, id: string, m: Metrics) {
    const acc = group.get(id) ?? {};
    accumulate(acc, m);
    group.set(id, acc);
  }
  const byGame = games.map((g) => {
    if (g.score.status === "excluded")
      return {
        teamId: g.teamId,
        gameId: g.gameId,
        status: g.score.status,
        reason: g.score.reason,
        costUsd: g.costUsd,
        wallClockMs: g.wallClockMs,
      };
    const s = g.score[side],
      m = nonMarketMetrics(s.overall, side);
    accumulate(all, m);
    add(teams, g.teamId, m);
    for (const [tier, row] of Object.entries(s.byTier))
      add(tiers, tier, nonMarketMetrics(row, side));
    for (const p of s.players)
      add(players, p.playerId, nonMarketMetrics(summarizePlayers([p]), side));
    return {
      teamId: g.teamId,
      gameId: g.gameId,
      status: g.score.status,
      metrics: means(m),
      costUsd: g.score.costUsd,
      wallClockMs: g.score.wallClockMs,
    };
  });
  const report = (group: Map<string, Metrics>) =>
    Object.fromEntries([...group].map(([k, m]) => [k, means(m)]));
  return {
    overall: means(all),
    byGame,
    byTeam: report(teams),
    byTier: report(tiers),
    byPlayer: report(players),
  };
}
const primary = [
  "minutes.pinball",
  "fantasy_points.pinball",
  "playBrier",
] as const;
export function pairedComparison(
  left: ScoredGame[],
  right: ScoredGame[],
  rightSide: Side = "agent",
) {
  const r = new Map(right.map((g) => [key(g), g]));
  if (
    !left.length ||
    r.size !== right.length ||
    new Set(left.map(key)).size !== left.length ||
    left.length !== r.size
  )
    throw Error("Mismatched evaluation games");
  const clusters = new Map<string, { left: Metrics; right: Metrics }>();
  for (const g of [...left].sort((a, b) => key(a).localeCompare(key(b)))) {
    const other = r.get(key(g));
    if (
      !other ||
      other.tip !== g.tip ||
      (g.score.status === "excluded") !== (other.score.status === "excluded")
    )
      throw Error("Mismatched evaluation games");
    if (g.score.status === "excluded" || other.score.status === "excluded")
      continue;
    const c = clusters.get(g.gameId) ?? { left: {}, right: {} };
    accumulate(c.left, nonMarketMetrics(g.score.agent.overall, "agent"));
    accumulate(
      c.right,
      nonMarketMetrics(other.score[rightSide].overall, rightSide),
    );
    clusters.set(g.gameId, c);
  }
  const rows = [...clusters.values()];
  function estimate(name: string, weights: Uint16Array) {
    let ls = 0,
      ln = 0,
      rs = 0,
      rn = 0;
    for (let i = 0; i < rows.length; i++) {
      const w = weights[i],
        a = rows[i].left[name],
        b = rows[i].right[name];
      ls += a[0] * w;
      ln += a[1] * w;
      rs += b[0] * w;
      rn += b[1] * w;
    }
    return {
      ratio: ln && rn && rs ? ls / ln / (rs / rn) : null,
      delta: ln && rn ? ls / ln - rs / rn : null,
    };
  }
  const interval = (xs: number[]) => {
    xs.sort((a, b) => a - b);
    return [quantile(xs, 0.05), quantile(xs, 0.95)];
  };
  const spend = (games: ScoredGame[]) =>
    games.reduce(
      (acc, g) => ({
        usd:
          acc.usd +
          (g.costUsd ?? (g.score.status === "excluded" ? 0 : g.score.costUsd)),
        unresolvedUsd: acc.unresolvedUsd + (g.unresolvedUsd ?? 0),
        ms:
          acc.ms +
          (g.wallClockMs ??
            (g.score.status === "excluded" ? 0 : g.score.wallClockMs)),
      }),
      { usd: 0, unresolvedUsd: 0, ms: 0 },
    );
  const leftSpend = spend(left),
    rightSpend = rightSide === "agent" ? spend(right) : null;
  const extraUsd = rightSpend ? leftSpend.usd - rightSpend.usd : null;
  const extraHours = rightSpend
    ? (leftSpend.ms - rightSpend.ms) / 3600000
    : null;
  const results = Object.fromEntries(
    primary.map((name) => {
      const ratio: number[] = [],
        delta: number[] = [],
        w = new Uint16Array(rows.length),
        rng = random(DEFAULT_BOOTSTRAP.seed);
      for (let n = 0; n < DEFAULT_BOOTSTRAP.resamples && rows.length; n++) {
        w.fill(0);
        for (let i = 0; i < w.length; i++) w[Math.floor(rng() * w.length)]++;
        const v = estimate(name, w);
        if (v.ratio !== null) ratio.push(v.ratio);
        if (v.delta !== null) delta.push(v.delta);
      }
      const point = estimate(name, w.fill(1));
      const influence = [...clusters.keys()]
        .map((gameId, i) => {
          w[i] = 0;
          const omitted = estimate(name, w).delta;
          w[i] = 1;
          return {
            gameId,
            index: i,
            omitted,
            shift:
              omitted === null || point.delta === null
                ? null
                : omitted - point.delta,
          };
        })
        .filter((g) => g.shift !== null)
        .sort((a, b) => Math.abs(b.shift!) - Math.abs(a.shift!))
        .slice(0, 5);
      for (const g of influence) w[g.index] = 0;
      return [
        name,
        {
          ...point,
          ratio90: interval(ratio),
          delta90: interval(delta),
          validRatioDraws: ratio.length,
          lossReductionPerExtraUsd:
            extraUsd && point.delta !== null ? -point.delta / extraUsd : null,
          lossReductionPerExtraHour:
            extraHours && point.delta !== null
              ? -point.delta / extraHours
              : null,
          influence: influence.map(({ index, ...g }) => g),
          withoutFive: estimate(name, w),
        },
      ];
    }),
  );
  return {
    bootstrap: { ...DEFAULT_BOOTSTRAP, interval: 0.9 },
    games: rows.length,
    teamGames: left.length,
    metrics: results,
    spend: {
      left: leftSpend,
      right: rightSpend,
    },
    guardrailFlag: ["playBrier", "fantasy_points.pinball"].some(
      (k) => (results[k].delta90[0] ?? 0) > 0,
    ),
  };
}
