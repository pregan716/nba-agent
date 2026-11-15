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
  host.review = fixtureReview;
  assert.throws(() => s.nominate(check.id), /full evaluation/);
  s.nominate(full.id);
  assert.equal(s.budget().nominee, full.id);
  assert.equal(calls.length, before);
  const result = await finalEvaluation(host, full.id);
  assert.deepEqual(Object.keys(result.runs), [
    "nominated",
    "agents-off",
    "clear-artifacts",
  ]);
  assert.equal(result.runs.nominated.archive.scores.length, 164);
  assert.equal(s.list().length, 3);
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
          content: [{ type: "text", text: "MARKET_PRICE_SENTINEL" }],
        });
        return "MARKET_PRICE_SENTINEL";
      },
      source: {
        data: f.source,
        schedule: [game],
        async outcomes(g) {
          return outcome(g);
        },
        async projection(g) {
          return { roster, reference: forecast(g, 7), spread: -3, total: 210 };
        },
      },
      training: {
        games,
        data: {
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
    if arg is None: return dict(type='agent',name='a',input='minutes',state=None)
    return dict(type='finish',forecast=ctx['reference'])
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
    assert.ok(!JSON.stringify(run).includes("MARKET_PRICE_SENTINEL"));
    assert.ok(run.archive.calls.every((c) => c.withheld));
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
        game_total: "MARKET_SENTINEL",
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
      games,
      data: {
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
assert "game_total" not in [row[1] for row in db.execute("pragma table_info(schedule)")]
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
    { calls: [call("submit", proposal)] },
  );
  const first = await architectIteration(host, provider.options);
  assert.equal(first.status, "test");
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
    ["proposal", "configuration", "review", "decision"],
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
  assert.doesNotMatch(history, /-12345|67890/);
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
});
