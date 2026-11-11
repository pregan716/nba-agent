import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  projectionSource,
  type ModelInput,
  type ReleasedGame,
} from "../src/projection/input.js";
import {
  projectionModel,
  referenceTables,
} from "../src/projection/reference.js";
import { BOS } from "../src/replay/types.js";
import type { Corpus } from "../src/data/corpus.js";
import {
  quantities,
  type Forecast,
  type Range,
} from "../src/projection/forecast.js";
import { digest } from "../src/runner/config.js";

const tip = "2025-10-22T13:00:00.000Z";
const schedule = (id: string, day: string, season = "2025-26") => ({
  id,
  data: {
    scheduled_tipoff: day,
    season,
    home_team_id: BOS,
    away_team_id: "away",
  },
});
const today = schedule("today", tip),
  prior = schedule("prior", "2025-04-01T20:00:00Z", "2024-25");
const future = schedule("exactly-at-cutoff", "2025-10-21T20:00:00Z");

test("reference input excludes equal-cutoff games, result rows and injury reports before their contents affect a refit", async () => {
  const source = async (planted: boolean, defect?: "orphan" | "release") => {
    const adapter = (games: (typeof today)[]) => ({
      games: async () => games,
      async *exportRecords(table: string, requested: typeof games) {
        assert.deepEqual(
          requested.map((g) => g.id),
          ["prior"],
        );
        const records = [BOS, "away"].map((team_id) => ({
          availableAt: "2025-04-02T13:00:00Z",
          data: {
            game_id: "prior",
            team_id,
            player_id: team_id,
            minutes_seconds: 60,
            points: 0,
            rebounds: 0,
            assists: 0,
            turnovers: 1,
            steals: 0,
            blocks: 0,
            three_pointers_made: 0,
            starter: false,
            participation_status: "played",
          },
        }));
        if (defect === "orphan" && table === "game_players")
          records.push({
            ...records[0],
            data: { ...records[0].data, player_id: "orphan" },
          });
        if (defect === "release")
          records[0].availableAt = "2025-04-02T13:00:01Z";
        if (planted)
          records.push({
            ...records[0],
            availableAt: tip,
            data: { ...records[0].data, player_id: "planted", points: 999 },
          });
        yield { gameId: "prior", reason: null, records };
      },
    });
    const corpus = {
      priorPbp: adapter([prior]),
      pbp: adapter(planted ? [today, future] : [today]),
      injuries: {
        release: { root: { sha256: "injury" } },
        async *partitions() {
          yield planted
            ? [
                {
                  availableAt: tip,
                  id: "late",
                  data: {
                    game_id: "today",
                    team_id: BOS,
                    observed_state: "players_listed",
                    player_name: "Invalid player",
                    status: "Out",
                  },
                },
              ]
            : [];
        },
      },
    };
    const s = await projectionSource(corpus as unknown as Corpus);
    return s.input(s.schedule.find((g) => g.gameId === "today")!);
  };
  const clean = await source(false),
    planted = await source(true);
  assert.deepEqual(planted, clean);
  await assert.rejects(source(false, "orphan"), /summary without box/);
  await assert.rejects(
    source(false, "release"),
    /Unexpected released envelope/,
  );
  assert.ok(clean.roster.length > 10);
  assert.equal(clean.history[0].players[0].fantasy_points, -0.5);
});

function fixture(): ModelInput {
  const history: ReleasedGame[] = Array.from({ length: 50 }, (_, i) => {
    const tip = new Date(Date.UTC(2024, 0, i + 1, 20)).toISOString();
    return {
      gameId: "g" + i,
      tip,
      release: new Date(Date.parse(tip) + 16 * 3600000).toISOString(),
      season: "2024-25",
      boston: true,
      players: Array.from({ length: 22 }, (_, j) => {
        const minutes = j === 0 ? 1 : (i + j) % 5 === 0 ? 0 : 12 + j;
        return {
          playerId: String(j),
          teamId: j < 11 ? BOS : "away",
          played: minutes > 0,
          starter: j % 11 < 5 && minutes > 0,
          inactive: false,
          minutes,
          points: j === 0 ? 0 : minutes * 0.4,
          rebounds: minutes * 0.1,
          assists: 0,
          fantasy_points: j === 0 ? -0.5 : minutes * 0.5,
        };
      }),
    };
  });
  return {
    tip,
    gameId: "today",
    roster: [
      ...history[0].players
        .slice(0, 11)
        .map((p) => ({ playerId: p.playerId, inactive: p.playerId === "10" })),
      { playerId: "rookie", inactive: false },
    ],
    history,
  };
}
test(
  "pinned refits reproduce the model hash and conditional ranges for the whole pregame roster",
  { skip: !process.env.PROJECTION_IMAGE },
  () => {
    const data = fixture(),
      model = projectionModel(process.env.PROJECTION_IMAGE!);
    const first = model.fit(data);
    assert.deepEqual(model.fit(data), first);
    assert.equal(first.forecast.players.length, data.roster.length);
    assert.ok(first.forecast.players.some((p) => p.fantasy_points[0] < 0));
    for (const p of first.forecast.players) {
      assert.ok(p.p_play >= p.p_start && p.p_start >= 0 && p.p_play <= 1);
      for (const stat of quantities) {
        assert.equal(p[stat].length, 7);
        assert.deepEqual(
          [...p[stat]].sort((a, b) => a - b),
          p[stat],
        );
        assert.ok(p[stat][0] >= (stat === "fantasy_points" ? -10 : 0));
      }
    }
    assert.equal(
      first.forecast.players.find((p) => p.playerId === "10")!.p_play,
      0,
    );
  },
);

test("pregame tables return immutable earlier forecasts paired only with released outcomes", async () => {
  const data = fixture(),
    g = { ...data.history.at(-1)!, season: "2025-26" },
    current = { ...g, gameId: "today", tip, release: "2025-10-23T13:00:00Z" };
  const source = {
    schedule: [g, current],
    input: async (game: typeof g) => ({
      ...data,
      gameId: game.gameId,
      tip: game.tip,
      history:
        game.gameId === g.gameId
          ? data.history.slice(0, -1)
          : [...data.history.slice(0, -1), g],
    }),
  };
  let fits = 0;
  const range: Range = [0, 1, 2, 3, 4, 5, 6];
  const model = {
    identity: async () => ({ version: "test", image: "test", source: "test" }),
    fit: (d: ModelInput) => {
      fits++;
      const forecast: Forecast = {
        version: "forecast-v1",
        gameId: d.gameId,
        players: d.roster.map(({ playerId }) => ({
          playerId,
          p_play: 0.8,
          p_start: 0.1,
          minutes: range,
          points: range,
          assists: range,
          rebounds: range,
          fantasy_points: range,
        })),
      };
      return { modelHash: digest(d), forecast };
    },
  };
  const root = await mkdtemp(join(tmpdir(), "reference-test-"));
  try {
    const tables = await referenceTables(source, "today", root, model);
    assert.equal(tables.history.length, 1);
    assert.equal(
      tables.history[0].errors[0].conditionalMedianError!.fantasy_points,
      -3.5,
    );
    assert.equal(tables.history[0].errors.at(-1)!.conditionalMedianError, null);
    assert.deepEqual(
      await referenceTables(source, "today", root, model),
      tables,
    );
    assert.equal(fits, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("injury partitions admit the cutoff day, skip later files and reject undated keys", async () => {
  const { InjuryAdapter } = await import("../src/data/adapters.js");
  const reads: string[] = [];
  const keys = [
    "reports/report_date=2025-10-22/rows",
    "reports/report_date=2025-10-23/rows",
  ];
  const release = {
    manifest: { partitions: keys.map((key) => ({ key })) },
    ref: (key: string) => ({ key }),
    rows: async (key: string) => {
      reads.push(key);
      return [];
    },
  };
  const adapter = new InjuryAdapter(
    release as unknown as Corpus["injuries"]["release"],
  );
  const scan = async () => {
    for await (const _ of adapter.partitions("players", "2025-10-22")) {
    }
  };
  await scan();
  assert.deepEqual(reads, [keys[0]]);
  release.manifest.partitions.push({ key: "reports/undated/rows" });
  await assert.rejects(scan, /Missing injury partition date/);
});
