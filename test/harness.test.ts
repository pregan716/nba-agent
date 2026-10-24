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
import {
  marketBaseline,
  naiveStatsBaseline,
  randomDeviationBaseline,
} from "../src/harness/baselines.js";
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
  return typeof c === "string" ? c : JSON.stringify(c);
};
const questionIds = (request: Request) => [
  ...new Set(
    [...textOf(request).matchAll(/"question_id": "([^"]+)"/g)].map((m) => m[1]),
  ),
];

/** A scripted model: each pregame/postgame conversation is driven by `steps`. */
function scripted(steps: Step[], seen: Request[] = []): ModelProvider {
  let calls = 0;
  return {
    count: async () => 5,
    create: async (request) => {
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
        usage,
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
      submission: runner.record.events("submission")[0]?.data.value,
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
const neverCalled: ModelProvider = {
  count: async () => {
    throw Error("baseline must not call the model");
  },
  create: async () => {
    throw Error("baseline must not call the model");
  },
};

test("analyst loop: fresh conversation, thinking passthrough, tool errors as results, retry, submit, postgame reflection", async () => {
  const f = configFor({ horizon: "season", revision: "editable" });
  const seen: Request[] = [];
  const provider = scripted(
    [
      (r) => {
        assert.equal(r.messages.length, 1); // no prior history
        assert.equal(r.messages[0].role, "user");
        assert.match(textOf(r), /Question set/);
        return [
          thinking("look at posts"),
          use("search_evidence", { query: "visible" }),
        ];
      },
      (r) => {
        // The thinking block from turn 1 is echoed back verbatim.
        const assistant = r.messages[1].content as any[];
        assert.equal(assistant[0].type, "thinking");
        assert.equal(assistant[0].signature, "sig_13");
        return [use("workspace_write", { path: "notes.md", content: "pre" })];
      },
      () => [use("fetch_evidence", { evidence_id: "does-not-exist" })],
      (r) => {
        const last = r.messages.at(-1)!.content as any[];
        assert.equal(last[0].type, "tool_result");
        assert.equal(last[0].is_error, true);
        assert.match(last[0].content, /not_found/);
        return [use("begin_commit", {})];
      },
      () => [use("submit", { answers: [] })],
      (r) => {
        const last = r.messages.at(-1)!.content as any[];
        assert.match(last[0].content, /validation_failed/);
        assert.match(last[0].content, /"attempts_remaining": 2/);
        return [
          use("submit", {
            answers: questionIds(r).map((id) => ({
              question_id: id,
              p_over: 0.9,
              rationale: "scripted deviation",
            })),
            notes: "n",
          }),
        ];
      },
      // Postgame conversation (fresh) starts here on the next create call.
      (r) => {
        assert.equal(r.messages.length, 1);
        assert.match(textOf(r), /Released results for this game/);
        assert.match(textOf(r), /"phase": "postgame"/);
        return [
          use("workspace_append", { path: "notes.md", content: "\npost" }),
        ];
      },
      () => [{ type: "text", text: "done", citations: null } as any],
    ],
    seen,
  );
  const result = await run(
    f.config,
    provider,
    analystHarness({ model: "claude-opus-4-6" }),
    f,
  );
  assert.deepEqual(
    result.ends.map((e) => e.status),
    ["completed", "completed"],
  );
  assert.equal(result.submission.submission.answers[0].p_over, 0.9);
  assert.equal(seen.length, 8);
  // Pregame offered tools include workspace and both begin_commit and submit; no postgame-only tools.
  const pregameTools = (seen[0].tools as any[]).map((t) => t.name);
  assert.ok(pregameTools.includes("workspace_write"));
  assert.ok(
    pregameTools.includes("begin_commit") && pregameTools.includes("submit"),
  );
  assert.ok(pregameTools.includes("read_released_results"));
  assert.ok(!(seen[6].tools as any[]).map((t) => t.name).includes("submit"));
  // System prompt carries the memory instruction for this configuration.
  assert.match(String(seen[0].system), /persistent, editable/);
  const attempts = result.events.filter((e) => e.kind === "submission_attempt");
  assert.equal(attempts.length, 2);
  assert.equal(result.events.filter((e) => e.kind === "submission").length, 1);
  const postEnd = result.events.filter((e) => e.kind === "session_end").at(-1)!;
  assert.deepEqual(postEnd.data.diff.changed, ["notes.md"]);
});

test("stateless analyst: no workspace tools offered, every pregame starts from one user message, postgame skipped", async () => {
  const f = configFor({ horizon: "stateless" });
  const seen: Request[] = [];
  const provider = scripted(
    [
      (r) => {
        assert.equal(r.messages.length, 1);
        assert.match(String(r.system), /stateless/);
        return [use("begin_commit", {})];
      },
      (r) => [
        use("submit", {
          answers: questionIds(r).map((id) => ({
            question_id: id,
            p_over: 0.5,
          })),
        }),
      ],
    ],
    seen,
  );
  const result = await run(
    f.config,
    provider,
    analystHarness({ model: "claude-opus-4-6" }),
    f,
  );
  assert.deepEqual(
    result.ends.map((e) => e.status),
    ["completed", "skipped"],
  );
  assert.ok(
    !(seen[0].tools as any[]).some((t) => t.name.startsWith("workspace_")),
  );
  assert.equal(seen.length, 2);
});

test("research exhaustion: the harness commits on the model's behalf and the submission comes from the reserve", async () => {
  const f = configFor({ horizon: "stateless" });
  f.config.budget.pregame.tokens = 1000;
  f.config.budget.submissionReserve = 300;
  let counts = 0;
  const seen: Request[] = [];
  const base = scripted(
    [
      (r) => {
        assert.match(textOf(r, r.messages.length - 1), /entered commit/);
        return [
          use("submit", {
            answers: questionIds(r).map((id) => ({
              question_id: id,
              p_over: 0.5,
            })),
          }),
        ];
      },
    ],
    seen,
  );
  const provider: ModelProvider = {
    // First preflight count exceeds the research allowance (700); later ones fit.
    count: async () => (counts++ === 0 ? 900 : 50),
    create: base.create,
  };
  const result = await run(
    f.config,
    provider,
    analystHarness({ model: "claude-opus-4-6" }),
    f,
  );
  assert.equal(result.ends[0].status, "completed");
  assert.ok(
    result.events.some(
      (e) => e.kind === "limit" && e.data.limit === "research_tokens",
    ),
  );
  assert.ok(result.events.some((e) => e.kind === "commit"));
  assert.equal(seen.length, 1);
});

test("max_tokens cut and end_turn without submission are nudged; silence ends as invalid_output without market filling", async () => {
  const f = configFor({ horizon: "stateless" });
  const seen: Request[] = [];
  const provider = scripted(
    [
      () => "cut",
      (r) => {
        assert.match(textOf(r, r.messages.length - 1), /cut off/);
        return [
          { type: "text", text: "thinking out loud", citations: null } as any,
        ];
      },
      (r) => {
        assert.match(textOf(r, r.messages.length - 1), /not submitted/);
        return [
          { type: "text", text: "still nothing", citations: null } as any,
        ];
      },
      () => [{ type: "text", text: "nothing", citations: null } as any],
    ],
    seen,
  );
  const result = await run(
    f.config,
    provider,
    analystHarness({ model: "claude-opus-4-6", loop: { nudges: 2 } }),
    f,
  );
  assert.equal(result.ends[0].status, "invalid_output");
  assert.equal(result.ends[0].limit, "submission_attempts");
  assert.equal(result.submission, undefined);
  assert.equal(seen.length, 4);
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
  assert.ok(pre.includes("begin_commit") && pre.includes("submit"));
  const stateless = offeredTools({
    ...base,
    memory: { ...base.memory, horizon: "stateless" },
  });
  assert.ok(!stateless.some((t) => t.startsWith("workspace_")));
  const post = offeredTools({ ...base, phase: "postgame" });
  assert.ok(!post.includes("submit") && !post.includes("begin_commit"));
  assert.ok(post.includes("read_released_results"));
});

test("the three baselines run end to end on the same question set without a model call", async () => {
  const market = configFor({ horizon: "stateless" }, { baseline: "market" });
  const m = await run(market.config, neverCalled, marketBaseline, market);
  assert.equal(m.ends[0].status, "completed");
  const q = await (async () => {
    const f = fixtureCorpus();
    const { Session } = await import("../src/env/session.js");
    const s = new Session(
      f.config,
      f.game,
      "pregame",
      f.game.scheduledStart,
      f.source,
    );
    return (await s.list_questions({})).questions[0];
  })();
  assert.equal(m.submission.submission.answers[0].p_over, q.p_over); // exactly the market

  const random = configFor(
    { horizon: "stateless" },
    { baseline: "random-deviation", seed: 7 },
  );
  const r1 = await run(
    random.config,
    neverCalled,
    randomDeviationBaseline(7),
    random,
  );
  const r2 = await run(
    random.config,
    neverCalled,
    randomDeviationBaseline(7),
    configFor(
      { horizon: "stateless" },
      { baseline: "random-deviation", seed: 7 },
    ),
  );
  assert.equal(r1.submission.receipt, r2.submission.receipt);
  const p = r1.submission.submission.answers[0].p_over;
  assert.ok(Math.abs(p - q.p_over) <= 0.15 && p >= 0.01 && p <= 0.99);

  const naive = configFor(
    { horizon: "stateless" },
    { baseline: "naive-stats" },
  );
  const n = await run(
    naive.config,
    neverCalled,
    naiveStatsBaseline({ minimumGames: 1, shrinkage: 10 }),
    naive,
  );
  // Fixture: one eligible prior game with 11 points over a 10.5 line → (1+0.5)/2 = 0.75, w = 1/11.
  const expected = (1 / 11) * 0.75 + (10 / 11) * q.p_over;
  assert.ok(
    Math.abs(n.submission.submission.answers[0].p_over - expected) < 1e-9,
  );
});

test("harness version changes with any prompt, tool definition, loop parameter or baseline choice", () => {
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
  assert.notEqual(
    version(
      harnessConfig({
        ...{
          memory: f.config.profile.memory,
          effort: "high",
          thinking: "adaptive",
          sandboxImage: f.config.harness.sandboxImage,
          codeRevision: "rev",
        },
        baseline: "market",
      }),
    ),
    v0,
  );
  assert.ok(
    Object.values(MEMORY_INSTRUCTIONS).every((m) =>
      Object.values(base().prompts).includes(m),
    ),
  );
  assert.equal(base().sdkVersion, f.config.harness.sdkVersion);
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
  f.config.budget.submissionReserve = 10_000;
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
        return [use("begin_commit", {})];
      },
      (r) => {
        assertPaired(r);
        return [
          use("submit", {
            answers: questionIds(r).map((id) => ({
              question_id: id,
              p_over: 0.5,
            })),
          }),
        ];
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
