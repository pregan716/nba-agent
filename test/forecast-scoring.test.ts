import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseTime } from "../src/env/visibility.js";
import { BOS } from "../src/replay/types.js";
import { distribution, minutes } from "../src/projection/distribution.js";
import type { Forecast, Range } from "../src/projection/forecast.js";
import type { Game } from "../src/projection/input.js";
import { outcome } from "../src/projection/input.js";
import type { RecordEnvelope } from "../src/data/contracts.js";
import { scoreGame } from "../src/projection/scoring.js";
import { forecastSession, ForecastRecord } from "../src/projection/session.js";
import { validateForecast } from "../src/projection/validation.js";

const flat = (x: number): Range => [x, x, x, x, x, x, x];
const roster = ["10", "2", "3", "4", "5"].map((playerId) => ({
  playerId,
  inactive: playerId === "5",
}));
const pre = { gameId: "today", tip: "2026-10-31T23:00:00Z", roster };
const draft: Forecast = {
  version: "forecast-v1",
  gameId: pre.gameId,
  players: roster.map(({ playerId }) => ({
    playerId,
    p_play: 0.5,
    p_start: 0.25,
    minutes: flat(10),
    points: flat(2),
    assists: flat(0),
    rebounds: flat(0),
    fantasy_points: flat(-1),
  })),
};
const game = {
  gameId: pre.gameId,
  tip: pre.tip,
  season: "2025-26",
  boston: true,
  release: releaseTime(pre.tip),
};
const row = {
  playerId: "2",
  teamId: BOS,
  played: true,
  inactive: false,
  starter: true,
  minutes: 10,
  points: 4,
  assists: 0,
  rebounds: 0,
  fantasy_points: 2,
  marketLine: 100,
};
const box = { ...game, players: [row], bigOver: true };
const meter = { costUsd: 4, wallClockMs: 120, relativeLoss: 5 };
const close = (a: number | null, b: number) =>
  assert.ok(a !== null && Math.abs(a - b) < 1e-10, `${a} != ${b}`);

test("validator accepts negative fantasy and flat ranges, rejects malformed drafts without repair", () => {
  assert.ok(validateForecast(draft, pre).ok);
  const p = draft.players[0];
  for (const bad of [
    { minutes: flat(59) },
    { minutes: flat(-0.01) },
    { fantasy_points: flat(-11) },
    { assists: [0, 0, 3, 2, 4, 5, 6] },
    { points: flat(Infinity) },
    { rebounds: [1] },
    { p_start: -0.1 },
    { p_play: 1.01 },
    { playerId: "2" },
    { marketLine: 7 },
  ]) {
    const result = validateForecast(
      { ...draft, players: [{ ...p, ...bad }, ...draft.players.slice(1)] },
      pre,
    );
    assert.ok(!result.ok && result.reason.length);
  }
  assert.equal(
    validateForecast({ ...draft, players: draft.players.slice(1) }, pre).ok,
    false,
  );
});

test("piecewise distribution preserves endpoint atoms and the fantasy lower tail", () => {
  const d = distribution("fantasy_points", [-3, -2, 0, 1, 4, 4, 4]);
  assert.equal(d.quantile(0), -4);
  assert.equal(d.quantile(0.85), 4);
  assert.equal(d.probability(4, ">"), 0);
  close(d.probability(4, ">="), 0.25);
  const r: Range = [1, 2, 5, 10, 15, 18, 19];
  const q = distribution("points", r);
  close(q.quantile(1), 20);
  close(q.probability(11, ">"), 0.45);
  close(minutes(0.5, r).quantile(0.75), 10);
  close(minutes(0.5, r).mean, 5);
});

test("hand-scored player and game diagnostics, pregame picks, weighted ceiling benchmark and feedback allowlist", () => {
  const report = scoreGame(pre, draft, draft, box, meter);
  const { overall } = report.agent;
  // Played player's unconditional minutes quantiles are 0,0,0,0,10,10,10.
  const played = report.agent.players.find((p) => p.playerId === "2")!;
  close(played.ranges.minutes!.pinball, 9 / 7);
  close(overall.ranges.minutes.pinball.mean, (9 + 4 * 4) / 35);
  close(overall.ranges.points.pinball.mean, 1);
  assert.equal(overall.ranges.points.pinball.count, 1);
  close(overall.playBrier.mean, 0.25);
  assert.equal(overall.playBrier.count, 4);
  close(overall.startBrier.mean, 0.75 ** 2);
  assert.equal(overall.startBrier.count, 1);
  close(overall.misplacedMinutes, 5);
  close(overall.ranges.minutes.coverage80.mean, 1);
  close(overall.ranges.points.coverage50.mean, 0);
  assert.deepEqual(report.agent.picks, ["2", "3", "4"]);
  assert.equal(overall.ceiling.voids, 2);
  close(overall.ceiling.hitRate, 1 / 3);
  close(overall.ceiling.hitRateWithoutVoids, 1);
  close(overall.ceiling.brier.mean, 0.25);
  assert.deepEqual(overall.ceiling.referenceWeighted, {
    numerator: 0.5,
    denominator: 2,
    rate: 0.25,
  });
  assert.equal(report.agent.byTier["deep bench"].players, 5);
  assert.doesNotMatch(
    JSON.stringify(report),
    /marketLine|bigOver|relativeLoss/,
  );
  const missing = scoreGame(
    pre,
    null,
    draft,
    {
      ...game,
      players: [
        { ...row, played: false, minutes: 0, points: 0, fantasy_points: 0 },
      ],
    },
    meter,
  );
  assert.equal(missing.status, "no_forecast");
  assert.deepEqual(missing.agent, missing.reference);
  assert.deepEqual(missing.agent.overall.ranges.points.pinball, {
    count: 0,
    mean: null,
  });
  assert.equal(missing.agent.overall.ceiling.hitRateWithoutVoids, null);
});

test("DK classic box calculation includes a made three, turnover and both milestone bonuses", () => {
  const envelope = {
    data: {
      player_id: "2",
      team_id: BOS,
      game_id: "g",
      minutes_seconds: 60,
      points: 12,
      rebounds: 10,
      assists: 11,
      steals: 1,
      blocks: 2,
      turnovers: 3,
      three_pointers_made: 2,
    },
  } as unknown as RecordEnvelope;
  assert.equal(outcome(envelope, envelope).fantasy_points, 51);
});

test("freeze across handles, scheduled cutoff, exact DST release and previous-game feedback", async () => {
  const root = await mkdtemp(join(tmpdir(), "forecast-session-"));
  const path = join(root, "arm.sqlite");
  const record = new ForecastRecord(path),
    other = new ForecastRecord(path);
  let now = "2026-10-31T22:59:59Z",
    phase: "pregame" | "postgame" = "pregame",
    reads = 0;
  const tomorrow = {
    ...game,
    gameId: "next",
    tip: "2026-11-02T00:00:00Z",
    release: "2026-11-02T14:00:00Z",
  };
  const setup = (id: string, handle: ForecastRecord) =>
    forecastSession({
      gameId: id,
      record: handle,
      referenceRoot: root,
      clock: () => ({ now, phase }),
      metering: () => meter,
      source: {
        schedule: [game, tomorrow],
        input: async (g: Game) => ({
          ...pre,
          gameId: g.gameId,
          tip: g.tip,
          history: [],
        }),
        outcomes: async (g, cutoff) => {
          reads++;
          assert.equal(g.gameId, "today");
          assert.ok(Date.parse(cutoff) > Date.parse(game.release));
          return box;
        },
      },
      model: {
        identity: async () => ({
          version: "fixture",
          image: "fixture",
          source: "fixture",
        }),
        fit: (i) => ({
          modelHash: "fixture",
          forecast: { ...draft, gameId: i.gameId },
        }),
      },
    });
  try {
    const s = await setup("today", record),
      reopened = await setup("today", other);
    assert.equal(s.freeze_forecast({}).ok, false);
    assert.ok(s.validate_forecast(draft).ok);
    assert.ok(s.freeze_forecast(draft).ok);
    const changed = structuredClone(draft);
    changed.players[0].minutes = flat(4);
    assert.equal(reopened.freeze_forecast(changed).ok, false);
    await assert.rejects(s.read_feedback(), /unavailable/);
    phase = "postgame";
    now = "2026-11-01T13:59:59.999Z";
    await assert.rejects(s.read_feedback(), /unavailable/);
    assert.equal(reads, 0);
    now = "2026-11-01T14:00:00Z";
    const fb = await reopened.read_feedback();
    assert.equal(fb.status, "frozen");
    assert.deepEqual(fb.agent.players[0].forecast, draft.players[0]);
    phase = "pregame";
    const next = await setup("next", other);
    assert.deepEqual(await next.read_feedback(), fb);
    now = tomorrow.tip;
    assert.equal(next.freeze_forecast({ ...draft, gameId: "next" }).ok, false);
    assert.equal(record.finalized({ ...pre, gameId: "missing" }, "ctx"), null);
    assert.equal(
      record.freeze(
        { ...pre, gameId: "missing" },
        "ctx",
        { ...draft, gameId: "missing" },
        () => ({ phase: "pregame", now: "2026-01-01T00:00:00Z" }),
      ).ok,
      false,
    );
  } finally {
    record.close();
    other.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ceiling uses the reference threshold, own play probability, and all eligible candidates in a short pool", () => {
  const own = structuredClone(draft);
  for (const p of own.players) {
    p.p_play = 0.25;
    p.fantasy_points = flat(3);
  }
  const short = {
    ...pre,
    roster: roster.map((r) => ({ ...r, inactive: r.playerId !== "2" })),
  };
  const { agent, reference } = scoreGame(short, own, draft, box, meter);
  assert.deepEqual(agent.picks, ["2"]);
  close(agent.overall.ceiling.brier.mean, 0.75 ** 2);
  close(reference.overall.ceiling.brier.mean, 1);
  assert.equal(agent.overall.ceiling.hits, 1);
  assert.deepEqual(agent.overall.ceiling.referenceWeighted, {
    numerator: 0.5,
    denominator: 0.5,
    rate: 1,
  });
});
