import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { PlayByPlayAdapter } from "../src/data/adapters.js";
import { Release } from "../src/data/release.js";
import { VerifiedStore, sha256, type ObjectRef } from "../src/data/store.js";
import { fixtureCorpus } from "./fixtures/session/corpus.js";
import { Session } from "../src/env/session.js";

for (const [status, emptyBoxes, expected] of [
  ["postponed", false, "void"],
  ["cancelled", true, "void"],
  ["canceled", false, "void"],
  ["final", false, "over"],
  ["completed", false, "over"],
  [undefined, false, "over"],
  ["scheduled", false, "unresolved"],
  ["in_progress", false, "unresolved"],
  ["unknown", false, "unresolved"],
  ["suspended", false, "unresolved"],
] as const) {
  test(`P1 ${status ?? "missing"} status stays hidden until release`, async () => {
    const f = fixtureCorpus(false);
    // A verified release exercises the actual P1 pick list, not a pre-built envelope.
    const key = "tables/games/phase=regular_season/part.jsonl";
    const games = Buffer.from(
      f.schedule
        .map((g) =>
          JSON.stringify({
            ...g.data,
            status: g.id === f.game.gameId ? status : "final",
            home_score: 999,
            away_score: 888,
          }),
        )
        .join("\n"),
    );
    const objects: Record<string, Buffer> = {
      [key]: games,
      root: Buffer.from(
        JSON.stringify({
          object_prefix: "",
          tables: { games: [key] },
          objects: { [key]: sha256(games) },
        }),
      ),
    };
    const rootRef: ObjectRef = {
      bucket: "sports-nba-data",
      key: "root",
      sha256: sha256(objects.root),
    };
    const adapter = new PlayByPlayAdapter(
      await Release.open(
        rootRef,
        new VerifiedStore({
          async get(_bucket, key) {
            if (!objects[key]) throw Error("Missing fixture object");
            return objects[key];
          },
        }),
      ),
    );
    // Exercise a source that shares rows: stripping pregame status must not
    // erase it for subsequent postgame sessions.
    const sharedGames = await adapter.games();
    f.source.games = async () => sharedGames;
    const columns = f.source.columns;
    f.source.columns = async (...args) => [
      ...(await columns(...args)),
      ...(args[0] === "games"
        ? [{ name: "status", description: "Published game status" }]
        : []),
    ];
    const current = (await adapter.games()).find(
      (g) => g.id === f.game.gameId,
    )!;
    assert.equal(current.data.status, status);
    assert.ok(!("home_score" in current.data));
    if (emptyBoxes) {
      const history = f.source.history;
      f.source.history = async (...args) =>
        args[1].id === f.game.gameId && args[0] !== "games"
          ? { records: [], reason: "No product for cancelled game" }
          : history(...args);
    }
    const pregame = new Session(
      f.config,
      f.game,
      "pregame",
      f.game.scheduledStart,
      f.source,
    );
    // Static metadata must not make final status available to the pregame agent.
    const schedule = await pregame.read_schedule_and_injuries({
      game_id: f.game.gameId,
    });
    assert.equal(schedule.schedule.length, 1);
    assert.ok(!("status" in schedule.schedule[0]));
    assert.equal(
      (
        await pregame.query_game_history({
          table: "games",
          game_id: f.game.gameId,
        })
      ).total,
      0,
    );

    const root = mkdtempSync(join(tmpdir(), "nba-game-status-"));
    try {
      const exported = await pregame.exportTo(
        join(root, "pre-export"),
        new AbortController().signal,
      );
      const db = new DatabaseSync(exported, { readOnly: true });
      try {
        assert.ok(
          !db
            .prepare("PRAGMA table_info(schedule)")
            .all()
            .some((c) => c.name === "status"),
        );
      } finally {
        db.close();
      }
      const shards = join(root, "pre-export", "games");
      assert.equal(
        readdirSync(shards).length,
        1,
        "Only the prior released game should have a history shard",
      );
      for (const shard of readdirSync(shards)) {
        const decoded = join(root, "decoded.sqlite");
        writeFileSync(decoded, gunzipSync(readFileSync(join(shards, shard))));
        const history = new DatabaseSync(decoded, { readOnly: true });
        try {
          assert.equal(
            history
              .prepare("SELECT count(*) AS n FROM games WHERE game_id = ?")
              .get(f.game.gameId)!.n,
            0,
          );
        } finally {
          history.close();
        }
      }
      const postgame = new Session(
        f.config,
        f.game,
        "postgame",
        f.game.release,
        f.source,
      );
      const history = await postgame.query_game_history({
        table: "games",
        game_id: f.game.gameId,
      });
      assert.equal(history.rows[0].status, status);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
