import test from "node:test";
import assert from "node:assert/strict";
import { Temporal } from "@js-temporal/polyfill";
import { Session } from "../src/env/session.js";
import { SessionError, type SubmitInput } from "../src/env/contract.js";
import { Lifecycle } from "../src/env/lifecycle.js";
import { validateSubmission } from "../src/env/submission.js";
import { visible, releasedGame } from "../src/env/visibility.js";
import { fixtureCorpus } from "./fixtures/session/corpus.js";
const refused = (e: unknown) =>
  e instanceof SessionError && e.code === "phase_refused";

test("validator collects structural, missing, unknown, duplicate, probability and rationale errors", async () => {
  const f = fixtureCorpus();
  const s = new Session(
    f.config,
    f.game,
    "pregame",
    f.game.scheduledStart,
    f.source,
  );
  const set = await s.questions();
  const id = set.questions[0].question_id;
  const missing = validateSubmission(
    {
      answers: [{ question_id: "unknown", p_over: NaN, extra: true }],
      notes: 1,
    },
    set,
  );
  assert.equal(missing.ok, false);
  for (const fragment of [
    id,
    "unknown",
    "outside allowed range",
    "extra",
    "notes",
  ])
    assert.ok(
      missing.errors.some((e) => e.includes(fragment)),
      fragment,
    );
  const duplicate = validateSubmission(
    {
      answers: [
        { question_id: id, p_over: 0.55 },
        { question_id: id, p_over: 0.45 },
      ],
    },
    set,
  );
  assert.ok(duplicate.errors.some((e) => e.includes("Duplicate")));
  assert.equal(
    duplicate.errors.filter((e) => e.includes("Rationale")).length,
    2,
  );
  for (const p of [Infinity, -Infinity, "0.5", null])
    assert.equal(
      validateSubmission({ answers: [{ question_id: id, p_over: p }] }, set).ok,
      false,
    );
  await assert.rejects(() => s.validateSubmission({ answers: [] }), refused);
  await s.transition("commit", f.game.scheduledStart);
  const valid = await s.validateSubmission({
    answers: [
      {
        question_id: id,
        p_over: 2,
        rationale: "Reason",
        evidence_refs: ["source-id"],
      },
    ],
    notes: "private",
  });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.clips, [
    { question_id: id, submitted: 2, clipped_to: 0.99 },
  ]);
  assert.equal((valid.value as SubmitInput).answers[0].p_over, 0.99);
});

test("five-phase lifecycle accepts runner order, rejects clock drift, reverse and skipped transitions", () => {
  const { game } = fixtureCorpus();
  const l = new Lifecycle(game, "pregame", game.scheduledStart);
  assert.throws(() => l.advance("postgame", game.release), refused);
  assert.throws(() => l.advance("commit", game.release), refused);
  l.advance("commit", game.scheduledStart);
  assert.throws(() => l.advance("pregame", game.scheduledStart), refused);
  const before = Temporal.Instant.from(game.release)
    .subtract({ seconds: 1 })
    .toString();
  assert.throws(() => l.advance("postgame", before), refused);
  l.advance("postgame", game.release);
  l.advance("checkpoint", game.release);
  assert.throws(() => l.advance("postgame", game.release), refused);
});

test("release gate, shared outcomes, shared scorer and explicit projection keep private material out", async () => {
  const f = fixtureCorpus();
  const s0 = new Session(
    f.config,
    f.game,
    "pregame",
    f.game.scheduledStart,
    f.source,
  );
  const questions = await s0.questions();
  const id = questions.questions[0].question_id;
  const records = () => [
    {
      questions,
      submission: {
        answers: [
          {
            question_id: id,
            p_over: 0.6,
            rationale: "SECRET",
            evidence_refs: ["SECRET"],
          },
        ],
        notes: "SECRET",
      },
    },
  ];
  const s = new Session(
    f.config,
    f.game,
    "pregame",
    f.game.scheduledStart,
    f.source,
    records,
  );
  assert.deepEqual(await s.read_released_results({}), { games: [] });
  const game = (await f.source.games()).find((g) => g.id === f.game.gameId)!;
  const before = Temporal.Instant.from(f.game.release)
    .subtract({ seconds: 1 })
    .toString();
  assert.equal(visible(releasedGame(game), before), false);
  await s.transition("commit", f.game.scheduledStart);
  await assert.rejects(() => s.transition("postgame", before), refused);
  await assert.rejects(() => s.read_released_results({}), refused);
  await s.transition("postgame", f.game.release);
  const result = await s.read_released_results({});
  assert.equal(result.games.length, 1);
  const q = result.games[0].questions[0];
  assert.equal(q.agent_p_over, 0.6);
  assert.equal(q.market_p_over, 0.5);
  assert.equal(q.actual, 11);
  assert.equal(q.outcome, "over");
  assert.equal(q.score, Math.log(0.6) - Math.log(0.5));
  assert.ok(!JSON.stringify(result).includes("SECRET"));
  assert.ok(!JSON.stringify(result).includes("provenance"));
  const odds = await s.query_odds_history({});
  assert.equal(
    odds.settlements.find((o) => o.line === q.line)?.outcome,
    q.outcome,
  );
  assert.deepEqual(await s.read_released_results({ game_id: "future" }), {
    games: [],
  });
  await assert.rejects(
    () => s.validateSubmission(records()[0].submission),
    refused,
  );
  const failed = new Session(
    f.config,
    f.game,
    "postgame",
    f.game.release,
    f.source,
    () => [{ questions, submission: null }],
  );
  assert.equal(
    (await failed.read_released_results({})).games[0].questions[0].agent_p_over,
    null,
  );
  const scored = new Session(
    f.config,
    f.game,
    "postgame",
    f.game.release,
    f.source,
    records,
    () => 0.123,
  );
  assert.equal(
    (await scored.read_released_results({})).games[0].questions[0].score,
    0.123,
  );
  await s.transition("checkpoint", f.game.release);
  await assert.rejects(() => s.read_released_results({}), refused);
});
