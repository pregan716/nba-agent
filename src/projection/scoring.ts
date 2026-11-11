import { BOS } from "../replay/types.js";
import { distribution, minutes } from "./distribution.js";
import {
  quantities,
  percentiles,
  type Forecast,
  type Quantity,
} from "./forecast.js";
import type { Outcome, ReleasedGame } from "./input.js";
import { validateForecast, type Pregame } from "./validation.js";

function perStat<T>(fn: (stat: Quantity) => T): Record<Quantity, T> {
  return Object.fromEntries(quantities.map((q) => [q, fn(q)])) as Record<
    Quantity,
    T
  >;
}
function average(values: (number | null)[]) {
  const eligible = values.filter((x) => x !== null);
  return {
    count: eligible.length,
    mean: eligible.length
      ? eligible.reduce((a, b) => a + b, 0) / eligible.length
      : null,
  };
}
export function pinball(t: number, forecast: number, actual: number) {
  return actual >= forecast
    ? t * (actual - forecast)
    : (1 - t) * (forecast - actual);
}
function coverage(values: readonly number[], y: number) {
  return {
    coverage80: Number(y >= values[1] && y <= values[5]),
    coverage50: Number(y >= values[2] && y <= values[4]),
  };
}
function brier(p: number, event: boolean) {
  return (p - Number(event)) ** 2;
}
const tiers = ["deep bench", "fringe", "rotation", "core"] as const;
function tier(m: number) {
  return tiers[m <= 5 ? 0 : m <= 15 ? 1 : m <= 26 ? 2 : 3];
}

function checked(f: Forecast, pre: Pregame) {
  const result = validateForecast(f, pre);
  if (!result.ok) throw Error(result.reason);
  return result.forecast;
}
function publicOutcome(row: Outcome) {
  return {
    playerId: row.playerId,
    teamId: row.teamId,
    played: row.played,
    starter: row.starter,
    inactive: row.inactive,
    ...perStat((q) => row[q]),
  };
}
function score(
  pre: Pregame,
  f: Forecast,
  ref: Forecast,
  outcomes: Map<string, Outcome>,
) {
  const forecast = new Map(f.players.map((p) => [p.playerId, p]));
  const reference = new Map(ref.players.map((p) => [p.playerId, p]));
  const candidates = pre.roster.map(({ playerId, inactive }) => {
    const own = forecast.get(playerId)!,
      base = reference.get(playerId)!;
    const threshold = distribution(
      "fantasy_points",
      base.fantasy_points,
    ).quantile(0.85);
    return {
      playerId,
      inactive,
      own,
      base,
      tier: tier(minutes(base.p_play, base.minutes).mean),
      threshold,
      probability:
        own.p_play *
        distribution("fantasy_points", own.fantasy_points).probability(
          threshold,
          ">",
        ),
    };
  });
  const picks = candidates
    .filter((c) => !c.inactive)
    .sort(
      (a, b) =>
        b.probability - a.probability ||
        a.playerId.localeCompare(b.playerId, "en", { numeric: true }),
    )
    .slice(0, 3)
    .map((c) => c.playerId);
  const players = candidates.map(
    ({ playerId, inactive, own, base, tier, threshold, probability }) => {
      const actual = outcomes.get(playerId) ?? {
        playerId,
        teamId: BOS,
        played: false,
        starter: null,
        inactive: false,
        ...perStat(() => 0),
      };
      const m = minutes(own.p_play, own.minutes);
      const ranges = perStat((q) => {
        if (q !== "minutes" && !actual.played) return null;
        const values =
          q === "minutes"
            ? percentiles.map((t) => m.quantile(t / 100))
            : own[q];
        const y = actual[q];
        return {
          pinball:
            values.reduce(
              (s, v, i) => s + pinball(percentiles[i] / 100, v, y),
              0,
            ) / values.length,
          ...coverage(values, y),
        };
      });
      const hit = actual.played && actual.fantasy_points > threshold;
      return {
        playerId,
        tier,
        actual: publicOutcome(actual),
        forecast: own,
        ranges,
        conditionalMinutesCoverage: actual.played
          ? coverage(own.minutes, actual.minutes)
          : null,
        misplacedMinutes: Math.abs(actual.minutes - m.quantile(0.5)) / 2,
        playBrier: inactive ? null : brier(own.p_play, actual.played),
        startBrier:
          actual.starter === null ? null : brier(own.p_start, actual.starter),
        ceiling: inactive
          ? null
          : {
              threshold,
              probability,
              hit,
              brier: brier(probability, hit),
              picked: picks.includes(playerId),
              weight: base.p_play,
            },
      };
    },
  );
  function summarize(rows: typeof players) {
    const picked = rows.filter((r) => r.ceiling?.picked),
      voids = picked.filter((r) => !r.actual.played).length;
    const hits = picked.filter((r) => r.ceiling?.hit).length;
    const denominator = rows.reduce((s, r) => s + (r.ceiling?.weight ?? 0), 0);
    const numerator = rows.reduce(
      (s, r) => s + (r.ceiling?.hit ? r.ceiling.weight : 0),
      0,
    );
    return {
      players: rows.length,
      conditionalMinutesCoverage: {
        coverage80: average(
          rows.map((r) => r.conditionalMinutesCoverage?.coverage80 ?? null),
        ),
        coverage50: average(
          rows.map((r) => r.conditionalMinutesCoverage?.coverage50 ?? null),
        ),
      },
      ranges: perStat((q) => ({
        pinball: average(rows.map((r) => r.ranges[q]?.pinball ?? null)),
        coverage80: average(rows.map((r) => r.ranges[q]?.coverage80 ?? null)),
        coverage50: average(rows.map((r) => r.ranges[q]?.coverage50 ?? null)),
      })),
      playBrier: average(rows.map((r) => r.playBrier)),
      startBrier: average(rows.map((r) => r.startBrier)),
      misplacedMinutes: rows.reduce((s, r) => s + r.misplacedMinutes, 0),
      ceiling: {
        brier: average(rows.map((r) => r.ceiling?.brier ?? null)),
        picks: picked.length,
        voids,
        hits,
        hitRate: picked.length ? hits / picked.length : null,
        hitRateWithoutVoids:
          picked.length > voids ? hits / (picked.length - voids) : null,
        referenceWeighted: {
          numerator,
          denominator,
          rate: denominator ? numerator / denominator : null,
        },
      },
    };
  }
  return {
    players,
    picks,
    overall: summarize(players),
    byTier: Object.fromEntries(
      tiers.map((t) => [t, summarize(players.filter((r) => r.tier === t))]),
    ),
  };
}

export interface Metering {
  costUsd: number;
  wallClockMs: number;
}
// Trusted evaluation entry point. The session releases this same allowlisted payload.
export function scoreGame(
  pre: Pregame,
  frozen: Forecast | null,
  reference: Forecast,
  game: ReleasedGame,
  meter: Metering,
) {
  if (
    game.gameId !== pre.gameId ||
    Date.parse(game.tip) !== Date.parse(pre.tip)
  )
    throw Error("Outcome game mismatch");
  if (
    ![meter.costUsd, meter.wallClockMs].every(
      (n) => Number.isFinite(n) && n >= 0,
    )
  )
    throw Error("Invalid game metering");
  const roster = new Set(pre.roster.map((r) => r.playerId));
  const rows = game.players.filter((p) => p.teamId === BOS);
  const outcomes = new Map(rows.map((r) => [r.playerId, r]));
  if (
    !rows.length ||
    rows.length !== outcomes.size ||
    rows.some((p) => p.played && !roster.has(p.playerId))
  )
    throw Error("Inconsistent Boston box score");
  const ref = checked(reference, pre);
  const refScores = score(pre, ref, ref, outcomes);
  return {
    gameId: pre.gameId,
    tip: pre.tip,
    status: frozen ? ("frozen" as const) : ("no_forecast" as const),
    costUsd: meter.costUsd,
    wallClockMs: meter.wallClockMs,
    box: game.players.map(publicOutcome),
    agent: frozen ? score(pre, checked(frozen, pre), ref, outcomes) : refScores,
    reference: refScores,
  };
}
