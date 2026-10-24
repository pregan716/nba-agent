import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import { manifest, digest } from "../src/runner/config.js";
import { RecordStore, snapshot, restore } from "../src/runner/record.js";
import {
  Budget,
  LimitError,
  normalizeUsage,
  tokenTotal,
} from "../src/runner/budget.js";
import { MeteringProxy, type ModelProvider } from "../src/runner/proxy.js";
import {
  Runner,
  type Harness,
  type EnvironmentFactory,
} from "../src/runner/runner.js";
import { checkpoint } from "../src/runner/sync.js";
import {
  fixtureConfig,
  environment,
  provider,
  sdkMessage,
  harness,
} from "./fixtures/runner/support.js";
const games = [
  { gameId: "g1", scheduledStart: "2025-11-01T23:30:00Z" },
  { gameId: "g2", scheduledStart: "2025-11-03T00:30:00Z" },
];
const temp = () => mkdtempSync(join(tmpdir(), "nba-runner-"));
async function setup(
  config = fixtureConfig(),
  model: ModelProvider = provider,
  env: EnvironmentFactory = environment,
  schedule = games,
) {
  const root = temp(),
    m = manifest(config, schedule),
    proxy = new MeteringProxy(model);
  await proxy.listen();
  const runner = new Runner(root, m, proxy, env);
  return {
    root,
    m,
    runner,
    proxy,
    async close() {
      runner.close();
      await proxy.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test("manifest pins all axes/descriptors and chronological 82-game schedule, first ten dev, DST release", () => {
  const schedule = JSON.parse(
    readFileSync("docs/evidence/audit/schedule.json", "utf8"),
  ).map((g: any) => ({ gameId: g.gameId, scheduledStart: g.cutoff }));
  const c = fixtureConfig();
  c.purpose = "pilot";
  const m = manifest(c, schedule.reverse());
  assert.equal(m.games.length, 82);
  assert.equal(m.games.filter((g) => g.development).length, 10);
  assert.deepEqual(m.config, c);
  assert.equal(m.harnessVersion, digest(c.harness));
  assert.equal(
    manifest(fixtureConfig(), games).games[0].release,
    "2025-11-02T14:00:00Z",
  );
  c.harness.prompts.system = "changed";
  assert.notEqual(manifest(c, schedule).harnessVersion, m.harnessVersion);
  assert.throws(() => {
    m.config.budget.pregame.tokens = 1;
  }, TypeError);
  c.purpose = "scored";
  assert.throws(() => manifest(c, schedule), /pilot budget/);
  c.budget.pilotApproved = true;
  c.host = "aws-ec2-ebs";
  c.contaminationProbe = {
    model: "claude-opus-4-6",
    prompt: "outcomes?",
    output: "probe fixture",
    executedAt: "2026-10-24T00:00:00Z",
    tools: [],
  };
  assert.equal(manifest(c, schedule).config.purpose, "scored");
  assert.throws(() => manifest(c, games), /82/);
  assert.throws(
    () => manifest(fixtureConfig(), [games[0], games[0]]),
    /duplicate/,
  );
});
test("record is append-only, hash-verified, manifest-bound and submissions are atomic/idempotent", () => {
  const root = temp(),
    m = manifest(fixtureConfig(), games),
    r = new RecordStore(root, m);
  try {
    const receipt = r.submission("g1", { answers: [1] });
    assert.deepEqual(r.submission("g1", { answers: [1] }), receipt);
    assert.equal(r.events("submission").length, 1);
    assert.throws(() => r.submission("g1", { answers: [2] }), /frozen/);
    assert.throws(() => r.db.exec("UPDATE events SET data='{}'"), /immutable/);
    assert.throws(() => r.db.exec("DELETE FROM events"), /immutable/);
    r.verify();
    assert.throws(
      () => new RecordStore(root, manifest(fixtureConfig("different"), games)),
      /manifest mismatch/,
    );
    r.db.exec(
      "DROP TRIGGER immutable_update; UPDATE events SET data='{}' WHERE kind='submission'",
    );
    assert.throws(() => r.verify(), /hash chain/);
  } finally {
    r.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("proxy works with Anthropic SDK, pins model/effort, records exact usage and revokes scoped keys", async () => {
  let actual: any;
  const s = await setup(fixtureConfig(), {
    count: provider.count,
    create: async (r) => {
      actual = r;
      return structuredClone(sdkMessage);
    },
  });
  const b = new Budget(s.runner.record, "g1:pregame", s.m.config, "pregame"),
    abort = new AbortController();
  const endpoint = s.proxy.issue(b, abort.signal);
  const client = new Anthropic({ ...endpoint, maxRetries: 0 });
  try {
    const result = await client.messages.create({
      model: "other",
      max_tokens: 60,
      messages: [{ role: "user", content: "hello" }],
      thinking: { type: "disabled" },
    });
    assert.equal(actual.model, "claude-opus-4-6");
    assert.deepEqual(actual.output_config, { effort: "high" });
    assert.deepEqual(actual.thinking, { type: "adaptive" });
    assert.deepEqual(result.usage, sdkMessage.usage);
    const usage = normalizeUsage(result.usage);
    assert.equal(tokenTotal(usage), 48);
    assert.equal(usage.reasoning, null);
    assert.equal(b.totals().tokens, 48);
    const recorded = s.runner.record.events("model_response")[0].data;
    assert.deepEqual(recorded.usage, usage);
    assert.equal(recorded.response.id, sdkMessage.id);
    assert.ok(s.runner.record.events("settlement")[0].data.details.usd > 0);
    await assert.rejects(
      () =>
        client.messages.create({
          model: "other",
          max_tokens: 10,
          messages: [],
          tools: [{ type: "web_search_20250305", name: "web_search" }],
        }),
      /Model request failed/,
    );
    await s.proxy.revoke(endpoint);
    await assert.rejects(
      () =>
        client.messages.create({
          model: "other",
          max_tokens: 10,
          messages: [],
        }),
      /Expired session/,
    );
    assert.ok(
      !JSON.stringify(s.runner.record.events()).includes(endpoint.apiKey),
    );
  } finally {
    abort.abort();
    await s.close();
  }
});
test("budget reserves final submission, has no rollover, counts all token classes and uncertain calls", async () => {
  const c = fixtureConfig();
  c.budget.pregame.tokens = 100;
  c.budget.submissionReserve = 30;
  const s = await setup(c);
  try {
    const b = new Budget(s.runner.record, "g1:pregame", s.m.config, "pregame");
    const id = b.reserve(60, 0, "model");
    assert.equal(b.remaining().tokens, 10);
    assert.ok(b.remaining().warning);
    assert.throws(
      () => b.reserve(11, 0, "model"),
      (e: any) => e.limit === "research_tokens",
    );
    b.settle(id, 60, 0, {});
    b.commit();
    assert.equal(b.remaining().tokens, 40);
    assert.equal(
      new Budget(
        s.runner.record,
        "g1:pregame",
        s.m.config,
        "pregame",
      ).remaining().tokens,
      40,
    );
    b.reserve(40, 0, "model");
    assert.equal(b.remaining().tokens, 0);
    assert.throws(() => b.reserve(1, 0, "model"), LimitError);
    assert.equal(
      new Budget(
        s.runner.record,
        "g2:pregame",
        s.m.config,
        "pregame",
      ).remaining().tokens,
      70,
    );
    assert.equal(
      new Budget(
        s.runner.record,
        "g1:postgame",
        s.m.config,
        "postgame",
      ).remaining().tokens,
      500,
    );
  } finally {
    await s.close();
  }
});
test("failed model transport is charged conservatively and cannot spend again concurrently", async () => {
  const s = await setup(fixtureConfig(), {
    count: provider.count,
    create: async () => {
      throw Error("private provider details");
    },
  });
  const budget = new Budget(
      s.runner.record,
      "g1:pregame",
      s.m.config,
      "pregame",
    ),
    endpoint = s.proxy.issue(budget, new AbortController().signal);
  try {
    const client = new Anthropic({ ...endpoint, maxRetries: 0 });
    await assert.rejects(
      () =>
        client.messages.create({ model: "x", messages: [], max_tokens: 40 }),
      /Model request failed/,
    );
    assert.equal(budget.totals().tokens, 81);
    assert.equal(s.runner.record.events("settlement").length, 0);
    assert.ok(
      !JSON.stringify(s.runner.record.events()).includes(
        "private provider details",
      ),
    );
  } finally {
    await s.proxy.revoke(endpoint);
    await s.close();
  }
});
test("runner preserves B workspace, resets A, locks commit and hands harness only scoped handles", async () => {
  for (const horizon of ["season", "stateless"] as const) {
    const s = await setup(fixtureConfig(horizon, horizon));
    const observed: string[] = [];
    try {
      await s.runner.run(async (handles) => {
        assert.deepEqual(Object.keys(handles).sort(), [
          "memoryInstructions",
          "model",
          "session",
        ]);
        assert.deepEqual(Object.keys(handles.session), ["call"]);
        const ctx = (await handles.session.call("context", {})) as any;
        if (ctx.phase === "postgame") {
          await handles.session.call("workspace_write", {
            path: "notes.txt",
            content: `after ${ctx.game.game_id}`,
          });
          return;
        }
        if (horizon === "season")
          observed.push(
            (
              await handles.session.call("workspace_read", {
                path: "notes.txt",
              })
            ).content,
          );
        else
          await assert.rejects(
            () => handles.session.call("workspace_read", { path: "notes.txt" }),
            /disabled/,
          );
        await handles.session.call("begin_commit", {});
        await assert.rejects(
          () =>
            handles.session.call("workspace_write", {
              path: "notes.txt",
              content: "bad",
            }),
          /locked/,
        );
        const r = await handles.session.call("submit", {
          answers: [],
          notes: "valid",
        });
        assert.deepEqual(
          await handles.session.call("submit", { answers: [], notes: "valid" }),
          r,
        );
      });
      assert.equal(s.runner.record.events("submission").length, 2);
      assert.deepEqual(observed, horizon === "season" ? ["", "after g1"] : []);
      assert.equal(
        s.runner.record.events("clock").at(-1)?.data.cutoff,
        "2025-11-03T14:00:00Z",
      );
      const ends = s.runner.record.events("session_end");
      assert.ok(ends.every((e) => e.data.status === "completed"));
      assert.ok(
        s.runner.record
          .events("game_end")
          .every((e) => e.data.development && !e.data.scoringEligible),
      );
      if (horizon === "season")
        assert.deepEqual(ends[1].data.diff.added, ["notes.txt"]);
      await s.runner.run(() => {
        throw Error("Completed session repeated");
      });
    } finally {
      await s.close();
    }
  }
});
test("invalid output, exhaustion and infrastructure failure remain distinct; code records enforce truncation", async () => {
  const cases: { run: Harness; status: string; limit: string | null }[] = [
    {
      run: async ({ session }) => {
        await session.call("begin_commit", {});
        for (let i = 0; i < 4; i++)
          await session.call("submit", { answers: [], notes: "invalid" });
      },
      status: "invalid_output",
      limit: "submission_attempts",
    },
    {
      run: async () => {
        throw Error("fixture failure");
      },
      status: "infrastructure_failure",
      limit: "infrastructure",
    },
    {
      run: async () => {
        await new Promise((r) => setTimeout(r, 100));
      },
      status: "budget_exhausted",
      limit: "wall_clock",
    },
  ];
  for (const c of cases) {
    const config = fixtureConfig();
    config.budget.pregame.wallSeconds = c.limit === "wall_clock" ? 0.03 : 10;
    const s = await setup(config, provider, environment, [games[0]]);
    try {
      await s.runner.run(c.run);
      const end = s.runner.record.events("phase_end", "g1:pregame")[0];
      assert.equal(end.data.status, c.status);
      assert.equal(end.data.limit, c.limit);
    } finally {
      await s.close();
    }
  }
  const s = await setup();
  try {
    await s.runner.run(async ({ session }) => {
      const ctx = (await session.call("context", {})) as any;
      if (ctx.phase === "postgame") return;
      const result = (await session.call("execute_code", {
        program: "a".repeat(500),
      })) as any;
      assert.equal(Buffer.byteLength(result.stdout), 128);
      assert.equal(result.truncated, true);
      await session.call("begin_commit", {});
      await session.call("submit", { answers: [], notes: "valid" });
    });
    const codes = s.runner.record.events("code_start");
    assert.equal(codes.length, 2);
    assert.equal(codes[0].data.program.length, 500);
    assert.equal(
      s.runner.record.events("code_result")[0].data.computeSeconds,
      0.1,
    );
  } finally {
    await s.close();
  }
});
test("SIGKILL after commit resumes from durable receipt and committed workspace, without duplicate submission", async () => {
  const root = temp();
  const child = (mode: string) =>
    new Promise<{ code: number | null; signal: string | null }>(
      (resolve, reject) => {
        const p = spawn(
          process.execPath,
          ["--import", "tsx", "test/fixtures/runner/crash.ts", root, mode],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let err = "";
        p.stderr.on("data", (x) => (err += x));
        p.on("error", reject);
        p.on("exit", (code, signal) => {
          if (code && code !== 0) reject(Error(err));
          else resolve({ code, signal });
        });
      },
    );
  try {
    assert.equal((await child("crash")).signal, "SIGKILL");
    assert.equal((await child("resume")).code, 0);
    const r = new RecordStore(join(root, "fixture", "r1"));
    try {
      assert.equal(r.events("submission").length, 1);
      assert.equal(r.events("submission_attempt").length, 1);
      assert.equal(
        r.events("session_end", "g1:pregame")[0].data.limit,
        "interrupted",
      );
      assert.equal(
        r.events("phase_end", "g1:pregame")[0].data.status,
        "completed",
      );
      assert.equal(
        readFileSync(
          join(root, "fixture", "r1", "workspace", "notes.txt"),
          "utf8",
        ),
        "postgame memory",
      );
      r.verify();
    } finally {
      r.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("checkpoints copy SQLite and blobs and publish index last; failed upload has no marker", async () => {
  const s = await setup();
  try {
    writeFileSync(join(s.runner.workspace, "note"), "one");
    const snap = snapshot(s.runner.root, s.runner.workspace);
    s.runner.record.append("snapshot", "fixture", snap);
    writeFileSync(join(s.runner.workspace, "note"), "two");
    restore(s.runner.root, s.runner.workspace, snap);
    assert.equal(readFileSync(join(s.runner.workspace, "note"), "utf8"), "one");
    const uploaded: { key: string; bytes: Buffer }[] = [];
    const path = await checkpoint(s.runner.record, {
      put: async (key, bytes) => {
        uploaded.push({ key, bytes });
      },
    });
    assert.ok(uploaded.at(-1)?.key.endsWith("/index.json"));
    const copy = new RecordStore(path);
    copy.verify();
    assert.equal(copy.events().length, s.runner.record.events().length);
    copy.close();
    const failed: string[] = [];
    await assert.rejects(
      () =>
        checkpoint(s.runner.record, {
          put: async (key) => {
            failed.push(key);
            if (key.includes("blobs")) throw Error("R2 unavailable");
          },
        }),
      /unavailable/,
    );
    assert.ok(!failed.some((k) => k.endsWith("index.json")));
  } finally {
    await s.close();
  }
});

test("run and replicate directories cannot share state; an active runner cannot be opened twice", async () => {
  const s = await setup();
  let other: Runner | undefined;
  try {
    assert.throws(
      () => new Runner(s.root, s.m, s.proxy, environment),
      /already active/,
    );
    const c = fixtureConfig("fixture", "stateless");
    c.replicateId = "r2";
    other = new Runner(s.root, manifest(c, games), s.proxy, environment);
    writeFileSync(join(s.runner.workspace, "private"), "B knowledge");
    assert.notEqual(other.workspace, s.runner.workspace);
    assert.deepEqual(snapshot(other.root, other.workspace).files, {});
    await other.run(harness);
    assert.deepEqual(snapshot(other.root, other.workspace).files, {});
  } finally {
    other?.close();
    await s.close();
  }
});
test("research exhaustion allows reserve submission while compute/tool limits are explicit", async () => {
  const c = fixtureConfig();
  c.budget.pregame.tokens = 100;
  c.budget.submissionReserve = 30;
  const s = await setup(c, {
    count: async () => 1,
    create: async (r) => ({
      ...sdkMessage,
      usage: {
        ...sdkMessage.usage,
        input_tokens: 1,
        output_tokens: r.max_tokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation: null,
      },
    }),
  });
  try {
    await s.runner.run(async ({ session, model }) => {
      const ctx = (await session.call("context", {})) as any;
      if (ctx.phase === "postgame") return;
      const client = new Anthropic({ ...model, maxRetries: 0 });
      await client.messages.create({
        model: "ignored",
        messages: [],
        max_tokens: 1000,
      });
      await assert.rejects(
        () =>
          client.messages.create({
            model: "ignored",
            messages: [],
            max_tokens: 1,
          }),
        /research_tokens/,
      );
      await session.call("begin_commit", {});
      await client.messages.create({
        model: "ignored",
        messages: [],
        max_tokens: 10,
      });
      await session.call("submit", { answers: [], notes: "valid" });
    });
    assert.equal(s.runner.record.events("submission").length, 2);
    assert.equal(
      s.runner.record.events("limit")[0].data.limit,
      "research_tokens",
    );
    const b = new Budget(s.runner.record, "limits", s.m.config, "pregame");
    assert.throws(
      () => b.reserve(0, 11, "code"),
      (e: any) => e.limit === "compute",
    );
    for (let i = 0; i < 30; i++) b.tool("query", {});
    assert.throws(
      () => b.tool("query", {}),
      (e: any) => e.limit === "tool_calls",
    );
  } finally {
    await s.close();
  }
});
test("proxy refuses concurrent calls and does not allow phase change to spend research against reserve", async () => {
  let release!: () => void;
  const model: ModelProvider = {
    count: provider.count,
    create: async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return structuredClone(sdkMessage);
    },
  };
  const s = await setup(fixtureConfig(), model, environment, [games[0]]);
  try {
    await s.runner.run(async ({ session, model }) => {
      const ctx = (await session.call("context", {})) as any;
      if (ctx.phase === "postgame") return;
      const client = new Anthropic({ ...model, maxRetries: 0 });
      const response = client.messages
        .create({ model: "x", messages: [], max_tokens: 50 })
        .then((r) => r);
      while (!release) await new Promise((r) => setTimeout(r, 1));
      await assert.rejects(
        () => session.call("begin_commit", {}),
        /Wait for the model/,
      );
      await assert.rejects(
        () =>
          client.messages.create({ model: "x", messages: [], max_tokens: 50 }),
        /Concurrent/,
      );
      release();
      await response;
      await session.call("begin_commit", {});
      await session.call("submit", { answers: [], notes: "valid" });
    });
    assert.equal(s.runner.record.events("model_response").length, 1);
  } finally {
    release?.();
    await s.close();
  }
});

test("published checkpoint restores persistent workspace without copying a live workspace directory", async () => {
  const s = await setup();
  let resumed: Runner | undefined;
  try {
    await s.runner.run(harness);
    const path = await checkpoint(s.runner.record);
    const base = temp(),
      target = join(base, "fixture", "r1");
    const { cpSync } = await import("node:fs");
    mkdirSync(target, { recursive: true });
    cpSync(path, target, { recursive: true });
    resumed = new Runner(base, s.m, s.proxy, environment);
    assert.equal(
      readFileSync(join(resumed.workspace, "notes.txt"), "utf8"),
      "reflected g2",
    );
    await resumed.run(() => {
      throw Error("Completed game replayed");
    });
    resumed.close();
    resumed = undefined;
    rmSync(base, { recursive: true, force: true });
  } finally {
    resumed?.close();
    await s.close();
  }
});

test("a crash between session end and phase checkpoint neither reruns the phase nor upgrades failure", async () => {
  const s = await setup(fixtureConfig(), provider, environment, [games[0]]);
  try {
    const before = snapshot(s.runner.root, s.runner.workspace);
    s.runner.record.append("session_start", "g1:pregame", {
      attempt: 1,
      before,
    });
    s.runner.record.append("session_end", "g1:pregame", {
      attempt: 1,
      status: "invalid_output",
      limit: "submission_attempts",
      after: before,
    });
    await s.runner.run(async ({ session }) => {
      const ctx = (await session.call("context", {})) as any;
      assert.equal(ctx.phase, "postgame");
    });
    assert.equal(
      s.runner.record.events("phase_end", "g1:pregame")[0].data.status,
      "invalid_output",
    );
    assert.equal(
      s.runner.record.events("session_start", "g1:pregame").length,
      1,
    );
  } finally {
    await s.close();
  }
});
test("postgame budget stops are recorded even when a harness handles the model error", async () => {
  const s = await setup(
    fixtureConfig(),
    { count: async () => 501, create: provider.create },
    environment,
    [games[0]],
  );
  try {
    await s.runner.run(async (handles) => {
      const ctx = (await handles.session.call("context", {})) as any;
      if (ctx.phase !== "postgame") {
        await harness(handles);
        return;
      }
      const client = new Anthropic({ ...handles.model, maxRetries: 0 });
      await assert.rejects(
        () =>
          client.messages.create({ model: "x", messages: [], max_tokens: 1 }),
        /tokens/,
      );
    });
    assert.equal(
      s.runner.record.events("phase_end", "g1:postgame")[0].data.status,
      "budget_exhausted",
    );
    assert.equal(
      s.runner.record.events("phase_end", "g1:postgame")[0].data.limit,
      "tokens",
    );
  } finally {
    await s.close();
  }
});

test("workspace snapshots preserve nested paths and refuse links to host data", async () => {
  const s = await setup();
  try {
    const { symlinkSync } = await import("node:fs");
    mkdirSync(join(s.runner.workspace, "scripts"));
    writeFileSync(join(s.runner.workspace, "scripts", "model.py"), "print(1)");
    const snap = snapshot(s.runner.root, s.runner.workspace);
    assert.deepEqual(Object.keys(snap.files), ["scripts/model.py"]);
    restore(s.runner.root, s.runner.workspace, snap);
    assert.equal(
      readFileSync(join(s.runner.workspace, "scripts", "model.py"), "utf8"),
      "print(1)",
    );
    symlinkSync(
      join(s.runner.root, "manifest.json"),
      join(s.runner.workspace, "leak"),
    );
    assert.throws(
      () => snapshot(s.runner.root, s.runner.workspace),
      /ordinary files/,
    );
  } finally {
    await s.close();
  }
});

test("resume charges observed attempt time but excludes a long outage and other scopes", async (t) => {
  const s = await setup(fixtureConfig(), provider, environment, [games[0]]);
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date("2026-10-24T00:00:00Z"),
  });
  try {
    const scope = "g1:pregame";
    const before = snapshot(s.runner.root, s.runner.workspace);
    s.runner.record.append("session_start", scope, { attempt: 1, before });
    t.mock.timers.tick(2000);
    s.runner.record.append("tool_result", scope, {
      name: "context",
      result: {},
    });
    t.mock.timers.tick(60 * 60 * 1000);
    s.runner.record.append("diagnostic", "other-scope", {});
    await s.runner.run(harness);
    const attempts = s.runner.record.events("session_end", scope);
    assert.equal(attempts[0].data.status, "infrastructure_failure");
    assert.equal(attempts[0].data.limit, "interrupted");
    assert.equal(attempts[0].data.elapsedMs, 2000);
    assert.equal(attempts[1].data.status, "completed");
    assert.equal(s.runner.record.events("submission", "g1").length, 1);
    assert.equal(
      s.runner.record.events("phase_end", scope)[0].data.status,
      "completed",
    );
  } finally {
    t.mock.timers.reset();
    await s.close();
  }
});

test("runner implements typed SessionTools results and capability groups at every routed boundary", async () => {
  const { SessionError } = await import("../src/env/contract.js");
  const { sessionEnvironment } = await import("../src/env/session.js");
  const { fixtureCorpus } = await import("./fixtures/session/corpus.js");
  const f = fixtureCorpus();
  const clips = [{ question_id: "fixture-q", submitted: 1, clipped_to: 0.99 }];
  const factory = sessionEnvironment(f.config, f.source, {
    async validateSubmission(value) {
      const v = value as { notes?: string };
      return v.notes === "invalid"
        ? {
            ok: false,
            errors: [
              "fixture-q: missing probability",
              "fixture-q: missing rationale",
            ],
          }
        : { ok: true, errors: [], value: { answers: [] }, clips };
    },
    async execute(program) {
      return {
        stdout: program,
        stderr: "",
        exitStatus: 0,
        computeSeconds: 0.1,
        truncated: false,
        limit: null,
      };
    },
  });
  // Later P3d–f methods are trusted fixture implementations; verify delegation
  // still uses the exact public types without making their features part of P3b.
  const routed: Partial<{
    [
      N in import("../src/env/contract.js").ToolName
    ]: import("../src/env/contract.js").ToolResult<N>;
  }> = {
    workspace_list: { entries: [] },
    workspace_read: { path: "notes", content: "", bytes: 0 },
    workspace_write: { path: "notes", bytes: 1 },
    workspace_append: { path: "notes", bytes: 1 },
    workspace_delete: { path: "notes", bytes: 0 },
    read_released_results: { games: [] },
  };
  const env: EnvironmentFactory = async (ctx, trusted) => {
    const base = await factory(ctx, trusted);
    return {
      ...base,
      async call(name, args, signal) {
        return name in routed
          ? routed[name as keyof typeof routed]
          : base.call(name, args, signal);
      },
    };
  };
  const s = await setup(f.config, provider, env, [
    { gameId: f.game.gameId, scheduledStart: f.game.scheduledStart },
  ]);
  let checked = false;
  try {
    await s.runner.run(async ({ session }) => {
      const typed: import("../src/env/contract.js").SessionTools = session;
      const context: import("../src/env/contract.js").ToolResult<"context"> =
        await typed.call("context", {});
      assert.equal(context.game.game_id, "current");
      assert.equal(context.game.game_index, 1);
      assert.deepEqual(
        Object.keys(context.budget).sort(),
        [
          "tokens",
          "compute_seconds",
          "tool_calls",
          "submission_reserve",
          "warning",
        ].sort(),
      );
      assert.equal(context.memory.horizon, "season");
      assert.equal(context.dataset_versions[0].source, "fixture");
      const questions: import("../src/env/contract.js").ToolResult<"list_questions"> =
        await typed.call("list_questions", {});
      assert.equal(questions.questions.length, 1);
      const released: import("../src/env/contract.js").ToolResult<"read_released_results"> =
        await typed.call("read_released_results", {});
      assert.deepEqual(released, { games: [] });
      if (context.phase === "postgame") return;
      const history: import("../src/env/contract.js").ToolResult<"query_game_history"> =
        await typed.call("query_game_history", {
          table: "events",
          game_id: "prior",
        });
      assert.equal(history.total, 2);
      const schedule: import("../src/env/contract.js").ToolResult<"read_schedule_and_injuries"> =
        await typed.call("read_schedule_and_injuries", { game_id: "current" });
      assert.equal(schedule.schedule.length, 1);
      const odds: import("../src/env/contract.js").ToolResult<"query_odds_history"> =
        await typed.call("query_odds_history", {});
      assert.equal(odds.observations.length, 2);
      const search: import("../src/env/contract.js").ToolResult<"search_evidence"> =
        await typed.call("search_evidence", { query: "visible" });
      assert.equal(search.total, 3);
      const fetch: import("../src/env/contract.js").ToolResult<"fetch_evidence"> =
        await typed.call("fetch_evidence", {
          evidence_id: search.items[0].evidence_id,
        });
      assert.equal(fetch.text, "visible");
      assert.equal(fetch.provenance.objects.length, 1);
      const list: import("../src/env/contract.js").ToolResult<"workspace_list"> =
        await typed.call("workspace_list", {});
      assert.deepEqual(list.entries, []);
      const read: import("../src/env/contract.js").ToolResult<"workspace_read"> =
        await typed.call("workspace_read", { path: "notes" });
      assert.equal(read.content, "");
      const write: import("../src/env/contract.js").ToolResult<"workspace_write"> =
        await typed.call("workspace_write", { path: "notes", content: "x" });
      assert.equal(write.bytes, 1);
      const append: import("../src/env/contract.js").ToolResult<"workspace_append"> =
        await typed.call("workspace_append", { path: "notes", content: "x" });
      assert.equal(append.bytes, 1);
      const del: import("../src/env/contract.js").ToolResult<"workspace_delete"> =
        await typed.call("workspace_delete", { path: "notes" });
      assert.equal(del.bytes, 0);
      const code: import("../src/env/contract.js").ToolResult<"execute_code"> =
        await typed.call("execute_code", { program: "print(1)" });
      assert.deepEqual(code, {
        stdout: "print(1)",
        stderr: "",
        exit_status: 0,
        compute_seconds: 0.1,
        truncated: false,
        limit: null,
      });
      await assert.rejects(
        () => typed.call("execute_code", "bad" as never),
        (e) => e instanceof SessionError && e.code === "invalid_input",
      );
      const commit: import("../src/env/contract.js").ToolResult<"begin_commit"> =
        await typed.call("begin_commit", {});
      assert.equal(commit.budget.submission_reserve, 0);
      assert.equal((await typed.call("context", {})).phase, "commit");
      await assert.rejects(
        () => typed.call("query_odds_history", {}),
        (e) => e instanceof SessionError && e.code === "phase_refused",
      );
      await assert.rejects(
        () => typed.call("submit", { answers: [], notes: "invalid" }),
        (e) =>
          e instanceof SessionError &&
          e.code === "validation_failed" &&
          e.attemptsRemaining === 2 &&
          e.problems.length === 2,
      );
      const submission: import("../src/env/contract.js").ToolResult<"submit"> =
        await typed.call("submit", { answers: [] });
      assert.equal(submission.attempt, 2);
      assert.deepEqual(submission.clips, clips);
      assert.equal(typeof submission.receipt, "string");
      assert.deepEqual(await typed.call("submit", { answers: [] }), submission);
      checked = true;
    });
    assert.equal(checked, true);
    assert.ok(
      s.runner.record
        .events("session_end")
        .every((e) => e.data.status === "completed"),
    );
  } finally {
    await s.close();
  }
});

test("runner refusals use SessionError codes for memory, disabled capabilities and tool budget", async () => {
  const { SessionError } = await import("../src/env/contract.js");
  for (const mode of [
    "stateless",
    "append-only",
    "disabled",
    "budget",
  ] as const) {
    const c = fixtureConfig(
      "refusal",
      mode === "stateless" ? "stateless" : "season",
    );
    if (mode === "append-only") c.profile.memory.revision = "append-only";
    if (mode === "disabled") c.profile.capabilities.enabled = ["execute_code"]; // Literal tool names no longer enable capabilities.
    if (mode === "budget") c.budget.pregame.toolCalls = 1;
    const s = await setup(c);
    let checked = 0;
    try {
      await s.runner.run(async ({ session }) => {
        const ctx = await session.call("context", {});
        if (ctx.phase === "postgame") return;
        if (mode === "budget") await session.call("list_questions", {});
        const expected =
          mode === "disabled"
            ? "capability_disabled"
            : mode === "budget"
              ? "budget_exhausted"
              : "memory_mode_refused";
        await assert.rejects(
          () =>
            mode === "disabled"
              ? session.call("execute_code", { program: "pass" })
              : mode === "budget"
                ? session.call("list_questions", {})
                : session.call("workspace_write", {
                    path: "notes.txt",
                    content: "x",
                  }),
          (e) => e instanceof SessionError && e.code === expected,
        );
        await session.call("begin_commit", {});
        await session.call("submit", { answers: [], notes: "valid" });
        checked++;
      });
      assert.equal(checked, 2);
    } finally {
      await s.close();
    }
  }
});
