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
import { provider } from "./fixtures/runner/support.js";
import { Session, sessionEnvironment } from "../src/env/session.js";
import { manifest } from "../src/runner/config.js";
import { Runner } from "../src/runner/runner.js";
import { MeteringProxy } from "../src/runner/proxy.js";
import { readReport } from "../src/evaluation/report.js";

for (const [status, emptyBoxes, expected] of [
  ["postponed", false, "void"],
  ["cancelled", true, "void"],
  ["canceled", false, "void"],
  ["final", false, "over"],
  ["completed", false, "over"],
  [undefined, false, "over"],
] as const) {
  test(`P1 ${status ?? "missing"} status reaches runner capture, feedback and offline report`, async () => {
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
    f.source.games = () => adapter.games();
    const current = (await adapter.games()).find(
      (g) => g.id === f.game.gameId,
    )!;
    assert.equal(current.data.status, status);
    assert.ok(!("home_score" in current.data));
    if (emptyBoxes) {
      const history = f.source.history;
      f.source.history = async (...args) =>
        args[1].id === f.game.gameId
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
    await assert.rejects(
      () => pregame.resolutionInput(f.game.gameId),
      /not released/,
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
    const proxy = new MeteringProxy(provider);
    await proxy.listen();
    const runner = new Runner(
      root,
      manifest(f.config, [
        { gameId: f.game.gameId, scheduledStart: f.game.scheduledStart },
      ]),
      proxy,
      sessionEnvironment(f.config, f.source),
    );
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
      assert.equal(readdirSync(shards).length, 1); // only the prior released game
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
      let feedback:
        | { outcome: string; actual: number | null; score: number | null }
        | undefined;
      await runner.run(async ({ session }) => {
        const ctx = await session.call("context", {});
        if (ctx.phase === "postgame") {
          feedback = (await session.call("read_released_results", {})).games[0]
            .questions[0];
          return;
        }
        assert.ok(!("status" in ctx.game));
        const qs = await session.call("list_questions", {});
        await session.call("begin_commit", {});
        await session.call("submit", {
          answers: qs.questions.map((q) => ({
            question_id: q.question_id,
            p_over: 0.6,
            rationale: "fixture",
          })),
        });
      });
      const captured = runner.record.events("resolution_input");
      assert.equal(captured.length, 1);
      assert.equal(captured[0].data.status, status ?? "");
      assert.equal(feedback?.outcome, expected);
      runner.close();
      const report = readReport(runner.root);
      assert.equal(report.rows[0].outcome, expected);
      assert.equal(report.rows[0].skill, feedback!.score);
      assert.equal(report.rows[0].actual, feedback!.actual);
      if (expected === "void") {
        assert.equal(report.rows[0].reason, "void");
        assert.equal(report.rows[0].actual, null);
        assert.equal(report.rows[0].skill, null);
        assert.equal(report.totals.scored, 0);
      } else {
        assert.equal(report.totals.scored, 1);
        assert.ok(report.rows[0].skill! > 0);
      }
    } finally {
      runner.close();
      await proxy.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
