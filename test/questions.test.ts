import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { OddsAdapter } from "../src/data/adapters.js";
import { Release } from "../src/data/release.js";
import { Identities } from "../src/data/identity.js";
import { VerifiedStore, sha256, type ObjectRef } from "../src/data/store.js";
import type { Row } from "../src/data/contracts.js";
import {
  buildQuestionSet,
  agentQuestion,
  loadQuestionLayer,
  validateLayerSummary,
  type QuestionLayer,
} from "../src/questions/builder.js";
const cutoff = "2025-10-22T23:30:00Z";
const game = {
  game_id: "nba-game",
  espn_event_id: "espn-game",
  scheduled_start: cutoff,
};
const ref = (key: string): ObjectRef => ({
  bucket: "pm-data-platform",
  key,
  sha256: "a".repeat(64),
});
function row(overrides: Row = {}): Row {
  return {
    espn_event_id: game.espn_event_id,
    espn_player_id: "espn-player",
    player_name: "Test Player",
    prop_type: "player_points",
    requested_at: cutoff,
    scheduled_start: cutoff,
    snapshot_at: "2025-10-22T23:25:39Z",
    snapshot_kind: "scheduled_start",
    status: "ok",
    selected_line: 20.5,
    p_over: 0.53456789,
    p_under: 0.46543211,
    contributing_books: ["book-a"],
    contributing_book_count: 1,
    probability_min: 0.53456789,
    probability_max: 0.53456789,
    probability_stddev: 0,
    season_inferred_identity_in_inputs: true,
    contributor_set_changed: true,
    selected_line_changed: false,
    lost_contributors: ["book-b"],
    gained_contributors: [],
    rejected_pairs: [{ bookmaker: "book-b", reason: "missing_side" }],
    last_update_oldest: "2025-10-22T23:24:00Z",
    last_update_newest: "2025-10-22T23:24:00Z",
    method: "proportional",
    line_selection: "median_book_main_lines",
    probability_basis: "unconditional",
    ...overrides,
  };
}
function summarize(rows: Row[]): Row {
  const counts = (list: Row[], field: string) => {
    const result: Record<string, number> = {};
    for (const r of list) result[r[field]] = (result[r[field]] ?? 0) + 1;
    return result;
  };
  const ok = rows.filter((r) => r.status === "ok");
  return {
    games: new Set(rows.map((r) => r.espn_event_id)).size,
    rows: rows.length,
    usableQuotes: ok.length,
    statusCounts: counts(rows, "status"),
    usableBySnapshotKind: counts(ok, "snapshot_kind"),
    usableByProp: counts(ok, "prop_type"),
  };
}
function layer(rows = [row()]): QuestionLayer {
  return {
    manifest: ref("layer/_MANIFEST.json"),
    methodology: ref("layer/methodology.json"),
    consensus: ref("layer/consensus.ndjson.gz"),
    bookLines: ref("layer/book-lines.ndjson.gz"),
    summaryRef: ref("layer/summary.json"),
    rows,
    pairs: rows
      .filter((r) => r.status === "ok")
      .map((r) => ({
        ...r,
        bookmaker: "book-a",
        line: r.selected_line,
        over_price: -110,
        under_price: -110,
        is_book_main_line: true,
        contributes_to_consensus: true,
      })),
    summary: summarize(rows),
    playerIds: { "espn-player": "nba-player" },
  };
}

test("cutoff builder includes agreed stats once, logs all exclusion statuses, and preserves published evidence", () => {
  const rows = [
    row(),
    row({ prop_type: "player_rebounds" }),
    row({ prop_type: "player_assists" }),
    ...["no_quotes", "dfs_only", "no_complete_sportsbook_pair"].map(
      (status, i) =>
        row({
          espn_player_id: `excluded-${i}`,
          status,
          selected_line: null,
          p_over: null,
          p_under: null,
        }),
    ),
    row({ prop_type: "player_threes" }),
    row({ prop_type: "player_points_rebounds_assists" }),
    row({ prop_type: "player_steals" }),
    row({ prop_type: "player_blocks" }),
    row({ prop_type: "player_minutes" }),
    row({
      snapshot_kind: "pregame",
      requested_at: "2025-10-22T22:00:00Z",
      p_over: 999,
    }),
    row({ espn_event_id: "other", p_over: 999 }),
  ];
  const l = layer(rows),
    set = buildQuestionSet(game, l);
  assert.deepEqual(set.questions.map((q) => q.stat).sort(), [
    "assists",
    "points",
    "rebounds",
  ]);
  assert.deepEqual(set.exclusions.map((e) => e.status).sort(), [
    "dfs_only",
    "no_complete_sportsbook_pair",
    "no_quotes",
  ]);
  assert.equal(new Set(set.questions.map((q) => q.question_id)).size, 3);
  for (const q of set.questions) {
    assert.equal(q.p_over, 0.53456789);
    assert.equal(q.p_under, 0.46543211);
    assert.equal(q.provenance.manifest_sha256, l.manifest.sha256);
    assert.equal(q.provenance.methodology_sha256, l.methodology.sha256);
    assert.deepEqual(
      q.provenance.consensus_row,
      rows.find((r) => r.prop_type === `player_${q.stat}`),
    );
    assert.equal(q.provenance.contributing_pairs[0].over_price, -110);
    // Raw -110/-110 would yield .5: no reconstruction or rounding is permitted here.
    assert.notEqual(q.p_over, 0.5);
  }
});
test("agent projection exposes exactly five fields and canonical player identity, with no provenance", () => {
  const q = buildQuestionSet(game, layer()).questions[0],
    visible = agentQuestion(q);
  assert.deepEqual(visible, {
    question_id: q.question_id,
    player: { id: "nba-player", name: "Test Player" },
    stat: "points",
    line: 20.5,
    p_over: 0.53456789,
  });
  assert.deepEqual(Object.keys(visible).sort(), [
    "line",
    "p_over",
    "player",
    "question_id",
    "stat",
  ]);
  assert.deepEqual(Object.keys(visible.player).sort(), ["id", "name"]);
  assert.notEqual(visible.player, q.player);
});
test("IDs, ordering and frozen records are deterministic and detached from caller inputs", () => {
  const l = layer([row(), row({ prop_type: "player_assists" })]),
    set = buildQuestionSet(game, l);
  assert.deepEqual(
    set,
    buildQuestionSet(
      { ...game, scheduled_start: "2025-10-22T23:30Z" },
      { ...l, rows: [...l.rows].reverse(), pairs: [...l.pairs].reverse() },
    ),
  );
  const changed = buildQuestionSet(game, {
    ...l,
    methodology: { ...l.methodology, sha256: "b".repeat(64) },
  });
  assert.notEqual(
    set.questions[0].question_id,
    changed.questions[0].question_id,
  );
  assert.throws(() => {
    set.questions[0].provenance.consensus_row.contributing_books.push("new");
  }, TypeError);
  l.rows[0].contributing_books.push("caller-mutation");
  assert.equal(
    set.questions.find((q) => q.stat === "points")!.provenance.consensus_row
      .contributing_books.length,
    1,
  );
  assert.throws(() => {
    set.questions.length = 0;
  }, TypeError);
});
test("builder rejects duplicates, canonical collisions and missing identities", () => {
  const r = row();
  assert.throws(
    () => buildQuestionSet(game, { ...layer(), rows: [r, { ...r }] }),
    /Duplicate cutoff/,
  );
  const l = layer([row(), row({ espn_player_id: "another" })]);
  l.playerIds.another = "nba-player";
  assert.throws(() => buildQuestionSet(game, l), /Duplicate canonical/);
  assert.throws(
    () => buildQuestionSet(game, { ...layer(), playerIds: {} }),
    /Unmapped/,
  );
});
test("builder refuses malformed probabilities, wrong cutoff, unrecognized status and incomplete contributor evidence", () => {
  for (const bad of [
    { p_over: NaN },
    { p_under: Infinity },
    { p_over: -0.1, p_under: 1.1 },
    { p_over: 0.5, p_under: 0.6 },
    { p_over: "0.53456789" },
    { selected_line: null },
  ])
    assert.throws(() => buildQuestionSet(game, layer([row(bad)])), /Invalid/);
  for (const bad of [
    { requested_at: "2025-10-22T23:29Z" },
    { scheduled_start: "2025-10-23T00:00Z" },
  ])
    assert.throws(
      () => buildQuestionSet(game, layer([row(bad)])),
      /Cutoff mismatch/,
    );
  assert.throws(
    () => buildQuestionSet(game, layer([row({ status: "pending" })])),
    /Unknown consensus status/,
  );
  assert.throws(
    () => buildQuestionSet(game, { ...layer(), pairs: [] }),
    /contributor evidence/,
  );
  const l = layer();
  l.pairs.push({ ...l.pairs[0] });
  assert.throws(() => buildQuestionSet(game, l), /contributor evidence/);
  assert.throws(
    () => buildQuestionSet({ ...game, espn_event_id: "missing" }, layer()),
    /No cutoff rows/,
  );
});
test("single-question and entirely excluded games remain represented; rounding tolerance does not renormalize", () => {
  assert.equal(buildQuestionSet(game, layer()).questions.length, 1);
  const excluded = buildQuestionSet(
    game,
    layer([
      row({
        status: "no_quotes",
        selected_line: null,
        p_over: null,
        p_under: null,
      }),
    ]),
  );
  assert.equal(excluded.questions.length, 0);
  assert.equal(excluded.exclusions.length, 1);
  const set = buildQuestionSet(
    game,
    layer([row({ p_over: 0.53, p_under: 0.4700000001 })]),
  );
  assert.equal(set.questions[0].p_under, 0.4700000001);
});

test("loader verifies all source bytes and published summary totals", async () => {
  const l = layer(),
    objects: Record<string, Buffer> = {
      [l.consensus.key]: gzipSync(
        Buffer.from(l.rows.map((r) => JSON.stringify(r)).join("\n")),
      ),
      [l.bookLines.key]: gzipSync(
        Buffer.from(l.pairs.map((r) => JSON.stringify(r)).join("\n")),
      ),
      [l.methodology.key]: Buffer.from(
        JSON.stringify({ method: "proportional" }),
      ),
      [l.summaryRef.key]: Buffer.from(JSON.stringify(l.summary)),
    };
  const manifest = Buffer.from(
    JSON.stringify({
      objects: Object.entries(objects).map(([key, b]) => ({
        key,
        sha256: sha256(b),
        bytes: b.length,
      })),
    }),
  );
  const root = { ...l.manifest, sha256: sha256(manifest) };
  objects[root.key] = manifest;
  const ids = new Identities();
  ids.add({
    entity: "player",
    provider: "espn",
    providerId: "espn-player",
    canonicalId: "nba-player",
    basis: "fixture",
    evidence: [root],
  });
  const store = new VerifiedStore({
    get: async (_bucket, key) => objects[key],
  });
  const adapter = new OddsAdapter(await Release.open(root, store));
  const loaded = await loadQuestionLayer(adapter, ids);
  assert.equal(buildQuestionSet(game, loaded).questions.length, 1);
  for (const key of [
    l.summaryRef.key,
    l.bookLines.key,
    l.methodology.key,
    l.consensus.key,
  ]) {
    const previous = objects[key];
    objects[key] = Buffer.from("tampered");
    // A fresh release must verify every input; a warm parsed-row cache keeps
    // the already verified immutable revision rather than rereading storage.
    const uncached = new OddsAdapter(await Release.open(root, store));
    await assert.rejects(
      loadQuestionLayer(uncached, ids),
      /Integrity mismatch/,
    );
    objects[key] = previous;
  }
  const changed = structuredClone(loaded);
  changed.summary.usableBySnapshotKind.scheduled_start = 2;
  assert.throws(() => validateLayerSummary(changed), /summary mismatch/);
});

test("season evidence retains all 82 games, matches per-game coverage, and includes April 12's one question", async () => {
  const read = async (name: string) =>
    JSON.parse(
      await readFile(
        new URL(`../docs/evidence/${name}.json`, import.meta.url),
        "utf8",
      ),
    );
  const report = await read("question-sets-2025-26"),
    coverage = await read("coverage-2025-26");
  assert.equal(report.games, 82);
  assert.equal(new Set(report.perGame.map((g: Row) => g.gameId)).size, 82);
  assert.equal(report.questions, 1779);
  for (const g of report.perGame) {
    const c = coverage.perGame.find((r: Row) => r.gameId === g.gameId);
    assert.ok(c);
    assert.deepEqual(g.statusCounts, c.cutoffStatusCounts);
  }
  assert.equal(
    report.perGame.find((g: Row) => g.espnEventId === "401811041").questions,
    1,
  );
});
