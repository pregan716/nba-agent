import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BOS,
  REPLAY_VERSIONS,
  type ReplayInput,
  type Window,
} from "../src/replay/types.js";
import { buildDataset } from "../src/replay/dataset.js";
import {
  uniform,
  validateAction,
  validatePrediction,
} from "../src/replay/contract.js";
import { scoreWindow, summarize } from "../src/replay/scoring.js";
import { fitBaselines } from "../src/replay/baselines.js";
import { RecordStore } from "../src/runner/record.js";
import {
  replay,
  PredictorFailure,
  type ReplayManifest,
} from "../src/replay/run.js";
import type { Row } from "../src/data/contracts.js";
const five = ["a", "b", "c", "d", "e"],
  opp = ["v", "w", "x", "y", "z"];
function fixture(): ReplayInput {
  const row = (seq: number, type: string, clock: number, extra: Row = {}) => ({
    game_id: "game",
    event_id: `e${seq}`,
    canonical_sequence: seq,
    period: 1,
    clock_remaining_ms: clock,
    type,
    subtype: null,
    validity: "effective",
    quality_status: "valid",
    team_id: BOS,
    home_lineup_before: [...five],
    home_lineup_after: [...five],
    away_lineup_before: [...opp],
    away_lineup_after: [...opp],
    home_score_before: 0,
    home_score_after: 0,
    away_score_before: 0,
    away_score_after: 0,
    ...extra,
  });
  const events = [
    row(0, "period_start", 720000),
    row(1, "timeout", 600000, { subtype: "full" }),
    row(2, "substitution", 600000),
    row(3, "substitution", 600000, {
      home_lineup_after: ["f", "b", "c", "d", "e"],
    }),
    row(4, "period_end", 0, {
      home_lineup_before: ["f", "b", "c", "d", "e"],
      home_lineup_after: ["f", "b", "c", "d", "e"],
    }),
  ];
  return {
    game: {
      gameId: "game",
      homeTeamId: BOS,
      awayTeamId: "other",
      scheduledStart: "2025-11-01T00:00:00Z",
    },
    release: {
      bucket: "sports-nba-data",
      key: "fixture",
      sha256: "a".repeat(64),
    },
    events,
    participants: [
      { event_id: "e2", team_id: BOS, player_id: "a", role: "sub_out" },
      { event_id: "e3", team_id: BOS, player_id: "f", role: "sub_in" },
    ],
    stints: [...five, "f", ...opp].map((player_id) => ({
      game_id: "game",
      team_id: opp.includes(player_id) ? "other" : BOS,
      player_id,
      period: 1,
      quality_status: "valid",
      duration_ms:
        player_id === "a" ? 120000 : player_id === "f" ? 600000 : 720000,
      start_clock_ms: player_id === "f" ? 600000 : 720000,
      end_clock_ms: player_id === "a" ? 600000 : 0,
      start_sequence: player_id === "f" ? 3 : 0,
      end_sequence: 4,
    })),
    coverage: ["lineups", "stints", "normalization", "summaries"].map(
      (product) => ({ game_id: "game", product, quality_status: "valid" }),
    ),
    issues: [],
    pregame: {
      gameId: "game",
      scheduledStart: "2025-11-01T00:00:00Z",
      roster: [...five, "f", "g", "h"].map((playerId) => ({
        playerId,
        availableAt: "2025-10-01T00:00:00Z",
      })),
      injuryReport: {
        availableAt: "2025-10-31T23:00:00Z",
        state: "unknown",
        players: [],
      },
      announcedStarters: null,
      sources: [],
    },
  };
}
const window = () => buildDataset(fixture()).windows[0];
const prediction = (p: number) => ({
  substitution: { type: "noul", noul: p },
  count: {
    type: "score",
    probabilities: { none: 1, one: 0, two: 0, three_or_more: 0 },
  },
  exit: { type: "choice", probabilities: uniform(five) },
  entry: { type: "choice", probabilities: uniform(["f", "g", "h"]) },
});
const near = (actual: number | null, expected: number) =>
  assert.ok(
    actual !== null && Math.abs(actual - expected) < 1e-12,
    `${actual} != ${expected}`,
  );

test("independent candidate, observable prefix, and outcome held separately", () => {
  const input = fixture(),
    d = buildDataset(input),
    w = d.windows[0];
  assert.deepEqual(w.exclusions, []);
  assert.deepEqual(w.actual, { players_out: ["a"], players_in: ["f"] });
  assert.deepEqual(w.state!.celtics, five);
  assert.equal(w.state!.players[0].minutes, 2);
  assert.equal(w.state!.history.substitutions.length, 0);
  input.events[4].futureSecret = "PLANTED_FUTURE";
  input.events[4].home_score_after = 999;
  input.participants.push({
    event_id: "e4",
    role: "fouler",
    player_id: "b",
    team_id: BOS,
  });
  assert.deepEqual(buildDataset(input).windows[0].state, w.state);
  assert.ok(!JSON.stringify(w.state).includes("PLANTED_FUTURE"));
  input.pregame.injuryReport.availableAt = input.game.scheduledStart;
  assert.throws(() => buildDataset(input), /strictly before/);
});

test("retrospective jump ball snapshots bucket start; other late markers exclude", () => {
  const input = fixture();
  input.events[1].type = "rebound";
  input.events[1].description = "TEAM defensive REBOUND";
  input.events.splice(4, 0, {
    ...input.events[3],
    event_id: "jump",
    canonical_sequence: 3.5,
    type: "jump_ball",
  });
  // Use the actual opener sequence layout 25 TEAM rebound, 26 out, 27 in, 28 jump.
  input.events.slice(1).forEach((e, i) => (e.canonical_sequence = 25 + i));
  let d = buildDataset(input);
  assert.equal(d.windows.length, 1);
  assert.equal(d.windows[0].sequence, 25);
  assert.deepEqual(d.windows[0].state!.celtics, five);
  assert.deepEqual(d.windows[0].exclusions, []);
  input.events[4].type = "timeout";
  input.events[4].subtype = "full";
  d = buildDataset(input);
  assert.ok(d.windows[0].exclusions.includes("marker_after_decision"));
  input.events.splice(4, 1);
  d = buildDataset(input);
  assert.equal(d.windows.length, 0);
  assert.equal(d.diagnostics.unanchoredBuckets, 1);
});

test("adjacency is immediately previous independent bucket, up to two seconds; no chains", () => {
  for (const gap of [1000, 2000, 3000]) {
    const input = fixture();
    input.events[2].clock_remaining_ms -= gap;
    input.events[3].clock_remaining_ms -= gap;
    const d = buildDataset(input);
    assert.equal(d.diagnostics.adjacencyBuckets, gap <= 2000 ? 1 : 0);
    assert.equal(d.diagnostics.positiveCandidates, gap <= 2000 ? 1 : 0);
    assert.equal(d.diagnostics.candidates, 1);
    assert.equal(d.windows[0].state!.clockMs, 600000);
  }
  const input = fixture();
  input.events.splice(2, 0, {
    ...input.events[1],
    type: "rebound",
    subtype: null,
    event_id: "intervening",
    clock_remaining_ms: 599000,
  });
  input.events.forEach((e, i) => (e.canonical_sequence = i));
  input.events[3].clock_remaining_ms = 598000;
  input.events[4].clock_remaining_ms = 598000;
  assert.equal(buildDataset(input).diagnostics.adjacencyBuckets, 0);
});

test("named partial summary nulls score; state failure still excludes", () => {
  const input = fixture();
  input.coverage.find((c) => c.product === "summaries")!.quality_status =
    "partial";
  input.issues = [
    {
      game_id: "game",
      product: "summaries",
      code: "summary_field_limitations",
      message:
        "field_goals_attempted:mismatch, offensive_rebounds:mismatch, rebounds:mismatch",
    },
  ];
  const w = buildDataset(input).windows[0];
  assert.deepEqual(w.exclusions, []);
  for (const p of w.state!.players) {
    assert.equal(p.box.field_goals_attempted, null);
    assert.equal(p.box.offensive_rebounds, null);
    assert.equal(p.box.rebounds, null);
    assert.equal(p.box.points, 0);
  }
  assert.ok(scoreWindow(w, prediction(0.2)).scores);
  input.events[1].away_lineup_after = null;
  const bad = buildDataset(input).windows[0];
  assert.ok(bad.exclusions.includes("unknown_lineup"));
  assert.equal(scoreWindow(bad, prediction(0.2)).scores, null);
});

test("question validation preserves valid answers and rejects illegal actions", () => {
  const state = window().state!,
    p = prediction(0.8);
  p.entry.probabilities = { intruder: 1 };
  const v = validatePrediction(p, state);
  assert.equal(v.questions.entry.valid, false);
  assert.equal(v.questions.exit.valid, true);
  assert.equal(v.questions.substitution.valid, true);
  assert.equal(v.answers.substitution.noul, 0.8);
  assert.deepEqual(v.answers.entry.probabilities, uniform(["f", "g", "h"]));
  for (const action of [
    { players_out: ["a"], players_in: ["intruder"] },
    { players_out: ["a"], players_in: [] },
    { players_out: ["a", "a"], players_in: ["f", "f"] },
    { players_out: ["a"], players_in: ["b"] },
  ])
    assert.equal(validateAction(action, state).valid, false);
  for (const invalid of [NaN, Infinity, -0.1, 1.1]) {
    p.substitution.noul = invalid;
    assert.equal(
      validatePrediction(p, state).questions.substitution.valid,
      false,
    );
  }
  const noBench = { ...state, eligibleBench: [] };
  assert.equal(
    validatePrediction(prediction(0.8), noBench).actionValidation.valid,
    false,
  );
});

test("five-window hand calculation, including entry-only fallback", () => {
  const outcomes = [[], ["a"], ["a", "b"], [], ["b"]],
    entries = [[], ["f"], ["f", "g"], [], ["g"]],
    probabilities = [0.1, 0.8, 0.6, 0.7, 0.2];
  const results = probabilities.map((p, i) => {
    const w: Window = {
      ...window(),
      id: `hand${i}`,
      actual: { players_out: outcomes[i], players_in: entries[i] },
    };
    const raw = prediction(p);
    if (i === 2)
      raw.count.probabilities = { none: 0, one: 0, two: 1, three_or_more: 0 };
    if (i === 4) raw.entry.probabilities = { wrong: 1 };
    return scoreWindow(w, raw);
  });
  const expectedTiming = [0.01, 0.04, 0.16, 0.49, 0.64];
  results.forEach((r, i) => near(r.scores!.timing, expectedTiming[i]));
  // k=1: (0.8^2+4*0.2^2)/5=.16; k=2: (2*0.6^2+3*0.4^2)/5=.24.
  near(results[1].scores!.exit, 0.16);
  near(results[2].scores!.exit, 0.24);
  near(results[4].scores!.exit, 0.16);
  // Three bench options: k=1 and k=2 both give conditional Brier 2/9.
  for (const i of [1, 2, 4]) near(results[i].scores!.entry, 2 / 9);
  assert.equal(results[4].validation!.questions.entry.valid, false);
  assert.equal(results[4].validation!.questions.exit.valid, true);
  near(results[4].scores!.timing, 0.64);
  assert.deepEqual(
    results.map((r) => r.scores!.exact),
    [1, 1, 1, 0, 0],
  );
  assert.deepEqual(
    results.map((r) => r.scores!.overlap),
    [null, 1, 1, 0, 0],
  );
  const s = summarize(results);
  near(s.timingBrier, 0.268);
  near(s.exitBrier, 0.56 / 3);
  near(s.entryBrier, 2 / 9);
  near(s.exactAction, 0.6);
  near(s.partialOverlap, 0.5);
  near(s.precision, 2 / 3);
  near(s.recall, 2 / 3);
  near(
    s.timingLogLoss,
    (-Math.log(0.9) -
      Math.log(0.8) -
      Math.log(0.6) -
      Math.log(0.3) -
      Math.log(0.2)) /
      5,
  );
  assert.equal(s.invalidQuestions.entry, 1);
});

test("failures, clipping, and constant baseline have explicit denominators", () => {
  const w = window();
  assert.equal(scoreWindow(w, prediction(1), "provider_failure").scores, null);
  assert.equal(scoreWindow(w, prediction(1), "invalid_package").scores, null);
  near(scoreWindow(w, null, "assembler_error").scores!.timing, 0.25);
  assert.equal(scoreWindow(w, prediction(1)).scores!.logLossClipped, true);
  const d = buildDataset(fixture());
  d.windows.push({
    ...w,
    id: "negative",
    actual: { players_in: [], players_out: [] },
  });
  const { constant } = fitBaselines([d]);
  near(constant.predict(w.state!).substitution.noul, 0.5);
  near(
    summarize(d.windows.map((w) => scoreWindow(w, constant.predict(w.state!))))
      .timingBrier,
    0.25,
  );
});

test("record keeps outcomes outside predictor, resumes, and verifies chain", async () => {
  const d = buildDataset(fixture()),
    dir = mkdtempSync(join(tmpdir(), "replay-test-"));
  const manifest: ReplayManifest = {
    schemaVersion: 1,
    kind: "replay-mvp",
    releaseManifestSha256: d.release.sha256,
    datasets: [{ gameId: d.gameId, inputHash: d.inputHash }],
    harness: REPLAY_VERSIONS,
    predictors: { fixture: { id: "fixture" }, failure: { id: "failure" } },
    codeRevision: "fixture",
  };
  try {
    const record = new RecordStore(dir, manifest);
    let calls = 0;
    await replay(
      d,
      "fixture",
      (state) => {
        calls++;
        assert.equal("actual" in state, false);
        assert.ok(Object.isFrozen(state.players));
        return prediction(0.8);
      },
      record,
    );
    await replay(
      d,
      "fixture",
      () => {
        throw Error("must resume");
      },
      record,
    );
    assert.equal(calls, 1);
    assert.ok(record.events("replay_window")[0].data.result.window.actual);
    record.verify();
    record.close();
    const reopened = new RecordStore(dir, manifest);
    assert.equal(reopened.events("replay_window").length, 1);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("audited jump prefixes: opener 25–28 and Brooklyn 199–206", async () => {
  const { readFile } = await import("node:fs/promises");
  const { buildState, actionFor } = await import("../src/replay/state.js");
  const fixtures = JSON.parse(
    await readFile(
      new URL("./fixtures/replay/jump-prefixes.json", import.meta.url),
      "utf8",
    ),
  ) as { bucketStart: number; input: ReplayInput }[];
  for (const { input, bucketStart } of fixtures) {
    const first = input.events.find(
      (e) => e.canonical_sequence === bucketStart,
    )!;
    const { state, reasons } = buildState(
      input,
      input.events,
      bucketStart,
      first.period,
      first.clock_remaining_ms,
      "jump_ball",
      first,
      true,
      [],
    );
    assert.deepEqual(reasons, []);
    assert.ok(state);
    const actual = actionFor(
      input.events.filter(
        (e) => e.canonical_sequence >= bucketStart && e.type === "substitution",
      ),
      input.participants,
    );
    assert.equal(validateAction(actual, state).valid, true);
    assert.equal(
      state.history.substitutions.some((s) => s.sequence >= bucketStart),
      false,
    );
    const exit = input.game.gameId === "0022500083" ? "1629674" : "1630202",
      entry = input.game.gameId === "0022500083" ? "1630214" : "1627759";
    assert.ok(state.celtics.includes(exit));
    assert.ok(!state.celtics.includes(entry));
    assert.deepEqual(actual, { players_out: [exit], players_in: [entry] });
    const changed = structuredClone(input);
    for (const e of changed.events.filter(
      (e) => e.canonical_sequence >= bucketStart,
    )) {
      e.description = "PLANTED FUTURE RECOVERY";
      e.home_lineup_after = ["BAD"];
      e.away_score_after = 999;
    }
    assert.deepEqual(
      buildState(
        changed,
        changed.events,
        bucketStart,
        first.period,
        first.clock_remaining_ms,
        "jump_ball",
        changed.events.find((e) => e.canonical_sequence === bucketStart)!,
        true,
        [],
      ).state,
      state,
    );
  }
});

test("period boundary uses prior five and new clock, not next five", () => {
  const input = fixture(),
    last = input.events.at(-1)!;
  input.events.push({
    ...last,
    event_id: "next",
    type: "period_start",
    period: 2,
    clock_remaining_ms: 720000,
    canonical_sequence: 5,
    home_lineup_before: ["a", "b", "c", "d", "e"],
    home_lineup_after: ["a", "b", "c", "d", "e"],
  });
  const d = buildDataset(input),
    w = d.windows.find((w) => w.kind === "between_periods")!;
  assert.deepEqual(w.exclusions, []);
  assert.equal(w.state!.period, 2);
  assert.equal(w.state!.clockMs, 720000);
  assert.deepEqual(w.state!.celtics, ["b", "c", "d", "e", "f"]);
  assert.deepEqual(w.actual, { players_out: ["f"], players_in: ["a"] });
  assert.equal(d.windows.filter((w) => w.kind === "between_periods").length, 1);
});

test("provider failures flag games above five percent; invalid package stops all calls", async () => {
  const d = buildDataset(fixture());
  d.windows.push({ ...d.windows[0], id: "second" });
  assert.equal(
    summarize(d.windows.map((w) => scoreWindow(w, null, "provider_failure")))
      .providerFailureFlag,
    true,
  );
  const dir = mkdtempSync(join(tmpdir(), "replay-failure-"));
  const manifest: ReplayManifest = {
    schemaVersion: 1,
    kind: "replay-mvp",
    releaseManifestSha256: d.release.sha256,
    datasets: [{ gameId: d.gameId, inputHash: d.inputHash }],
    harness: REPLAY_VERSIONS,
    predictors: { fixture: { id: "fixture" }, failure: { id: "failure" } },
    codeRevision: "fixture",
  };
  const record = new RecordStore(dir, manifest);
  try {
    let calls = 0;
    const results = await replay(
      d,
      "failure",
      () => {
        calls++;
        throw new PredictorFailure("invalid_package", "cannot load");
      },
      record,
    );
    assert.equal(calls, 1);
    assert.ok(
      results.every(
        (r) => r.failure === "invalid_package" && r.scores === null,
      ),
    );
  } finally {
    record.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bench comes from frozen roster, injury status, fouls and ejections only", async () => {
  const { buildState } = await import("../src/replay/state.js");
  const input = fixture();
  input.pregame.injuryReport.state = "listed";
  input.pregame.injuryReport.players = [{ playerId: "f", status: "Out" }];
  const additions = Array.from({ length: 6 }, (_, i) => ({
    ...input.events[1],
    event_id: `foul${i}`,
    type: "foul",
    subtype: "personal",
    canonical_sequence: i + 1,
  }));
  additions.push({
    ...input.events[1],
    event_id: "technical",
    type: "foul",
    subtype: "technical",
    canonical_sequence: 7,
  });
  additions.push({
    ...input.events[1],
    event_id: "ejection",
    type: "ejection",
    subtype: "ejection",
    canonical_sequence: 8,
  });
  const marker = { ...input.events[1], canonical_sequence: 9 };
  const events = [input.events[0], ...additions, marker];
  input.participants = [
    ...additions.slice(0, 6).map((e) => ({
      event_id: e.event_id,
      team_id: BOS,
      player_id: "g",
      role: "fouler",
    })),
    { event_id: "technical", team_id: BOS, player_id: "b", role: "fouler" },
    { event_id: "ejection", team_id: BOS, player_id: "h", role: "ejected" },
  ];
  const { state } = buildState(
    input,
    events,
    10,
    1,
    600000,
    "timeout",
    marker,
    false,
    [],
  );
  assert.deepEqual(state!.eligibleBench, []);
  assert.equal(
    state!.players.find((p) => p.playerId === "g")!.personalFouls,
    6,
  );
  assert.equal(
    state!.players.find((p) => p.playerId === "b")!.personalFouls,
    0,
  );
  assert.ok(window().state!.eligibleBench.includes("h"));
});

test("adjacency cannot chain and state quality failures take precedence", () => {
  const input = fixture();
  input.events[2].clock_remaining_ms = 599000;
  input.events[3].clock_remaining_ms = 599000;
  input.events.splice(
    4,
    0,
    {
      ...input.events[2],
      event_id: "second-out",
      canonical_sequence: 4,
      clock_remaining_ms: 598000,
    },
    {
      ...input.events[3],
      event_id: "second-in",
      canonical_sequence: 5,
      clock_remaining_ms: 598000,
    },
  );
  input.events.at(-1)!.canonical_sequence = 6;
  let d = buildDataset(input);
  assert.equal(d.diagnostics.adjacencyBuckets, 1);
  assert.equal(d.diagnostics.unanchoredBuckets, 1);
  assert.equal(d.diagnostics.candidates, 1);
  const repaired = fixture();
  repaired.events[1].order_repair_reason = "corrected clock order";
  assert.ok(
    buildDataset(repaired).windows[0].exclusions.includes(
      "unresolved_or_repaired_order",
    ),
  );
  const bad = fixture();
  bad.stints[0].duration_ms = NaN;
  assert.ok(
    buildDataset(bad).windows[0].exclusions.includes("unreconciled_stints"),
  );
});

test("opening-clock substitutions are one net boundary history entry", async () => {
  const { buildState } = await import("../src/replay/state.js");
  const input = fixture(),
    last = input.events.at(-1)!;
  const start = {
    ...last,
    event_id: "start2",
    type: "period_start",
    period: 2,
    clock_remaining_ms: 720000,
    canonical_sequence: 5,
  };
  const out = {
      ...start,
      event_id: "out2",
      type: "substitution",
      canonical_sequence: 6,
    },
    into = {
      ...out,
      event_id: "in2",
      canonical_sequence: 7,
      home_lineup_after: five,
    };
  const marker = {
    ...into,
    event_id: "timeout2",
    type: "timeout",
    subtype: "full",
    canonical_sequence: 8,
    clock_remaining_ms: 700000,
    home_lineup_before: five,
  };
  input.events.push(start, out, into, marker);
  input.participants.push(
    { event_id: "out2", team_id: BOS, player_id: "f", role: "sub_out" },
    { event_id: "in2", team_id: BOS, player_id: "a", role: "sub_in" },
  );
  const { state, reasons } = buildState(
    input,
    input.events,
    9,
    2,
    700000,
    "timeout",
    marker,
    false,
    [],
  );
  assert.deepEqual(reasons, []);
  const boundary = state!.history.substitutions.filter((s) => s.period === 2);
  assert.equal(boundary.length, 1);
  assert.equal(boundary[0].windowId, "game:period:2");
  assert.deepEqual(boundary[0].players_out, ["f"]);
  assert.deepEqual(boundary[0].players_in, ["a"]);
});

test("live-ball events and non-opening whistles after an opener remain ambiguous", () => {
  for (const type of [
    "steal",
    "block",
    "turnover",
    "foul",
    "violation",
    "ejection",
  ]) {
    const input = fixture();
    input.events.splice(2, 0, {
      ...input.events[1],
      event_id: "later",
      type,
      subtype:
        type === "foul"
          ? "technical"
          : type === "violation"
            ? "delay-of-game"
            : "bad pass",
    });
    input.events.forEach((e, i) => (e.canonical_sequence = i));
    assert.ok(
      buildDataset(input).windows[0].exclusions.includes("ambiguous_stoppage"),
      type,
    );
  }
});
