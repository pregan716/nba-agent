import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureCorpus, BOS, cutoff } from "./fixtures/session/corpus.js";
import { releaseTime } from "../src/env/visibility.js";
import { readPackage, type Package } from "../src/game-loop/package.js";
import { replay, type ReplaySource } from "../src/game-loop/replay.js";
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
    for score in ctx["scores"]:
        assert all(p["actual"]["teamId"] == ctx["teamId"] for p in score["agent"]["players"])
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
      stdoutBytes: 1024 * 1024,
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
    assert.match(read(oversizedRoot)[0].reason, /stdout truncated/);
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
    const timed = await replay({
      ...base,
      root: join(parent, "timeout"),
      games: games.slice(0, 1),
      profile: { usdPerTeamGame: 2, gameUsd: 10, gameMinutes: 0.025 },
      package: {
        ...pkg,
        files: {
          ...pkg.files,
          "main.py": "def run(ctx, arg):\n    while True: pass",
        },
      },
      runAgent: async () => null,
    });
    assert.equal([...timed.scores.values()][0].status, "no_forecast");
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
    for (const s of limited.scores.values())
      if (s.status === "no_forecast") assert.deepEqual(s.agent, s.reference);
  },
);

test("Pi specialist uses the declared model and sandbox tool, streams each turn and settles usage", async (t) => {
  const { createServer } = await import("node:http");
  const { specialists } = await import("../src/game-loop/agents.js");
  let turns = 0;
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
    const events = [
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
  }
  assert.deepEqual(
    charges.map((usd) => Math.round(usd * 1e9)),
    [75000, 75000],
  );
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
