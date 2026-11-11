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
import { STATIC_AT } from "../src/data/contracts.js";
const budget: BudgetRemaining = {
  tokens: 123,
  compute_seconds: 4.5,
  tool_calls: 6,
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
    () => create(f).read_schedule_and_injuries({}),
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

test("persisted I2 injury mapping resolves Jaylin Williams only for Oklahoma City", async () => {
  const { readFile } = await import("node:fs/promises");
  const mappings = JSON.parse(await readFile("config/identities.json", "utf8"));
  const mapping = mappings.find(
    (m: any) =>
      m.entity === "player" &&
      m.provider === "injury-name" &&
      m.providerId === "Williams, Jaylin",
  );
  assert.equal(mapping.canonicalId, "1631119");
  assert.deepEqual(mapping.scope, { teamId: "1610612760" });
  for (const team of ["1610612760", BOS]) {
    const f = fixtureCorpus();
    f.source.identities.add(mapping);
    f.source.teams.push({
      team_id: "1610612760",
      abbreviation: "OKC",
      name: "Oklahoma City Thunder",
    });
    f.schedule.find((g) => g.id === "current")!.data.home_team_id = team;
    f.records.injuries[0].data.team_id = team;
    f.records.injuries[0].data.player_name = "Williams, Jaylin";
    const result = await create(f).read_schedule_and_injuries({
      game_id: "current",
      team_id: team,
    });
    assert.equal(result.injury_reports.length, 1);
    assert.equal(
      result.injury_reports[0].player_id,
      team === "1610612760" ? "1631119" : null,
    );
  }
});

test("player-grained history reads each eligible game once without loading membership boxes", async () => {
  for (const table of [
    "player_box_scores",
    "player_game_summary",
    "player_stints",
  ] as const) {
    const f = fixtureCorpus();
    f.history["prior:player_stints"] = f.history["prior:player_box_scores"];
    const calls: string[] = [];
    const original = f.source.history;
    f.source.history = async (...args) => {
      calls.push(`${args[1].id}:${args[0]}`);
      return original(...args);
    };
    const result = await create(f).query_game_history({
      table,
      player_id: "player",
      season: "2025-26",
    });
    assert.equal(result.total, 1);
    assert.deepEqual(calls, [`prior:${table}`]);
  }
});

test("evidence search filters future records before counts, snippets and pages", async () => {
  const results = [];
  for (const includeFuture of [true, false]) {
    const f = fixtureCorpus(includeFuture),
      s = create(f);
    assert.deepEqual(await s.search_evidence({ query: "FUTURE_SECRET" }), {
      items: [],
      total: 0,
      next_cursor: null,
    });
    const first = await s.search_evidence({ query: "visible", limit: 1 });
    assert.equal(first.total, 3);
    const second = await s.search_evidence({
      query: "visible",
      limit: 1,
      cursor: first.next_cursor!,
    });
    const third = await s.search_evidence({
      query: "visible",
      limit: 1,
      cursor: second.next_cursor!,
    });
    assert.equal(third.next_cursor, null);
    const fetched = await Promise.all(
      [...first.items, ...second.items, ...third.items].map((hit) =>
        s.fetch_evidence({ evidence_id: hit.evidence_id }),
      ),
    );
    noType(fetched);
    results.push([first, second, third, fetched]);
    assert.deepEqual(
      await s.search_evidence({ query: "visible", limit: 1 }),
      first,
    );
    await assert.rejects(
      () =>
        s.search_evidence({
          query: "different",
          limit: 1,
          cursor: first.next_cursor!,
        }),
      code("invalid_input"),
    );
    await assert.rejects(
      () => s.search_evidence({ query: "!!!" }),
      code("invalid_input"),
    );
    await assert.rejects(
      () => s.search_evidence({ query: "visible", cursor: "broken" }),
      code("invalid_input"),
    );
    assert.equal(
      (await s.search_evidence({ query: "visible", sources: ["posts"] })).total,
      1,
    );
    assert.equal(
      (await s.search_evidence({ query: "visible", from: cutoff })).total,
      0,
    );
  }
  assert.deepEqual(results[0], results[1]);
});

test("fetch hides future, equality, superseded and unknown ids identically; references remain eligible", async () => {
  const { evidenceId } = await import("../src/env/evidence.js");
  const f = fixtureCorpus();
  f.records.posts[0].data.references = [
    { postId: f.records.posts[2].data.postId },
    { postId: "absent" },
  ];
  const s = create(f);
  let expected;
  for (const id of [
    evidenceId(f.records.posts[2]),
    evidenceId(f.records.posts[1]),
    "unknown",
  ]) {
    try {
      await s.fetch_evidence({ evidence_id: id });
      assert.fail("must refuse");
    } catch (e) {
      assert.ok(e instanceof SessionError);
      assert.equal(e.code, "not_found");
      if (expected) assert.deepEqual(e.toJSON(), expected);
      else expected = e.toJSON();
    }
  }
  assert.deepEqual(
    (await s.fetch_evidence({ evidence_id: evidenceId(f.records.posts[0]) }))
      .references,
    [],
  );
  const edit = structuredClone(f.records.posts[0]);
  edit.id = "eligible-edit";
  edit.availableAt = "2025-11-02T22:59:59.5Z";
  edit.data.text = "replacement version";
  f.records.posts.push(edit);
  const later = create(f);
  assert.equal(
    (await later.search_evidence({ query: "replacement" })).total,
    1,
  );
  await assert.rejects(
    () => later.fetch_evidence({ evidence_id: evidenceId(f.records.posts[0]) }),
    code("not_found"),
  );
  const reply = structuredClone(edit);
  reply.id = "reply";
  reply.data.postId = "reply";
  reply.data.references = [{ postId: edit.data.postId, type: "quote" }];
  f.records.posts.push(reply);
  assert.deepEqual(
    (await create(f).fetch_evidence({ evidence_id: evidenceId(reply) }))
      .references,
    [evidenceId(edit)],
  );
});

test("transcripts preserve published defects, speaker clusters and artifact provenance; titles never set time", async () => {
  const { evidenceId } = await import("../src/env/evidence.js");
  const f = fixtureCorpus();
  const r = f.records.transcripts[0];
  r.data.title = "POSTGAME future title words";
  r.data.readable = "  Misspeled repeat repeat\n[foreign text retained]  ";
  r.data.normalized = {
    utterances: [
      { speaker: "speaker_X", start: 1.25, text: "segmentonly defect" },
    ],
    speakers: [{ name: "SECRET IDENTITY" }],
  };
  r.data.readable_ref = {
    bucket: "sports-transcription",
    key: "readable",
    sha256: "b".repeat(64),
  };
  const s = create(f),
    hit = (await s.search_evidence({ query: "segmentonly" })).items[0];
  assert.ok(hit.snippet.includes("segmentonly"));
  const fetched = await s.fetch_evidence({ evidence_id: hit.evidence_id });
  assert.equal(fetched.text, r.data.readable);
  assert.deepEqual(fetched.segments, [
    {
      speaker_label: "speaker_X",
      start_seconds: 1.25,
      text: "segmentonly defect",
    },
  ]);
  assert.equal(fetched.provenance.objects.length, 2);
  assert.ok(!JSON.stringify(fetched).includes("SECRET IDENTITY"));
  assert.equal(fetched.evidence_id, evidenceId(r));
  fetched.text = "mutated";
  assert.equal(
    (await s.fetch_evidence({ evidence_id: hit.evidence_id })).text,
    r.data.readable,
  );
  assert.equal(
    (await s.search_evidence({ query: "postgame", sources: ["transcripts"] }))
      .total,
    1,
  );
});

test("lineup equality is unavailable even after release; eligible announcements retain starters", async () => {
  const f = fixtureCorpus();
  const s = create(f, "postgame");
  const result = await s.search_evidence({
    query: "visible",
    sources: ["lineups"],
  });
  assert.equal(result.total, 1);
  const fetched = await s.fetch_evidence({
    evidence_id: result.items[0].evidence_id,
  });
  assert.deepEqual(fetched.starters, [
    { id: "player", name: "Fixture Player" },
  ]);
  await s.close();
  await assert.rejects(
    () => s.search_evidence({ query: "visible" }),
    code("phase_refused"),
  );
  const pre = create(f);
  await pre.transition("commit", cutoff);
  await assert.rejects(
    () => pre.fetch_evidence({ evidence_id: result.items[0].evidence_id }),
    code("phase_refused"),
  );
});

test("evidence index is deterministic under input order and future edits, cached per session", async () => {
  const f = fixtureCorpus();
  f.records.posts[2].data.postId = f.records.posts[0].data.postId;
  const expected = await create(f).search_evidence({ query: "visible" });
  Object.values(f.records).forEach((records) => records.reverse());
  let calls = 0;
  const original = f.source.evidence;
  f.source.evidence = async (source) => {
    calls++;
    return original(source);
  };
  const s = create(f);
  assert.deepEqual(await s.search_evidence({ query: "VISIBLE" }), expected);
  await s.fetch_evidence({ evidence_id: expected.items[0].evidence_id });
  assert.equal(calls, 3);
  assert.equal(
    (await s.search_evidence({ query: "visible", sources: [] })).total,
    0,
  );
  f.config.profile.capabilities.enabled = [];
  await assert.rejects(
    () => create(f).search_evidence({ query: "visible" }),
    code("capability_disabled"),
  );
});

test("history defaults to lean rows and names; metadata opt-in preserves descriptions", async () => {
  const f = fixtureCorpus();
  for (const r of f.history["prior:events"])
    Object.assign(r.data, {
      raw_object_ids: ["source-a"],
      quality_status: "partial",
    });
  const columns = f.source.columns.bind(f.source);
  f.source.columns = async (...args) => [
    ...(await columns(...args)),
    { name: "raw_object_ids", description: "Source object IDs" },
    { name: "quality_status", description: "Row validity" },
  ];
  const session = create(f);
  const lean = await session.query_game_history({
    table: "events",
    game_id: "prior",
  });
  const full = await session.query_game_history({
    table: "events",
    game_id: "prior",
    include_metadata: true,
  });
  assert.ok(full.columns.length > lean.columns.length);
  assert.ok(full.columns.every((c) => typeof c.description === "string"));
  assert.ok(lean.columns.every((c) => Object.keys(c).join() === "name"));
  assert.ok(!lean.columns.some((c) => c.name === "raw_object_ids"));
  assert.ok(full.columns.some((c) => c.name === "raw_object_ids"));
  assert.ok(lean.rows.length > 0);
  assert.ok(lean.rows.every((r) => r.quality_status === "partial"));
  assert.ok(lean.rows.every((r) => !Object.hasOwn(r, "raw_object_ids")));
  assert.ok(
    full.rows.every((r) => r.raw_object_ids === JSON.stringify(["source-a"])),
  );
  assert.equal(lean.rows.length, full.rows.length);
});

test("default schedule is current plus next, with bounded cutoff-bound pagination", async () => {
  const f = fixtureCorpus();
  for (const phase of ["pregame", "postgame"] as const) {
    const s = create(f, phase);
    const first = await s.read_schedule_and_injuries({});
    assert.deepEqual(
      first.schedule.map((g) => g.game_id),
      ["current", "future"],
    );
    assert.ok(first.next_cursor);
    const second = await s.read_schedule_and_injuries({
      cursor: first.next_cursor,
    });
    assert.deepEqual(
      second.schedule.map((g) => g.game_id),
      ["0022500338"],
    );
    assert.equal(second.next_cursor, null);
    assert.ok(second.injury_reports.every((r) => r.game_id === "0022500338"));
    await assert.rejects(
      s.read_schedule_and_injuries({ cursor: first.next_cursor, team_id: BOS }),
      code("invalid_input"),
    );
    await assert.rejects(
      s.read_schedule_and_injuries({ cursor: "bad" }),
      code("invalid_input"),
    );
    await assert.rejects(
      s.read_schedule_and_injuries({ cursor: first.next_cursor, from: before }),
      code("invalid_input"),
    );
    const explicit = await s.read_schedule_and_injuries({ team_id: BOS });
    assert.deepEqual(
      explicit.schedule.map((g) => g.game_id),
      ["prior", "current", "future", "0022500338"],
    );
    assert.equal(Object.hasOwn(explicit, "next_cursor"), false);
    assert.deepEqual(
      (await s.read_schedule_and_injuries({ game_id: "prior" })).schedule.map(
        (g) => g.game_id,
      ),
      ["prior"],
    );
  }
  const cursor = (await create(f).read_schedule_and_injuries({})).next_cursor!;
  await assert.rejects(
    create(f, "postgame").read_schedule_and_injuries({ cursor }),
    code("invalid_input"),
  );
});
