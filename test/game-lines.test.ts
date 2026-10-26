import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  buildGameLines,
  gameLineMethodHash,
} from "../src/questions/game-lines.js";
import { Session } from "../src/env/session.js";
import {
  fixtureCorpus,
  cutoff,
  before,
  future,
} from "./fixtures/session/corpus.js";
function quotes(at = cutoff) {
  return ["book-a", "book-b"].flatMap((bookmaker) =>
    [
      ["spreads", "Boston Celtics", null, -4],
      ["spreads", "Opponent", null, 4],
      ["team_totals", "Over", "Boston Celtics", 112],
      ["team_totals", "Under", "Boston Celtics", 112],
      ["team_totals", "Over", "Opponent", 108],
      ["team_totals", "Under", "Opponent", 108],
    ].map(([market, selection, description, line]) => ({
      espn_event_id: "current",
      requested_at: at,
      snapshot_kind: at === cutoff ? "scheduled_start" : "pregame",
      market,
      selection,
      description,
      line,
      bookmaker,
      price: -110,
      odds_format: "american",
      price_is_indicative: false,
      snapshot_at: at,
      last_update: at,
    })),
  );
}
test("game lines preserve spread sign, proportional pairs, derived totals, counts and missing markets", () => {
  const rows = quotes();
  const [r] = buildGameLines(rows);
  assert.equal(r.celtics_spread, -4);
  assert.equal(r.game_total, 220);
  assert.equal(r.celtics_implied_total, 112);
  assert.equal(r.opponent_implied_total, 108);
  assert.equal(r.spread_book_count, 2);
  assert.equal(r.total_book_count, 2);
  assert.equal(r.implied_total_book_count, 2);
  assert.equal(r.p_celtics_cover, 0.5);
  assert.equal(buildGameLines(rows, 3)[0].game_total, null);
  assert.equal(buildGameLines(rows, 3)[0].celtics_spread, null);
  const totals = buildGameLines(
    rows.filter((r) => r.market === "team_totals"),
  )[0];
  assert.equal(totals.game_total, 220);
  assert.equal(totals.celtics_spread, null);
  assert.equal(totals.celtics_implied_total, null);
  const dfs = rows.map((r) => ({ ...r, bookmaker: "prizepicks" }));
  assert.equal(buildGameLines(dfs)[0].spread_book_count, 0);
  const conflicting = [...rows, { ...rows[0], price: 120 }];
  assert.equal(buildGameLines(conflicting)[0].spread_book_count, 1);
  const mismatched = rows.map((r) => ({
    ...r,
    last_update: r.selection === "Under" ? before : cutoff,
  }));
  assert.equal(buildGameLines(mismatched)[0].game_total, null);
});

test("context, history and sandbox share cutoff-gated lines across memory modes and phases", async () => {
  const budget = {
    tokens: 100,
    compute_seconds: 10,
    tool_calls: 10,
    submission_reserve: 10,
    warning: false,
  };
  for (const horizon of ["stateless", "season"] as const) {
    const f = fixtureCorpus(false);
    f.config.profile.memory.horizon = horizon;
    const ref = f.source.layer.manifest;
    f.source.layer.gameLines = {
      rows: buildGameLines([
        ...quotes(before),
        ...quotes(),
        ...quotes(future),
        ...quotes(before).map((r) => ({ ...r, espn_event_id: "prior" })),
        ...quotes(before).map((r) => ({ ...r, espn_event_id: "future" })),
      ]),
      provenance: {
        layer_manifest: ref,
        source_manifest: ref,
        quotes: ref,
        methodology: ref,
        adaptation_sha256: gameLineMethodHash,
      },
    };
    for (const phase of ["pregame", "postgame"] as const) {
      const s = new Session(
        f.config,
        f.game,
        phase,
        phase === "pregame" ? cutoff : f.game.release,
        f.source,
      );
      const context = await s.context(budget);
      assert.equal(context.game_lines.game_total, 220);
      assert.equal(context.game_lines.available_at, cutoff);
      const history = await s.query_odds_history({});
      assert.equal(
        (await s.query_odds_history({ game_id: "prior" })).game_lines.length,
        1,
      );
      assert.equal(
        (await s.query_odds_history({ game_id: "future" })).game_lines.length,
        0,
      );
      assert.equal(history.game_lines.length, phase === "pregame" ? 2 : 3);
      const directory = mkdtempSync(join(tmpdir(), "nba-game-lines-"));
      try {
        await s.exportTo(directory, new AbortController().signal);
        const db = new DatabaseSync(join(directory, "session.sqlite"));
        try {
          const rows = db
            .prepare(
              "SELECT game_total,available_at FROM game_lines WHERE game_id = ? ORDER BY available_at",
            )
            .all(f.game.gameId);
          assert.equal(rows.length, history.game_lines.length);
          assert.ok(rows.every((r) => r.game_total === 220));
        } finally {
          db.close();
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }
});
