import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureCorpus, BOS, cutoff } from "./fixtures/session/corpus.js";
import { stageArtifacts, type Artifacts } from "../src/game-loop/artifacts.js";
import { releaseTime } from "../src/env/visibility.js";
import { readPackage, type Package } from "../src/game-loop/package.js";
import { review } from "../src/evaluation/review/index.js";
import { fixtureReview } from "./review-fixture.js";
import {
  replay as runReplay,
  type ReplaySource,
} from "../src/game-loop/replay.js";
import { RecordStore } from "../src/runner/record.js";
import type { Range } from "../src/projection/forecast.js";

const loop = `def run(ctx, arg):
    import sys
    print("w" * 8192, file=sys.stderr)
    if arg is None:
        return dict(type="agent",name="reader",state=None,input=ctx["artifacts"])
    writes = {"note": ctx["teamId"], "latest": ctx["gameId"]}
    if ctx["teamId"] == "${BOS}":
        writes["private_note"] = "private:" + ctx["teamId"]
    return dict(type="finish",forecast=ctx["reference"],writes=writes)
`;
const pkg: Package = {
  version: "game-loop-v1",
  hypothesis: "A specialist can interpret recent minutes.",
  entry: "main.py",
  training: [],
  files: {
    "main.py": loop,
    "inspect.py": `def run(ctx, args):
    import gzip, pathlib, socket, sys
    print("w" * 8192, file=sys.stderr)
    try:
        sock = socket.socket()
    except PermissionError:
        pass
    else:
        raise AssertionError("socket allowed")
    if ctx["teamId"] != "${BOS}":
        assert "private_note" not in ctx["artifacts"]
    for p in pathlib.Path("/data").rglob("*"):
        if p.is_file() and p.suffix not in (".py",):
            data = gzip.open(p).read() if p.suffix == ".gz" else p.read_bytes()
            if ctx["gameId"] == "current":
                assert b"FUTURE_SECRET" not in data and b"EQUAL_SECRET" not in data
            if ctx["teamId"] != "${BOS}":
                assert b"private:${BOS}" not in data
            assert b"MARKET_SENTINEL" not in data
    assert [s["gameId"] for s in ctx["scores"]] == [r["gameId"] for r in ctx["referenceHistory"]]
    return {"artifacts":ctx["artifacts"],"feedback":ctx["feedback"] is not None,"history":len(ctx["referenceHistory"])}
`,
  },
  agents: {
    reader: {
      model: "claude-sonnet-4-6",
      prompt: "Examine {{team}} in {{game}}.",
      skills: ["Use the research export."],
      tools: {
        inspect: {
          file: "inspect.py",
          description: "Inspect available pregame evidence.",
          parameters: {
            type: "object",
            properties: { value: { type: "integer" } },
            required: ["value"],
            additionalProperties: false,
          },
        },
      },
    },
  },
  artifacts: { note: "team", latest: "league", private_note: "team" },
};
test("package hash covers file contents independent of member order; unknown model and escaping path refused", () => {
  const { hash } = readPackage(pkg);
  assert.equal(
    readPackage({
      ...pkg,
      files: Object.fromEntries(Object.entries(pkg.files).reverse()),
    }).hash,
    hash,
  );
  assert.notEqual(readPackage({ ...pkg, hypothesis: "Other" }).hash, hash);
  assert.throws(() =>
    readPackage({
      ...pkg,
      agents: { reader: { ...pkg.agents.reader, model: "other" } },
    }),
  );
  assert.throws(() => readPackage({ ...pkg, entry: "../main.py" }));
  // A thinking level is part of the configuration: optional, from a fixed
  // list, covered by the hash, and not for Jev.
  const thinking = (level: unknown, model = pkg.agents.reader.model) =>
    readPackage({
      ...pkg,
      agents: { reader: { ...pkg.agents.reader, model, thinking: level } },
    });
  assert.notEqual(thinking("high").hash, hash);
  assert.notEqual(thinking("high").hash, thinking("low").hash);
  assert.throws(() => thinking("max"));
  assert.throws(() => thinking("high", "jev-1.14.0"), /Jev agents/);
});
test("artifact limits count retained UTF-8 JSON values per owner after replacements", () => {
  const declarations: Package["artifacts"] = {
    extra: "team",
    shared: "league",
  };
  const data = "é".repeat(128 * 1024 - 1); // Quotes bring the JSON value to exactly 256 KiB.
  let store: Artifacts = new Map();
  for (let n = 0; n < 4; n++) {
    const t = "team" + n,
      l = "league" + n;
    declarations[t] = "team";
    declarations[l] = "league";
    store = stageArtifacts(store, declarations, BOS, { [t]: data, [l]: data });
  }
  store = stageArtifacts(store, declarations, "other", { extra: data });
  store = stageArtifacts(store, declarations, BOS, {
    team0: data,
    league0: data,
  });
  assert.throws(
    () => stageArtifacts(store, declarations, BOS, { extra: 0 }),
    /per-team limit/,
  );
  assert.throws(
    () => stageArtifacts(store, declarations, BOS, { shared: 0 }),
    /league limit/,
  );
  assert.throws(
    () => stageArtifacts(store, declarations, BOS, { team0: data + "a" }),
    /per-artifact limit/,
  );
  assert.doesNotThrow(() =>
    stageArtifacts(store, declarations, BOS, { extra: 0, team0: "" }),
  );
});
const image = process.env.FORECAST_SANDBOX_IMAGE;
test(
  "two teams replay a week in isolated sandboxes, including simultaneous tips and ablations",
  { skip: !image },
  async (t) => {
    const f = fixtureCorpus();
    const parent = mkdtempSync(join(tmpdir(), "game-loop-"));
    t.after(() => rmSync(parent, { recursive: true, force: true }));
    f.config.harness.sandboxImage = image!;
    Object.assign(f.config.budget.sandbox, {
      stdoutBytes: 16 * 1024,
      memoryBytes: 256 * 1024 * 1024,
    });
    f.records.odds[0].data.secret = "MARKET_SENTINEL";
    f.source.odds = async () => {
      throw Error("Market requested");
    };
    f.history["prior:events"].push({
      ...f.history["prior:events"][0],
      availableAt: cutoff,
      data: { description: "EQUAL_SECRET" },
    });
    const teamB = f.source.teams[1].team_id;
    const games = [
      { gameId: "current", teamId: BOS, tip: cutoff },
      { gameId: "current", teamId: teamB, tip: cutoff },
      { gameId: "future", teamId: teamB, tip: "2025-11-04T23:00:00Z" },
      { gameId: "last", teamId: BOS, tip: "2025-11-08T23:00:00Z" },
    ];
    const range: Range = [0, 1, 2, 3, 4, 5, 6];
    const source: ReplaySource = {
      schedule: [
        ...games,
        { gameId: "fifth", teamId: BOS, tip: "2025-11-10T23:00:00Z" },
      ],
      data: f.source,
      async projection(g) {
        return {
          roster: [{ playerId: "p", inactive: false }],
          reference: {
            gameId: g.gameId,
            version: "forecast-v1",
            players: [
              {
                playerId: "p",
                p_start: 0.3,
                p_play: 0.8,
                minutes: range,
                points: range,
                assists: range,
                rebounds: range,
                fantasy_points: range,
              },
            ],
          },
        };
      },
      async outcomes(g, at) {
        assert.ok(Date.parse(at) >= Date.parse(releaseTime(g.tip)));
        return {
          gameId: g.gameId,
          tip: g.tip,
          release: releaseTime(g.tip),
          season: "2025-26",
          boston: g.teamId === BOS,
          players: [
            {
              teamId: g.teamId,
              playerId: "p",
              played: true,
              starter: false,
              inactive: false,
              minutes: 4,
              points: 2,
              assists: 1,
              rebounds: 0,
              fantasy_points: 4,
            },
          ],
        };
      },
    };
    async function replay(
      options: Omit<Parameters<typeof runReplay>[0], "package"> & {
        package: unknown;
      },
    ) {
      return runReplay({
        ...options,
        package: await review(parent, fixtureReview, options.package),
      });
    }
    const base = {
      config: f.config,
      package: pkg,
      source,
      games: [...games].reverse(),
    };
    const observed: unknown[] = [];
    const root = join(parent, "week");
    const week = await replay({
      ...base,
      root,
      games: [...source.schedule].reverse(),
      runAgent: async (call) => {
        assert.match(call.system, /Use the research export/);
        observed.push(await call.tool("inspect", {}));
        call.transcript({ fixture: "ok" });
        return "done";
      },
    });
    const read = (root: string) => {
      const r = new RecordStore(root);
      try {
        return r.events("team_game").map((e) => e.data);
      } finally {
        r.close();
      }
    };
    assert.deepEqual(
      read(root).map((r) => r.reason),
      [null, null, null, null, null],
    );
    const log = new RecordStore(root);
    try {
      const steps = log.events("sandbox_step");
      assert.deepEqual(
        steps.slice(0, 3).map((e) => e.data.action),
        ["agent", null, "finish"],
      );
      assert.ok(
        steps.every(
          (e) =>
            Buffer.byteLength(e.data.stderr) === 4096 &&
            !e.data.stdoutTruncated,
        ),
      );
    } finally {
      log.close();
    }
    assert.equal(week.usd, 0);
    assert.deepEqual(observed, [
      { artifacts: {}, feedback: false, history: 0 },
      { artifacts: {}, feedback: false, history: 0 },
      {
        artifacts: { latest: "current", note: teamB },
        feedback: true,
        history: 1,
      },
      {
        artifacts: {
          latest: "future",
          note: BOS,
          private_note: "private:" + BOS,
        },
        feedback: true,
        history: 1,
      },
      {
        artifacts: {
          latest: "last",
          note: BOS,
          private_note: "private:" + BOS,
        },
        feedback: true,
        history: 2,
      },
    ]);
    const largeRoot = join(parent, "large-results");
    const players = Array.from({ length: 25 }, (_, n) => String(n));
    const precise = range.map((v) => v + 0.1234567890123456) as Range;
    await replay({
      ...base,
      root: largeRoot,
      games: [games[0], games[3]],
      source: {
        ...source,
        async projection(g) {
          const { reference } = await source.projection(g);
          return {
            roster: players.map((playerId) => ({ playerId, inactive: false })),
            reference: {
              ...reference,
              players: players.map((playerId) => ({
                ...reference.players[0],
                playerId,
                minutes: precise,
                points: precise,
                assists: precise,
                rebounds: precise,
                fantasy_points: precise,
              })),
            },
          };
        },
        async outcomes(g, at) {
          const r = await source.outcomes(g, at);
          return {
            ...r,
            players: players.map((playerId) => ({ ...r.players[0], playerId })),
          };
        },
      },
      package: {
        ...pkg,
        files: {
          "inspect.py": "def run(ctx,args):\n    return 't' * 50000",
          "main.py": `def run(ctx,arg):
    if arg is None:
        return dict(type='agent', name='reader', input='a'*50000, state='s'*50000)
    assert len(arg['state']) == 50000 and arg['reply']['ok']
    size = 100 * 1024 if 'note' not in ctx['artifacts'] else 256 * 1024
    return dict(type='finish',forecast=ctx['reference'],writes={'note':'x'*size})`,
        },
      },
      runAgent: async (call) => {
        assert.equal(String(call.input.task).length, 50000);
        assert.equal(String(await call.tool("inspect", {})).length, 50000);
        return "ok";
      },
    });
    const [success, failure] = read(largeRoot);
    assert.equal(success.reason, null);
    assert.equal(success.frozen.players.length, 25);
    assert.ok(Buffer.byteLength(JSON.stringify(success.frozen)) > 16 * 1024);
    assert.equal(success.artifacts[0].value.length, 100 * 1024);
    assert.equal(failure.frozen, null);
    assert.match(failure.reason, /note exceeds the 256 KiB/);
    assert.deepEqual(failure.artifacts, success.artifacts);
    const largeLog = new RecordStore(largeRoot);
    try {
      assert.equal(largeLog.events("forecast_freeze").length, 1);
    } finally {
      largeLog.close();
    }
    const oversizedRoot = join(parent, "oversized");
    await replay({
      ...base,
      root: oversizedRoot,
      games: games.slice(0, 1),
      package: {
        ...pkg,
        files: {
          ...pkg.files,
          "main.py": 'def run(ctx,arg):\n    return "x" * (1024*1024)',
        },
      },
      runAgent: async () => null,
    });
    assert.match(read(oversizedRoot)[0].reason, /1 MiB step result limit/);
    const off = join(parent, "off");
    let offCalls = 0;
    const ablated = await replay({
      ...base,
      root: off,
      games: [games[0], games[3], games[2]],
      agentsOff: true,
      clearArtifacts: true,
      package: {
        ...pkg,
        files: {
          ...pkg.files,
          "main.py": loop.replace(
            'return dict(type="finish"',
            'assert not ctx["artifacts"] and not arg["reply"]["ok"]\n    if ctx["teamId"] == "' +
              teamB +
              '": return dict(type="finish",forecast=None)\n    return dict(type="finish"',
          ),
        },
      },
      runAgent: async () => {
        offCalls++;
        throw Error("Should never run");
      },
    });
    assert.equal(offCalls, 0);
    assert.ok(read(off)[2].frozen);
    const missing = [...ablated.scores.values()].find(
      (s) => s.status === "no_forecast",
    );
    assert.ok(missing && missing.status === "no_forecast");
    assert.deepEqual(missing.agent, missing.reference);
    assert.ok(read(off)[0].frozen);
    assert.equal(read(off)[1].frozen, null);
    const preparedRoot = join(parent, "slow-preparation");
    const preparationDelay = 1600;
    const waitForSource = () =>
      new Promise((resolve) => setTimeout(resolve, preparationDelay));
    const prepared = await replay({
      ...base,
      root: preparedRoot,
      games: [games[3]],
      profile: { usdPerTeamGame: 2, gameUsd: 10, gameMinutes: 0.025 },
      source: {
        ...source,
        async projection(g) {
          if (g.gameId === games[0].gameId) await waitForSource();
          return source.projection(g);
        },
        data: {
          ...source.data,
          async games() {
            await waitForSource();
            return source.data.games();
          },
        },
      },
      package: {
        ...pkg,
        files: {
          ...pkg.files,
          "main.py":
            "def run(ctx, arg):\n    return dict(type='finish',forecast=ctx['reference'])",
        },
      },
      runAgent: async () => null,
    });
    const [receipt] = read(preparedRoot);
    assert.equal(receipt.reason, null);
    assert.ok(receipt.hostPreparationMs >= 2 * preparationDelay - 5);
    assert.ok(receipt.wallClockMs > 0 && receipt.wallClockMs < 1500);
    const [score] = prepared.scores.values();
    assert.ok(score.status !== "excluded");
    assert.equal(score.wallClockMs, receipt.wallClockMs);

    const timed = await replay({
      ...base,
      root: join(parent, "timeout"),
      games: games.slice(0, 1),
      profile: { usdPerTeamGame: 2, gameUsd: 10, gameMinutes: 0.025 },
      package: {
        ...pkg,
        files: {
          ...pkg.files,
          "main.py": "def run(ctx, arg):\n    import time; time.sleep(5)",
        },
      },
      runAgent: async () => null,
    });
    assert.equal([...timed.scores.values()][0].status, "no_forecast");
    assert.equal(read(join(parent, "timeout"))[0].reason, "wall_clock");
    const perGame = await replay({
      ...base,
      root: join(parent, "safeguard"),
      games: games.slice(0, 2),
      profile: { usdPerTeamGame: 2, gameUsd: 1, gameMinutes: 1 },
      runAgent: async (call) => {
        assert.throws(() => call.reserve(1.01));
        call.reserve(1)(0.5);
        assert.equal(call.remaining(), 0.5);
        return "done";
      },
    });
    assert.equal(perGame.usd, 1);
    const budget = join(parent, "budget");
    const limited = await replay({
      ...base,
      root: budget,
      profile: { usdPerTeamGame: 1, gameUsd: 10, gameMinutes: 1 },
      runAgent: async (call) => {
        call.reserve(4)(4);
        return "done";
      },
    });
    assert.equal(limited.usd, 4);
    assert.deepEqual(
      read(budget).map((r) => r.reason),
      [null, ...Array(3).fill("run_budget_exhausted")],
    );
    assert.ok(
      read(budget)
        .slice(1)
        .every((r) => r.wallClockMs === 0),
    );
    for (const s of limited.scores.values())
      if (s.status === "no_forecast") assert.deepEqual(s.agent, s.reference);

    // SPO-941: without league artifacts each team runs in a lane of its own,
    // and the record holds what the single ordered loop would have written.
    const teamOnly = {
      ...pkg,
      artifacts: { note: "team" },
      files: {
        "main.py": `def run(ctx, arg):
    if arg is None:
        return dict(type="agent",name="reader",state=None,input=ctx["artifacts"])
    seen = ctx["artifacts"].get("note", []) + [ctx["gameId"]]
    return dict(type="finish",forecast=ctx["reference"],writes={"note": seen})`,
        "inspect.py": pkg.files["inspect.py"],
      },
    } satisfies Package;
    async function lanes(name: string, artifacts: Package["artifacts"]) {
      let running = 0,
        peak = 0;
      const seen: unknown[] = [];
      const result = await replay({
        ...base,
        root: join(parent, name),
        games: source.schedule,
        package: { ...teamOnly, artifacts },
        runAgent: async (call) => {
          peak = Math.max(peak, ++running);
          seen.push([call.input.teamId, call.input.gameId, call.input.task]);
          const boston = call.input.teamId === BOS;
          // Boston is slow, so the other team's lane gets ahead of it.
          await new Promise((r) => setTimeout(r, boston ? 1500 : 0));
          call.reserve(0.5)(boston ? 0.25 : 0.125);
          running--;
          return "done";
        },
      });
      const r = new RecordStore(join(parent, name));
      try {
        const timeless = ({
          hostPreparationMs,
          wallClockMs,
          configurationHash,
          ...rest
        }: Record<string, unknown>) => rest;
        return {
          peak,
          usd: result.usd,
          seen: seen.map((x) => JSON.stringify(x)).sort(),
          receipts: r
            .events("team_game")
            .map((e) => [e.scope, timeless(e.data)]),
          scores: r
            .events("game_score")
            .map((e) => [e.scope, timeless(e.data)])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        };
      } finally {
        r.close();
      }
    }
    const { peak: lanePeak, ...laned } = await lanes(
      "lanes",
      teamOnly.artifacts,
    );
    // A declared league artifact, even one never written, keeps one loop.
    const { peak: loopPeak, ...looped } = await lanes("loop", {
      ...teamOnly.artifacts,
      latest: "league",
    });
    assert.equal(lanePeak, 2);
    assert.equal(loopPeak, 1);
    assert.deepEqual(laned, looped);
    assert.equal(laned.usd, 3 * 0.25 + 2 * 0.125);
    assert.deepEqual(
      laned.receipts.map(([scope]) => scope),
      source.schedule.map((g) => JSON.stringify([g.teamId, g.gameId])),
    );
    const last = laned.receipts.at(-1)![1] as { artifacts: unknown };
    assert.deepEqual(last.artifacts, [
      { name: "note", team: BOS, value: ["current", "last", "fifth"] },
      { name: "note", team: teamB, value: ["current", "future"] },
    ]);
    // Clearing artifacts before every game removes the dependence too.
    let cleared = 0,
      clearedPeak = 0;
    await replay({
      ...base,
      root: join(parent, "cleared-lanes"),
      games: source.schedule,
      clearArtifacts: true,
      runAgent: async () => {
        clearedPeak = Math.max(clearedPeak, ++cleared);
        await new Promise((r) => setTimeout(r, 300));
        cleared--;
        return "done";
      },
    });
    assert.equal(clearedPeak, 2);
    assert.ok(
      read(join(parent, "cleared-lanes")).every(
        (r) => r.reason === null && r.artifacts.length <= 3,
      ),
    );
    // A failure in one lane ends the replay and stops the other lane's game.
    let stopped = false;
    await assert.rejects(
      replay({
        ...base,
        root: join(parent, "lane-failure"),
        games: source.schedule,
        package: teamOnly,
        source: {
          ...source,
          async projection(g) {
            if (g.teamId === teamB && g.gameId === "future")
              throw Error("Planted lane failure");
            return source.projection(g);
          },
        },
        runAgent: async (call) => {
          if (call.input.teamId === BOS)
            await new Promise<void>((resolve) =>
              call.signal.addEventListener("abort", () => {
                stopped = true;
                resolve();
              }),
            );
          return "done";
        },
      }),
      /Planted lane failure/,
    );
    assert.ok(stopped);
    assert.deepEqual(
      read(join(parent, "lane-failure")).map((r) => r.reason),
      [],
    );
  },
);

test("Pi specialist uses the declared model and sandbox tool, streams each turn and settles usage", async (t) => {
  const { createServer } = await import("node:http");
  const { specialists } = await import("../src/game-loop/agents.js");
  let turns = 0;
  // When set, the next reply is thinking only, cut off at the output limit.
  let cut = false;
  const requests: any[] = [];
  const slow = process.env.GAME_LOOP_LONG_STREAM === "1";
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.url?.includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"input_tokens":10}');
      return;
    }
    const request = JSON.parse(body);
    requests.push(request);
    const tool = ++turns === 1;
    const thinkingOnly = cut;
    cut = false;
    const events = thinkingOnly
      ? [
          {
            type: "message_start",
            message: {
              id: "fixture",
              model: request.model,
              type: "message",
              role: "assistant",
              content: [],
              usage: { input_tokens: 10, output_tokens: 0 },
              stop_reason: null,
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "", signature: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "weighing" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: "s" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "max_tokens" },
            usage: { output_tokens: 64 },
          },
          { type: "message_stop" },
        ]
      : [
          {
            type: "message_start",
            message: {
              id: "fixture",
              model: request.model,
              type: "message",
              role: "assistant",
              content: [],
              usage: { input_tokens: 10, output_tokens: 0 },
              stop_reason: null,
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: tool
              ? { type: "tool_use", id: "toolu_1", name: "inspect", input: {} }
              : { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: tool
              ? { type: "input_json_delta", partial_json: '{"value":2}' }
              : { type: "text_delta", text: "done" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: tool ? "tool_use" : "end_turn" },
            usage: { output_tokens: 3 },
          },
          { type: "message_stop" },
        ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (slow && tool) {
      res.write(": stream open\n\n");
      const ping = setInterval(() => res.write(": keepalive\n\n"), 15000);
      try {
        await new Promise((resolve) => setTimeout(resolve, 301000));
      } finally {
        clearInterval(ping);
      }
    }
    for (const e of events)
      res.write("event: " + e.type + "\ndata: " + JSON.stringify(e) + "\n\n");
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const agent = specialists({
    anthropic: "fixture",
    anthropicBaseURL: "http://127.0.0.1:" + address.port,
  });
  const charges: number[] = [];
  const tools: unknown[] = [];
  const result = await agent({
    agent: pkg.agents.reader,
    system: "Use inspect.",
    input: { teamId: BOS, gameId: "fixture", task: {} },
    signal: AbortSignal.timeout(slow ? 330000 : 10000),
    remaining: () => 0.001,
    reserve: (estimate) => {
      assert.ok(estimate <= 0.001);
      return (usd) => charges.push(usd);
    },
    transcript() {},
    async tool(name, args) {
      tools.push({ name, args });
      return "tool fixture";
    },
  });
  assert.equal(result, "done");
  assert.deepEqual(tools, [{ name: "inspect", args: { value: 2 } }]);
  assert.equal(requests.length, 2);
  for (const r of requests) {
    assert.ok(r.system.some((block: any) => block.text === "Use inspect."));
    assert.equal(r.tools[0].input_schema.properties.value.type, "integer");
    assert.equal(r.stream, true);
    assert.equal(r.model, pkg.agents.reader.model);
    assert.equal(r.max_tokens, 64);
    // No level declared: thinking is off.
    assert.deepEqual(r.thinking, { type: "disabled" });
  }
  assert.deepEqual(
    charges.map((usd) => Math.round(usd * 1e9)),
    [75000, 75000],
  );
  // A declared level reaches the provider. The reply is still the text only.
  const call = (agentSpec: Package["agents"][string], remaining: number) =>
    agent({
      agent: agentSpec,
      system: "Use inspect.",
      input: { teamId: BOS, gameId: "fixture", task: {} },
      signal: AbortSignal.timeout(10000),
      remaining: () => remaining,
      reserve: () => (usd) => charges.push(usd),
      transcript() {},
      tool: async () => "tool fixture",
    });
  assert.equal(
    await call({ ...pkg.agents.reader, thinking: "medium" }, 0.001),
    "done",
  );
  assert.equal(requests.at(-1).thinking.type, "adaptive");
  assert.equal(requests.at(-1).output_config.effort, "medium");
  // A model with a fixed thinking budget keeps it below the output allowance,
  // and is refused when the balance leaves no room to think.
  const fixed = {
    ...pkg.agents.reader,
    model: "claude-haiku-4-5-20251001" as const,
    thinking: "high" as const,
  };
  assert.equal(await call(fixed, 0.02), "done");
  const sent = requests.at(-1);
  assert.equal(sent.thinking.type, "enabled");
  assert.ok(sent.thinking.budget_tokens >= 1024);
  assert.ok(sent.thinking.budget_tokens < sent.max_tokens);
  const before = requests.length;
  await assert.rejects(call(fixed, 0.001), /Specialist failed|Insufficient/);
  assert.equal(requests.length, before);
  // An agent that spends its whole allowance thinking has not answered: the
  // call fails, after its usage is charged, instead of returning "".
  cut = true;
  const charged = charges.length;
  await assert.rejects(
    call({ ...pkg.agents.reader, thinking: "high" }, 0.001),
    /ran out of output before answering/,
  );
  assert.equal(charges.length, charged + 1);
  assert.equal(Math.round(charges.at(-1)! * 1e9), (10 * 3 + 64 * 15) * 1000);
});

test("Jev receives only the declared instructions, runtime team, task and sandbox tool output", async (t) => {
  const { specialists } = await import("../src/game-loop/agents.js");
  const charges: number[] = [];
  const requests: any[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)));
      if (requests.length === 1)
        return new Response(null, {
          status: 429,
          headers: { "retry-after": "0" },
        });
      return Response.json({
        model: "jev-1.14.0",
        usage: { input_tokens: 50, output_tokens: 3 },
        answers: { plays: "yes" },
      });
    },
  );
  const run = specialists({ typesafe: "fixture" });
  const result = await run({
    agent: { ...pkg.agents.reader, model: "jev-1.14.0" },
    system: "Estimate minutes.",
    input: {
      teamId: BOS,
      gameId: "fixture",
      task: {
        state: "today",
        questions: {
          plays: { type: "choice", criteria: { yes: "plays", no: "rests" } },
        },
      },
    },
    signal: AbortSignal.timeout(1000),
    remaining: () => 1,
    reserve: () => (usd) => charges.push(usd),
    transcript() {},
    async tool(name, args) {
      assert.equal(name, "inspect");
      assert.equal(args, "today");
      return "fixture";
    },
  });
  assert.deepEqual(result, { plays: "yes" });
  assert.equal(requests[0].model, "jev-1.14.0");
  assert.equal(requests[0].questions.plays.instructions, "Estimate minutes.");
  assert.equal(JSON.parse(requests[0].state).evidence.inspect, "fixture");
  assert.deepEqual(
    charges.map((usd) => Math.round(usd * 1e9)),
    [0, 2100],
  );
});
