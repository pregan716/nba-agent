import { annotate } from "../src/evaluation/learning.js";
import { RecordStore, snapshot } from "../src/runner/record.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logSkill } from "../src/evaluation/scoring.js";
import { evaluate, readReport } from "../src/evaluation/report.js";
import { compare, replicateSpread } from "../src/evaluation/compare.js";
import { resolveFrozen } from "../src/env/results.js";
import { manifest } from "../src/runner/config.js";
import type { Event } from "../src/runner/record.js";
import { fixtureConfig, provider } from "./fixtures/runner/support.js";
import { fixtureCorpus, envelope } from "./fixtures/session/corpus.js";
import { sessionEnvironment } from "../src/env/session.js";
import { MeteringProxy } from "../src/runner/proxy.js";
import { Runner } from "../src/runner/runner.js";
function fixture() {
  const m = manifest(
    fixtureConfig(),
    Array.from({ length: 5 }, (_, i) => ({
      gameId: `g${i}`,
      scheduledStart: `2025-11-${String(i + 1).padStart(2, "0")}T23:00:00Z`,
    })),
  );
  const events: Event[] = [];
  const add = (kind: string, scope: string, data: any) =>
    events.push({
      seq: events.length + 1,
      kind,
      scope,
      data,
      at: "2025-11-01T00:00:00Z",
      previous: "",
      hash: "",
    });
  add("manifest", "run", m);
  [0.6, 0.4, 0.5, 0.8, 0.2].forEach((p, i) => {
    const game = `g${i}`,
      player = "player";
    add("questions", game, {
      game: { game_id: game },
      questions: [
        {
          question_id: game,
          player: { id: player, name: player },
          stat: "points",
          selected_line: 10.5,
          p_over: 0.5,
        },
      ],
      exclusions: [],
    });
    add("submission", game, {
      value: {
        submission: {
          answers: [{ question_id: game, p_over: p, rationale: "fixture" }],
        },
      },
    });
    add("phase_end", `${game}:pregame`, { status: "completed" });
    const record = (data: any) =>
      envelope(
        game,
        "game",
        "2025-11-01T00:00:00Z",
        "game_next_morning_eastern",
        { player_id: player, ...data },
      );
    add("resolution_input", game, {
      gameId: game,
      status: "final",
      boxReason: null,
      summaryReason: null,
      boxes: [record({ points: i % 2 === 0 ? 11 : 10, minutes_seconds: 60 })],
      summaries: [record({ reconstructed_minutes: 1 })],
    });
  });
  return events;
}
test("five hand-computed scores, exact market zero, calibration and deviations", () => {
  const events = fixture(),
    r = evaluate(events);
  const expected = [
    Math.log(1.2),
    Math.log(1.2),
    0,
    Math.log(0.4),
    Math.log(0.4),
  ];
  r.rows.forEach((row, i) =>
    assert.ok(Math.abs(row.skill! - expected[i]) < 1e-14),
  );
  assert.ok(
    Math.abs(r.totals.skill! - expected.reduce((a, b) => a + b) / 5) < 1e-14,
  );
  assert.equal(r.totals.deviations[0].count, 4);
  assert.equal(r.totals.deviations[1].hitRate, 0.5);
  assert.equal(
    r.totals.calibration.reduce((n, d) => n + d.count, 0),
    5,
  );
  assert.ok(Math.abs(r.totals.brier! - -0.12) < 1e-14);
  for (const outcome of ["over", "under"] as const)
    assert.equal(
      logSkill({ outcome, actual: 1, agent_p_over: 0.37, market_p_over: 0.37 }),
      0,
    );
});
test("push, DNP, partial-summary fallback, conflicting/missing sources and void games", () => {
  const input = fixture().find((e) => e.kind === "resolution_input")!.data;
  assert.equal(resolveFrozen(input, "player", "points", 11).outcome, "push");
  input.summaries[0].data.reconstructed_minutes = 0;
  assert.equal(
    resolveFrozen(input, "player", "points", 10).outcome,
    "did_not_play",
  );
  input.summaryReason = "Published summaries are partial";
  assert.equal(resolveFrozen(input, "player", "points", 10).outcome, "over");
  input.summaryReason = "missing";
  assert.equal(
    resolveFrozen(input, "player", "points", 10).outcome,
    "unresolved",
  );
  input.status = "postponed";
  assert.equal(resolveFrozen(input, "player", "points", 10).outcome, "void");
  input.status = "final";
  input.summaryReason = null;
  input.summaries[0].data.reconstructed_minutes = 1;
  input.boxes.push(input.boxes[0]);
  assert.equal(
    resolveFrozen(input, "player", "points", 10).outcome,
    "unresolved",
  );
  const events = fixture();
  events.find(
    (e) => e.kind === "resolution_input",
  )!.data.summaries[0].data.reconstructed_minutes = 0;
  assert.equal(evaluate(events).totals.scored, 4);
});
test("matched comparison removes unresolved, uses seeded game bootstrap and flags axes", () => {
  const left = evaluate(fixture()),
    events = fixture();
  events.find((e) => e.kind === "resolution_input")!.data.boxes = [];
  const right = evaluate(events);
  right.budget = { ...right.budget, id: "different" };
  const result = compare(left, right, 1000);
  assert.equal(result.matchedQuestions, 4);
  assert.equal(result.difference, 0);
  assert.deepEqual(result.bootstrap.interval90, [0, 0]);
  assert.deepEqual(compare(left, right, 1000), result);
  assert.deepEqual(result.warnings, ["Comparison differs in budget"]);
  const same = evaluate(fixture());
  same.replicateId = "r2";
  assert.equal(replicateSpread([left, same])[0].standardDeviation, 0);
});
test("costs use pinned prices, separate unavailable reasoning and unsettled reservations", () => {
  const events = fixture();
  const e = events[0];
  events.push({
    ...e,
    kind: "model_response",
    scope: "g0:pregame",
    data: {
      usage: {
        input: 1000000,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        reasoning: null,
      },
    },
  });
  events.push({
    ...e,
    kind: "reservation",
    scope: "g0:pregame",
    data: { id: "unknown", tokens: 100, compute: 3 },
  });
  const r = evaluate(events);
  assert.equal(r.cost.usd, 5);
  assert.equal(r.cost.usage.reasoning, null);
  assert.equal(r.cost.computeSeconds, 3);
  assert.equal(r.cost.spendComplete, false);
});
test("runner captures outcome inputs without a model tool call; offline report equals released feedback", async () => {
  const f = fixtureCorpus(),
    root = mkdtempSync(join(tmpdir(), "nba-report-"));
  const proxy = new MeteringProxy(provider);
  await proxy.listen();
  const m = manifest(f.config, [
    { gameId: f.game.gameId, scheduledStart: f.game.scheduledStart },
  ]);
  const runner = new Runner(
    root,
    m,
    proxy,
    sessionEnvironment(f.config, f.source),
  );
  let score: number | null = null;
  try {
    await runner.run(async ({ session }) => {
      const ctx = await session.call("context", {});
      if (ctx.phase === "postgame") {
        score = (await session.call("read_released_results", {})).games[0]
          .questions[0].score;
        return;
      }
      const qs = await session.call("list_questions", {});
      await session.call("begin_commit", {});
      await session.call("submit", {
        answers: qs.questions.map((q) => ({
          question_id: q.question_id,
          p_over: 0.6,
          rationale: "fixture",
        })),
      });
    });
    assert.equal(runner.record.events("resolution_input").length, 1);
    runner.close();
    const bytes = readFileSync(join(runner.root, "record.sqlite"));
    const report = readReport(runner.root);
    assert.equal(report.rows[0].skill, score);
    assert.ok(score! > 0);
    assert.deepEqual(readReport(runner.root), report);
    assert.deepEqual(readFileSync(join(runner.root, "record.sqlite")), bytes);
  } finally {
    runner.close();
    await proxy.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("stateless baseline also captures released inputs and scores exactly zero", async () => {
  const f = fixtureCorpus();
  f.config.profile.memory.horizon = "stateless";
  const root = mkdtempSync(join(tmpdir(), "nba-stateless-report-")),
    proxy = new MeteringProxy(provider);
  await proxy.listen();
  const runner = new Runner(
    root,
    manifest(f.config, [
      { gameId: f.game.gameId, scheduledStart: f.game.scheduledStart },
    ]),
    proxy,
    sessionEnvironment(f.config, f.source),
  );
  try {
    await runner.run(async ({ session }) => {
      const qs = await session.call("list_questions", {});
      await session.call("begin_commit", {});
      await session.call("submit", {
        answers: qs.questions.map((q) => ({
          question_id: q.question_id,
          p_over: q.p_over,
          rationale: "",
        })),
      });
    });
    assert.equal(runner.record.events("resolution_input").length, 1);
    assert.equal(evaluate(runner.record.events()).totals.skill, 0);
  } finally {
    runner.close();
    await proxy.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap resamples whole games and returns a nonzero paired interval", () => {
  const a = evaluate(fixture()),
    b = evaluate(fixture());
  b.rows.forEach((r) => {
    r.skill = 0;
    r.brier = 0;
  });
  const result = compare(a, b, 1000);
  assert.equal(result.difference, a.totals.skill);
  assert.ok(result.bootstrap.interval90![0] < result.bootstrap.interval90![1]);
  assert.equal(result.influential.length, 5);
  assert.equal(result.withoutFive, null);
  assert.equal(compare({ ...a, rows: [] }, b).bootstrap.interval90, null);
});

test("learning annotations require actual workspace quotes and captured outcomes", () => {
  const root = mkdtempSync(join(tmpdir(), "nba-learning-"));
  try {
    const events = fixture(),
      record = new RecordStore(root, events[0].data);
    for (const e of events.slice(1)) record.append(e.kind, e.scope, e.data);
    const work = join(root, "workspace");
    mkdirSync(work);
    writeFileSync(join(work, "notes.txt"), "Recorded belief");
    const snap = snapshot(root, work),
      end = record.append("session_end", "g0:postgame", {
        before: snap,
        after: snap,
        diff: { added: [], removed: [], changed: [] },
      });
    record.close();
    const example = {
      category: "stale beliefs",
      explanation: "Fixture evidence only",
      workspace: [
        {
          sessionSeq: end.seq,
          path: "notes.txt",
          side: "after",
          quote: "Recorded belief",
        },
      ],
      questions: [{ gameId: "g0", questionId: "g0" }],
    };
    annotate(root, example);
    assert.throws(
      () =>
        annotate(root, {
          ...example,
          workspace: [{ ...example.workspace[0], quote: "invented" }],
        }),
      /quote/,
    );
    const reopened = new RecordStore(root);
    assert.equal(reopened.events("learning_annotation").length, 1);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
