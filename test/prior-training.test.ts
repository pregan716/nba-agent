import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadPriorSeasonTraining } from "../src/replay/load.js";
import { fitBaselines } from "../src/replay/baselines.js";
import { replay } from "../src/replay/run.js";
import { replayDescriptor } from "../src/launch/run.js";
import { chronologicalFixture } from "../scripts/fixtures/chronological.js";
import { BOS } from "../src/replay/types.js";

test("prior loader reads only the prior Celtics regular season, preserves two gaps and marks retrospective rosters", async () => {
  const input = JSON.parse(
    readFileSync("test/fixtures/replay/jump-prefixes.json", "utf8"),
  )[0].input;
  const ids = [
    "0022400061",
    "0022400230",
    ...Array.from({ length: 80 }, (_, i) => `prior-${i}`),
  ];
  const games = ids.map((id) => ({
    id,
    data: {
      season: "2024-25",
      phase: "regular_season",
      home_team_id: BOS,
      away_team_id: "1610612755",
      scheduled_tipoff: input.game.scheduledStart,
    },
  }));
  const roster = input.pregame.roster.map((r: any) => r.playerId);
  const tables = Object.fromEntries(
    [
      "events",
      "event_participants",
      "v_player_stints",
      "data_quality_issues",
    ].map((t) => [
      t,
      ids
        .slice(2)
        .flatMap((id) =>
          (
            input[
              t === "event_participants"
                ? "participants"
                : t === "v_player_stints"
                  ? "stints"
                  : t === "data_quality_issues"
                    ? "issues"
                    : t
            ] ?? []
          ).map((r: any) => ({ ...r, game_id: id })),
        ),
    ]),
  );
  tables.player_box_scores = ids.flatMap((id) =>
    roster.map((player_id: string) => ({
      game_id: id,
      team_id: BOS,
      player_id,
      minutes_seconds: 0,
    })),
  );
  const reads: string[] = [];
  const release = {
    root: input.release,
    manifest: {
      object_prefix: "",
      game_index: "index",
      tables: Object.fromEntries(Object.keys(tables).map((t) => [t, [t]])),
    },
    bytes: async () =>
      Buffer.from(
        JSON.stringify({
          tables: Object.fromEntries(
            Object.keys(tables).map((t) => [t, { [t]: ids.map((id) => [id]) }]),
          ),
        }),
      ),
    rows: async (t: string) => {
      reads.push(t);
      return tables[t];
    },
  };
  const corpus: any = {
    priorPbp: {
      release,
      coverage: async () => [],
      games: async () => [
        ...games,
        { id: "playoffs", data: { ...games[0].data, phase: "playoffs" } },
        { id: "other", data: { ...games[0].data, home_team_id: "other" } },
      ],
    },
    get pbp() {
      throw Error("Must not read current-season games");
    },
  };
  const datasets = await loadPriorSeasonTraining(corpus);
  assert.deepEqual(
    datasets.map((d) => d.gameId),
    ids,
  );
  assert.equal(datasets.length, 82);
  assert.deepEqual(
    datasets.filter((d) => !d.windows.length).map((d) => d.gameId),
    ids.slice(0, 2),
  );
  assert.ok(
    datasets.every(
      (d) => d.trainingOnly?.rosterPolicy === "same-game-box-score-v1",
    ),
  );
  assert.ok(reads.includes("player_box_scores"));
  assert.throws(() => replayDescriptor(datasets), /Training-only/);
  await assert.rejects(
    replay(datasets[2], "x", () => null, {} as any),
    /Training-only/,
  );
  const warmup = chronologicalFixture().datasets;
  const old = fitBaselines(warmup),
    fitted = fitBaselines(warmup, [...datasets, ...warmup]);
  assert.equal(fitted.constant.id, old.constant.id);
  assert.deepEqual(fitted.constant.parameters, old.constant.parameters);
  assert.deepEqual(
    fitted.constant.predict(warmup[0].windows[0].state!),
    old.constant.predict(warmup[0].windows[0].state!),
  );
  assert.equal(fitted.statistical.training.gameIds.length, 84);
});
