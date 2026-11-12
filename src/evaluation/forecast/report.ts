import { DEFAULT_BOOTSTRAP, quantile, random } from "../compare.js";
import {
  gameMetrics,
  type Metrics,
  type Ratio,
  type GameResult,
} from "./metrics.js";
import type { EvaluationRun } from "./records.js";

type Series = Metrics[];
const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const value = ([s, n]: Ratio) => (n ? s / n : null);
const difference = (a: number | null, b: number | null) =>
  a === null || b === null ? null : a - b;
const pool = (rows: Ratio[], weights?: Uint16Array): Ratio => {
  let s = 0,
    n = 0;
  for (let i = 0; i < rows.length; i++) {
    const w = weights ? weights[i] : 1;
    s += w * rows[i][0];
    n += w * rows[i][1];
  }
  return [s, n];
};
function bootstrap(n: number) {
  const rng = random(DEFAULT_BOOTSTRAP.seed);
  return Array.from({ length: DEFAULT_BOOTSTRAP.resamples }, () => {
    const weights = new Uint16Array(n);
    for (let j = 0; j < n; j++) weights[Math.floor(rng() * n)]++;
    return weights;
  });
}
interface Estimate {
  sum: number;
  weight: number;
  mean: number | null;
  interval90: (number | null)[];
}
interface Contrast {
  left: Estimate;
  right: Estimate;
  delta: number | null;
  interval90: (number | null)[];
  validDraws: number;
  influence: { game: string; omitted: number | null; shift: number | null }[];
  withoutFive: number | null;
}
function comparison<T>(
  left: Series,
  right: Series,
  ids: string[],
  samples: Uint16Array[],
  spend: T,
) {
  const metrics: Record<string, Contrast> = {};
  if (!ids.length) return { games: 0, spend, metrics };
  const cache = new Map<string, Contrast>();
  for (const k of Object.keys(left[0])) {
    const a = left.map((g) => g[k]),
      b = right.map((g) => g[k]),
      pa = pool(a),
      pb = pool(b);
    const key = JSON.stringify([a, b]);
    const existing = cache.get(key);
    if (existing) {
      metrics[k] = existing;
      continue;
    }
    const delta = difference(value(pa), value(pb));
    const aa: number[] = [],
      bb: number[] = [],
      dd: number[] = [];
    for (const draw of samples) {
      const x = value(pool(a, draw)),
        y = value(pool(b, draw));
      if (x !== null) aa.push(x);
      if (y !== null) bb.push(y);
      if (x !== null && y !== null) dd.push(x - y);
    }
    const interval = (xs: number[]) => {
      xs.sort((x, y) => x - y);
      return [quantile(xs, 0.05), quantile(xs, 0.95)];
    };
    const influence = ids
      .map((game, i) => {
        const omitted = difference(
          value([pa[0] - a[i][0], pa[1] - a[i][1]]),
          value([pb[0] - b[i][0], pb[1] - b[i][1]]),
        );
        return { game, omitted, shift: difference(omitted, delta) };
      })
      .filter((r) => r.shift !== null)
      .sort(
        (x, y) =>
          Math.abs(y.shift!) - Math.abs(x.shift!) ||
          x.game.localeCompare(y.game),
      )
      .slice(0, 5);
    const keep = Uint16Array.from(ids, (id) =>
      Number(!influence.some((r) => r.game === id)),
    );
    metrics[k] = {
      left: {
        sum: pa[0],
        weight: pa[1],
        mean: value(pa),
        interval90: interval(aa),
      },
      right: {
        sum: pb[0],
        weight: pb[1],
        mean: value(pb),
        interval90: interval(bb),
      },
      delta,
      interval90: interval(dd),
      validDraws: dd.length,
      influence,
      withoutFive: difference(value(pool(a, keep)), value(pool(b, keep))),
    };
    cache.set(key, metrics[k]);
  }
  return { games: ids.length, spend, metrics };
}
function meanSeries(series: Series[]): Series {
  return series[0].map((row, i) =>
    Object.fromEntries(
      Object.keys(row).map((k) => {
        const [s, n] = pool(series.map((r) => r[i][k]));
        return [k, [s / series.length, n / series.length] as Ratio];
      }),
    ),
  );
}
function spending(games: GameResult[]) {
  const usd = total(games.map((g) => g.costUsd)),
    wallClockMs = total(games.map((g) => g.wallClockMs));
  return {
    usd,
    wallClockMs,
    usdPerGame: games.length ? usd / games.length : null,
    msPerGame: games.length ? wallClockMs / games.length : null,
  };
}
export function forecastReport(runs: EvaluationRun[]) {
  if (!runs.length) throw Error("Supply at least one forecast record");
  const first = runs[0];
  if (
    runs.some(
      (r) =>
        r.common !== first.common ||
        r.population !== first.population ||
        r.games.map((g) => g.id).join() !== first.games.map((g) => g.id).join(),
    )
  )
    throw Error(
      "Incompatible settings, games, outcomes, reference or consensus",
    );
  const reps = (arm: string) =>
    runs
      .filter((r) => r.arm === arm)
      .sort((a, b) => a.replicate.localeCompare(b.replicate));
  const no = reps("no-memory"),
    full = reps("full-memory");
  for (const arm of [no, full]) {
    if (
      new Set(arm.map((r) => r.replicate)).size !== arm.length ||
      new Set(arm.map((r) => r.armSettings)).size > 1
    )
      throw Error("Duplicate or incompatible replicates");
  }
  if (
    no.length &&
    full.length &&
    no.map((r) => r.replicate).join() !== full.map((r) => r.replicate).join()
  )
    throw Error("Unmatched replicate IDs");
  function view(dropFlagged: boolean) {
    const mask = first.games.map(
      (_, i) => !dropFlagged || runs.every((r) => !r.games[i].flagged),
    );
    const selected = (r: EvaluationRun) => r.games.filter((_, i) => mask[i]);
    const ids = selected(first).map((g) => g.id),
      samples = bootstrap(ids.length);
    const data = runs.map((run) => {
      const games = selected(run);
      return {
        run,
        games,
        agent: gameMetrics(games, "agent"),
        ref: gameMetrics(games, "reference"),
        cost: spending(games),
      };
    });
    const againstReference = data.map((d) => ({
      arm: d.run.arm,
      replicate: d.run.replicate,
      ...comparison(d.agent, d.ref, ids, samples, {
        analyst: d.cost,
        reference: null,
      }),
    }));
    const paired = no.flatMap((n) => {
      const f = full.find((r) => r.replicate === n.replicate);
      if (!f) return [];
      const a = data.find((d) => d.run === f)!,
        b = data.find((d) => d.run === n)!;
      return [
        {
          id: n.replicate,
          a,
          b,
          spend: {
            full: a.cost,
            noMemory: b.cost,
            deltaUsd: a.cost.usd - b.cost.usd,
            deltaWallClockMs: a.cost.wallClockMs - b.cost.wallClockMs,
          },
        },
      ];
    });
    const armDifferences = paired.map((p) => ({
      replicate: p.id,
      ...comparison(p.a.agent, p.b.agent, ids, samples, p.spend),
    }));
    const pooled = paired.length
      ? comparison(
          meanSeries(paired.map((p) => p.a.agent)),
          meanSeries(paired.map((p) => p.b.agent)),
          ids,
          samples,
          paired.map((p) => ({ replicate: p.id, ...p.spend })),
        )
      : null;
    const primary = [
      "minutes.pinball",
      "points.pinball",
      "rebounds.pinball",
      "assists.pinball",
      "fantasy_points.pinball",
      "playBrier",
    ];
    const learningCurves = paired.flatMap((p) =>
      p.a.games.map((g, i) => ({
        replicate: p.id,
        index: g.index,
        game: g.id,
        fullCost: spending([g]),
        noMemoryCost: spending([p.b.games[i]]),
        primary: Object.fromEntries(
          primary.map((k) => {
            const a = value(p.a.agent[i]["all/" + k]),
              b = value(p.b.agent[i]["all/" + k]);
            return [k, { full: a, noMemory: b, delta: difference(a, b) }];
          }),
        ),
      })),
    );
    function spread(values: (number | null)[]) {
      const observed = values.filter((x) => x !== null);
      return observed.length
        ? { min: Math.min(...observed), max: Math.max(...observed) }
        : null;
    }
    const replicateSpread = Object.fromEntries(
      Object.keys(data[0].agent[0] ?? {}).map((k) => [
        k,
        {
          fullMemory: spread(
            againstReference
              .filter((r) => r.arm === "full-memory")
              .map((r) => r.metrics[k].left.mean),
          ),
          noMemory: spread(
            againstReference
              .filter((r) => r.arm === "no-memory")
              .map((r) => r.metrics[k].left.mean),
          ),
          difference: spread(armDifferences.map((r) => r.metrics[k].delta)),
        },
      ]),
    );
    return {
      games: ids,
      againstReference,
      armDifferences,
      pooled,
      replicateSpread,
      learningCurves,
    };
  }
  const withFlagged = view(false);
  return {
    version: "forecast-evaluation-v1",
    bootstrap: { ...DEFAULT_BOOTSTRAP, interval: 0.9 },
    records: runs.map((r) => ({
      arm: r.arm,
      replicate: r.replicate,
      runId: r.runId,
      head: r.source,
      configurations: r.configurations,
      excluded: r.excluded,
      flagged: r.games.filter((g) => g.flagged).map((g) => g.id),
    })),
    withFlagged,
    withoutFlagged: runs.some((r) => r.games.some((g) => g.flagged))
      ? view(true)
      : withFlagged,
  };
}
