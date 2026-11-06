import test from "node:test";
import assert from "node:assert/strict";
import {
  appearanceFacts,
  coin,
  selectAppearances,
  spokenDate,
  summarizeProbeGroups,
  winLossFacts,
} from "../src/policy/probe-facts.js";

const games = Array.from({ length: 40 }, (_, i) => ({
  season: "2025-26",
  gameId: `00225${String(i).padStart(5, "0")}`,
  date: "2025-11-0" + ((i % 9) + 1),
  opponent: "Example Team",
  celticsWon: true,
}));

test("statement polarity is independent of the outcome", () => {
  const facts = winLossFacts(games, "sha");
  // Every game was won, yet about half the statements are false.
  const truths = facts.filter((f) => f.truth).length;
  assert.ok(truths > 10 && truths < 30, String(truths));
  for (const [i, f] of facts.entries()) {
    assert.equal(f.truth, f.question.includes(" won "));
    assert.equal(coin(f.id), f.question.includes(" won "));
    assert.equal(f.group, "result:2025-26");
    assert.match(f.question, /Example Team on November \d, 2025\.$/);
    assert.ok(f.id.endsWith(games[i].gameId));
  }
  // Flipping every outcome flips every truth and no wording.
  const flipped = winLossFacts(
    games.map((g) => ({ ...g, celticsWon: false })),
    "sha",
  );
  for (const [i, f] of flipped.entries()) {
    assert.equal(f.question, facts[i].question);
    assert.equal(f.truth, !facts[i].truth);
  }
  assert.equal(spokenDate("2026-04-03"), "April 3, 2026");
});

test("appearance facts state played or did not play against the truth", () => {
  const [a, b] = appearanceFacts(
    ["p1", "p2"].map((playerId, i) => ({
      ...games[0],
      playerId,
      playerName: `Player ${i}`,
      played: i === 0,
    })),
    "sha",
  );
  assert.equal(a.truth, a.question.includes(" played ") === true);
  assert.equal(b.truth, b.question.includes(" did not play "));
});

test("appearance selection keeps only players whose participation is uncertain", () => {
  const roster = ["always", "never", "half", "short"];
  const rows = Array.from({ length: 20 }, (_, i) => ({
    gameId: `g${i}`,
    roster: i < 5 ? roster : roster.slice(0, 3),
    played: new Set(["always", ...(i % 2 ? ["half"] : []), "short"]),
  }));
  const picks = selectAppearances(rows);
  assert.equal(picks.length, 20);
  // "always" (100 %), "never" (0 %) and "short" (under ten games) are never asked.
  assert.deepEqual([...new Set(picks.map((p) => p.playerId))], ["half"]);
  for (const [i, p] of picks.entries()) assert.equal(p.played, i % 2 === 1);
  assert.deepEqual(selectAppearances(rows), picks);
  assert.deepEqual(
    selectAppearances([{ gameId: "x", roster: ["a"], played: new Set() }]),
    [],
  );
});

test("probe groups report chance-referenced statistics", () => {
  const summary = summarizeProbeGroups([
    { group: "a", truth: true, probability: 0.9 },
    { group: "a", truth: false, probability: 0.1 },
    { group: "a", truth: true, probability: null },
    { group: "b", truth: true, probability: 0.5 },
    { group: "b", truth: false, probability: 0.5 },
  ]);
  assert.equal(summary.a.facts, 3);
  assert.equal(summary.a.invalid, 1);
  assert.equal(summary.a.trueStatements, 2);
  assert.equal(summary.a.accuracy, 1);
  assert.ok(Math.abs(summary.a.brier! - 0.01) < 1e-12);
  assert.ok(Math.abs(summary.a.discrimination! - 0.8) < 1e-12);
  assert.equal(summary.b.discrimination, 0);
  assert.equal(summary.b.brier, 0.25);
});

test("an outcome-blind predictor that knows the win rate discriminates, and the reference accounts for it", () => {
  // Deterministic 75 % win rate over many games; polarity is hash-assigned.
  const many = Array.from({ length: 10000 }, (_, i) => ({
    season: "2025-26",
    gameId: `g${i}`,
    date: "2025-11-01",
    opponent: "Example Team",
    celticsWon: i % 4 !== 0,
  }));
  const facts = winLossFacts(many, "sha");
  const blind = summarizeProbeGroups(
    facts.map((f) => ({ ...f, probability: f.positive ? 0.75 : 0.25 })),
  )["result:2025-26"];
  // Knowing no single result, the predictor is far from uninformed chance...
  assert.ok(Math.abs(blind.accuracy! - 0.75) < 0.01);
  assert.ok(Math.abs(blind.brier! - 0.1875) < 0.005);
  assert.ok(Math.abs(blind.discrimination! - 0.25) < 0.01);
  // ...and the reference shows that none of it goes beyond the base rate.
  assert.ok(Math.abs(blind.baseRateReference!.positiveRate! - 0.75) < 1e-9);
  assert.ok(Math.abs(blind.beyondBaseRate!.discrimination!) < 1e-9);
  assert.ok(Math.abs(blind.beyondBaseRate!.brier!) < 1e-9);
  assert.ok(Math.abs(blind.beyondBaseRate!.accuracy!) < 1e-9);
  // A predictor that actually knows every result is well beyond it.
  const recall = summarizeProbeGroups(
    facts.map((f) => ({ ...f, probability: f.truth ? 1 : 0 })),
  )["result:2025-26"];
  assert.ok(recall.beyondBaseRate!.discrimination! > 0.7);
  assert.ok(recall.beyondBaseRate!.brier! < -0.18);
  // An uninformed predictor is below the reference, not at it.
  const flat = summarizeProbeGroups(
    facts.map((f) => ({ ...f, probability: 0.5 })),
  )["result:2025-26"];
  assert.ok(flat.beyondBaseRate!.discrimination! < -0.2);
});

test("per-subject rates give a stricter reference for appearance facts", () => {
  // One player plays 80 % of the time, another 20 %; pooled rate is 50 %.
  const rows = Array.from({ length: 400 }, (_, i) => {
    const often = i % 2 === 0,
      played = often ? i % 10 < 8 : i % 10 < 2;
    return {
      season: "2025-26",
      gameId: `g${i}`,
      date: "2025-11-01",
      opponent: "Example Team",
      playerId: often ? "often" : "rarely",
      playerName: often ? "Player A" : "Player B",
      played,
    };
  });
  const facts = appearanceFacts(rows, "sha");
  for (const f of facts) assert.ok(f.subject && f.positive !== undefined);
  // Outcome-blind, but aware of each player's usual rate.
  const prior = summarizeProbeGroups(
    facts.map((f) => {
      const rate = f.subject === "often" ? 0.8 : 0.2;
      return { ...f, probability: f.positive ? rate : 1 - rate };
    }),
  )["appearance:2025-26"];
  assert.ok(prior.discrimination! > 0.3);
  // The pooled reference misses the per-player prior; the subject one does not.
  assert.ok(prior.beyondBaseRate!.discrimination! > 0.3);
  assert.ok(Math.abs(prior.beyondSubjectRate!.discrimination!) < 0.02);
  // Without polarity the references are absent rather than guessed.
  const bare = summarizeProbeGroups([
    { group: "x", truth: true, probability: 0.7 },
  ]).x;
  assert.equal(bare.baseRateReference, null);
  assert.equal(bare.beyondBaseRate, null);
});
