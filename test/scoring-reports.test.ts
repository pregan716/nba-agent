import test from "node:test";
import assert from "node:assert/strict";
import { scoreWindow, summarize } from "../src/replay/scoring.js";
import type { Window } from "../src/replay/types.js";
const near = (a: number | null, b: number) =>
  assert.ok(a !== null && Math.abs(a - b) < 1e-10, `${a} != ${b}`);
function row(p: number, y: number, gameId = "g", kind = "timeout", k = 1) {
  const window = {
    id: `${gameId}:${p}:${y}:${kind}`,
    gameId,
    kind: kind === "between_periods" ? kind : "in_period",
    exclusions: [],
    actual: {
      players_out: y ? ["a", "b"].slice(0, k) : [],
      players_in: y ? ["f", "g"].slice(0, k) : [],
    },
    state: {
      gameId,
      stoppage: { kind },
      celtics: ["a", "b", "c", "d", "e"],
      eligibleBench: ["f", "g", "h"],
      flags: [],
    },
  } as unknown as Window;
  return scoreWindow(window, {
    substitution: { type: "noul", noul: p },
    count: {
      type: "score",
      probabilities: { none: 0, one: 1, two: 0, three_or_more: 0 },
    },
    exit: {
      type: "choice",
      probabilities: { a: 0.4, b: 0.3, c: 0.2, d: 0.1, e: 0 },
    },
    entry: { type: "choice", probabilities: { f: 0.6, g: 0.3, h: 0.1 } },
  });
}
test("constant skill and game-weighted pooled Murphy decomposition", () => {
  const rows = [
    row(0.5, 0),
    row(0.5, 1),
    row(0.25, 0, "h"),
    row(0.25, 0, "h"),
    row(0.25, 0, "h"),
    row(0.25, 1, "h"),
  ];
  const m = summarize(rows);
  near(m.timingSkillVsConstant, 0);
  near(m.timingConstantBrier, (2 * 0.25 + 4 * 0.1875) / 6);
  near(m.brierDecomposition!.reliability, 0);
  near(m.brierDecomposition!.resolution, 0);
  near(m.brierDecomposition!.uncertainty, m.timingConstantBrier!);
  const varied = summarize([row(0.21, 0), row(0.29, 1), row(0.8, 1)]),
    d = varied.brierDecomposition!;
  near(
    d.reliability - d.resolution + d.uncertainty + d.binningError,
    varied.timingBrier!,
  );
  near(varied.meanPredicted, (0.21 + 0.29 + 0.8) / 3);
  near(varied.observedRate, 2 / 3);
  assert.equal(summarize([row(0.1, 0)]).timingSkillVsConstant, null);
  assert.equal(summarize([]).brierDecomposition, null);
});
test("breakdowns partition scores and mid-period excludes boundaries", () => {
  const rows = [
    row(0.2, 0),
    row(0.8, 1, "g", "between_periods"),
    row(0.3, 1, "h", "foul"),
  ];
  const m = summarize(rows);
  assert.equal(
    Object.values(m.byStoppage).reduce((n, b) => n + b.n, 0),
    m.scored,
  );
  assert.equal(m.midPeriod.n, 2);
  near(m.midPeriod.timingBrier, (0.04 + 0.49) / 2);
  near(m.byStoppage.foul.exitLogLoss, -Math.log(0.4));
});
test("player log loss and reciprocal rank average movers then substitution windows", () => {
  const two = row(0.8, 1, "g", "timeout", 2),
    one = row(0.8, 1, "g", "foul");
  near(two.scores!.exitLogLoss, (-Math.log(0.4) - Math.log(0.3)) / 2);
  near(two.scores!.entryLogLoss, (-Math.log(0.6) - Math.log(0.3)) / 2);
  near(two.scores!.exitMRR, 0.75);
  near(one.scores!.entryMRR, 1);
  near(
    summarize([two, one]).exitLogLoss,
    (two.scores!.exitLogLoss! + one.scores!.exitLogLoss!) / 2,
  );
  const raw = structuredClone(two.raw) as any;
  raw.exit.probabilities = { a: 0, b: 0, c: 0, d: 0, e: 1 };
  const clipped = scoreWindow(two.window, raw);
  assert.equal(clipped.scores!.exitLogLossClips, 2);
  near(clipped.scores!.exitLogLoss, -Math.log(0.001));
  near(clipped.scores!.exitMRR, (1 / 2 + 1 / 3) / 2);
  raw.exit = {};
  const invalid = scoreWindow(two.window, raw);
  near(invalid.scores!.exitLogLoss, Math.log(5));
  near(invalid.scores!.exitMRR, 0.75);
  raw.exit = {
    type: "choice",
    probabilities: { a: 2, b: 1, c: 1, d: 0, e: 0 },
  }; // out-of-range remains invalid and uniform
  near(scoreWindow(two.window, raw).scores!.exitLogLoss, Math.log(5));
});
