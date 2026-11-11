import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Message,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/messages";
import { manifest, digest, type RunConfig } from "../src/runner/config.js";
import { MeteringProxy, type ModelProvider } from "../src/runner/proxy.js";
import { Runner, type Harness } from "../src/runner/runner.js";
import { sessionEnvironment } from "../src/env/session.js";
import { fixtureCorpus } from "./fixtures/session/corpus.js";
import { piHarness } from "../src/harness/pi.js";
import { harnessConfig } from "../src/harness/version.js";
import { SYSTEM_PROMPT } from "../src/harness/prompts.js";

type Request = MessageCreateParamsNonStreaming;
// Content blocks are loosely typed here so the script does not track SDK block shape churn.
type Step = (request: Request, calls: number) => any[] | "cut" | { cut: any[] };
const usage = {
  input_tokens: 20,
  output_tokens: 10,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_creation: {
    ephemeral_5m_input_tokens: 0,
    ephemeral_1h_input_tokens: 0,
  },
};
let ids = 0;
const use = (name: string, input: unknown) => ({
  type: "tool_use" as const,
  id: `toolu_${++ids}`,
  name,
  input,
});
const textOf = (request: Request, index = 0) => {
  const c = request.messages[index].content;
  return typeof c === "string"
    ? c
    : (c as any[])
        .map((b) =>
          typeof b.text === "string"
            ? b.text
            : typeof b.content === "string"
              ? b.content
              : JSON.stringify(b),
        )
        .join("\n");
};
function scripted(
  steps: Step[],
  seen: Request[] = [],
  usageOverride: Partial<typeof usage> = {},
): ModelProvider {
  let calls = 0;
  return {
    count: async () => 5,
    create: async (request) => {
      assert.doesNotMatch(textOf(request), /dataset_versions/);
      seen.push(structuredClone(request));
      const step = steps[Math.min(calls, steps.length - 1)];
      const produced = step(request, calls++);
      const cut =
        produced === "cut" ||
        (typeof produced === "object" &&
          !Array.isArray(produced) &&
          "cut" in produced);
      const content: any[] =
        produced === "cut"
          ? [{ type: "text", text: "partial", citations: null }]
          : Array.isArray(produced)
            ? produced
            : produced.cut;
      return {
        id: `msg_${calls}`,
        type: "message",
        role: "assistant",
        model: "claude-opus-4-6",
        content,
        stop_reason: cut
          ? "max_tokens"
          : content.some((b) => b.type === "tool_use")
            ? "tool_use"
            : "end_turn",
        stop_sequence: null,
        usage: { ...usage, ...usageOverride },
      } as Message;
    },
  };
}
async function run(
  config: RunConfig,
  provider: ModelProvider,
  harness: Harness,
  corpus = fixtureCorpus(),
) {
  const root = mkdtempSync(join(tmpdir(), "nba-harness-"));
  const proxy = new MeteringProxy(provider);
  await proxy.listen();
  const m = manifest(config, [
    { gameId: corpus.game.gameId, scheduledStart: corpus.game.scheduledStart },
  ]);
  const runner = new Runner(
    root,
    m,
    proxy,
    sessionEnvironment(config, corpus.source),
  );
  try {
    await runner.run(harness);
    return {
      events: runner.record.events(),
      ends: runner.record.events("phase_end").map((e) => e.data),
      errors: runner.record
        .events("session_error")
        .map((e) => String(e.data.message)),
    };
  } finally {
    runner.close();
    await proxy.close();
    rmSync(root, { recursive: true, force: true });
  }
}
function configFor(
  memory: Partial<
    Extract<RunConfig["profile"]["memory"], { version: "memory-v1" }>
  > = {},
  harness: Partial<Parameters<typeof harnessConfig>[0]> = {},
) {
  const f = fixtureCorpus();
  f.config.profile.memory = {
    ...(f.config.profile.memory as Extract<
      RunConfig["profile"]["memory"],
      { version: "memory-v1" }
    >),
    ...memory,
  };
  f.config.harness = harnessConfig({
    implementation: "pi",
    memory: f.config.profile.memory,
    effort: "high",
    thinking: "adaptive",
    sandboxImage: f.config.harness.sandboxImage,
    codeRevision: "test",
    ...harness,
  });
  return f;
}

test("Pi starts fresh phases and records tool calls, results and usage", async () => {
  const f = configFor({ horizon: "season", revision: "editable" });
  const seen: Request[] = [];
  const result = await run(
    f.config,
    scripted(
      [
        () => [
          use("workspace_write", { path: "note.md", content: "remember" }),
        ],
        () => [{ type: "text", text: "done" }],
        (r) => {
          assert.equal(r.messages.length, 1);
          assert.match(textOf(r), /postgame/);
          return [use("workspace_read", { path: "note.md" })];
        },
        () => [{ type: "text", text: "done" }],
      ],
      seen,
    ),
    piHarness({ model: "claude-opus-4-6" }),
    f,
  );
  assert.deepEqual(
    result.events.filter((e) => e.kind === "model_error").map((e) => e.data),
    [],
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.ends.map((e) => e.status),
    ["completed", "completed"],
  );
  assert.equal(seen.length, 4);
  const history = result.events
    .filter((e) => e.kind === "harness_history")
    .at(-1)!.data.history;
  assert.equal(history.settled, true);
  assert.ok(history.messages.some((m: any) => m.role === "toolResult"));
  assert.ok(
    history.messages.some(
      (m: any) => m.role === "assistant" && m.usage.output === 10,
    ),
  );
});

test("Pi excludes host credentials, discovery, builtins, and stateless workspace tools", async () => {
  const f = configFor({ horizon: "stateless" });
  const seen: Request[] = [];
  const originalEnv = process.env;
  const oldCwd = process.cwd();
  const host = mkdtempSync(join(tmpdir(), "nba-pi-host-"));
  const agent = join(host, "agent");
  mkdirSync(agent);
  mkdirSync(join(host, ".pi"));
  writeFileSync(join(host, "AGENTS.md"), "HOST-POISON");
  writeFileSync(
    join(agent, "settings.json"),
    JSON.stringify({ appendSystemPrompt: "HOST-POISON" }),
  );
  writeFileSync(
    join(agent, "auth.json"),
    JSON.stringify({ anthropic: { type: "api_key", key: "HOST-POISON" } }),
  );
  const before = readdirSync(host, { recursive: true }).sort();
  let keyReads = 0;
  const trappedEnv = new Proxy(
    {
      ...originalEnv,
      PI_CODING_AGENT_DIR: agent,
      ANTHROPIC_API_KEY: "real-secret-must-not-be-read",
    },
    {
      get(target, name) {
        if (name === "ANTHROPIC_API_KEY") keyReads++;
        return Reflect.get(target, name);
      },
    },
  );
  try {
    const result = await run(
      f.config,
      scripted(
        [
          () => [
            use("bash", { command: "touch forbidden" }),
            use("workspace_write", { path: "leak", content: "bad" }),
          ],
          () => [{ type: "text", text: "done" }],
        ],
        seen,
      ),
      async (handles) => {
        process.env = trappedEnv;
        process.chdir(host);
        try {
          await piHarness({ model: "claude-opus-4-6" })(handles);
        } finally {
          process.env = originalEnv;
          process.chdir(oldCwd);
        }
      },
      f,
    );
    assert.deepEqual(result.errors, []);
    assert.equal(keyReads, 0);
    assert.deepEqual(readdirSync(host, { recursive: true }).sort(), before);
    assert.equal(readFileSync(join(host, "AGENTS.md"), "utf8"), "HOST-POISON");
    assert.doesNotMatch(JSON.stringify(seen), /HOST-POISON/);
    assert.equal(seen.length, 2);
    const tools = (seen[0].tools as any[]).map((t) => t.name);
    for (const name of [
      "read",
      "write",
      "edit",
      "bash",
      "grep",
      "find",
      "ls",
      "web",
    ])
      assert.ok(!tools.includes(name));
    assert.ok(!tools.some((n) => n.startsWith("workspace_")));
    assert.ok(
      !result.events.some(
        (e) =>
          e.kind === "tool_result" &&
          ["bash", "workspace_write"].includes(e.data.name),
      ),
    );
    assert.doesNotMatch(JSON.stringify(seen), /real-secret-must-not-be-read/);
    assert.equal(
      (seen[0].system as any[])[0].text,
      `${SYSTEM_PROMPT}\n\n${f.config.harness.memoryInstructions}`,
    );
    assert.match(JSON.stringify(seen[1].messages), /not found|allowlist/i);
  } finally {
    process.env = originalEnv;
    process.chdir(oldCwd);
    rmSync(host, { recursive: true, force: true });
  }
});

test("Pi aborts on proxy budget refusal and preserves the recorded limit", async () => {
  const f = configFor({ horizon: "stateless" });
  f.config.budget.pregame.tokens = 1;
  const seen: Request[] = [];
  const result = await run(
    f.config,
    scripted([() => [{ type: "text", text: "unexpected" }]], seen),
    piHarness({ model: "claude-opus-4-6" }),
    f,
  );
  assert.equal(seen.length, 0);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ends[0].status, "budget_exhausted");
  assert.equal(result.ends[0].limit, "tokens");
  assert.equal(
    result.events.filter((e) => e.kind === "harness_history").at(-1)!.data
      .history.stopped,
    true,
  );
});

test("Pi pairs truncated tool calls without executing them", async () => {
  const f = configFor({ horizon: "season", revision: "editable" });
  const seen: Request[] = [];
  const result = await run(
    f.config,
    scripted(
      [
        () => ({
          cut: [
            use("workspace_write", {
              path: "must-not-exist",
              content: "partial",
            }),
          ],
        }),
        () => [{ type: "text", text: "done" }],
      ],
      seen,
    ),
    piHarness({ model: "claude-opus-4-6" }),
    f,
  );
  assert.deepEqual(result.errors, []);
  assert.ok(
    !result.events.some(
      (e) => e.kind === "tool_result" && e.data.name === "workspace_write",
    ),
  );
  const histories = result.events.filter((e) => e.kind === "harness_history");
  const messages = histories[0].data.history.messages;
  const calls = messages.flatMap((m: any) =>
    m.role === "assistant"
      ? m.content.filter((b: any) => b.type === "toolCall")
      : [],
  );
  assert.equal(calls.length, 1);
  for (const call of calls)
    assert.ok(
      messages.some(
        (m: any) =>
          m.role === "toolResult" && m.toolCallId === call.id && m.isError,
      ),
    );
});

test("Pi turn safeguard bounds a model that keeps calling tools", async () => {
  const f = configFor({ horizon: "stateless" });
  const seen: Request[] = [];
  const result = await run(
    f.config,
    scripted([() => [use("context", {})]], seen),
    piHarness({ model: "claude-opus-4-6", loop: { maxTurns: 2 } }),
    f,
  );
  assert.deepEqual(result.errors, []);
  assert.equal(seen.length, 2);
});

test("Pi configuration, package version, and prompt changes alter harness version", () => {
  const f = configFor();
  const original = digest(f.config.harness);
  assert.notEqual(
    original,
    digest({
      ...f.config.harness,
      pi: { ...f.config.harness.pi, packageVersion: "next" },
    }),
  );
  assert.notEqual(
    original,
    digest({
      ...f.config.harness,
      prompts: { ...f.config.harness.prompts, system: "changed" },
    }),
  );
  assert.notEqual(
    original,
    digest(
      harnessConfig({
        memory: f.config.profile.memory,
        effort: "high",
        thinking: "adaptive",
        sandboxImage: f.config.harness.sandboxImage,
        codeRevision: "test",
      }),
    ),
  );
});

test("Pi stops on session tool budget errors without making another model call", async () => {
  const f = configFor({ horizon: "stateless" });
  f.config.budget.pregame.toolCalls = 1; // context is free; the second fetch is refused
  const seen: Request[] = [];
  const result = await run(
    f.config,
    scripted([() => [use("fetch_evidence", { evidence_id: "missing" })]], seen),
    piHarness({ model: "claude-opus-4-6" }),
    f,
  );
  assert.equal(seen.length, 2);
  assert.equal(result.ends[0].status, "budget_exhausted");
  assert.equal(result.ends[0].limit, "tool_calls");
});

test("runner wall timeout closes Pi before finalizing the record", async () => {
  const f = configFor({ horizon: "stateless" });
  f.config.budget.pregame.wallSeconds = 5;
  let aborted = false;
  const result = await run(
    f.config,
    {
      count: async () => 5,
      create: async (_request, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(Error("cancelled"));
            },
            { once: true },
          );
        }),
    },
    piHarness({ model: "claude-opus-4-6" }),
    f,
  );
  assert.equal(aborted, true);
  assert.equal(result.ends[0].status, "budget_exhausted");
  assert.equal(result.ends[0].limit, "wall_clock");
  const history = result.events
    .filter((e) => e.kind === "harness_history")
    .at(-1)!;
  assert.ok(history);
  assert.ok(
    history.seq < result.events.find((e) => e.kind === "session_end")!.seq,
  );
});

test("Pi propagates tool infrastructure failures instead of completing silently", async () => {
  const f = configFor({ horizon: "stateless" });
  const result = await run(
    f.config,
    scripted([() => [use("fetch_evidence", { evidence_id: "missing" })]]),
    async (handles) => {
      await piHarness({ model: "claude-opus-4-6" })({
        ...handles,
        session: {
          ...handles.session,
          call: async (name, args) => {
            if (name === "fetch_evidence")
              throw Error("fixture infrastructure failure");
            return handles.session.call(name, args);
          },
        },
      });
    },
    f,
  );
  assert.equal(result.ends[0].status, "infrastructure_failure");
  assert.ok(
    result.errors.every((e) => e.includes("fixture infrastructure failure")),
  );
});

test("multi-MB Pi history is recorded before session closing events", async () => {
  const f = configFor({ horizon: "stateless" });
  const text = "large-history-".repeat(250_000);
  const result = await run(
    f.config,
    scripted([() => [{ type: "text", text }]]),
    piHarness({ model: "claude-opus-4-6" }),
    f,
  );
  assert.deepEqual(result.errors, []);
  const snapshots = result.events.filter((e) => e.kind === "harness_history");
  const final = snapshots.at(-1)!;
  assert.equal(final?.data.history.settled, true);
  assert.equal(final.data.history.messages.at(-1).content[0].text, text);
  const closing = result.events.find((e) => e.kind === "session_end")!;
  assert.ok(snapshots.every((e) => e.seq < closing.seq));
});

test("late recorder failure rejects Pi completion for a large final snapshot", async () => {
  const f = configFor({ horizon: "stateless" });
  const result = await run(
    f.config,
    scripted([() => [{ type: "text", text: "x".repeat(3_000_000) }]]),
    async (handles) => {
      await piHarness({ model: "claude-opus-4-6" })({
        ...handles,
        session: {
          ...handles.session,
          recordHistory: (history: any) => {
            if (history.settled)
              throw Error("fixture final snapshot write failed");
            handles.session.recordHistory?.(history);
          },
        },
      });
    },
    f,
  );
  assert.equal(result.ends[0].status, "infrastructure_failure");
  assert.ok(result.errors.length > 0);
  assert.ok(
    result.errors.every((error) =>
      error.includes("fixture final snapshot write failed"),
    ),
  );
});
