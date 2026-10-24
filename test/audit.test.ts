import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sample,
  checkConsensus,
  outcome,
  nearCutoff,
} from "../src/audit/checks.js";

test("audit sample is stable across ordering and rejects duplicate identities", () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: String(i) }));
  assert.deepEqual(
    sample(rows, 20, "fixed", (r) => r.id),
    sample([...rows].reverse(), 20, "fixed", (r) => r.id),
  );
  assert.equal(new Set(sample(rows, 20, "fixed", (r) => r.id)).size, 20);
  assert.throws(
    () => sample([{ id: "a" }, { id: "a" }], 1, "fixed", (r) => r.id),
    /Duplicate/,
  );
});
test("consensus audit independently checks normalization, main lines and alternate contributions", () => {
  const pairs = [
    {
      bookmaker: "a",
      line: 10.5,
      over_price: -110,
      under_price: -110,
      p_over: 0.5,
      p_under: 0.5,
      is_book_main_line: true,
      contributes_to_consensus: true,
    },
    {
      bookmaker: "b",
      line: 11.5,
      over_price: -110,
      under_price: -110,
      p_over: 0.5,
      p_under: 0.5,
      is_book_main_line: true,
      contributes_to_consensus: false,
    },
    {
      bookmaker: "b",
      line: 10.5,
      over_price: -150,
      under_price: 150,
      p_over: 0.6,
      p_under: 0.4,
      is_book_main_line: false,
      contributes_to_consensus: true,
    },
  ];
  const row = {
    selected_line: 10.5,
    p_over: 0.55,
    p_under: 0.45,
    contributing_books: ["a", "b"],
    contributing_book_count: 2,
  };
  assert.deepEqual(checkConsensus(row, pairs).problems, []);
  assert.ok(
    checkConsensus({ ...row, p_over: 0.6 }, pairs).problems.includes(
      "median probability",
    ),
  );
  assert.ok(
    checkConsensus(
      row,
      pairs.map((p, i) => (i === 0 ? { ...p, p_over: 0.9 } : p)),
    ).problems.includes("pair normalization"),
  );
  assert.ok(
    checkConsensus({ ...row, selected_line: 11 }, pairs).problems.includes(
      "selected line",
    ),
  );
});
test("audit resolution distinguishes missing evidence, DNP and push; boundaries are inclusive", () => {
  assert.equal(outcome(null, 5.5, null), "unresolved");
  assert.equal(outcome(null, 5.5, 0), "did_not_play");
  assert.equal(outcome(6, 6, 1), "push");
  assert.equal(outcome(0, 5.5, 1), "under");
  assert.equal(outcome(10, 5.5, 1), "over");
  assert.equal(
    nearCutoff("2026-01-01T00:30:00Z", "2026-01-01T00:00:00Z"),
    true,
  );
  assert.equal(
    nearCutoff("2025-12-31T23:30:00Z", "2026-01-01T00:00:00Z"),
    true,
  );
  assert.equal(
    nearCutoff("2026-01-01T00:30:01Z", "2026-01-01T00:00:00Z"),
    false,
  );
});
