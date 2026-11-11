import { forecastReport } from "../src/evaluation/forecast/report.js";
import { markdown } from "../src/evaluation/forecast/markdown.js";
import { recordConsensus } from "../src/evaluation/forecast/capture.js";
import { loadForecastRun } from "../src/evaluation/forecast/records.js";
import { Identities } from "../src/data/identity.js";
import { ExcludedOutcome } from "../src/projection/input.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureCorpus, BOS } from "./fixtures/session/corpus.js";
import { provider } from "./fixtures/runner/support.js";
import { forecastEnvironment } from "../src/projection/environment.js";
import {
  forecastProfile,
  type ForecastArm,
} from "../src/projection/profile.js";
import { forecastTools } from "../src/projection/tools.js";
import { releaseTime } from "../src/env/visibility.js";
import {
  Workspace,
  WorkspacePolicy,
  CODE_BYTE_CAP,
} from "../src/env/workspace.js";
import { manifest } from "../src/runner/config.js";
import { Runner } from "../src/runner/runner.js";
import { MeteringProxy } from "../src/runner/proxy.js";
import type { Forecast, Range } from "../src/projection/forecast.js";

const pin = "fixture@sha256:" + "a".repeat(64);
function setup(
  arm: ForecastArm,
  referenceRoot: string,
  image = pin,
  excluded = false,
) {
  const { source, schedule } = fixtureCorpus(false);
  source.odds = async () => {
    throw Error("Player consensus read");
  };
  const games = schedule.slice(0, 2).map((g) => ({
    gameId: g.id,
    tip: String(g.data.scheduled_tipoff),
    season: "2025-26",
    release: releaseTime(g.data.scheduled_tipoff),
    boston: true,
  }));
  const config = forecastProfile({
    arm,
    sandboxImage: image,
    projectionImage: pin,
    runId: "fixture-" + arm,
    replicateId: "r1",
    purpose: "fixture",
    dataSources: [
      ...source.versions,
      {
        source: "odds",
        release: "fixture-odds",
        manifest_sha256: "b".repeat(64),
      },
    ],
  });
  const zero: Range = [0, 0, 0, 0, 0, 0, 0];
  const forecast = (gameId: string): Forecast => ({
    version: "forecast-v1",
    gameId,
    players: [
      {
        playerId: "1",
        p_play: 1,
        p_start: 1,
        minutes: zero,
        points: zero,
        rebounds: zero,
        assists: zero,
        fantasy_points: zero,
      },
    ],
  });
  const result = (g: (typeof games)[number]) => ({
    ...g,
    players: [
      {
        playerId: "1",
        teamId: BOS,
        played: true,
        inactive: false,
        starter: true,
        minutes: 20,
        points: 10,
        rebounds: 2,
        assists: 2,
        fantasy_points: 15,
      },
    ],
  });
  const projections = {
    schedule: games,
    input: async (g: (typeof games)[number]) => ({
      gameId: g.gameId,
      tip: g.tip,
      roster: [{ playerId: "1", inactive: false }],
      history: games.filter((h) => h.tip < g.tip).map(result),
    }),
    outcomes: async (g: (typeof games)[number]) => {
      if (excluded && g === games[0])
        throw new ExcludedOutcome(g.gameId, "incomplete product");
      return result(g);
    },
  };
  let referenceReads = 0;
  const model = {
    identity: async () => {
      referenceReads++;
      return {
        version: "fixture",
        source: "fixture",
        image: pin,
      };
    },
    fit: (i: { gameId: string }) => ({
      modelHash: "fixture",
      forecast: forecast(i.gameId),
    }),
  };
  return {
    config,
    games,
    forecast,
    referenceReads: () => referenceReads,
    environment: forecastEnvironment(
      config,
      {
        ...source,
        versions: [
          ...source.versions,
          {
            source: "odds",
            release: "fixture-odds",
            manifest_sha256: "b".repeat(64),
          },
        ],
      },
      projections,
      model,
      () => ({ celtics_spread: -2, game_total: 210 }),
      referenceRoot,
    ),
  };
}

async function twoGames(arm: ForecastArm, image?: string, excluded = false) {
  const base = mkdtempSync(join(tmpdir(), "forecast-arms-"));
  const { config, games, environment, forecast, referenceReads } = setup(
    arm,
    join(base, "reference"),
    image,
    excluded,
  );
  const proxy = new MeteringProxy(provider);
  await proxy.listen();
  const runner = new Runner(
    base,
    manifest(
      config,
      games.map((g) => ({ gameId: g.gameId, scheduledStart: g.tip })),
    ),
    proxy,
    environment,
  );
  try {
    let phases = 0;
    await runner.run(async ({ session }) => {
      const call = (name: string, args: object = {}) =>
        session.call(name as never, args as never) as Promise<any>;
      const ctx = await call("context"),
        id = ctx.game.game_id;
      const first = id === games[0].gameId;
      phases++;
      assert.deepEqual(ctx.game_lines, { celtics_spread: -2, game_total: 210 });
      for (const t of [
        "validate_package",
        "freeze_package",
        "backtest_package",
        "read_odds",
        "evaluator_consensus",
        "advance",
        "checkpoint",
      ])
        await assert.rejects(call(t), /unavailable/);
      await assert.rejects(
        call("query_game_history", { table: "decision_windows", game_id: id }),
        /Unknown history/,
      );
      await assert.rejects(
        call("read_feedback", { game_id: games[0].gameId }),
        /no arguments/,
      );
      if (arm === "no-memory") {
        for (const t of [
          "workspace_list",
          "workspace_read",
          "workspace_write",
          "workspace_append",
          "workspace_edit",
          "workspace_delete",
        ])
          await assert.rejects(
            call(t, { path: "memory/answer", content: "x" }),
            /unavailable/,
          );
      }
      if (ctx.phase === "postgame") {
        assert.equal((await call("read_feedback")).gameId, id);
        await assert.rejects(
          call("freeze_forecast", { draft: forecast(id) }),
          /unavailable/,
        );
        return;
      }
      const feedback = await call("read_feedback");
      if (first) assert.equal(feedback.status, "unavailable");
      else {
        assert.equal(feedback.gameId, games[0].gameId);
        if (excluded)
          assert.deepEqual(feedback, {
            gameId: games[0].gameId,
            status: "excluded",
            reason: "incomplete product",
          });
      }
      const preparedReads = referenceReads();
      await call("reference_projection", { list: true });
      assert.deepEqual(
        (await call("reference_projection")).forecast,
        forecast(id),
      );
      if (!first)
        assert.equal(
          (await call("reference_projection", { game_id: games[0].gameId }))
            .errors.length,
          1,
        );
      assert.equal(referenceReads(), preparedReads);
      if (arm === "full-memory") {
        assert.deepEqual(
          (await call("workspace_list")).entries.map(
            (e: { path: string }) => e.path,
          ),
          ["code", "memory"],
        );
        if (first)
          await call("workspace_write", {
            path: "memory/note",
            content: "rotations",
          });
        else
          assert.equal(
            (await call("workspace_read", { path: "memory/note" })).content,
            "rotations",
          );
      }
      if (image) {
        const program =
          arm === "full-memory"
            ? first
              ? `import pickle, pathlib
from sklearn.linear_model import LinearRegression
p=pathlib.Path('/workspace/code')
(p/'predict.py').write_text('def predict(model): return model.predict([[3]])[0]')
(p/'model.pkl').write_bytes(pickle.dumps(LinearRegression().fit([[0],[1]],[0,2])))
print('saved')`
              : `import pickle,sys
sys.path.insert(0,'/workspace/code')
from predict import predict
assert round(predict(pickle.load(open('/workspace/code/model.pkl','rb'))))==6
print('loaded')`
            : `from pathlib import Path
assert not Path('/workspace/code').exists() and not Path('/workspace/memory').exists()
assert not Path('/workspace').is_mount()
assert not Path('/scratch/sentinel').exists()
Path('/scratch/sentinel').touch()
print('empty')`;
        const checkExport = `import gzip, pathlib, sqlite3
for shard in pathlib.Path('/data/games').glob('*.sqlite.gz'):
    assert 'decision_windows' not in gzip.decompress(shard.read_bytes()).decode('latin1')
db=sqlite3.connect('file:/data/session.sqlite?mode=ro',uri=True)
names={r[0] for r in db.execute("select name from sqlite_master")}
assert not names.intersection({'odds','prop_consensus','decision_windows','unanchored_substitutions'})
`;
        const out = await call("execute_code", {
          program: checkExport + program,
        });
        assert.equal(out.exit_status, 0, JSON.stringify(out));
        assert.match(out.stdout, /saved|loaded|empty/);
      }
      const bad = await call("freeze_forecast", { draft: {} });
      assert.equal(bad.ok, false);
      assert.ok((await call("validate_forecast", { draft: forecast(id) })).ok);
      if (first) {
        assert.ok((await call("freeze_forecast", { draft: forecast(id) })).ok);
        await assert.rejects(
          call("freeze_forecast", { draft: forecast(id) }),
          /unavailable/,
        );
      }
    });
    assert.deepEqual(
      runner.record.events("session_error").map((e) => e.data.message),
      [],
    );
    assert.equal(phases, arm === "full-memory" ? 4 : 2);
    for (const g of games) {
      const reference = runner.record.events("reference_forecast", g.gameId)[0];
      assert.ok(
        reference.seq <
          runner.record.events("session_start", g.gameId + ":pregame")[0].seq,
      );
      if (arm === "no-memory") {
        assert.equal(
          runner.record.events("session_start", g.gameId + ":postgame").length,
          0,
        );
        assert.equal(
          runner.record.events("phase_end", g.gameId + ":postgame")[0].data
            .status,
          "skipped",
        );
      }
    }
    assert.equal(runner.record.events("forecast_feedback").length, 2);
    assert.equal(runner.record.events("forecast_freeze").length, 1);
    assert.equal(runner.record.events("forecast_missing").length, 1);
    assert.equal(runner.record.events("reference_forecast").length, 2);
    assert.equal(runner.record.events("boundary_audit").length, 0);
    assert.deepEqual(
      runner.record.events("game_end").map((e) => e.data.forecastStatus),
      [excluded ? "excluded" : "frozen", "no_forecast"],
    );
    const ids = new Identities();
    for (const [entity, id] of [
      ...games.map((g) => ["game", g.gameId] as const),
      ["player", "1"] as const,
    ])
      ids.add({
        entity,
        provider: "espn",
        providerId: id,
        canonicalId: id,
        basis: "fixture",
        evidence: [
          { bucket: "sports-nba-data", key: "fixture", sha256: "a".repeat(64) },
        ],
      });
    const odds = {
      version: () => ({
        name: "odds",
        manifest: {
          bucket: "sports-nba-data" as const,
          key: "fixture-odds",
          sha256: "b".repeat(64),
        },
        methodologySha256: "c".repeat(64),
      }),
      auditRows: async () =>
        games.flatMap((g) => {
          const prop = {
            espn_event_id: g.gameId,
            espn_player_id: "1",
            prop_type: "player_points",
            requested_at: g.tip,
            snapshot_kind: "scheduled_start",
            status: "ok",
            probability_basis: "unconditional",
            selected_line: 2,
            p_over: 0.45,
          };
          return [
            prop,
            { ...prop, status: "no_consensus", prop_type: "player_assists" },
            { ...prop, snapshot_kind: "early" },
          ];
        }),
    };
    await recordConsensus(runner.record, odds, ids);
    await recordConsensus(runner.record, odds, ids);
    assert.equal(runner.record.events("evaluator_consensus").length, 2);
    const read = loadForecastRun(runner.root);
    assert.equal(read.excluded.length, Number(excluded));
    assert.equal(read.games.at(-1)?.flagged, true);
    assert.deepEqual(read.games[0].market.props, [
      { playerId: "1", stat: "points", line: 2, market: 0.45 },
    ]);
    assert.equal(read.games[0].market.unavailable, 1);
    if (image && arm === "full-memory")
      assert.ok(runner.record.events("session_end").at(-1)!.data.codeBytes > 0);
    return read;
  } finally {
    runner.close();
    await proxy.close();
    rmSync(base, { recursive: true, force: true });
  }
}
for (const arm of ["no-memory", "full-memory"] as const) {
  test(
    arm + " runs two forecast games with isolated permissions and release",
    async () => {
      await twoGames(arm);
    },
  );
  test(
    arm + " research sandbox across games",
    { skip: !process.env.FORECAST_SANDBOX_IMAGE },
    async () => {
      await twoGames(arm, process.env.FORECAST_SANDBOX_IMAGE);
    },
  );
}
test("code cap counts binary bytes and serializes competing writes; notes use the pinned memory counter", async () => {
  const { config } = setup("full-memory", tmpdir());
  const root = mkdtempSync(join(tmpdir(), "forecast-quota-"));
  const path = join(root, "workspace");
  mkdirSync(path);
  mkdirSync(join(root, "blobs"));
  try {
    const w = new Workspace(
      path,
      new WorkspacePolicy(config.profile.memory, () => "pregame"),
      root,
      undefined,
      async (files) => Object.values(files).join("").length,
    );
    await w.mutate("write", "code/m", Buffer.alloc(CODE_BYTE_CAP - 1, 255));
    const result = await Promise.allSettled([
      w.mutate("append", "code/m", Buffer.from("A")),
      w.mutate("write", "code/second", Buffer.from("B")),
    ]);
    assert.deepEqual(
      result.map((r) => r.status),
      ["fulfilled", "rejected"],
    );
    await w.mutate("write", "code/m", Buffer.from("m"));
    await w.mutate("write", "memory/m", Buffer.alloc(50000, 65));
    await assert.rejects(
      Promise.resolve(w.mutate("append", "memory/m", Buffer.from("x"))),
      /cap exceeded/,
    );
    assert.ok(
      !JSON.stringify(forecastTools("pregame", false)).includes(
        "decision_windows",
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi registers and invokes only the forecast arm's phase tools", async () => {
  const { piHarness } = await import("../src/harness/pi.js");
  const base = mkdtempSync(join(tmpdir(), "forecast-pi-"));
  const { config, games, environment, forecast } = setup(
    "full-memory",
    join(base, "reference"),
  );
  const id = games[0].gameId;
  const toolsSeen: string[][] = [];
  const proxy = new MeteringProxy({
    ...provider,
    create: async (request, signal) => {
      const names = (request.tools ?? []).map((t) =>
        "name" in t ? t.name : "unexpected server tool",
      );
      toolsSeen.push(names);
      const answer = await provider.create(request, signal);
      if (
        names.includes("freeze_forecast") &&
        !request.messages.some((m) => m.role === "assistant")
      ) {
        return {
          ...answer,
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "freeze",
              name: "freeze_forecast",
              input: { draft: forecast(id) },
            },
          ],
        } as typeof answer;
      }
      return answer;
    },
  });
  await proxy.listen();
  const runner = new Runner(
    base,
    manifest(config, [{ gameId: id, scheduledStart: games[0].tip }]),
    proxy,
    environment,
  );
  try {
    await runner.run(piHarness({ model: config.profile.modelRoles.analyst }));
    assert.deepEqual(
      runner.record.events("session_error").map((e) => e.data.message),
      [],
    );
    assert.equal(runner.record.events("forecast_freeze").length, 1);
    assert.equal(runner.record.events("forecast_feedback").length, 1);
    assert.deepEqual(
      new Set(toolsSeen[0]),
      new Set(forecastTools("pregame", true).map((t) => t.name)),
    );
    assert.deepEqual(
      new Set(toolsSeen.at(-1)),
      new Set(forecastTools("postgame", true).map((t) => t.name)),
    );
  } finally {
    runner.close();
    await proxy.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test("excluded current outcomes release a reason and allow the next game", async () => {
  await twoGames("no-memory", undefined, true);
});

test("completed records yield matched curves, flags and refusal of incompatible comparisons", async () => {
  const left = await twoGames("full-memory"),
    right = await twoGames("no-memory");
  assert.throws(
    () => forecastReport([left, { ...right, population: "changed" }]),
    /Incompatible/,
  );
  assert.throws(
    () => forecastReport([left, { ...right, replicate: "unpaired" }]),
    /Unmatched/,
  );
  const report = forecastReport([left, right]);
  assert.equal(report.withFlagged.learningCurves.length, 2);
  assert.equal(report.withoutFlagged.learningCurves.length, 1);
  assert.equal(report.withFlagged.pooled?.metrics["all/market.brier"].delta, 0);
  assert.equal(
    report.withFlagged.againstReference[0].metrics[
      "all/market.blendMinusMarketOnly"
    ].left.weight,
    2,
  );
  assert.equal(
    report.withoutFlagged.againstReference[0].metrics[
      "all/market.blendMinusMarketOnly"
    ].left.mean,
    null,
  );
  assert.match(markdown(report), /Full memory minus no memory/);
  // One game has one losing probability, the other has three perfect ones.
  const uneven = structuredClone(right);
  const first = uneven.games[0].market.props[0];
  first.market = 0;
  uneven.games[1].market.props = (
    ["points", "assists", "rebounds"] as const
  ).map((stat) => ({ ...first, stat, line: 0, market: 1 }));
  const estimate = forecastReport([uneven]).withFlagged.againstReference[0]
    .metrics["all/market.consensusBrier"].left;
  assert.deepEqual(estimate, {
    sum: 1,
    weight: 4,
    mean: 0.25,
    interval90: [0, 1],
  });
});
