import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import {
  decisionRows,
  decisionColumns,
  withDecisionHistory,
  DECISION_TABLES,
} from "../src/env/decision-history.js";
import { chronologicalFixture } from "../scripts/fixtures/chronological.js";
import {
  fixtureCorpus,
  envelope,
  BOS,
  OPP,
} from "./fixtures/session/corpus.js";
import { Session } from "../src/env/session.js";
import { STATIC_AT } from "../src/data/contracts.js";

function history(gameId: string) {
  const dataset = structuredClone(chronologicalFixture().datasets[0]);
  dataset.gameId = gameId;
  dataset.windows.forEach((w) => {
    w.gameId = gameId;
    w.id = `${gameId}:in:1`;
    w.state!.gameId = gameId;
  });
  const first = dataset.windows[0];
  dataset.windows.push({
    ...structuredClone(first),
    id: `${gameId}:period:2`,
    kind: "between_periods",
    actual: { players_out: [], players_in: [] },
    state: {
      ...structuredClone(first.state!),
      period: 2,
      clockMs: 720000,
      stoppage: {
        kind: "between_periods",
        timeoutTeam: null,
        freeThrowsPending: null,
      },
    },
  });
  dataset.windows.push({
    ...structuredClone(first),
    id: `${gameId}:excluded`,
    state: null,
    actual: null,
    exclusions: ["marker_after_decision", "unknown_lineup"],
    adjacentSubstitutionBuckets: 1,
  });
  dataset.ledger = [
    {
      gameId,
      datasetVersion: dataset.version,
      releaseManifestSha256: dataset.release.sha256,
      span: [2, 3],
      reason: "unanchored_substitution",
      mechanism: "other_substitution_only",
    },
  ];
  const events = [
    {
      game_id: gameId,
      event_id: "opener",
      canonical_sequence: 1,
      period: 1,
      clock_remaining_ms: 600000,
      type: "timeout",
      subtype: "full",
      validity: "effective",
    },
    ...[2, 3].map((i) => ({
      game_id: gameId,
      event_id: `e${i}`,
      canonical_sequence: i,
      period: 1,
      clock_remaining_ms: 600000,
      type: "substitution",
      team_id: BOS,
      validity: "effective",
    })),
  ];
  const participants = [
    { event_id: "e2", role: "sub_out", player_id: "a" },
    { event_id: "e3", role: "sub_in", player_id: "f" },
  ];
  return { dataset, events, participants };
}
test("decision facts project every window and ledger row with complete descriptions", () => {
  const h = history("prior"),
    rows = decisionRows("decision_windows", h) as any[];
  assert.equal(rows.length, h.dataset.windows.length);
  rows.forEach((row, i) => {
    const w = h.dataset.windows[i];
    assert.equal(row.window_id, w.id);
    assert.deepEqual(row.players_out, w.actual?.players_out ?? null);
    assert.deepEqual(row.players_in, w.actual?.players_in ?? null);
    assert.equal(
      row.substituted,
      w.actual ? Number(w.actual.players_out.length > 0) : null,
    );
    assert.deepEqual(row.state, w.state);
    assert.equal(
      row.exclusion_reason,
      w.exclusions.length ? w.exclusions.join(";") : null,
    );
  });
  assert.equal(rows[0].canonical_sequence, 1); // state cutoff is 2
  assert.equal(rows[1].canonical_sequence, null);
  assert.equal(rows[1].stoppage_kind, "between_periods");
  assert.equal(rows[2].stoppage_kind, "timeout");
  assert.equal(rows[2].adjacency, 1);
  assert.equal(rows[2].period, 1);
  const ledger = decisionRows("unanchored_substitutions", h) as any[];
  assert.equal(ledger.length, h.dataset.ledger.length);
  assert.deepEqual(ledger[0], {
    game_id: "prior",
    period: 1,
    clock_remaining_ms: 600000,
    mechanism: "other_substitution_only",
    sequence_start: 2,
    sequence_end: 3,
    players_out: ["a"],
    players_in: ["f"],
  });
  for (const table of DECISION_TABLES) {
    const columns = decisionColumns(table);
    assert.ok(columns.every((c) => c.description.length > 0));
    assert.deepEqual(
      Object.keys(decisionRows(table, h)[0]).sort(),
      columns.map((c) => c.name).sort(),
    );
    assert.ok(
      columns.every(
        (c) =>
          !["noul", "brier", "score", "prediction", "answers"].includes(c.name),
      ),
    );
  }
});

test("query and shards expose prior seasons but never current or future decision facts, including postgame", async () => {
  const root = mkdtempSync(join(tmpdir(), "decision-history-")),
    f = fixtureCorpus();
  const old = envelope("old", "schedule", STATIC_AT, "schedule_static", {
    game_id: "old",
    season: "2024-25",
    scheduled_tipoff: "2024-11-01T23:00:00Z",
    home_team_id: BOS,
    away_team_id: OPP,
  });
  const base = {
    ...f.source,
    games: async () => [old, ...(await f.source.games())],
  };
  const loaded: string[] = [];
  const source = withDecisionHistory(base, async (game) => {
    loaded.push(game.id);
    return history(game.id);
  });
  f.config.profile.dataSources = source.versions.map((v) => ({
    type: v.source,
    release: v.release,
    manifestSha256: v.manifest_sha256,
  }));
  mkdirSync(join(root, "workspace"));
  const session = new Session(
    f.config,
    f.game,
    "pregame",
    f.game.scheduledStart,
    source,
    join(root, "workspace"),
    root,
  );
  try {
    const oldRows = await session.query_game_history({
      table: "decision_windows",
      game_id: "old",
      include_metadata: true,
    });
    assert.equal(oldRows.rows.length, 3);
    assert.match(oldRows.table_description!, /windows-v2/);
    assert.ok(oldRows.columns.every((c) => c.description));
    assert.deepEqual(
      JSON.parse(
        oldRows.rows.find((r) => r.window_id === "old:in:1")!.state as string,
      ),
      history("old").dataset.windows[0].state,
    );
    for (const id of ["current", "future"])
      assert.equal(
        (
          await session.query_game_history({
            table: "decision_windows",
            game_id: id,
          })
        ).rows.length,
        0,
      );
    assert.ok(!loaded.includes("current") && !loaded.includes("future"));
    await session.transition("commit", f.game.scheduledStart);
    await session.transition("postgame", f.game.release);
    assert.equal(
      (
        await session.query_game_history({
          table: "decision_windows",
          game_id: "current",
        })
      ).rows.length,
      0,
    );
    const out = join(root, "export");
    await session.exportTo(out, new AbortController().signal);
    const ids = new Set<string>();
    let currentEvents = false;
    for (const path of readdirSync(join(out, "games"))) {
      const file = join(root, path + ".db");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(file, gunzipSync(readFileSync(join(out, "games", path))));
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        for (const row of db.prepare("select * from decision_windows").all())
          ids.add(row.game_id as string);
        const metadata = db
          .prepare(
            "select * from _history_metadata where table_name='decision_windows'",
          )
          .all();
        assert.equal(
          metadata.length,
          decisionColumns("decision_windows").length,
        );
        assert.ok(
          metadata.every((r) =>
            String(r.table_description).includes("windows-v2"),
          ),
        );
        if (
          db.prepare("select game_id from games where game_id='current'").get()
        ) {
          currentEvents = true;
          assert.equal(
            db.prepare("select count(*) n from decision_windows").get()!.n,
            0,
          );
        }
      } finally {
        db.close();
      }
    }
    assert.ok(ids.has("old") && ids.has("prior"));
    assert.ok(!ids.has("current") && !ids.has("future"));
    assert.ok(currentEvents);
  } finally {
    await session.close();
    rmSync(root, { recursive: true, force: true });
  }
});
