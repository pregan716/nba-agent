import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGameLines,
  gameLineVersion,
} from "../src/projection/game-lines.js";
import { cutoff, before } from "./fixtures/session/corpus.js";
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
test("pinned game lines preserve spread sign, paired team totals and missing markets", () => {
  const rows = quotes();
  function values(data: typeof rows) {
    const [r] = buildGameLines(data);
    return [r.celtics_spread, r.game_total];
  }
  assert.deepEqual(values(rows), [-4, 220]);
  assert.deepEqual(values(rows.filter((r) => r.market === "team_totals")), [
    null,
    220,
  ]);
  assert.deepEqual(
    values(rows.map((r) => ({ ...r, bookmaker: "prizepicks" }))),
    [null, null],
  );
  const one = rows.filter((r) => r.bookmaker === "book-a");
  assert.deepEqual(values([...one, { ...one[0], price: 120 }]), [null, 220]);
  assert.deepEqual(
    values(
      rows.map((r) => ({
        ...r,
        last_update: r.selection === "Under" ? before : cutoff,
      })),
    ),
    [-4, null],
  );
  assert.deepEqual(
    values(
      rows.filter(
        (r) =>
          r.market === "spreads" ||
          (r.description === "Opponent") === (r.bookmaker === "book-a"),
      ),
    ),
    [-4, null],
  );
});

test("game-line source pins the SPO-829 methodology", () => {
  assert.equal(
    gameLineVersion.manifest_sha256,
    "a83d4537b93d028bb856b357bb10438d1b8624ea49d4a6feea442271e7d402ad",
  );
});
