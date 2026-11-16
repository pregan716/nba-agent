import { fixtureReview } from "./review-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cutoff, envelope, fixtureCorpus } from "./fixtures/session/corpus.js";
import { teamIds } from "../src/data/teams.js";
import { releaseTime } from "../src/env/visibility.js";
import {
  developmentService,
  finalEvaluation,
  type EvaluationHost,
} from "../src/evaluation/service/index.js";
import { EvaluationPool } from "../src/evaluation/service/pool.js";
import {
  evaluationProfile,
  developmentGames,
  finalGames,
} from "../src/evaluation/service/profile.js";
import {
  pairedComparison,
  type ScoredGame,
} from "../src/evaluation/service/scores.js";
import { scoreGame } from "../src/projection/scoring.js";
import type { ReplaySource, TeamGame } from "../src/game-loop/replay.js";
import type { Package } from "../src/game-loop/package.js";
import type { Forecast, Range } from "../src/projection/forecast.js";

const pkg: Package = {
  version: "game-loop-v1",
  entry: "main.py",
  files: {
    "main.py":
      "def run(ctx, arg):\n return dict(type='finish',forecast=ctx['reference'])",
  },
  training: [],
  agents: {},
  artifacts: {},
  hypothesis: "Reference as baseline",
};
const middle = {
  teamId: teamIds.BOS,
  gameId: "current",
  tip: "2026-01-05T00:00:00Z",
};
const opening = { ...middle, gameId: "earlier", tip: "2025-10-21T23:30:00Z" };
function forecast(g: TeamGame, n: number): Forecast {
  const range: Range = [n, n, n, n, n, n, n];
  return {
    version: "forecast-v1",
    gameId: g.gameId,
    players: [
      {
        playerId: "p",
        p_play: 1,
        p_start: 0,
        minutes: range,
        fantasy_points: range,
        points: range,
        rebounds: range,
        assists: range,
      },
    ],
  };
}
const roster = [{ playerId: "p", inactive: false }];
function outcome(g: TeamGame) {
  return {
    ...g,
    release: releaseTime(g.tip),
    season: "2025-26",
    boston: g.teamId === teamIds.BOS,
    players: [
      {
        teamId: g.teamId,
        playerId: "p",
        inactive: false,
        played: true,
        starter: false,
        minutes: 10,
        fantasy_points: 10,
        points: 10,
        rebounds: 10,
        assists: 10,
      },
    ],
  };
}
function scored(g: TeamGame, system: number, ref: number): ScoredGame {
  return {
    ...g,
    score: scoreGame(
      { ...g, roster },
      forecast(g, system),
      forecast(g, ref),
      outcome(g),
      { costUsd: 0, wallClockMs: 1 },
      g.teamId,
    ),
  };
}
test("paired target divides game means and resamples both sides of a shared game together", () => {
  const a = scored(middle, 8, 6),
    b = scored(opening, 6, 8);
  const cmp = pairedComparison([a, b], [b, a], "reference").metrics[
    "minutes.pinball"
  ];
  assert.equal(cmp.ratio, 1);
  assert.deepEqual(cmp.ratio90, [0.5, 2]);
  const shared = scored({ ...middle, teamId: teamIds.OKC }, 6, 8);
  const single = pairedComparison([a, shared], [shared, a], "reference");
  assert.equal(single.games, 1);
  assert.deepEqual(single.metrics["minutes.pinball"].ratio90, [1, 1]);
  assert.equal(pairedComparison([b], [b], "reference").guardrailFlag, true);
  assert.throws(() => pairedComparison([a], [b]), /Mismatched/);
});
test("pool serializes reservations across handles, records refusals and releases unused dollars", (t) => {
  const root = mkdtempSync(join(tmpdir(), "eval-pool-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = { ...evaluationProfile, poolUsd: 2, fullLimit: 1 };
  const a = new EvaluationPool(root, profile, "env"),
    b = new EvaluationPool(root, profile, "env");
  t.after(() => {
    a.close();
    b.close();
  });
  const id = a.reserve("full", null, "hash", pkg, [middle]);
  assert.throws(
    () => b.reserve("test", null, "hash", pkg, [middle]),
    /dollar pool/,
  );
  b.recover(() => {
    throw Error("Live reservation was reclaimed");
  });
  a.settle(id, 0, "complete");
  assert.throws(
    () => b.reserve("repeat", id, "hash", pkg, [middle]),
    /cap exceeded/,
  );
  b.reserve("test", null, "hash", pkg, [middle]);
  assert.equal(a.refusals().length, 2);
});
test("development requests stay on the pinned games, final mode is separate, repeats and checks reuse the package", async (t) => {
  const f = fixtureCorpus(),
    root = mkdtempSync(join(tmpdir(), "v5-service-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const final = Array.from({ length: 82 }, (_, i) =>
    [teamIds.DEN, teamIds.MEM].map((teamId) => ({
      teamId,
      gameId: "final" + i,
      tip: new Date(
        Date.parse("2026-03-24T00:00:00Z") + 86400000 * i,
      ).toISOString(),
    })),
  ).flat();
  const calls: string[] = [];
  const source: ReplaySource = {
    data: f.source,
    schedule: [middle, opening, ...final],
    async projection(g) {
      calls.push(g.gameId);
      return { roster, reference: forecast(g, 7) };
    },
    async outcomes(g) {
      return outcome(g);
    },
  };
  const profile = structuredClone(evaluationProfile);
  profile.replay.usdPerTeamGame = 0;
  profile.windows.middle.count = profile.windows.opening.count = 1;
  const host: EvaluationHost = {
    review: fixtureReview,
    config: f.config,
    source,
    root,
    profile,
    runAgent: async () => {
      throw Error("No provider call expected");
    },
    get training(): never {
      throw Error("No training declared");
    },
  };
  const s = developmentService(host);
  t.after(() => s.close());
  await assert.rejects(s.evaluate({ kind: "final" }));
  assert.equal("finalEvaluation" in s, false);
  await assert.rejects(
    s.evaluate({
      kind: "test",
      package: pkg,
      games: [{ gameId: "final0", teamId: teamIds.DEN }],
    }),
    /Unknown/,
  );
  const withAgent = {
    ...pkg,
    agents: {
      reader: {
        model: "claude-sonnet-4-6",
        prompt: "Review minutes.",
        skills: [],
        tools: {},
      },
    },
  };
  const full = await s.evaluate({ kind: "full", package: withAgent });
  assert.equal(full.againstReference.metrics["minutes.pinball"].ratio, 1);
  assert.equal(full.archive.forecasts[0].reason, "run_budget_exhausted");
  assert.equal(full.archive.forecasts[0].fallback, true);
  const check = await s.evaluate({
    kind: "check",
    window: "opening",
    runId: full.id,
  });
  const repeat = await s.evaluate({ kind: "repeat", runId: full.id });
  assert.equal(check.archive.hash, full.archive.hash);
  assert.equal(repeat.archive.hash, full.archive.hash);
  assert.throws(() => s.compare(full.id, check.id), /Mismatched/);
  assert.equal(
    s.compare(full.id, repeat.id).metrics["minutes.pinball"].ratio,
    1,
  );
  assert.ok(!calls.some((id) => id.startsWith("final")));
  assert.equal(finalGames(source.schedule).length, 164);
  const before = calls.length;
  host.review = {
    ...fixtureReview,
    reviewer: async () => ({
      usd: 0,
      text: JSON.stringify({
        verdict: "reject",
        reasons: [
          { file: "main.py", line: 1, reason: "Planted season knowledge" },
        ],
      }),
    }),
  };
  for (const request of [
    { kind: "full", package: pkg },
    {
      kind: "test",
      package: pkg,
      games: [{ gameId: middle.gameId, teamId: middle.teamId }],
    },
    { kind: "check", window: "opening", runId: full.id },
    { kind: "repeat", runId: full.id },
  ]) {
    await assert.rejects(s.evaluate(request), /Planted season knowledge/);
  }
  await assert.rejects(
    finalEvaluation(host, full.id),
    /Planted season knowledge/,
  );
  assert.equal(calls.length, before);
  assert.equal(s.list().length, 3);
  await assert.rejects(s.nominate(full.id), /Planted season knowledge/);
  assert.equal(s.budget().nominee, null);
  host.review = fixtureReview;
  await s.evaluate({
    kind: "test",
    package: pkg,
    games: [{ gameId: middle.gameId, teamId: middle.teamId }],
  });
  const afterRecovery = calls.length;
  await assert.rejects(s.nominate(check.id), /full evaluation/);
  await s.nominate(full.id);
  let finalReviewCalls = 0;
  host.review = {
    ...fixtureReview,
    reviewer: async () => {
      finalReviewCalls++;
      return {
        usd: 0,
        text: JSON.stringify({
          verdict: "reject",
          reasons: [{ file: "main.py", line: 1, reason: "Changed verdict" }],
        }),
      };
    },
  };

  assert.equal(s.budget().nominee, full.id);
  assert.equal(calls.length, afterRecovery);
  const result = await finalEvaluation(host, full.id);
  assert.deepEqual(Object.keys(result.runs), [
    "nominated",
    "agents-off",
    "clear-artifacts",
  ]);
  assert.equal(finalReviewCalls, 0);
  host.review = fixtureReview;
  assert.equal(result.runs.nominated.archive.scores.length, 164);
  assert.equal(s.list().length, 4);
  await assert.rejects(
    s.evaluate({ kind: "full", package: pkg }),
    /closed after nomination/,
  );
});

test(
  "sandbox trains on prior-only rows and repeat replay receives the identical attached model",
  { skip: !process.env.FORECAST_SANDBOX_IMAGE },
  async (t) => {
    const f = fixtureCorpus(),
      root = mkdtempSync(join(tmpdir(), "v5-training-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    f.config.harness.sandboxImage = process.env.FORECAST_SANDBOX_IMAGE!;
    Object.assign(f.config.budget.sandbox, {
      memoryBytes: 256 * 1024 * 1024,
      stdoutBytes: 1024 * 1024,
    });
    const game = { ...middle, tip: cutoff };
    const gameRow = (id: string, tip: string, season: string) =>
      envelope(id, "schedule", tip, "schedule_static", {
        game_id: id,
        season,
        home_team_id: teamIds.BOS,
        away_team_id: "other",
        scheduled_tipoff: tip,
      });
    const games = Array.from({ length: 82 }, (_, i) =>
      gameRow(
        i === 0 ? "CURRENT_SEASON_SENTINEL" : "b" + i,
        i < 70
          ? cutoff
          : new Date(
              Date.parse("2026-03-23T00:00:00Z") + (i - 70) * 86400000,
            ).toISOString(),
        "2025-26",
      ),
    );
    games.push(gameRow("prior", "2025-01-05T00:00:00Z", "2024-25"));
    let builds = 0;
    const host: EvaluationHost = {
      review: fixtureReview,
      root,
      config: f.config,
      runAgent: async (call) => {
        call.transcript({
          role: "assistant",
          content: [{ type: "text", text: "AGENT_REPLY" }],
        });
        return "AGENT_REPLY";
      },
      source: {
        data: f.source,
        schedule: [game],
        async outcomes(g) {
          return outcome(g);
        },
        async projection(g) {
          return {
            roster,
            reference: forecast(g, 7),
            spread: -3,
            total: 210,
            playerProp: { line: "PROP_LINE_SENTINEL" },
          };
        },
      },
      training: {
        gameLines: async () => {
          throw Error("Training requested game lines");
        },
        games,
        data: {
          identities: f.source.identities,
          async columns() {
            return [{ name: "marker", description: "test" }];
          },
          async *exportHistory(table, selected) {
            if (table === "events") builds++;
            assert.deepEqual(
              selected.map((g) => g.id),
              ["prior"],
            );
            yield {
              gameId: "prior",
              reason: null,
              records: [
                envelope(
                  "ok",
                  "history",
                  "2025-01-06T14:00:00Z",
                  "game_next_morning_eastern",
                  { game_id: "prior", season: "2024-25", marker: "allowed" },
                ),
                envelope(
                  "bad",
                  "history",
                  cutoff,
                  "game_next_morning_eastern",
                  {
                    game_id: "prior",
                    season: "2025-26",
                    marker: "CURRENT_SEASON_SENTINEL",
                  },
                ),
              ],
            };
          },
        },
        corpus: {
          injuries: {
            async *partitions() {
              throw Error("Current injuries accessed");
            },
          },
        },
        evidence: [],
        rosters: new Map(),
      },
    };
    const trainingPackage: Package = {
      ...pkg,
      training: ["train.py"],
      artifacts: { note: "team" },
      agents: {
        a: {
          model: "claude-sonnet-4-6",
          prompt: "Estimate minutes",
          skills: [],
          tools: {},
        },
      },
      files: {
        "main.py": `def run(ctx,arg):
    import json
    assert json.load(open('/data/models/train.py.json'))=={'prior_rows':1}
    assert 'playerProp' not in ctx
    if arg is None: return dict(type='agent',name='a',input='minutes',state=None)
    return dict(type='finish',forecast=ctx['reference'],writes={'note':arg['reply']['value']})
`,
        "train.py": `def train(path):
    import sqlite3, pathlib
    db=sqlite3.connect('file:'+path+'?mode=ro',uri=True)
    assert db.execute("select distinct season from schedule").fetchall()==[('2024-25',)]
    assert db.execute("select marker from events").fetchall()==[('allowed',)]
    assert b'CURRENT_SEASON_SENTINEL' not in pathlib.Path(path).read_bytes()
    assert not pathlib.Path('/data/game.json').exists()
    return {'prior_rows':db.execute('select count(*) from schedule').fetchone()[0]}
`,
      },
    };
    const s = developmentService(host);
    t.after(() => s.close());
    const run = await s.evaluate({
      kind: "test",
      package: trainingPackage,
      games: [{ teamId: game.teamId, gameId: game.gameId }],
    });
    assert.equal(
      run.archive.forecasts[0].fallback,
      false,
      JSON.stringify(run.archive.forecasts[0].reason),
    );
    assert.equal(builds, 1);
    assert.equal(
      run.archive.calls.filter((c) => c.kind === "agent_end").length,
      1,
    );
    assert.deepEqual(
      run.archive.calls.map((c) => c.kind),
      ["agent_start", "agent_transcript", "agent_end"],
    );
    assert.equal(run.archive.calls[0].data.system, "Estimate minutes");
    assert.equal(run.archive.calls[0].data.input, "minutes");
    assert.equal(
      run.archive.calls[1].data.value.content[0].text,
      "AGENT_REPLY",
    );
    assert.equal(run.archive.calls[2].data.reply.value, "AGENT_REPLY");
    const archived = run.archive.forecasts[0];
    assert.equal(archived.spread, -3);
    assert.equal(archived.total, 210);
    assert.deepEqual(archived.artifacts, [
      { name: "note", team: game.teamId, value: "AGENT_REPLY" },
    ]);
    assert.deepEqual(
      run.archive.sandboxSteps.map((s) => s.action),
      ["agent", "finish"],
    );
    assert.ok(!JSON.stringify(run.archive).includes("PROP_LINE_SENTINEL"));
    const failed = await s.evaluate({
      kind: "test",
      games: [{ teamId: game.teamId, gameId: game.gameId }],
      package: {
        ...pkg,
        files: {
          "main.py":
            "def run(ctx,arg):\n    raise RuntimeError('bad rotation estimate')",
        },
      },
    });
    assert.match(failed.archive.forecasts[0].reason, /bad rotation estimate/);
    assert.equal(failed.archive.forecasts[0].fallback, true);
    const [step] = failed.archive.sandboxSteps;
    assert.equal(step.file, "main.py");
    assert.equal(step.action, null);
    assert.equal(step.exitStatus, 1);
    assert.equal(step.limit, null);
    assert.match(step.stderr, /RuntimeError: bad rotation estimate/);
    const repeat = await s.evaluate({ kind: "repeat", runId: run.id });
    assert.equal(repeat.archive.forecasts[0].fallback, false);
    assert.equal(builds, 1);
    await assert.rejects(
      s.evaluate({
        kind: "test",
        package: { ...trainingPackage, weights: [3] },
        games: [{ teamId: game.teamId, gameId: game.gameId }],
      }),
    );
  },
);

test("fresh Pi architect iterations retain drafts and hypotheses, submit through review and read only development results", async (t) => {
  const { architectIteration } = await import("../src/architect/session.js");
  const { architectProvider } =
    await import("./fixtures/architect-provider.js");
  const { DatabaseSync } = await import("node:sqlite");
  const provider = await architectProvider();
  t.after(() => provider.close());
  const f = fixtureCorpus(),
    root = mkdtempSync(join(tmpdir(), "architect-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = structuredClone(evaluationProfile);
  const image = process.env.FORECAST_SANDBOX_IMAGE;
  profile.replay.usdPerTeamGame = image ? 1 : 0;
  profile.windows.middle.count = 1;
  if (image) {
    f.config.harness.sandboxImage = image;
    Object.assign(f.config.budget.sandbox, {
      memoryBytes: 256 * 1024 * 1024,
      stdoutBytes: 1024 * 1024,
    });
  }
  const games = Array.from({ length: 82 }, (_, n) => {
    const tip =
      n < 70
        ? middle.tip
        : new Date(
            Date.parse("2026-03-23T00:00:00Z") + 86400000 * (n - 70),
          ).toISOString();
    return envelope(
      n === 0 ? "visible" : "g" + n,
      "schedule",
      tip,
      "schedule_static",
      {
        game_id: n >= 70 ? "HOLDOUT_SENTINEL" : "visible",
        scheduled_tipoff: tip,
        season: "2025-26",
        home_team_id: teamIds.BOS,
        away_team_id: "other",
        player_prop: "PROP_LINE_SENTINEL",
      },
    );
  });

  const host: EvaluationHost = {
    root,
    profile,
    config: f.config,
    review: fixtureReview,
    runAgent: async () => {
      throw Error("Unexpected provider");
    },
    source: {
      data: f.source,
      schedule: [middle],
      projection: async (g) => ({
        roster,
        reference: forecast(g, 7),
        spread: -12345,
        total: 67890,
      }),
      outcomes: async (g) => outcome(g),
    },
    training: {
      gameLines: async () => () => ({ spread: -12345, total: 67890 }),
      games,
      data: {
        identities: f.source.identities,
        async columns() {
          return [];
        },
        async *exportHistory() {},
      },
      evidence: [],
      rosters: new Map(),
      corpus: { injuries: { async *partitions() {} } },
    },
  };
  const call = (name: string, input: Record<string, unknown>) => ({
    name,
    input,
  });
  const proposal = {
    kind: "test",
    hypothesis: "Baseline",
    expectedEffect: "Match reference scores.",
    games: [{ gameId: middle.gameId, teamId: middle.teamId }],
  };
  const { games: _, ...ending } = { ...proposal, kind: "full" };
  const { files, ...manifest } = pkg;
  provider.steps.push(
    { truncated: true },
    {
      calls: [
        call("document_write", {
          area: "notes",
          name: "memo",
          content: "PRIVATE_ITERATION_NOTE",
        }),
        call("document_write", {
          area: "draft",
          name: "package.json",
          content: JSON.stringify(manifest),
        }),
        call("document_write", {
          area: "draft",
          name: "main.py",
          content: files["main.py"],
        }),
        ...(image
          ? [
              call("data_python", {
                code: `import sqlite3, pathlib
db=sqlite3.connect("file:/data/session.sqlite?mode=ro",uri=True)
assert db.execute("select distinct game_id from schedule").fetchall()==[("visible",)]
assert "player_prop" not in [row[1] for row in db.execute("pragma table_info(schedule)")]
assert db.execute("select distinct spread,total from game_lines").fetchall()==[(-12345,67890)]
assert not pathlib.Path("/data/architect.sqlite").exists()
print("filtered data verified")`,
              }),
            ]
          : []),
        call("validate_package", {}),
        call("submit", proposal),
        call("hypothesis_write", {
          action: "add",
          name: "Baseline",
          description: "Use a code-only forecast.",
        }),
        call("submit", { ...proposal, hypothesis: "" }),
        call("submit", { ...proposal, expectedEffect: "" }),
        call("document_edit", {
          area: "notes",
          name: "memo",
          before: "PRIVATE_ITERATION_NOTE",
          after: "PRIVATE_ITERATION_NOTE updated",
        }),
      ],
    },
    // A test run leaves the iteration open: its result is read in the same
    // session, and the full evaluation ends it.
    { calls: [call("submit", proposal)] },
    {
      calls: ({ messages }) => [
        call("archive_read", {
          runId: /runId\\*":\\*"([0-9a-f-]{36})/.exec(
            JSON.stringify(messages.at(-1)),
          )![1],
          section: "forecasts",
        }),
      ],
    },
    { calls: [call("submit", ending)] },
  );
  const first = await architectIteration(host, provider.options);
  assert.equal(first.status, "full");
  // The test run's forecast reached the architect before it submitted full.
  const readBack = JSON.stringify(provider.requests.at(-1)!.messages.at(-1));
  assert.match(readBack, /forecast-v1/);
  assert.match(readBack, /-12345/);
  assert.match(
    JSON.stringify(provider.requests[1].messages),
    /last response reached the output limit/,
  );
  const db = new DatabaseSync(join(root, "architect.sqlite"), {
    readOnly: true,
  });
  t.after(() => db.close());
  const events = db
    .prepare("SELECT seq,kind,data FROM events WHERE iteration=? ORDER BY seq")
    .all(first.iteration);
  if (image)
    assert.ok(
      events.some(
        (e) =>
          e.kind === "tool_result" &&
          JSON.parse(String(e.data)).result?.stdout?.includes(
            "filtered data verified",
          ),
      ),
    );
  const decision = JSON.parse(
    String(events.find((r) => r.kind === "decision")!.data),
  );
  const recorded = events.filter((r) =>
    ["proposal", "configuration", "review", "decision"].includes(
      String(r.kind),
    ),
  );
  assert.deepEqual(
    recorded.map((r) => r.kind),
    [
      "proposal",
      "configuration",
      "review",
      "decision",
      "proposal",
      "configuration",
      "review",
      "decision",
    ],
  );
  assert.deepEqual(
    recorded
      .filter((r) => r.kind === "decision")
      .map((r) => JSON.parse(String(r.data)).kind),
    ["test", "full"],
  );
  assert.equal(
    JSON.parse(String(recorded[0].data)).expectedEffect,
    proposal.expectedEffect,
  );
  assert.equal(JSON.parse(String(recorded[2].data)).verdict, "accept");
  assert.equal(
    JSON.parse(String(recorded[1].data)).files["main.py"],
    files["main.py"],
  );
  if (image) {
    const service = developmentService(host);
    try {
      assert.equal(
        service.archive(decision.runId).forecasts[0].fallback,
        false,
      );
    } finally {
      service.close();
    }
  }
  const before = provider.requests.length;
  provider.steps.push(
    {
      calls: [
        call("document_read", { area: "notes", name: "memo" }),
        call("archive_read", { runId: decision.runId, section: "forecasts" }),
        call("archive_read", {
          runId: decision.runId,
          section: "sandboxSteps",
        }),
        call("final", {}),
        call("budget", {}),
      ],
    },
    // Near the iteration cap, force a warning on an ordinary tool result and
    // then use the exact remaining amount in the last fixture response.
    { inputTokens: 5599900, outputTokens: 10, calls: [call("hypotheses", {})] },
  );
  const chargedFirstTurn = 10 * 5 + 3 * 25;
  const remainingMicro = 30e6 - chargedFirstTurn - (5599900 * 5 + 10 * 25);
  provider.steps.push({
    inputTokens: (remainingMicro - 25) / 5,
    outputTokens: 1,
  });
  const second = await architectIteration(host, provider.options);
  assert.equal(second.status, "budget");
  assert.equal(second.budget.sessionUsd, 0);
  assert.ok(
    !JSON.stringify(provider.requests[before].messages).includes(
      "PRIVATE_ITERATION_NOTE",
    ),
  );
  const history = JSON.stringify(provider.requests[before + 1].messages);
  assert.match(history, /PRIVATE_ITERATION_NOTE updated/);
  assert.match(history, /forecast-v1/);
  assert.match(history, /-12345/);
  assert.match(history, /67890/);
  if (image) assert.match(history, /stdoutTruncated/);
  assert.doesNotMatch(history, /PROP_LINE_SENTINEL/);
  assert.ok(
    !provider.requests[before].tools.some((tool) => tool.name === "final"),
  );
  assert.match(
    JSON.stringify(provider.requests.at(-1)!.messages),
    /Budget low/,
  );
  assert.ok(
    provider.requests.every((r) => r.stream && r.model === "claude-opus-4-6"),
  );
  assert.equal(db.prepare("SELECT count(*) AS n FROM documents").get()?.n, 3);
  assert.equal(db.prepare("SELECT count(*) AS n FROM hypotheses").get()?.n, 1);
  host.review = {
    ...fixtureReview,
    scan: () => [{ file: "main.py", line: 1, reason: "Planted leak" }],
  };
  provider.steps.push({ calls: [call("submit", proposal)] });
  const rejected = await architectIteration(host, provider.options);
  assert.equal(rejected.status, "rejected");
  const receipt = db
    .prepare("SELECT data FROM events WHERE iteration=? AND kind='review'")
    .get(rejected.iteration)!;
  assert.equal(
    JSON.parse(String(receipt.data)).reasons[0].reason,
    "Planted leak",
  );
  // The first submission exhausts reviewer retries. The architect sees the
  // error and submits the same configuration in the same iteration.
  const pool = new DatabaseSync(join(root, "evaluations.sqlite"), {
    readOnly: true,
  });
  t.after(() => pool.close());
  const runCount = () =>
    Number(pool.prepare("SELECT count(*) AS n FROM runs").get()!.n);
  const baseline = runCount();
  let reviewCalls = 0;
  host.review = {
    ...fixtureReview,
    reviewer: async (pkg) => {
      assert.equal(runCount(), baseline);
      if (++reviewCalls <= 5)
        throw Object.assign(Error("overloaded"), { status: 529 });
      return fixtureReview.reviewer(pkg);
    },
  };
  provider.failures.count.push(529);
  provider.failures.model.push(529, 429);
  provider.steps.push(
    { calls: [call("submit", ending)], disconnected: true },
    { calls: [call("submit", ending)] },
    { calls: [call("submit", ending)], streamError: "overloaded_error" },
    { calls: [call("submit", ending)] },
  );
  const recovered = await architectIteration(host, provider.options);
  assert.equal(recovered.status, "full");
  assert.equal(reviewCalls, 6);
  assert.equal(runCount(), baseline + 1);
  assert.match(
    JSON.stringify(provider.requests.at(-1)!.messages),
    /Reviewer unavailable. Submit the configuration again/,
  );
  const receipts = db
    .prepare(
      "SELECT data FROM events WHERE iteration=? AND kind='review' ORDER BY seq",
    )
    .all(recovered.iteration);
  assert.deepEqual(
    receipts.map((row) => JSON.parse(String(row.data)).verdict),
    ["failed", "accept"],
  );
  const reviewDb = new DatabaseSync(join(root, "reviews.sqlite"), {
    readOnly: true,
  });
  t.after(() => reviewDb.close());
  for (const [index, row] of receipts.entries()) {
    const { id, verdict } = JSON.parse(String(row.data));
    const review = reviewDb
      .prepare("SELECT verdict,reviewerUsd FROM reviews WHERE id=?")
      .get(id)!;
    assert.equal(review.verdict, verdict);
    assert.equal(review.reviewerUsd, null);
    const amounts = reviewDb
      .prepare("SELECT usd FROM reviewer_attempts WHERE review=? ORDER BY id")
      .all(id)
      .map((a) => a.usd);
    assert.deepEqual(
      amounts,
      index === 0 ? [null, null, null, null] : [null, 0],
    );
  }
  const ledger = db
    .prepare("SELECT spent,held FROM iterations WHERE id=?")
    .get(recovered.iteration)!;
  // The HTTP 529, disconnect and streamed overload each retain a hold. The rate limit
  // released its reservation and the token count never charged the ledger.
  assert.equal(ledger.spent, 2 * (10 * 5 + 3 * 25) * 1000);
  const hold = (10 * 5 + 32000 * 25) * 1000;
  assert.equal(ledger.held, 3 * hold);

  for (const streamError of [
    "api_error",
    "rate_limit_error",
    "overloaded_error",
    "api_error",
  ])
    provider.steps.push({ calls: [call("submit", proposal)], streamError });
  const beforeExhaustion = provider.requests.length;
  await assert.rejects(
    architectIteration(host, provider.options),
    /Architect stream failed/,
  );
  assert.equal(provider.requests.length - beforeExhaustion, 4);
  const failed = db
    .prepare(
      "SELECT status,spent,held FROM iterations ORDER BY rowid DESC LIMIT 1",
    )
    .get()!;
  assert.deepEqual(
    { ...failed },
    { status: "failed", spent: 0, held: 4 * hold },
  );
  assert.equal(runCount(), baseline + 1);
});
