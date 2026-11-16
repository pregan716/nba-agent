import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/env/session.js";
import { teamIds } from "../src/data/teams.js";
import { fixtureCorpus, before, cutoff } from "./fixtures/session/corpus.js";

test("development session exports only pre-tip overlap evidence; final sessions see both test teams", async (t) => {
  const f = fixtureCorpus();
  const { BOS, DEN, MEM } = teamIds;
  f.source.teams.push(
    { team_id: DEN, abbreviation: "DEN", name: "Denver" },
    { team_id: MEM, abbreviation: "MEM", name: "Memphis" },
  );
  const [overlap, , final, holdout] = f.schedule;
  overlap.data.away_team_id = DEN;
  Object.assign(final.data, {
    home_team_id: DEN,
    away_team_id: MEM,
    scheduled_tipoff: cutoff,
  });
  Object.assign(holdout.data, {
    away_team_id: MEM,
    scheduled_tipoff: "2026-03-23T00:00:00Z",
  });
  const earlier = "2025-10-30T12:00:00Z";
  for (const kind of ["lineups", "injuries", "transcripts", "posts"]) {
    const template = f.records[kind][0];
    f.records[kind] = [];
    for (const [id, team, game, at] of [
      ["OVERLAP", DEN, overlap.id, earlier],
      ["LATE", DEN, overlap.id, overlap.data.scheduled_tipoff],
      ["DEN_PRIVATE", DEN, final.id, before],
      ["MEM_PRIVATE", MEM, final.id, before],
      ["HOLDOUT", MEM, holdout.id, before],
      ["AT_CUTOFF", MEM, final.id, cutoff],
      ...(kind === "posts" || kind === "transcripts"
        ? [
            ["UNTAGGED", DEN, undefined, before],
            ["OTHER_SIDE", BOS, final.id, before],
          ]
        : []),
    ] as const) {
      f.records[kind].push({
        ...template,
        id: kind + id,
        availableAt: at!,
        data: {
          ...template.data,
          team_id: team,
          game_id: game,
          gameId: game,
          postId: id,
          text: id,
          readable: id,
          player_name: id,
        },
      });
    }
  }
  f.profiles.push({
    ...f.profiles[0],
    id: "den-profile",
    data: {
      ...f.profiles[0].data,
      opening_team_id: DEN,
      full_name: "DEN_PRIVATE",
    },
  });
  const root = await mkdtemp(join(tmpdir(), "development-evidence-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  for (const development of [true, false]) {
    const game = {
      ...f.game,
      development,
      gameId: development ? f.game.gameId : final.id,
    };
    const session = new Session(
      f.config,
      game,
      "pregame",
      cutoff,
      f.source,
      undefined,
      undefined,
      undefined,
      true,
      development ? BOS : MEM,
    );
    const dir = join(root, development ? "development" : "final");
    try {
      await session.exportTo(dir, new AbortController().signal);
    } finally {
      await session.close();
    }
    const db = new DatabaseSync(join(dir, "session.sqlite"), {
      readOnly: true,
    });
    try {
      for (const [table, column] of Object.entries({
        lineups: "text",
        posts: "text",
        transcripts: "text",
        injury_players: "player_name",
        injury_teams: "player_name",
      })) {
        const values = db
          .prepare("select " + column + " as marker from " + table)
          .all()
          .map((r) => r.marker);
        if (development) assert.deepEqual(values, ["OVERLAP"], table);
        else {
          for (const label of [
            "OVERLAP",
            "DEN_PRIVATE",
            "MEM_PRIVATE",
            "HOLDOUT",
          ])
            assert.ok(values.includes(label), table + " " + label);
          assert.ok(!values.includes("AT_CUTOFF"));
          if (table !== "lineups") assert.ok(values.includes("LATE"));
        }
      }
      for (const [table, column, marker] of [
        ["schedule", "game_id", final.id],
        ["injuries", "player_name", "DEN_PRIVATE"],
        ["player_profiles", "full_name", "DEN_PRIVATE"],
      ]) {
        assert.equal(
          !!db
            .prepare("select 1 from " + table + " where " + column + "=?")
            .get(marker),
          !development,
          table,
        );
      }
      const files = join(dir, "evidence");
      const texts = await Promise.all(
        (await readdir(files)).map((name) =>
          readFile(join(files, name), "utf8"),
        ),
      );
      assert.ok(texts.includes("OVERLAP"));
      assert.equal(texts.includes("MEM_PRIVATE"), !development);
      assert.equal(
        !!db.prepare("select 1 from evidence where text='DEN_PRIVATE'").get(),
        !development,
      );
    } finally {
      db.close();
    }
  }
});
