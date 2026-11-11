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
function setup(arm: ForecastArm, image = pin) {
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
    dataSources: source.versions,
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
    outcomes: async (g: (typeof games)[number]) => result(g),
  };
  const model = {
    identity: async () => ({
      version: "fixture",
      source: "fixture",
      image: pin,
    }),
    fit: (i: { gameId: string }) => ({
      modelHash: "fixture",
      forecast: forecast(i.gameId),
    }),
  };
  return {
    config,
    games,
    forecast,
    environment: forecastEnvironment(
      config,
      source,
      projections,
      model,
      () => ({ celtics_spread: -2, game_total: 210 }),
    ),
  };
}

async function twoGames(arm: ForecastArm, image?: string) {
  const { config, games, environment, forecast } = setup(arm, image);
  const base = mkdtempSync(join(tmpdir(), "forecast-arms-"));
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
      else assert.equal(feedback.gameId, games[0].gameId);
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
    assert.equal(phases, 4);
    assert.equal(runner.record.events("forecast_freeze").length, 1);
    assert.equal(runner.record.events("forecast_missing").length, 1);
    assert.equal(runner.record.events("reference_forecast").length, 2);
    assert.equal(runner.record.events("boundary_audit").length, 0);
    assert.deepEqual(
      runner.record.events("game_end").map((e) => e.data.forecastStatus),
      ["frozen", "no_forecast"],
    );
    if (image && arm === "full-memory")
      assert.ok(runner.record.events("session_end").at(-1)!.data.codeBytes > 0);
  } finally {
    runner.close();
    await proxy.close();
    rmSync(base, { recursive: true, force: true });
  }
}
for (const arm of ["no-memory", "full-memory"] as const) {
  test(
    arm + " runs two forecast games with isolated permissions and release",
    () => twoGames(arm),
  );
  test(
    arm + " research sandbox across games",
    { skip: !process.env.FORECAST_SANDBOX_IMAGE },
    () => twoGames(arm, process.env.FORECAST_SANDBOX_IMAGE),
  );
}
test("code cap counts binary bytes and serializes competing writes; notes use the pinned memory counter", async () => {
  const { config } = setup("full-memory");
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
  const { config, games, environment, forecast } = setup("no-memory");
  const base = mkdtempSync(join(tmpdir(), "forecast-pi-"));
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
      new Set(forecastTools("pregame", false).map((t) => t.name)),
    );
    assert.deepEqual(
      new Set(toolsSeen.at(-1)),
      new Set(forecastTools("postgame", false).map((t) => t.name)),
    );
  } finally {
    runner.close();
    await proxy.close();
    rmSync(base, { recursive: true, force: true });
  }
});
