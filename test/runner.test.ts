import { retryModel, modelError } from "../src/runner/retry.js";
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
import { manifest, digest, type Manifest } from "../src/runner/config.js";
import { RecordStore, snapshot, restore } from "../src/runner/record.js";
import {
  Budget,
  LimitError,
  normalizeUsage,
  tokenTotal,
  chargedInputEstimate,
} from "../src/runner/budget.js";
import { MeteringProxy, type ModelProvider } from "../src/runner/proxy.js";
import {
  Runner,
  type Harness,
  type EnvironmentFactory,
} from "../src/runner/runner.js";
import { checkpoint, restoreCheckpoint } from "../src/runner/sync.js";
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
    assert.deepEqual(
      r.events("manifest")[0].data.config.profile.dataSources,
      m.config.profile.dataSources,
    );
    assert.ok(m.config.profile.dataSources.length > 0);
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
    assert.equal(
      s.runner.record.events("model_error")[0].data.message,
      "private provider details",
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
        readFileSync(
          join(
            root,
            "fixture",
            "r1",
            "blobs",
            r.events("submission")[0].data.value.workspaceChanges[0].sha256,
          ),
          "utf8",
        ),
        "committed memory",
      );
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
      has: async () => false,
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
          has: async () => false,
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
    const index = JSON.parse(readFileSync(join(path, "index.json"), "utf8"));
    await restoreCheckpoint(
      {
        get: async (key) =>
          readFileSync(
            key.includes("/blobs/")
              ? join(s.runner.root, "blobs", key.split("/").at(-1)!)
              : join(path, key.split("/").at(-1)!),
          ),
      },
      `fixture/r1/${index.seq}-${index.head}/index.json`,
      target,
    );
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
      assert.equal("dataset_versions" in context, false);
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
                : mode === "append-only"
                  ? session.call("workspace_delete", { path: "notes.txt" })
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

test("real P3 submissions freeze once, persist clips, expose redacted results and survive reopen", async () => {
  const { sessionEnvironment } = await import("../src/env/session.js");
  const { fixtureCorpus } = await import("./fixtures/session/corpus.js");
  const f = fixtureCorpus();
  const s = await setup(
    f.config,
    provider,
    sessionEnvironment(f.config, f.source),
    [{ gameId: f.game.gameId, scheduledStart: f.game.scheduledStart }],
  );
  let receipt = "",
    postgame = false;
  try {
    await s.runner.run(async ({ session }) => {
      const ctx = await session.call("context", {});
      if (ctx.phase === "postgame") {
        const results = await session.call("read_released_results", {});
        assert.equal(results.games[0].questions[0].agent_p_over, 0.99);
        assert.ok(!JSON.stringify(results).includes("SECRET"));
        await assert.rejects(() => session.call("submit", { answers: [] }), {
          code: "phase_refused",
        });
        postgame = true;
        return;
      }
      const { questions } = await session.call("list_questions", {});
      await session.call("begin_commit", {});
      await assert.rejects(() => session.call("submit", { answers: [] }), {
        code: "validation_failed",
        attemptsRemaining: 2,
      });
      const input = {
        answers: questions.map((q) => ({
          question_id: q.question_id,
          p_over: 2,
          rationale: "SECRET",
        })),
        notes: "SECRET",
      };
      const first = await session.call("submit", input);
      assert.equal(first.attempt, 2);
      assert.equal(first.clips.length, 1);
      receipt = first.receipt;
      assert.deepEqual(await session.call("submit", input), first);
      await assert.rejects(
        () => session.call("submit", { ...input, notes: "changed" }),
        { code: "phase_refused" },
      );
    });
    assert.ok(postgame);
    assert.equal(s.runner.record.events("submission").length, 1);
    assert.equal(s.runner.record.events("submission_attempt").length, 2);
    assert.equal(
      s.runner.record.events("phase_end")[0].data.status,
      "completed",
    );
    s.runner.close();
    const reopened = new RecordStore(s.runner.root, s.m);
    assert.equal(reopened.events("submission")[0].data.receipt, receipt);
    assert.equal(
      reopened.events("submission")[0].data.value.submission.answers[0].p_over,
      0.99,
    );
    reopened.close();
  } finally {
    await s.close();
  }
});

test("third real validation failure persists every problem and never fabricates market answers", async () => {
  const { sessionEnvironment } = await import("../src/env/session.js");
  const { fixtureCorpus } = await import("./fixtures/session/corpus.js");
  const f = fixtureCorpus();
  const s = await setup(
    f.config,
    provider,
    sessionEnvironment(f.config, f.source),
    [{ gameId: f.game.gameId, scheduledStart: f.game.scheduledStart }],
  );
  let checked = false;
  try {
    await s.runner.run(async ({ session }) => {
      if ((await session.call("context", {})).phase === "postgame") {
        const result = await session.call("read_released_results", {});
        assert.equal(result.games[0].questions[0].agent_p_over, null);
        assert.equal(result.games[0].questions[0].score, null);
        checked = true;
        return;
      }
      await session.call("begin_commit", {});
      for (let i = 0; i < 3; i++)
        await assert.rejects(() => session.call("submit", { answers: [] }), {
          code: "validation_failed",
          attemptsRemaining: 2 - i,
        });
      await assert.rejects(() => session.call("submit", { answers: [] }), {
        code: "budget_exhausted",
      });
    });
    assert.ok(checked);
    assert.equal(s.runner.record.events("submission").length, 0);
    const attempts = s.runner.record.events("submission_attempt");
    assert.equal(attempts.length, 3);
    assert.ok(
      attempts[2].data.validation.errors.some((e: string) =>
        e.includes("Missing question_id"),
      ),
    );
    assert.equal(
      s.runner.record.events("phase_end")[0].data.status,
      "invalid_output",
    );
  } finally {
    await s.close();
  }
});

test("real workspace service carries season memory, expires k-window writes and journals checkpoints", async () => {
  const { Workspace, WorkspacePolicy } =
    await import("../src/env/workspace.js");
  for (const horizon of ["season", "window", "stateless"] as const) {
    const config = fixtureConfig(`workspace-${horizon}`);
    config.profile.memory.horizon = horizon;
    if (horizon === "window") config.profile.memory.windowGames = 1;
    const factory: EnvironmentFactory = async (ctx, trusted) => {
      const base = await environment(ctx, trusted);
      let phase: import("../src/env/lifecycle.js").LifecyclePhase | "closed" =
        ctx.phase;
      const w = new Workspace(
        trusted.workspace,
        new WorkspacePolicy(config.profile.memory, () =>
          phase === "initialize" || phase === "checkpoint" ? "closed" : phase,
        ),
        trusted.root,
      );
      return {
        ...base,
        workspaceChanges: () => w.changes(),
        async transition(next, cutoff) {
          await base.transition(next, cutoff);
          phase = next;
        },
        async close() {
          phase = "closed";
          await base.close();
        },
        async call(name, args, signal) {
          const a = args as { path: string; content: string };
          if (name === "workspace_list") return w.list(a.path);
          if (name === "workspace_read") return w.read(a.path);
          if (name.startsWith("workspace_"))
            return w.mutate(
              name.slice(10) as "write" | "append" | "delete",
              a.path,
              Buffer.from(a.content ?? ""),
            );
          return base.call(name, args, signal);
        },
      };
    };
    const s = await setup(config, provider, factory, [
      ...games,
      { gameId: "g3", scheduledStart: "2025-11-05T00:30:00Z" },
    ]);
    const seen: string[] = [];
    try {
      await s.runner.run(async ({ session }) => {
        const ctx = await session.call("context", {});
        if (ctx.phase === "postgame") {
          await session.call("workspace_append", {
            path: "notes",
            content: `post-${ctx.game.game_id};`,
          });
          return;
        }
        if (horizon === "stateless") {
          assert.deepEqual(
            snapshot(s.runner.root, s.runner.workspace).files,
            {},
          );
          await assert.rejects(
            () =>
              session.call("workspace_write", {
                path: "notes",
                content: "forbidden",
              }),
            { code: "memory_mode_refused" },
          );
          seen.push("");
        } else {
          const files = await session.call("workspace_list", {});
          seen.push(
            files.entries.length
              ? (await session.call("workspace_read", { path: "notes" }))
                  .content
              : "",
          );
          await session.call("workspace_append", {
            path: "notes",
            content: `pre-${ctx.game.game_id};`,
          });
        }
        await session.call("begin_commit", {});
        await session.call("submit", { answers: [], notes: "valid" });
      });
      assert.equal(seen.length, 3);
      if (horizon === "stateless") assert.deepEqual(seen, ["", "", ""]);
      else {
        assert.equal(seen[0], "");
        assert.equal(seen[1], "pre-g1;post-g1;");
        assert.equal(
          seen[2],
          horizon === "window"
            ? "pre-g2;post-g2;"
            : "pre-g1;post-g1;pre-g2;post-g2;",
        );
        const ends = s.runner.record.events("session_end");
        assert.equal(ends.length, 6);
        assert.ok(ends.every((e) => e.data.workspaceChanges.length === 1));
        const persisted = [...ends, ...s.runner.record.events("submission")];
        for (const event of persisted) {
          const journal = (
            event.kind === "submission" ? event.data.value : event.data
          ).workspaceChanges;
          assert.equal(Object.hasOwn(journal[0], "content"), false);
          assert.deepEqual(Object.keys(journal[0]).sort(), [
            "operation",
            "path",
            "sha256",
          ]);
          const bytes = readFileSync(
            join(s.runner.root, "blobs", journal[0].sha256),
          );
          assert.equal(
            bytes.toString(),
            `${event.kind === "submission" || event.scope.endsWith(":pregame") ? "pre" : "post"}-${event.scope.split(":")[0]};`,
          );
          assert.ok(
            !JSON.stringify(event.data).includes(bytes.toString("base64")),
          );
        }
        assert.deepEqual(ends[0].data.diff.added, ["notes"]);
        assert.deepEqual(ends[1].data.diff.changed, ["notes"]);
        assert.equal(
          s.runner.record.events("submission")[0].data.value.workspaceChanges
            .length,
          1,
        );
      }
      assert.ok(
        s.runner.record
          .events("session_end")
          .every((e) => e.data.status === "completed"),
      );
    } finally {
      await s.close();
    }
  }
});

test("a manifest without cacheReadWeight keeps its digest, resumes at weight 1, and a weight change is a new run", async () => {
  const legacy = fixtureConfig();
  delete (legacy.budget as any).cacheReadWeight; // as persisted before SPO-814
  const m = manifest(legacy, games);
  assert.ok(!("cacheReadWeight" in m.config.budget)); // parsing inserts nothing
  assert.equal(
    digest(m),
    digest(manifest(JSON.parse(JSON.stringify(legacy)), games)),
  );
  const root = temp();
  try {
    const first = new Runner(root, m, new MeteringProxy(provider), environment);
    const runRoot = first.root;
    first.close();
    // Reopen the persisted run on this code with the saved manifest.
    const store = new RecordStore(runRoot);
    const saved = store.events("manifest")[0].data as Manifest;
    store.close();
    assert.ok(!("cacheReadWeight" in saved.config.budget));
    const proxy = new MeteringProxy({
      count: async () => 100,
      create: async () => {
        const r = structuredClone(sdkMessage);
        r.usage = {
          ...r.usage,
          input_tokens: 0,
          output_tokens: 10,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 0,
          cache_creation: {
            ephemeral_5m_input_tokens: 0,
            ephemeral_1h_input_tokens: 0,
          },
        } as any;
        return r;
      },
    });
    await proxy.listen();
    const resumed = new Runner(root, saved, proxy, environment);
    try {
      const b = new Budget(
        resumed.record,
        "g1:pregame",
        resumed.manifest.config,
        "pregame",
      );
      const client = new Anthropic({
        ...proxy.issue(b, new AbortController().signal),
        maxRetries: 0,
      });
      await client.messages.create({
        model: "x",
        max_tokens: 50,
        messages: [],
      });
      assert.equal(b.totals().tokens, 110); // cache reads at full weight, as before
      assert.equal(
        resumed.record.events("model_request")[0].data.cacheReadWeight,
        1,
      );
    } finally {
      resumed.close();
      await proxy.close();
    }
    // An actual policy change is a different manifest and is refused.
    const changed = fixtureConfig();
    changed.budget.cacheReadWeight = 0.1;
    assert.throws(
      () => new RecordStore(runRoot, manifest(changed, games)),
      /Run manifest mismatch/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cache reads count at the budget profile's weight: charge, preflight estimate, clamp and settlement (SPO-814)", async () => {
  // Game one of pilot-b-1, pregame: 22 calls, nearly all input re-read from cache.
  const gameOne = {
    input: 24,
    output: 18763,
    cacheRead: 2130716,
    cacheWrite: 184153,
    cacheWrite5m: 184153,
    cacheWrite1h: 0,
    reasoning: null,
  };
  assert.equal(tokenTotal(gameOne), 2333656); // full weight: most of a 3M cap
  assert.equal(tokenTotal(gameOne, 0.1), 416012); // price-ratio weight
  assert.equal(chargedInputEstimate(100000, 0, 0.1), 100000); // first call: all new
  assert.equal(chargedInputEstimate(100000, 90000, 0.1), 19000); // growth 10k + 90k cached
  assert.equal(chargedInputEstimate(50000, 90000, 0.1), 5000); // shrunk history: all cached

  const c = fixtureConfig();
  c.budget.cacheReadWeight = 0.1;
  c.budget.pregame.tokens = 1000;
  c.budget.submissionReserve = 100;
  c.budget.warnRemainingTokens = 1;
  const counts = [400, 500];
  const seen: any[] = [];
  let calls = 0;
  const s = await setup(c, {
    count: async () => counts[calls++],
    create: async (r) => {
      seen.push(r);
      const m = structuredClone(sdkMessage);
      m.usage = {
        ...m.usage,
        input_tokens: 0,
        output_tokens: 10,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 0,
        cache_creation: {
          ephemeral_5m_input_tokens: 0,
          ephemeral_1h_input_tokens: 0,
        },
      } as any;
      return m;
    },
  });
  const b = new Budget(s.runner.record, "g1:pregame", s.m.config, "pregame");
  const endpoint = s.proxy.issue(b, new AbortController().signal);
  const client = new Anthropic({ ...endpoint, maxRetries: 0 });
  try {
    await client.messages.create({
      model: "x",
      max_tokens: 2000,
      messages: [],
    });
    // First call: no previous request, 400 charged in full; clamp to 900 - 400.
    assert.equal(seen[0].max_tokens, 500);
    let requests = s.runner.record.events("model_request");
    assert.equal(requests[0].data.chargedEstimate, 400);
    assert.equal(requests[0].data.cacheReadWeight, 0.1);
    // Settled on actual usage: 10 output + 500 cache reads at 0.1.
    assert.equal(b.totals().tokens, 60);
    await client.messages.create({
      model: "x",
      max_tokens: 2000,
      messages: [],
    });
    // Second call: 500 counted, 400 assumed cached (40) plus 100 new; clamp to 840 - 140.
    assert.equal(seen[1].max_tokens, 700);
    requests = s.runner.record.events("model_request");
    assert.equal(requests[1].data.chargedEstimate, 140);
    assert.equal(b.totals().tokens, 120);
    const settlements = s.runner.record.events("settlement");
    assert.deepEqual(
      settlements.map((e) => e.data.tokens),
      [60, 60],
    );
    assert.equal(settlements[1].data.details.usage.cacheRead, 500); // raw counts kept
  } finally {
    await s.close();
  }
});

test("proxy retries transient failures in one reservation, records diagnostics and preserves legacy hashes", async () => {
  const config = fixtureConfig();
  const legacy = manifest(config, games);
  assert.deepEqual(manifest(legacy.config, games), legacy);
  config.recovery = { model: { baseMs: 1, capMs: 2, totalMs: 1000 } };
  assert.equal(manifest(config, games).harnessVersion, legacy.harnessVersion);
  let calls = 0;
  const s = await setup(config, {
    count: provider.count,
    create: async () => {
      if (++calls <= 2)
        throw Object.assign(new Error("overloaded api_key=secret-value"), {
          status: 529,
          error: { type: "overloaded_error" },
          headers: new Headers({ "request-id": "req-123" }),
        });
      return structuredClone(sdkMessage);
    },
  });
  const b = new Budget(s.runner.record, "g1:pregame", s.m.config, "pregame");
  const endpoint = s.proxy.issue(b, new AbortController().signal);
  try {
    const client = new Anthropic({ ...endpoint, maxRetries: 0 });
    await client.messages.create({ model: "x", messages: [], max_tokens: 60 });
    assert.equal(calls, 3);
    assert.equal(s.runner.record.events("reservation").length, 1);
    assert.equal(s.runner.record.events("settlement").length, 1);
    const errors = s.runner.record.events("model_error");
    assert.equal(errors.length, 2);
    assert.ok(
      errors.every(
        (e) =>
          e.data.status === 529 &&
          e.data.type === "overloaded_error" &&
          e.data.requestId === "req-123" &&
          e.data.terminal === false,
      ),
    );
    assert.ok(!JSON.stringify(errors).includes("secret-value"));
    assert.equal(s.runner.record.events("model_response")[0].data.retries, 2);
    assert.equal(b.totals().tokens, 48);
  } finally {
    await s.proxy.revoke(endpoint);
    await s.close();
  }
});

test("proxy does not retry provider limits or client errors", async () => {
  for (const status of [400, 401, 403, 404, 413, 422, 429]) {
    const c = fixtureConfig();
    c.recovery = { model: { baseMs: 1, capMs: 2, totalMs: 30 } };
    let calls = 0;
    const s = await setup(c, {
      count: provider.count,
      create: async () => {
        calls++;
        throw Object.assign(new Error("provider rejected"), { status });
      },
    });
    const b = new Budget(s.runner.record, "g1:pregame", s.m.config, "pregame");
    const endpoint = s.proxy.issue(b, new AbortController().signal);
    try {
      const client = new Anthropic({ ...endpoint, maxRetries: 0 });
      await assert.rejects(
        client.messages.create({ model: "x", messages: [], max_tokens: 40 }),
        /Model request failed/,
      );
      assert.equal(calls, 1);
      assert.equal(b.totals().tokens, 81);
      assert.equal(s.runner.record.events("model_error").length, 1);
    } finally {
      await s.proxy.revoke(endpoint);
      await s.close();
    }
  }
});

test("infrastructure retry rolls back workspace and starts fresh caps while retaining failed charges", async () => {
  const c = fixtureConfig();
  c.budget.pregame.tokens = 110;
  c.budget.submissionReserve = 20;
  let calls = 0;
  const s = await setup(
    c,
    {
      count: provider.count,
      create: async () => {
        if (++calls === 1)
          throw Object.assign(new Error("upstream failed"), { status: 400 });
        return structuredClone(sdkMessage);
      },
    },
    environment,
    [games[0]],
  );
  let attempts = 0;
  try {
    await s.runner.run(async (handles) => {
      const ctx = (await handles.session.call("context", {})) as any;
      if (ctx.phase !== "postgame") {
        attempts++;
        if (attempts === 1)
          writeFileSync(join(s.runner.workspace, "partial"), "discard me");
        else
          assert.throws(() =>
            readFileSync(join(s.runner.workspace, "partial")),
          );
        const b = new Budget(
          s.runner.record,
          "g1:pregame",
          s.m.config,
          "pregame",
        );
        assert.equal(b.remaining().tokens, 90);
        assert.equal(b.stage, "pregame");
        const client = new Anthropic({ ...handles.model, maxRetries: 0 });
        await client.messages.create({
          model: "x",
          messages: [],
          max_tokens: 40,
        });
      }
      await harness(handles);
    });
    const ends = s.runner.record.events("session_end", "g1:pregame");
    assert.deepEqual(
      ends.map((e) => e.data.status),
      ["infrastructure_failure", "completed"],
    );
    assert.deepEqual(
      ends.map((e) => e.data.usage.tokens),
      [81, 48],
    );
    assert.equal(s.runner.record.events("submission", "g1").length, 1);
    assert.equal(
      s.runner.record.events("phase_end", "g1:pregame")[0].data.status,
      "completed",
    );
  } finally {
    await s.close();
  }
});

test("infrastructure session attempts stop at default bound", async () => {
  const s = await setup(fixtureConfig(), provider, environment, [games[0]]);
  try {
    await s.runner.run(async () => {
      throw Error("infrastructure down");
    });
    assert.equal(
      s.runner.record.events("session_start", "g1:pregame").length,
      2,
    );
    assert.equal(
      s.runner.record.events("phase_end", "g1:pregame")[0].data.status,
      "infrastructure_failure",
    );
  } finally {
    await s.close();
  }
});

test("retry window refuses another attempt after a slow failure; cancellation starts no call", async () => {
  const c = fixtureConfig();
  c.recovery = { model: { retries: 10, baseMs: 1, capMs: 1, totalMs: 30 } };
  let calls = 0;
  const errors: any[] = [];
  await assert.rejects(
    retryModel(
      async () => {
        calls++;
        if (calls === 1)
          throw Object.assign(new Error("socket closed"), {
            code: "ECONNRESET",
          });
        await new Promise((resolve) => setTimeout(resolve, 60));
        throw Object.assign(new Error("upstream unavailable"), { status: 503 });
      },
      new AbortController().signal,
      c,
      (e, a, t) => errors.push({ e, a, t }),
    ),
    /upstream unavailable/,
  );
  assert.equal(calls, 2);
  assert.equal(errors.length, 2);
  assert.equal(errors[1].t, true);
  const aborted = new AbortController();
  aborted.abort(new Error("cancelled"));
  await assert.rejects(
    retryModel(
      async () => {
        assert.fail("no provider call after abort");
      },
      aborted.signal,
      c,
      () => {},
    ),
    /cancelled/,
  );
});

test("SDK connection errors without a socket code are retryable", async () => {
  const c = fixtureConfig();
  c.recovery = { model: { baseMs: 1, totalMs: 1000 } };
  let calls = 0;
  const result = await retryModel(
    async () => {
      if (++calls === 1) throw new Anthropic.APIConnectionError({});
      return "ok";
    },
    new AbortController().signal,
    c,
    () => {},
  );
  assert.deepEqual(result, { value: "ok", retries: 1 });
});

test("recovered postgame model errors do not trigger a session re-attempt", async () => {
  const c = fixtureConfig();
  c.recovery = { model: { baseMs: 1, totalMs: 1000 } };
  let calls = 0;
  const s = await setup(
    c,
    {
      count: provider.count,
      create: async () => {
        if (++calls === 1)
          throw Object.assign(new Error("overloaded"), { status: 529 });
        return structuredClone(sdkMessage);
      },
    },
    environment,
    [games[0]],
  );
  try {
    await s.runner.run(async (handles) => {
      const ctx = (await handles.session.call("context", {})) as any;
      if (ctx.phase === "postgame") {
        const client = new Anthropic({ ...handles.model, maxRetries: 0 });
        await client.messages.create({
          model: "x",
          messages: [],
          max_tokens: 40,
        });
      }
      await harness(handles);
    });
    assert.equal(
      s.runner.record.events("session_start", "g1:postgame").length,
      1,
    );
    assert.equal(
      s.runner.record.events("phase_end", "g1:postgame")[0].data.status,
      "completed",
    );
  } finally {
    await s.close();
  }
});

test("upstream diagnostics redact quoted credential fields and SDK keys", () => {
  const error = modelError(
    new Error(
      'failed {"api_key":"sensitive-value"} Authorization: Bearer opaque-token sk-ant-private-key',
    ),
  );
  assert.ok(!JSON.stringify(error).includes("sensitive-value"));
  assert.ok(!JSON.stringify(error).includes("opaque-token"));
  assert.ok(!JSON.stringify(error).includes("sk-ant-private-key"));
});

test("healthy generation outlives the retry window and settles once", async () => {
  const c = fixtureConfig();
  c.recovery = { model: { totalMs: 10, baseMs: 1 } };
  let calls = 0;
  const s = await setup(c, {
    count: provider.count,
    create: async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 60));
      return structuredClone(sdkMessage);
    },
  });
  const b = new Budget(s.runner.record, "g1:pregame", s.m.config, "pregame");
  const endpoint = s.proxy.issue(b, new AbortController().signal);
  try {
    await new Anthropic({ ...endpoint, maxRetries: 0 }).messages.create({
      model: "x",
      messages: [],
      max_tokens: 60,
    });
    assert.equal(calls, 1);
    assert.equal(s.runner.record.events("model_error").length, 0);
    assert.equal(s.runner.record.events("model_response")[0].data.retries, 0);
    assert.equal(s.runner.record.events("reservation").length, 1);
    assert.equal(s.runner.record.events("settlement").length, 1);
    assert.equal(b.totals().tokens, 48);
  } finally {
    await s.proxy.revoke(endpoint);
    await s.close();
  }
});

test("session cancellation still interrupts an in-flight model call", async () => {
  const c = fixtureConfig();
  c.recovery = { model: { totalMs: 1 } };
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = retryModel(
    async () => {
      started();
      return new Promise(() => {});
    },
    controller.signal,
    c,
    () => {},
  );
  await ready;
  controller.abort(new Error("session wall clock"));
  await assert.rejects(pending, /session wall clock/);
});
