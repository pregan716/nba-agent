import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixtureCorpus } from "./fixtures/session/corpus.js";
import { fixtureReview } from "./review-fixture.js";
import { Iteration } from "../src/architect/iteration.js";
import { EvaluationPool } from "../src/evaluation/service/pool.js";
import { evaluationProfile } from "../src/evaluation/service/profile.js";
import { seedRoundTwo } from "../src/evaluation/service/seed.js";
import {
  developmentService,
  finalEvaluation,
  type EvaluationHost,
} from "../src/evaluation/service/index.js";
import { RecordStore } from "../src/runner/record.js";
import { digest } from "../src/runner/config.js";
import { readPackage, type Package } from "../src/game-loop/package.js";
import { scoreGame } from "../src/projection/scoring.js";
import type { TeamGame } from "../src/game-loop/replay.js";
import type { Forecast, Range } from "../src/projection/forecast.js";
import { teamIds } from "../src/data/teams.js";

const pkg: Package = {
  version: "game-loop-v1",
  entry: "main.py",
  files: {
    "main.py":
      "def run(ctx,arg): return dict(type='finish',forecast=ctx['reference'])",
  },
  agents: {},
  artifacts: {},
  training: [],
  hypothesis: "Baseline",
};
const agentPkg: Package = {
  ...pkg,
  agents: {
    reader: {
      model: "claude-sonnet-4-6",
      prompt: "Read evidence.",
      skills: [],
      tools: {},
    },
  },
};
const games: TeamGame[] = [0, 1, 2].map((n) => ({
  gameId: "g" + n,
  teamId: teamIds.BOS,
  tip: `2026-01-0${n + 5}T00:00:00Z`,
}));
function record(
  host: EvaluationHost,
  root: string,
  selected: TeamGame[],
  config: Package,
  development: boolean,
  successful: number[] = [],
  failures = false,
) {
  const store = new RecordStore(root, {
    schemaVersion: "game-loop-v1",
    packageHash: readPackage(config).hash,
    package: config,
    config: host.config,
    games: selected,
    development,
    agentsOff: false,
    clearArtifacts: false,
  });
  try {
    for (const [index, g] of selected.entries()) {
      const scope = JSON.stringify([g.teamId, g.gameId]);
      const range: Range = [7, 7, 7, 7, 7, 7, 7];
      const forecast: Forecast = {
        version: "forecast-v1",
        gameId: g.gameId,
        players: [
          {
            playerId: "p",
            p_play: 0.9,
            p_start: 0.1,
            minutes: range,
            points: range,
            rebounds: range,
            assists: range,
            fantasy_points: range,
          },
        ],
      };
      const outcome = {
        ...g,
        season: "2025-26",
        boston: true,
        release: g.tip,
        players: [
          {
            playerId: "p",
            teamId: g.teamId,
            played: true,
            starter: false,
            inactive: false,
            minutes: 10,
            points: 10,
            rebounds: 10,
            assists: 10,
            fantasy_points: 10,
          },
        ],
      };
      const score = scoreGame(
        { ...g, roster: [{ playerId: "p", inactive: false }] },
        forecast,
        forecast,
        outcome,
        { costUsd: 0, wallClockMs: 1 },
        g.teamId,
      );
      for (const n of successful.filter((n) => n === index))
        store.append("agent_end", scope, { reply: { ok: true, value: n } });
      if (failures) {
        store.append("agent_end", scope, {
          reply: { ok: false, error: "Agent call refused" },
        });
        store.append("agent_end", scope, {
          reply: { ok: false, error: "Agent call failed" },
        });
      }
      store.append("team_game", scope, {
        frozen: forecast,
        reference: forecast,
        reason: null,
        artifacts: {},
        costUsd: 0,
        unresolvedUsd: 0,
        wallClockMs: 1,
      });
      store.append("game_score", scope, score);
    }
    store.append("replay_end", "run", {
      usd: 0,
      unresolvedUsd: 0,
      teamGames: selected.length,
    });
  } finally {
    store.close();
  }
}
function completed(
  host: EvaluationHost,
  kind = "full",
  config = pkg,
  successful: number[] = [],
  failures = false,
  selected = games,
) {
  const pool = new EvaluationPool(
    host.root,
    host.profile!,
    digest(host.config),
  );
  try {
    const id = pool.reserve(
      kind,
      null,
      readPackage(config).hash,
      config,
      selected,
    );
    record(
      host,
      join(host.root, "development", id),
      selected,
      config,
      true,
      successful,
      failures,
    );
    pool.settle(id, 0, "complete");
    return id;
  } finally {
    pool.close();
  }
}
function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "round-two-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = fixtureCorpus();
  const profile = structuredClone(evaluationProfile);
  profile.windows.middle.count = 3;
  profile.replay.usdPerTeamGame = 0;
  const unexpected = async (): Promise<never> => {
    throw Error("Unexpected execution");
  };
  const old: EvaluationHost = {
    root: join(directory, "round-one"),
    config: f.config,
    profile,
    review: fixtureReview,
    runAgent: unexpected,
    source: {
      data: f.source,
      schedule: games,
      projection: unexpected,
      outcomes: unexpected,
    },
    training: {} as EvaluationHost["training"],
  };
  const current = {
    ...old,
    root: join(directory, "round-two"),
    config: structuredClone(old.config),
  };
  current.config.harness.codeRevision = "new-revision";
  const ledger = new Iteration(old.root);
  ledger.db
    .prepare("INSERT INTO documents VALUES('notes','memo','useful notes')")
    .run();
  ledger.db
    .prepare("INSERT INTO documents VALUES('draft','main.py','OBSOLETE_DRAFT')")
    .run();
  ledger.db.prepare("INSERT INTO hypotheses VALUES('h','test agents',0)").run();
  ledger.reserve(10)(10);
  ledger.status = "full";
  ledger.close();
  return { directory, old, current };
}

test("seed imports historical development records across revisions with fresh budgets and no final or late files", async (t) => {
  const { old, current } = fixture(t);
  const baseline = completed(old);
  completed(old, "full", agentPkg, [0, 1, 2]);
  const late = completed(old, "check", pkg, [], false, [
    { ...games[0], tip: "2026-03-01T00:00:00Z" },
  ]);
  const service = developmentService(old);
  await service.nominate(baseline);
  service.close();
  mkdirSync(join(old.root, "final", "secret"), { recursive: true });
  writeFileSync(join(old.root, "final", "secret", "FINAL_SENTINEL"), "secret");
  writeFileSync(
    join(old.root, "development", baseline, "EXTRA_SENTINEL"),
    "secret",
  );
  await seedRoundTwo(current, old.root);
  assert.throws(
    () => developmentService({ ...current, root: old.root }),
    /Different evaluation/,
  );
  const s = developmentService(current);
  t.after(() => s.close());
  assert.equal(s.round().round, 2);
  assert.equal(s.round().baselineRunId, baseline);
  assert.equal(s.budget().nominee, null);
  assert.equal(s.budget().fullEvaluations, current.profile!.fullLimit);
  assert.equal(s.budget().evaluationUsd, current.profile!.poolUsd);
  assert.equal(s.budget().agentGate?.met, false);
  assert.equal(s.list().length, 2);
  assert.equal(s.archive(baseline).hash, readPackage(pkg).hash);
  assert.equal(
    s.compare(baseline, baseline).metrics["minutes.pinball"].ratio,
    1,
  );
  assert.throws(() => s.archive(late), /Unknown/);
  assert.equal(existsSync(join(current.root, "final")), false);
  assert.deepEqual(
    readdirSync(join(current.root, "development", baseline)).sort(),
    ["manifest.json", "record.sqlite"],
  );
  const i = new Iteration(current.root);
  try {
    assert.equal(i.budget().totalUsd, 350);
    assert.equal(
      i.db
        .prepare(
          "SELECT content FROM documents WHERE area='draft' AND name='main.py'",
        )
        .get()?.content,
      pkg.files["main.py"],
    );
    assert.equal(
      i.db.prepare("SELECT content FROM documents WHERE area='notes'").get()
        ?.content,
      "useful notes",
    );
    assert.equal(
      i.db.prepare("SELECT description FROM hypotheses").get()?.description,
      "test agents",
    );
  } finally {
    i.close();
  }
  await assert.rejects(seedRoundTwo(current, old.root), /must not exist/);
});

test("round-two gate excludes inherited, uncalled, failed, partial, check, repeat and test runs", async (t) => {
  const { old, current } = fixture(t);
  const baseline = completed(old);
  const oldService = developmentService(old);
  assert.deepEqual(oldService.round(), { round: 1, baselineRunId: null });
  await oldService.nominate(baseline);
  oldService.close();
  await seedRoundTwo(current, old.root);
  const s = developmentService(current);
  t.after(() => s.close());
  const refused = () =>
    assert.rejects(s.nominate(baseline), /successful agent replies/);
  await refused();
  completed(current, "full", agentPkg);
  await refused();
  completed(current, "full", agentPkg, [], true);
  await refused();
  completed(current, "full", agentPkg, [0, 0, 0]);
  await refused();
  for (const kind of ["check", "repeat", "test"])
    completed(current, kind, agentPkg, [0, 1, 2]);
  await refused();
  const failedRun = completed(current, "full", agentPkg, [0, 1, 2]);
  const pool = new EvaluationPool(
    current.root,
    current.profile!,
    digest(current.config),
  );
  pool.db.prepare("UPDATE runs SET status='failed' WHERE id=?").run(failedRun);
  pool.close();
  await refused();
  const qualifying = completed(current, "full", agentPkg, [0, 1]);
  assert.deepEqual(s.budget().agentGate, {
    met: true,
    qualifyingRunId: qualifying,
  });
  assert.equal(s.compare(qualifying, baseline).teamGames, games.length);
  await s.nominate(baseline);
  assert.equal(s.budget().nominee, baseline);
});

test("round-two final compares the nominees using an external historical final record", async (t) => {
  const { old, current } = fixture(t);
  const baseline = completed(old);
  const prior = developmentService(old);
  await prior.nominate(baseline);
  prior.close();
  await seedRoundTwo(current, old.root);
  completed(current, "full", agentPkg, [0, 1]);
  const finalGames = Array.from({ length: 82 }, (_, n) =>
    [teamIds.DEN, teamIds.MEM].map((teamId) => ({
      teamId,
      gameId: "final" + n,
      tip: new Date(Date.UTC(2026, 0, n + 1)).toISOString(),
    })),
  ).flat();
  current.source = { ...current.source, schedule: finalGames };
  const baselineFinal = join(old.root, "final", baseline, "nominated");
  record(old, baselineFinal, finalGames, pkg, false);
  current.roundOneFinal = baselineFinal;
  for (const mode of ["nominated", "clear-artifacts"])
    record(
      current,
      join(current.root, "final", baseline, mode),
      finalGames,
      pkg,
      false,
    );
  await assert.rejects(
    finalEvaluation({ ...current, roundOneFinal: undefined }, baseline),
    /Pass the round-one/,
  );
  const wrongFinal = join(old.root, "final", "wrong-environment");
  record(current, wrongFinal, finalGames, pkg, false);
  await assert.rejects(
    finalEvaluation({ ...current, roundOneFinal: wrongFinal }, baseline),
    /baseline nominee/,
  );
  await assert.rejects(
    finalEvaluation(
      { ...current, roundOneFinal: join(old.root, "development", baseline) },
      baseline,
    ),
    /baseline nominee/,
  );
  const result = await finalEvaluation(current, baseline);
  assert.equal(result.againstRoundOne?.teamGames, 164);
  assert.equal(result.againstRoundOne?.metrics["minutes.pinball"].ratio, 1);
  assert.deepEqual(
    result.againstRoundOne?.metrics["minutes.pinball"].ratio90,
    [1, 1],
  );
});

test("failed seeding leaves no partial destination and can be retried", async (t) => {
  const { old, current } = fixture(t);
  const baseline = completed(old);
  await assert.rejects(seedRoundTwo(current, old.root), /no nominee/);
  assert.equal(existsSync(current.root), false);
  const s = developmentService(old);
  await s.nominate(baseline);
  s.close();
  const active = new Iteration(old.root);
  await assert.rejects(seedRoundTwo(current, old.root), /active architect/);
  assert.equal(existsSync(current.root), false);
  active.status = "full";
  active.close();
  await seedRoundTwo(current, old.root);
  assert.equal(existsSync(current.root), true);
});

test("seed accepts a record whose games are in replay order while the pool lists them in schedule order", async (t) => {
  const { old, current } = fixture(t);
  const pool = new EvaluationPool(old.root, old.profile!, digest(old.config));
  const listed = [...games].reverse();
  const baseline = pool.reserve(
    "full",
    null,
    readPackage(pkg).hash,
    pkg,
    listed,
  );
  record(
    old,
    join(old.root, "development", baseline),
    games,
    pkg,
    true,
    [],
    false,
  );
  pool.settle(baseline, 0, "complete");
  pool.close();
  const service = developmentService(old);
  await service.nominate(baseline);
  service.close();
  const info = await seedRoundTwo(current, old.root);
  assert.equal(info.baselineRunId, baseline);
});
