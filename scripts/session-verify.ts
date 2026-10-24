import { DopplerStore } from "../src/data/store.js";
import { openCorpus } from "../src/data/corpus.js";
import { Identities } from "../src/data/identity.js";
import { loadQuestionLayer } from "../src/questions/builder.js";
import { corpusSource } from "../src/env/source.js";
import { Session } from "../src/env/session.js";
import { fixtureConfig } from "../test/fixtures/runner/support.js";
import { manifest } from "../src/runner/config.js";
import { HISTORY_TABLE } from "../src/env/source.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const store = new DopplerStore();
try {
  const c = await openCorpus(store, process.cwd(), ".cache/objects");
  const ids = new Identities();
  for (const m of JSON.parse(await readFile("config/identities.json", "utf8")))
    ids.add(m);
  const source = await corpusSource(
    c,
    await loadQuestionLayer(c.odds, ids),
    ids,
  );
  const config = fixtureConfig("live-smoke");
  config.profile.capabilities.enabled = ["game_history", "odds_history"];
  config.profile.dataSources = source.versions.map((v) => ({
    type: v.source,
    release: v.release,
    manifestSha256: v.manifest_sha256,
  }));
  config.devig.manifestSha256 = source.layer.manifest.sha256;
  config.devig.methodologySha256 = source.layer.methodology.sha256;
  const gs = (await source.games()).filter(
    (g) =>
      g.data.season === "2025-26" &&
      [g.data.home_team_id, g.data.away_team_id].includes("1610612738"),
  );
  const m = manifest(
    config,
    gs.map((g) => ({ gameId: g.id, scheduledStart: g.data.scheduled_tipoff })),
  );
  for (const id of [m.games[0].gameId, "0022500338"]) {
    const g = m.games.find((g) => g.gameId === id)!;
    for (const phase of ["pregame", "postgame"] as const) {
      const s = new Session(
        config,
        g,
        phase,
        phase === "pregame" ? g.scheduledStart : g.release,
        source,
      );
      const q = await s.list_questions({});
      const odds = await s.query_odds_history({});
      const result = {
        id,
        phase,
        questions: q.questions.length,
        odds: odds.observations.length,
        settlements: odds.settlements.length,
        unresolved: odds.settlements.filter((s) => s.outcome === "unresolved")
          .length,
      };
      console.log(result);
      if (phase === "pregame") assert.equal(odds.settlements.length, 0);
      if (phase === "postgame") {
        assert.ok(odds.settlements.length > 0);
        assert.equal(result.unresolved, 0);
        for (const table of Object.keys(
          HISTORY_TABLE,
        ) as (keyof typeof HISTORY_TABLE)[]) {
          const r = await s.query_game_history({
            table,
            game_id: id,
            limit: 1,
          });
          console.log(table, r.total, r.columns.length, r.unavailable);
          if (
            id === "0022500338" &&
            ["player_game_summary", "team_game_summary"].includes(table)
          ) {
            assert.equal(r.total, 0);
            assert.equal(r.unavailable.length, 1);
          } else assert.ok(r.total > 0);
          assert.ok(
            r.rows.every((row) =>
              Object.keys(row).every((k) =>
                r.columns.some((c) => c.name === k),
              ),
            ),
          );
        }
        const p = await s.query_game_history({
          table: "player_profiles",
          team_id: "1610612738",
          limit: 1,
        });
        assert.ok(p.total > 0);
        assert.equal(typeof p.rows[0]?.age_on_replay_date, "number");
        console.log("profiles", p.total, p.rows[0]?.age_on_replay_date);
      }
      if (id === m.games[0].gameId && phase === "pregame") {
        const r = await s.read_schedule_and_injuries({ game_id: id });
        console.log("injuries", r.team_snapshots, r.injury_reports.length);
      }
    }
  }
} finally {
  store.close();
}
