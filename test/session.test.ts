import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../src/env/session.js";
import { visible, releasedGame } from "../src/env/visibility.js";
import { SessionError, type BudgetRemaining } from "../src/env/contract.js";
import {
  fixtureCorpus,
  envelope,
  cutoff,
  before,
  future,
  BOS,
} from "./fixtures/session/corpus.js";
import { agentQuestion } from "../src/questions/builder.js";
import { STATIC_AT } from "../src/data/contracts.js";
const budget: BudgetRemaining = {
  tokens: 123,
  compute_seconds: 4.5,
  tool_calls: 6,
  submission_reserve: 20,
  warning: false,
};
const create = (
  f = fixtureCorpus(),
  phase: "pregame" | "postgame" = "pregame",
) =>
  new Session(
    f.config,
    f.game,
    phase,
    phase === "pregame" ? f.game.scheduledStart : f.game.release,
    f.source,
  );
const code = (value: string) => (error: unknown) =>
  error instanceof SessionError && error.code === value;
function noType(value: unknown) {
  if (value && typeof value === "object") {
    assert.ok(!Object.hasOwn(value, "type"));
    Object.values(value).forEach(noType);
  }
}

test("one visibility gate handles all sources, strict equality and static build cutoff", () => {
  const f = fixtureCorpus();
  for (const [name, records] of Object.entries(f.records)) {
    assert.equal(visible(records[0], cutoff), true, name);
    assert.equal(
      visible(records[1], cutoff),
      ["events", "odds"].includes(name),
      name,
    );
    assert.equal(visible(records[2], cutoff), false, name);
  }
  assert.equal(
    visible(
      envelope(
        "static",
        "player-reference",
        future,
        "opening_reference_static",
        {},
      ),
      cutoff,
    ),
    false,
  );
  assert.equal(
    visible(
      envelope("bad", "posts", "invalid", "post_version_publication", {}),
      cutoff,
    ),
    false,
  );
  assert.equal(
    visible(
      envelope(
        "static",
        "player-reference",
        STATIC_AT,
        "opening_reference_static",
        {},
      ),
      cutoff,
    ),
    true,
  );
});

test("adding future records cannot change any implemented read, total, columns or cursor", async () => {
  const all = async (future: boolean) => {
    const f = fixtureCorpus(future),
      session = create(f);
    const page = await session.query_game_history({
      table: "events",
      team_id: BOS,
      limit: 1,
    });
    const next = await session.query_game_history({
      table: "events",
      team_id: BOS,
      limit: 1,
      cursor: page.next_cursor!,
    });
    return [
      await session.context(budget),
      page,
      next,
      await session.read_schedule_and_injuries({ game_id: "current" }),
      await session.query_odds_history({}),
      await session.list_questions({}),
      await session.query_game_history({ table: "player_profiles" }),
    ];
  };
  const result = await all(true);
  assert.deepEqual(result, await all(false));
  assert.ok(!JSON.stringify(result).includes("FUTURE_SECRET"));
  noType(result);
  assert.equal((result[1] as any).total, 2);
});

test("future and nonexistent games have identical empty history, odds, and gap metadata", async () => {
  const f = fixtureCorpus();
  f.reasons["future:events"] = "FUTURE_SECRET";
  const s = create(f);
  for (const table of [
    "events",
    "player_box_scores",
    "player_game_summary",
  ] as const)
    assert.deepEqual(
      await s.query_game_history({ table, game_id: "future" }),
      await s.query_game_history({ table, game_id: "absent" }),
    );
  assert.deepEqual(
    await s.query_odds_history({ game_id: "future" }),
    await s.query_odds_history({ game_id: "absent" }),
  );
});

test("cutoff odds equality, exact P2 projection, and postgame release equality", async () => {
  const f = fixtureCorpus(),
    s = create(f);
  assert.equal((await s.query_odds_history({})).observations.length, 2);
  assert.deepEqual((await s.query_odds_history({})).settlements, []);
  assert.deepEqual(
    (await s.list_questions({})).questions,
    (await s.questions()).questions.map(agentQuestion),
  );
  assert.equal(
    (
      await s.query_game_history({
        table: "player_box_scores",
        game_id: "current",
      })
    ).total,
    0,
  );
  const post = create(f, "postgame");
  assert.equal(
    (
      await post.query_game_history({
        table: "player_box_scores",
        game_id: "current",
      })
    ).total,
    2,
  );
  assert.equal(
    (await post.query_odds_history({})).settlements[0].outcome,
    "over",
  );
  assert.equal(visible(releasedGame(f.schedule[1]), f.game.release), true);
});

test("latest absent team is unknown and carries no older player report forward", async () => {
  const f = fixtureCorpus();
  f.records.injuries[0].availableAt = "2025-11-02T22:00:00Z";
  f.records.injuries.push(
    envelope("absent", "injuries", before, "injury_printed_report", {
      game_id: "current",
      team_id: BOS,
      observed_state: "team_absent",
      assessment_time: "FUTURE_SECRET",
    }),
  );
  const r = await create(f).read_schedule_and_injuries({ game_id: "current" });
  assert.deepEqual(r.team_snapshots, [
    { game_id: "current", team_id: BOS, report_time: before, state: "unknown" },
  ]);
  assert.deepEqual(r.injury_reports, []);
  assert.ok(!JSON.stringify(r).includes("FUTURE_SECRET"));
});

test("injury identity refusals remain null; printed states and rows are allowlisted", async () => {
  const f = fixtureCorpus();
  f.records.injuries[0].data.player_name = "Jones, Dillon";
  const r = await create(f).read_schedule_and_injuries({});
  assert.equal(r.injury_reports[0].player_id, null);
  assert.equal(r.team_snapshots[0].state, "listed");
  f.records.injuries[0].data.observed_state = "not_yet_submitted";
  assert.deepEqual(
    (await create(f).read_schedule_and_injuries({})).injury_reports,
    [],
  );
});

test("static player reference computes age at replay, rejects time/game filters", async () => {
  const s = create();
  const r = await s.query_game_history({
    table: "player_profiles",
    player_id: "player",
    team_id: BOS,
  });
  assert.equal(r.rows[0].age_on_replay_date, 24);
  assert.equal(r.columns.length, Object.keys(r.rows[0]).length);
  await assert.rejects(
    () => s.query_game_history({ table: "player_profiles", season: "2025-26" }),
    code("invalid_input"),
  );
  await assert.rejects(
    () => s.query_game_history({ table: "events" }),
    code("invalid_input"),
  );
});

test("eligible coverage gaps are absent with reason and Dec 5 uses official box minutes", async () => {
  const f = fixtureCorpus();
  f.game = {
    ...f.game,
    gameId: "0022500338",
    scheduledStart: f.schedule[3].data.scheduled_tipoff,
    release: releasedGame(f.schedule[3]).availableAt,
  };
  f.records.odds[0].data.espn_event_id = "0022500338";
  const s = create(f, "postgame");
  assert.deepEqual(
    (
      await s.query_game_history({
        table: "player_game_summary",
        game_id: f.game.gameId,
      })
    ).unavailable,
    [{ game_id: f.game.gameId, reason: "Published summaries are partial" }],
  );
  assert.equal((await s.query_odds_history({})).settlements[0].outcome, "over");
  f.history[`${f.game.gameId}:player_box_scores`][0].data.minutes_seconds = 0;
  assert.equal(
    (await create(f, "postgame").query_odds_history({})).settlements[0].outcome,
    "did_not_play",
  );
});

test("context uses supplied budgets; run identity, pins, cutoff and cursors cannot be changed", async () => {
  const f = fixtureCorpus(),
    s = create(f);
  f.config.runId = "mutated";
  f.game.index = 99;
  const ctx = await s.context(budget);
  assert.deepEqual(ctx.budget, budget);
  assert.equal(ctx.game.game_index, 2);
  ctx.budget.tokens = 0;
  assert.equal((await s.context(budget)).budget.tokens, 123);
  await assert.rejects(
    () =>
      s.query_game_history({
        table: "events",
        game_id: "prior",
        cutoff: future,
      } as never),
    code("invalid_input"),
  );
  const page = await s.query_game_history({
    table: "events",
    game_id: "prior",
    limit: 1,
  });
  await assert.rejects(
    () =>
      s.query_game_history({
        table: "events",
        game_id: "current",
        limit: 1,
        cursor: page.next_cursor!,
      }),
    code("invalid_input"),
  );
  await assert.rejects(
    () =>
      s.query_game_history({
        table: "events",
        game_id: "prior",
        cursor: "bad",
      }),
    code("invalid_input"),
  );
  await assert.rejects(
    () => s.transition("postgame", future),
    code("phase_refused"),
  );
  await s.transition("commit", cutoff);
  await assert.rejects(() => s.query_odds_history({}), code("phase_refused"));
  assert.equal((await s.list_questions({})).questions.length, 1);
  f.config.profile.dataSources[0].manifestSha256 = "b".repeat(64);
  assert.throws(() => create(f), /pins differ/);
});

test("stable pagination is independent of source iteration order and rejects malformed input", async () => {
  const f = fixtureCorpus(),
    a = await create(f).query_game_history({
      table: "events",
      game_id: "prior",
      limit: 1,
    });
  f.history["prior:events"].reverse();
  f.schedule.reverse();
  assert.deepEqual(
    await create(f).query_game_history({
      table: "events",
      game_id: "prior",
      limit: 1,
    }),
    a,
  );
  for (const input of [
    { table: "events", game_id: "prior", limit: 0 },
    { table: "events", game_id: "prior", from: "bad" },
    { table: "raw_objects", game_id: "prior" },
  ])
    await assert.rejects(
      () => create(f).query_game_history(input as never),
      code("invalid_input"),
    );
  f.config.profile.capabilities.enabled = [];
  await assert.rejects(
    () => create(f).query_odds_history({}),
    code("capability_disabled"),
  );
});

test("injury window filters printed report time, not scheduled tipoff", async () => {
  const s = create();
  const result = await s.read_schedule_and_injuries({
    game_id: "current",
    from: before,
    to: cutoff,
  });
  assert.equal(result.schedule.length, 1);
  assert.equal(result.injury_reports.length, 1);
  assert.equal(result.injury_reports[0].report_time, before);
  assert.equal(
    (await s.read_schedule_and_injuries({ game_id: "current", from: cutoff }))
      .injury_reports.length,
    0,
  );
});
