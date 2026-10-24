import { DopplerStore } from "../src/data/store.js";
import { openCorpus } from "../src/data/corpus.js";
import assert from "node:assert/strict";
const raw = new DopplerStore();
try {
  const c = await openCorpus(raw, process.cwd(), ".cache/objects");
  for (const table of [
    "player_profiles",
    "player_season_stats",
    "player_2024_25_summary",
    "player_career_summary",
    "player_reference",
    "player_identity_exceptions",
  ]) {
    const rows = await c.players.records(table);
    assert.ok(rows.length);
    assert.ok(
      rows.every(
        (r) =>
          r.availableAt &&
          r.availabilityConvention === "opening_reference_static",
      ),
    );
    console.log(table, rows.length);
  }
  for (const [adapter, game] of [
    [c.pbp, "0022500338"],
    [c.priorPbp, "0022400061"],
  ] as const) {
    const rows = await adapter.records("player_box_scores", game);
    assert.ok(rows.length);
    console.log("official_box_scores", game, rows.length);
  }
  assert.equal(
    (await c.pbp.records("v_player_game_summary", "0022500338")).length,
    0,
  );
  let tested = false;
  for await (const records of c.injuries.partitions("players")) {
    assert.ok(records.length);
    assert.ok(records.every((r) => !("interpretation_assessed_at" in r.data)));
    tested = true;
    console.log("injury_player_partition", records.length);
    break;
  }
  assert.ok(tested);
  console.log("Live source adapter checks passed.");
} finally {
  raw.close();
}
