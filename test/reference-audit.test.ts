import assert from "node:assert/strict";
import { test } from "node:test";
import { auditGames, FIRST_SCORED_INDEX } from "../src/projection/audit.js";
import type { Forecast, Range } from "../src/projection/forecast.js";
import type { Outcome } from "../src/projection/input.js";

const range: Range = [10, 12, 16, 20, 24, 28, 30];
const forecast = (gameId: string): Forecast => ({
  version: "forecast-v1",
  gameId,
  players: ["a", "b"].map((playerId) => ({
    playerId,
    p_play: 1,
    p_start: 0,
    minutes: range,
    points: range,
    rebounds: range,
    assists: range,
    fantasy_points: range,
  })),
});
const line = (playerId: string, value: number, played = true): Outcome => ({
  playerId,
  teamId: "1610612738",
  played,
  starter: false,
  inactive: false,
  minutes: value,
  points: value,
  rebounds: value,
  assists: value,
  fantasy_points: value,
});

test("the audit reports the same coverage counters for games 21 onward", () => {
  assert.equal(FIRST_SCORED_INDEX, 20);
  // Games 1-20: both players inside every range. Game 21: one above the 90th
  // percentile, one DNP. Game 22: one below the 10th, one inside the outer range only.
  const games = Array.from({ length: 22 }, (_, i) => ({
    forecast: forecast("g" + (i + 1)),
    boston:
      i < 20
        ? [line("a", 20), line("b", 20)]
        : i === 20
          ? [line("a", 29), line("b", 0, false)]
          : [line("a", 11), line("b", 13)],
  }));
  const { all, scored, perGame } = auditGames(games);
  assert.equal(perGame.length, 22);
  assert.equal(all.games, 22);
  assert.equal(scored.games, 2);

  // Whole-roster minutes count the DNP; his zero is outside a range that starts at 10.
  assert.deepEqual(scored.coverage.minutes, {
    n: 4,
    inside1090: 1,
    inside2575: 0,
  });
  assert.deepEqual(all.coverage.minutes, {
    n: 44,
    inside1090: 41,
    inside2575: 40,
  });
  // Production and conditional minutes leave the DNP out of the denominator.
  for (const counts of [scored.coverage.points, scored.conditionalMinutes])
    assert.deepEqual(counts, { n: 3, inside1090: 1, inside2575: 0 });
  assert.deepEqual(all.coverage.points, {
    n: 43,
    inside1090: 41,
    inside2575: 40,
  });
  assert.deepEqual(all.conditionalMinutes, all.coverage.points);

  // 85th percentile is 24 + (28 - 24) * (0.10 / 0.15) = 26.67; only the 29 is above it.
  assert.deepEqual(scored.tails.fantasy_points, {
    n: 3,
    below10: 1,
    above90: 1,
    above85: 1,
  });
  assert.deepEqual(all.tails.fantasy_points, {
    n: 43,
    below10: 1,
    above90: 1,
    above85: 1,
  });
});

test("a result exactly at the 85th percentile is not above it", () => {
  const flat: Range = [10, 12, 16, 20, 24, 24, 24];
  const f = forecast("g1");
  f.players = [{ ...f.players[0], fantasy_points: flat }];
  const { all } = auditGames([{ forecast: f, boston: [line("a", 24)] }]);
  assert.equal(all.tails.fantasy_points.above85, 0);
  assert.equal(all.tails.fantasy_points.above90, 0);
});

test("a player who played outside the dated roster fails the audit", () => {
  assert.throws(
    () => auditGames([{ forecast: forecast("g1"), boston: [line("z", 12)] }]),
    /outside dated roster/,
  );
});
