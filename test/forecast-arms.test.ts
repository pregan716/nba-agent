import { execFileSync } from "node:child_process";
import { continuationData } from "../src/runner/continuation.js";
import { RecordStore } from "../src/runner/record.js";
import { forecastReport } from "../src/evaluation/forecast/report.js";
import { markdown } from "../src/evaluation/forecast/markdown.js";
import { recordConsensus } from "../src/evaluation/forecast/capture.js";
import { loadForecastRun } from "../src/evaluation/forecast/records.js";
import { Identities } from "../src/data/identity.js";
import { ExcludedOutcome } from "../src/projection/input.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
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
  pilotThrough?: number,
) {
  const { source, schedule } = fixtureCorpus(false);
  source.odds = async () => {
    throw Error("Player consensus read");
  };
  const games = schedule.slice(0, pilotThrough ? 3 : 2).map((g) => ({
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
    purpose: pilotThrough ? "pilot" : "fixture",
    throughGame: pilotThrough,
    pilotCaps: pilotThrough === 3,
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

function fixtureOdds(games: { gameId: string; tip: string }[]) {
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
  return { ids, odds };
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
        { code: "invalid_input" },
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
      if (image) {
        // Compare what Python can actually read with the public tools at this cutoff.
        const mounted = await call("execute_code", {
          program: `import base64, gzip, json, os
from pathlib import Path
root = Path("/data")
ref = root / "reference"
feedback = root / "feedback.json"
assert os.statvfs(ref).f_flag & os.ST_RDONLY
assert os.statvfs(feedback).f_flag & os.ST_RDONLY
files = {p.relative_to(ref).as_posix(): json.loads(p.read_bytes()) for p in ref.rglob("*") if p.is_file()}
payload = {"reference": files, "feedback": json.loads(feedback.read_bytes())}
print(base64.b64encode(gzip.compress(json.dumps(payload).encode())).decode())`,
        });
        assert.equal(mounted.exit_status, 0, JSON.stringify(mounted));
        assert.equal(mounted.truncated, false);
        const visible = JSON.parse(
          gunzipSync(Buffer.from(mounted.stdout.trim(), "base64")).toString(),
        );
        const expected: Record<string, unknown> = {
          "tonight.json": await call("reference_projection"),
        };
        if (!first) {
          const priorId = games[0].gameId;
          const prior = await call("reference_projection", {
            game_id: priorId,
          });
          assert.equal(prior.errors[0].playerId, "1");
          expected["history/" + priorId + ".json"] = prior;
        }
        assert.deepEqual(visible, {
          reference: expected,
          feedback: await call("read_feedback"),
        });
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
    const { ids, odds } = fixtureOdds(games);
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

test("Pi continues a thinking-only cutoff, freezes the forecast and offers the phase tools", async () => {
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
      assert.equal(request.max_tokens, 32000);
      if (toolsSeen.length === 1) {
        return {
          ...answer,
          stop_reason: "max_tokens",
          usage: { ...answer.usage, output_tokens: 32000 },
          content: [
            {
              type: "thinking",
              thinking: "Preparing the forecast",
              signature: "test",
            },
          ],
        };
      }
      if (toolsSeen.length === 2) {
        assert.ok(names.includes("freeze_forecast"));
        const content = request.messages.at(-1)!.content;
        assert.ok(
          Array.isArray(content) &&
            content.some(
              (b) =>
                b.type === "text" &&
                b.text ===
                  "Your last response reached the output limit before it finished, and nothing in it was acted on. Continue from where you were. Keep your reasoning brief and make your next tool call.",
            ),
        );

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
    assert.equal(config.harness.loop.parameters.maxTokens, 32000);
    assert.deepEqual(
      runner.record
        .events("output_limit_continuation")
        .map((e) => [e.scope, e.data]),
      [[id + ":pregame", { attempt: 1, continuation: 1, outputTokens: 32000 }]],
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

test("pilot continuation preserves the boundary, applies new caps and evaluates a matched range", async () => {
  const base = mkdtempSync(join(tmpdir(), "pilot-continuation-"));
  const image = process.env.FORECAST_SANDBOX_IMAGE;
  const proxy = new MeteringProxy(provider);
  await proxy.listen();
  async function extend(arm: ForecastArm, revision: string, parent: string) {
    const first = setup(arm, join(base, "refs"), image, false, 2);
    const next = setup(arm, join(base, "refs"), image, false, 3);
    next.config.codeRevision = next.config.harness.codeRevision = revision;
    const games = first.games;
    const schedule = [
      ...games.map((g) => ({ gameId: g.gameId, scheduledStart: g.tip })),
      ...Array.from({ length: 79 }, (_, i) => ({
        gameId: "unused-" + i,
        scheduledStart: new Date(Date.UTC(2025, 11, 1 + i, 23)).toISOString(),
      })),
    ];
    const original = manifest(first.config, schedule),
      updated = manifest(next.config, schedule);
    const scored = structuredClone(original);
    scored.config.purpose = "scored";
    assert.throws(() => continuationData(scored, updated), /Incompatible/);
    const { ids, odds } = fixtureOdds(games);
    const runner = new Runner(parent, original, proxy, first.environment);
    const root = runner.root;
    let prefix: string[];
    try {
      assert.throws(() => new RecordStore(root, updated, true), /boundary/);
      await runner.run(async ({ session }) => {
        const ctx = await session.call("context", {});
        if (ctx.phase === "postgame" && ctx.game.game_id === games[1].gameId)
          await session.call("workspace_write", {
            path: "memory/prior",
            content: "from game two",
          });
      });
      await recordConsensus(runner.record, odds, ids);
      prefix = runner.record.events().map((e) => e.hash);
    } finally {
      runner.close();
    }
    for (const change of [
      (c: typeof next.config) => {
        c.purpose = "scored";
      },
      (c: typeof next.config) => {
        c.profile.memory = {
          ...c.profile.memory,
          version: "memory-v1",
        } as typeof c.profile.memory;
      },
      (c: typeof next.config) => {
        c.profile.dataSources[0].manifestSha256 = "d".repeat(64);
      },
      (c: typeof next.config) => {
        c.profile.memory.horizon =
          arm === "full-memory" ? "stateless" : "season";
      },
    ]) {
      const bad = structuredClone(updated);
      change(bad.config);
      assert.throws(() => new RecordStore(root, bad, true), /Incompatible/);
    }
    const open = () =>
      new Runner(parent, updated, proxy, next.environment, undefined, {
        continuePilot: true,
      });
    const continued = open();
    try {
      await assert.rejects(
        recordConsensus(continued.record, odds, ids),
        /finished/,
      );
      assert.throws(() => loadForecastRun(root), /incomplete/i);
      await continued.run(async ({ session }) => {
        const ctx = await session.call("context", {});
        assert.equal(ctx.game.game_id, games[2].gameId);
        if (ctx.phase === "pregame") {
          const feedback = (await session.call(
            "read_feedback" as never,
            {} as never,
          )) as any;
          assert.equal(feedback.gameId, games[1].gameId);
          if (arm === "full-memory") {
            assert.equal(
              (await session.call("workspace_read", { path: "memory/prior" }))
                .content,
              "from game two",
            );
            if (image) {
              const result = await session.call("execute_code", {
                program:
                  "from pathlib import Path\nprint(Path('/workspace/memory/prior').read_text())",
              });
              assert.match(result.stdout, /from game two/);
            }
          }
          for (let i = 0; i < 81; i++)
            await session.call("read_feedback" as never, {} as never);
        }
      });
      assert.deepEqual(
        continued.record.events("session_error").map((e) => e.data.message),
        ["Session limit: tool_calls"],
      );
      const end = continued.record.events(
        "phase_end",
        games[2].gameId + ":pregame",
      )[0];
      assert.equal(end.data.limit, "tool_calls");
      assert.equal(continued.record.events("tool_start", end.scope).length, 80);
      assert.deepEqual(
        continued.record
          .events()
          .slice(0, prefix.length)
          .map((e) => e.hash),
        prefix,
      );
      await recordConsensus(continued.record, odds, ids);
      assert.equal(continued.record.events("evaluator_consensus").length, 3);
      continued.record.verify();
    } finally {
      continued.close();
    }
    assert.throws(() => new RecordStore(root, original), /manifest mismatch/);
    const resumed = open();
    try {
      await resumed.run(async () => {
        throw Error("Game ran twice");
      });
      assert.equal(resumed.record.events("game_end").length, 3);
      assert.equal(resumed.record.events("continuation").length, 1);
      assert.equal(resumed.record.events("continuation_end").length, 1);
    } finally {
      resumed.close();
    }
    const result = loadForecastRun(root, { first: 3, last: 3 });
    assert.deepEqual(
      result.games.map((g) => g.index),
      [3],
    );
    assert.equal(result.configurations[0].budget, "forecast-pilot-caps-v2");
    if (arm === "full-memory") {
      const report = JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--import",
            "tsx",
            "scripts/forecast-evaluate.ts",
            "--json",
            "--games",
            "3-3",
            root,
          ],
          { encoding: "utf8" },
        ),
      );
      assert.deepEqual(report.withFlagged.games, [games[2].gameId]);
      assert.deepEqual(report.records[0].configurations, result.configurations);
    }
    assert.equal(loadForecastRun(root).configurations.length, 2);
    return result;
  }
  try {
    const a = await extend("no-memory", "revision-two", base),
      b = await extend("full-memory", "revision-two", base);
    assert.match(markdown(forecastReport([a, b])), /Games 3–3/);
    const other = await extend(
      "no-memory",
      "different-revision",
      join(base, "different"),
    );
    assert.throws(() => forecastReport([other, b]), /Incompatible/);
  } finally {
    await proxy.close();
    rmSync(base, { recursive: true, force: true });
  }
});

for (const failedPhase of ["pregame", "postgame"] as const) {
  test(`forecast infrastructure failure halts at ${failedPhase} and relaunch resumes there`, async () => {
    const base = mkdtempSync(join(tmpdir(), "forecast-halt-"));
    const { config, games, environment } = setup(
      "full-memory",
      join(base, "reference"),
    );
    const m = manifest(
      config,
      games.map((g) => ({ gameId: g.gameId, scheduledStart: g.tip })),
    );
    let broken = true;
    const proxy = new MeteringProxy({
      ...provider,
      create: async (request, signal) => {
        if (broken) throw Error("fixture provider unavailable");
        return provider.create(request, signal);
      },
    });
    await proxy.listen();
    const open = () => new Runner(base, m, proxy, environment);
    let runner = open();
    const id = games[0].gameId;
    const scope = id + ":" + failedPhase;
    const harness: import("../src/runner/runner.js").Harness = async ({
      session,
      model,
    }) => {
      const ctx = await session.call("context", {});
      if (ctx.game.game_id !== id || ctx.phase !== failedPhase) return;
      const workspace = await session.call("workspace_list", {
        path: "memory",
      });
      assert.equal(workspace.entries.length, 0);
      await session.call("workspace_write", {
        path: "memory/attempt",
        content: "partial",
      });
      const response = await fetch(model.baseURL + "/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": model.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-opus-4-6",
          max_tokens: 32000,
          messages: [{ role: "user", content: "OK?" }],
        }),
      });
      if (!response.ok)
        throw Error(`fixture provider returned ${response.status}`);
    };
    try {
      await assert.rejects(
        runner.run(harness),
        new RegExp("stopped at " + scope),
      );
      assert.equal(runner.record.events("model_error", scope).length, 2);
      assert.deepEqual(
        runner.record.events("session_end", scope).map((e) => e.data.status),
        ["infrastructure_failure", "infrastructure_failure"],
      );
      for (const kind of [
        "forecast_missing",
        "forecast_feedback",
        "game_end",
        "run_end",
      ])
        assert.equal(runner.record.events(kind).length, 0, kind);
      assert.equal(runner.record.events("phase_end", scope).length, 0);
      assert.equal(
        runner.record
          .events("session_start")
          .some((e) => e.scope.startsWith(games[1].gameId + ":")),
        false,
      );
      runner.close();
      broken = false;
      runner = open();
      await runner.run(harness);
      assert.equal(
        runner.record.events("session_end", scope).at(-1)?.data.attempt,
        3,
      );
      assert.equal(
        runner.record.events("phase_end", scope)[0].data.status,
        "completed",
      );
      assert.equal(runner.record.events("game_end").length, 2);
      assert.equal(runner.record.events("forecast_feedback", id).length, 1);
      assert.equal(runner.record.events("forecast_missing", id).length, 1);
      runner.record.verify();
    } finally {
      runner.close();
      await proxy.close();
      rmSync(base, { recursive: true, force: true });
    }
  });
}

test("Pi sees the remaining budget, acts on both thresholds, and freezes the last validated draft", async () => {
  const { piHarness } = await import("../src/harness/pi.js");
  const base = mkdtempSync(join(tmpdir(), "forecast-budget-"));
  const { config, games, environment, forecast } = setup(
    "full-memory",
    join(base, "reference"),
  );
  const id = games[0].gameId;
  config.budget.pregame.tokens = 1000;
  config.budget.postgame.tokens = 500;
  config.budget.warnRemainingTokens = 650;
  const requests: import("@anthropic-ai/sdk/resources/messages").MessageCreateParamsNonStreaming[] =
    [];
  const proxy = new MeteringProxy({
    ...provider,
    create: async (request, signal) => {
      requests.push(structuredClone(request));
      const answer = await provider.create(request, signal);
      const call = (name: string, input: Record<string, unknown>) =>
        ({
          ...answer,
          usage: {
            ...answer.usage,
            input_tokens: 10,
            output_tokens: 180,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_creation: {
              ephemeral_5m_input_tokens: 0,
              ephemeral_1h_input_tokens: 0,
            },
          },
          stop_reason: "tool_use" as const,
          content: [
            {
              type: "tool_use" as const,
              id: "call-" + requests.length,
              name,
              input,
            },
          ],
        }) as typeof answer;
      switch (requests.length) {
        case 1:
          return call("freeze_forecast", {});
        case 2:
          return call("read_feedback", { game_id: "not-allowed" });
        case 3:
          assert.match(
            JSON.stringify(request.messages.at(-1)),
            /Validate and freeze/,
          );
          return call("validate_forecast", { draft: forecast(id) });
        case 4:
          return call("read_feedback", {});
        case 5:
          assert.match(
            JSON.stringify(request.messages.at(-1)),
            /Validate and freeze/,
          );
          return call("freeze_forecast", {});
        default:
          return answer;
      }
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
    const latest = requests.map((r) =>
      JSON.stringify(r.messages.at(-1)?.content),
    );
    assert.match(latest[1], /No draft has passed validation/);
    for (const [i, tokens] of [810, 620, 430, 240, 50].entries())
      assert.match(
        latest[i + 1],
        new RegExp("Remaining token budget: " + tokens),
      );
    assert.doesNotMatch(latest[1], /Budget warning/);
    assert.match(
      latest[2],
      /Budget warning: 620 tokens, \d+ compute seconds and \d+ tool calls remaining\. Validate and freeze/,
    );
    assert.doesNotMatch(latest[3], /Budget warning/);
    assert.match(latest[4], /Budget warning: 240 tokens/);
    assert.doesNotMatch(latest[5], /Budget warning/);
    assert.match(latest[6], /Finish writing memory now/);
    const delivered = runner.record.events("budget_warning_delivered");
    assert.deepEqual(
      delivered.map((e) => [
        e.scope,
        e.data.threshold,
        e.data.remaining.tokens,
      ]),
      [
        [id + ":pregame", 650, 620],
        [id + ":pregame", 325, 240],
        [id + ":postgame", 650, 500],
      ],
    );
    const frozen = runner.record.events("forecast_freeze", id)[0];
    assert.equal(
      JSON.stringify(frozen.data.forecast),
      JSON.stringify(forecast(id)),
    );
    assert.equal(
      runner.record.events("phase_end", id + ":pregame")[0].data.status,
      "completed",
    );
    assert.equal(
      runner.record
        .events("tool_start")
        .filter((e) => e.data.name === "context").length,
      0,
    );
  } finally {
    runner.close();
    await proxy.close();
    rmSync(base, { recursive: true, force: true });
  }
});
