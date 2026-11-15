import assert from "node:assert/strict";
import test from "node:test";
import {
  appearanceFacts,
  selectAppearances,
  summarize,
  winLossFacts,
} from "../src/harness/jev-probe.js";

const game = (gameId: string, won: boolean) => ({
  season: "2024-25",
  gameId,
  date: "2024-11-05",
  team: "DEN",
  teamName: "Denver Nuggets",
  opponent: "Utah Jazz",
  won,
});

test("probe statements name the team, and truth follows polarity and outcome", () => {
  const games = Array.from({ length: 40 }, (_, i) =>
    game("g" + i, i % 3 === 0),
  );
  const facts = winLossFacts(games);
  for (const [i, f] of facts.entries()) {
    assert.equal(f.truth, f.positive === games[i].won);
    assert.match(f.question, /^The Denver Nuggets (won|lost) their/);
    assert.equal(f.group, "result:2024-25:DEN");
  }
  // Polarity comes from the id alone, so both kinds of statement appear.
  assert.ok(facts.some((f) => f.positive) && facts.some((f) => !f.positive));
  const [a] = appearanceFacts([
    {
      ...game("g1", true),
      playerId: "7",
      playerName: "A Player",
      played: false,
    },
  ]);
  assert.equal(a.truth, a.positive === false);
  assert.equal(a.subject, "7");
});

test("appearance picks are players who play some games but not most", () => {
  const games = Array.from({ length: 20 }, (_, i) => ({
    gameId: "g" + i,
    roster: ["always", "never", "half"],
    played: new Set(i % 2 ? ["always", "half"] : ["always"]),
  }));
  const picks = selectAppearances(games);
  assert.equal(picks.length, 20);
  assert.ok(picks.every((p) => p.playerId === "half"));
});

test("a summary reports chance-level answers as chance", () => {
  const rows = winLossFacts(
    Array.from({ length: 40 }, (_, i) => game("g" + i, i % 2 === 0)),
  ).map((f) => ({ ...f, probability: 0.5 }));
  const s = summarize(rows);
  assert.equal(s.brier, 0.25);
  assert.equal(s.discrimination, 0);
  assert.equal(s.invalid, 0);
});
