import assert from "node:assert/strict";
import test from "node:test";
import {
  allowedRanges,
  eligibleGame,
  readAllowedRows,
} from "../src/harness/jev-probe-source.js";

const holdout = "2026-03-23T00:00:00Z";

test("a game is eligible only when its outcome was released before the holdout", () => {
  // Played two nights before: released the next morning, before the holdout.
  assert.equal(eligibleGame("2026-03-21T23:00:00Z", holdout), true);
  // Tipped before the holdout instant but released at 9 a.m. Eastern after it.
  assert.equal(eligibleGame("2026-03-22T21:00:00Z", holdout), false);
  assert.equal(eligibleGame("2026-03-23T00:00:00Z", holdout), false);
});

test("only the row ranges of allowed games are decoded, and other files stay closed", async () => {
  const index = {
    "ineligible.parquet": [
      ["late1", 0, 2],
      ["late2", 2, 2],
    ] as [string, number, number][],
    "mixed.parquet": [
      ["ok1", 0, 2],
      ["late3", 2, 2],
      ["ok2", 4, 2],
      ["ok3", 6, 2],
    ] as [string, number, number][],
  };
  const allowed = new Set(["ok1", "ok2", "ok3"]);
  assert.deepEqual(allowedRanges(index["mixed.parquet"], allowed), [
    { start: 0, end: 2 },
    { start: 4, end: 8 },
  ]);
  const games = index["mixed.parquet"].flatMap(([id]) => [id, id]);
  const calls: [string, number, number][] = [];
  const rows = await readAllowedRows(index, allowed, async (file, a, b) => {
    calls.push([file, a, b]);
    return games.slice(a, b).map((game_id) => ({ game_id }));
  });
  assert.deepEqual(calls, [
    ["mixed.parquet", 0, 2],
    ["mixed.parquet", 4, 8],
  ]);
  assert.deepEqual(
    rows.map((r) => r.game_id),
    ["ok1", "ok1", "ok2", "ok2", "ok3", "ok3"],
  );
});

test("a row outside the allowed games fails the read", async () => {
  await assert.rejects(
    readAllowedRows(
      { "f.parquet": [["ok", 0, 1]] },
      new Set(["ok"]),
      async () => [{ game_id: "late" }],
    ),
    /does not match/,
  );
});
