import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
import { analystHarness, offeredTools } from "../src/harness/loop.js";
import { harnessConfig } from "../src/harness/version.js";
import { MEMORY_INSTRUCTIONS, SYSTEM_PROMPT } from "../src/harness/prompts.js";
import type { ContextResult } from "../src/env/contract.js";

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
const thinking = (s: string) => ({
  type: "thinking" as const,
  thinking: s,
  signature: "sig_" + s.length,
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
/** Every `cache_control` marker in a request, as a path from the request root. */
const cacheMarkers = (value: unknown, path = "$"): string[] => {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value))
    return value.flatMap((v, i) => cacheMarkers(v, `${path}[${i}]`));
  const o = value as Record<string, unknown>;
  return [
    ...("cache_control" in o ? [path] : []),
    ...Object.entries(o).flatMap(([k, v]) => cacheMarkers(v, `${path}.${k}`)),
  ];
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
  memory: Partial<RunConfig["profile"]["memory"]> = {},
  harness: Partial<Parameters<typeof harnessConfig>[0]> = {},
) {
  const f = fixtureCorpus();
  f.config.profile.memory = { ...f.config.profile.memory, ...memory };
  f.config.harness = harnessConfig({
    memory: f.config.profile.memory,
    effort: "high",
    thinking: "adaptive",
    sandboxImage: f.config.harness.sandboxImage,
    codeRevision: "test",
    ...harness,
  });
  return f;
}
test("tool loop preserves thinking, returns tool errors, and starts a fresh postgame conversation", async () => {
  const f = configFor({ horizon: "season", revision: "editable" });
  const seen: Request[] = [];
  const model = scripted(
    [
      () => [
        thinking("inspect"),
        use("fetch_evidence", { evidence_id: "missing" }),
      ],
      (r) => {
        assert.match(textOf(r, 2), /not_found/);
        return [
          use("workspace_write", { path: "note.md", content: "remember" }),
        ];
      },
      () => [{ type: "text", text: "done", citations: null } as any],
      (r) => {
        assert.equal(r.messages.length, 1);
        assert.match(textOf(r), /postgame/);
        return [use("workspace_read", { path: "note.md" })];
      },
      () => [{ type: "text", text: "done", citations: null } as any],
    ],
    seen,
  );
  const result = await run(
    f.config,
    model,
    analystHarness({ model: "claude-opus-4-6" }),
    f,
  );
  assert.deepEqual(
    result.ends.map((e) => e.status),
    ["completed", "completed"],
  );
  assert.equal(seen.length, 5);
  assert.equal((seen[1].messages[1].content as any[])[0].type, "thinking");
  for (const r of seen) assertPaired(r);
});

test("stateless loop offers no workspace, stops normally and skips postgame", async () => {
  const f = configFor({ horizon: "stateless" });
  const seen: Request[] = [];
  const result = await run(
    f.config,
    scripted(
      [() => [{ type: "text", text: "done", citations: null } as any]],
      seen,
    ),
    analystHarness({ model: "claude-opus-4-6" }),
    f,
  );
  assert.deepEqual(
    result.ends.map((e) => e.status),
    ["completed", "skipped"],
  );
  assert.equal(seen.length, 1);
  assert.ok(
    !(seen[0].tools as any[]).some((t) => t.name.startsWith("workspace_")),
  );
});

test("prompt caching places two breakpoints without mutating history and can be disabled", async () => {
  for (const mode of ["ephemeral-5m", "none"] as const) {
    const f = configFor(
      { horizon: "stateless" },
      { loop: { promptCache: mode } },
    );
    const seen: Request[] = [];
    const result = await run(
      f.config,
      scripted(
        [
          () => [use("search_evidence", { query: "visible" })],
          () => [{ type: "text", text: "done", citations: null } as any],
        ],
        seen,
        { cache_read_input_tokens: 15, input_tokens: 5 },
      ),
      analystHarness({ model: "claude-opus-4-6", loop: { promptCache: mode } }),
      f,
    );
    assert.equal(seen.length, 2);
    for (const r of seen) {
      const last = r.messages.length - 1;
      const block = (r.messages[last].content as any[]).length - 1;
      assert.deepEqual(
        cacheMarkers(r),
        mode === "none"
          ? []
          : [
              `$.messages[${last}].content[${block}]`,
              `$.tools[${(r.tools as any[]).length - 1}]`,
            ],
      );
      assert.equal(cacheMarkers(r.messages.slice(0, -1)).length, 0);
    }
    const response = result.events.find((e) => e.kind === "model_response")!;
    assert.equal(response.data.usage.cacheRead, 15);
  }
  assert.notEqual(
    digest(
      configFor({ horizon: "stateless" }, { loop: { promptCache: "none" } })
        .config.harness,
    ),
    digest(configFor({ horizon: "stateless" }).config.harness),
  );
});

test("offeredTools follows phase, capability groups and memory horizon", () => {
  const base = {
    phase: "pregame",
    capabilities: ["game_history", "workspace"],
    memory: { horizon: "season", revision: "editable", process: "voluntary" },
  } as unknown as ContextResult;
  const pre = offeredTools(base);
  assert.ok(
    pre.includes("query_game_history") && pre.includes("workspace_read"),
  );
  assert.ok(!pre.includes("search_evidence") && !pre.includes("execute_code"));
  assert.ok(pre.includes("context"));
  const stateless = offeredTools({
    ...base,
    memory: { ...base.memory, horizon: "stateless" },
  });
  assert.ok(!stateless.some((t) => t.startsWith("workspace_")));
  const post = offeredTools({ ...base, phase: "postgame" });
  assert.ok(post.includes("query_game_history"));
});

test("harness version changes with any prompt, tool definition, loop parameter", () => {
  const f = fixtureCorpus();
  const base = () =>
    harnessConfig({
      memory: f.config.profile.memory,
      effort: "high",
      thinking: "adaptive",
      sandboxImage: f.config.harness.sandboxImage,
      codeRevision: "rev",
    });
  const version = (h: RunConfig["harness"]) =>
    manifest({ ...f.config, harness: h }, [
      { gameId: f.game.gameId, scheduledStart: f.game.scheduledStart },
    ]).harnessVersion;
  const v0 = version(base());
  assert.equal(v0, version(base()));
  assert.equal(v0, digest(base()));
  const prompt = base();
  prompt.prompts.system = SYSTEM_PROMPT + " ";
  assert.notEqual(version(prompt), v0);
  const tool = base();
  (tool.toolDefinitions[0] as any).description += "!";
  assert.notEqual(version(tool), v0);
  assert.notEqual(
    version({ ...base(), loop: { ...base().loop, effort: "low" } }),
    v0,
  );
  assert.ok(
    Object.values(MEMORY_INSTRUCTIONS).every((m) =>
      Object.values(base().prompts).includes(m),
    ),
  );
  assert.equal(base().sdkVersion, f.config.harness.sdkVersion);
});

test("persistent memory instructions name durable working aids; stateless does not", () => {
  const aids = /schema you have learned/;
  for (const name of [
    "season-editable",
    "season-append-only",
    "window",
  ] as const)
    assert.match(MEMORY_INSTRUCTIONS[name], aids, name);
  assert.doesNotMatch(MEMORY_INSTRUCTIONS.stateless, aids);
  // The instruction describes what to keep, never what the schema is.
  for (const m of Object.values(MEMORY_INSTRUCTIONS))
    assert.doesNotMatch(m, /player_box_scores|player_id|nba_data/);
});

/** Reject a conversation in which an assistant tool_use is not answered by a tool_result. */
function assertPaired(request: Request) {
  for (let i = 0; i < request.messages.length; i++) {
    const m = request.messages[i];
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    const uses = (m.content as any[]).filter((b) => b.type === "tool_use");
    if (!uses.length) continue;
    const next = request.messages[i + 1];
    const results =
      next && typeof next.content !== "string"
        ? (next.content as any[])
            .filter((b) => b.type === "tool_result")
            .map((b) => b.tool_use_id)
        : [];
    for (const u of uses)
      assert.ok(
        results.includes(u.id),
        `unmatched tool_use ${u.id} at message ${i}`,
      );
  }
}

test("a tool call cut at max_tokens is retried with a larger allowance, never committed unmatched, then dropped with a nudge", async () => {
  const f = configFor({ horizon: "stateless" });
  // A budget large enough that the proxy's clamp does not bind, so the
  // harness-side max_tokens growth is observable at the provider.
  f.config.budget.pregame.tokens = 1_000_000;
  f.config.budget.warnRemainingTokens = 1_000;
  const seen: Request[] = [];
  const cutCall = () => ({
    cut: [
      { type: "text", text: "let me search", citations: null },
      {
        type: "tool_use",
        id: `toolu_cut_${++ids}`,
        name: "search_evidence",
        input: { query: "visi" },
      },
    ],
  });
  const provider = scripted(
    [
      (r) => {
        assertPaired(r);
        assert.equal(r.max_tokens, 16000);
        assert.equal(r.messages.length, 1);
        return cutCall();
      },
      (r) => {
        assertPaired(r);
        assert.equal(r.max_tokens, 32000); // retry 1, same history
        assert.equal(r.messages.length, 1);
        return cutCall();
      },
      (r) => {
        assertPaired(r);
        assert.equal(r.max_tokens, 64000); // retry 2, ceiling
        assert.equal(r.messages.length, 1);
        return cutCall();
      },
      (r) => {
        // Retries spent: the text survived, the tool_use did not, and a nudge followed.
        assertPaired(r);
        assert.equal(r.messages.length, 3);
        const assistant = r.messages[1].content as any[];
        assert.deepEqual(
          assistant.map((b) => b.type),
          ["text"],
        );
        assert.match(textOf(r, 2), /not executed/);
        return [use("search_evidence", { query: "visible" })];
      },
      (r) => {
        assertPaired(r);
        return [{ type: "text", text: "done", citations: null } as any];
      },
    ],
    seen,
  );
  const result = await run(
    f.config,
    provider,
    analystHarness({ model: "claude-opus-4-6" }),
    f,
  );
  assert.deepEqual(result.errors, []);
  assert.equal(result.ends[0].status, "completed");
  assert.equal(seen.length, 5);
  for (const r of seen) assertPaired(r);
});

test("probe record round-trip: the writer's shape projects to the strict manifest field", async () => {
  const { buildProbeRecord, probeForManifest, PROBE_PROMPT } =
    await import("../src/harness/probe.js");
  const { configSchema } = await import("../src/runner/config.js");
  const f = fixtureCorpus();
  const record = buildProbeRecord({
    model: "claude-opus-4-6",
    prompt: PROBE_PROMPT,
    output: "[UNKNOWN] no regular-season results",
    executedAt: "2026-10-24T22:00:00.000Z",
    usage: { input_tokens: 500, output_tokens: 300 },
    responseModel: "claude-opus-4-6-20260101",
  });
  // The stored file shape (through JSON) fails the strict schema as-is...
  const stored = JSON.parse(JSON.stringify(record));
  assert.throws(
    () => configSchema.parse({ ...f.config, contaminationProbe: stored }),
    /usage|Unrecognized|unrecognized/,
  );
  // ...and passes once projected, keeping exactly the five fields.
  const projected = probeForManifest(stored);
  assert.deepEqual(Object.keys(projected).sort(), [
    "executedAt",
    "model",
    "output",
    "prompt",
    "tools",
  ]);
  const parsed = configSchema.parse({
    ...f.config,
    contaminationProbe: projected,
  });
  assert.equal(parsed.contaminationProbe?.output, record.output);
  assert.throws(
    () => probeForManifest({ ...stored, tools: ["web_search"] }),
    /no tools/,
  );
  assert.throws(
    () => probeForManifest({ ...stored, output: "" }),
    /missing output/,
  );
});
