import test from "node:test";
import assert from "node:assert/strict";
import {
  CAPABILITY_TOOLS,
  SessionError,
  TOOL_CAPABILITY,
  TOOL_NAMES,
  TOOL_PHASES,
  VISIBILITY,
  type ContextResult,
  type FetchEvidenceResult,
  type ListQuestionsResult,
  type OddsObservation,
  type ReleasedQuestion,
  type SessionTools,
  type ToolResult,
} from "../src/env/contract.js";
import {
  TOOL_DEFINITIONS,
  canonicalJson,
  messagesApiTools,
  serializeToolDefinitions,
  toolDefinitionsSha256,
} from "../src/env/tools.js";
import type { RecordEnvelope } from "../src/data/contracts.js";
import type {
  AgentQuestion,
  QuestionRecord,
  QuestionSet,
} from "../src/questions/builder.js";

// ---------------------------------------------------------------------------
// Type-level checks. Each @ts-expect-error line fails `npm run check` if the
// assignment ever becomes legal, i.e. if a result type widens to accept an
// internal record.
// ---------------------------------------------------------------------------
declare const envelope: RecordEnvelope;
declare const questionRecord: QuestionRecord;
declare const questionSet: QuestionSet;
declare const agentQuestion: AgentQuestion;
export function typeLevel() {
  // @ts-expect-error a P1 envelope is not a session context
  const a: ContextResult = envelope;
  // @ts-expect-error a P1 envelope is not evidence
  const b: FetchEvidenceResult = envelope;
  // @ts-expect-error a P1 envelope is not an odds observation
  const c: OddsObservation = envelope;
  // @ts-expect-error the full P2 record (selected_line, p_under, provenance) is not the agent projection
  const d: AgentQuestion = questionRecord;
  // @ts-expect-error a released question carries no provenance
  const e: ReleasedQuestion = questionRecord;
  // @ts-expect-error the P2 question set with exclusions is not the agent list
  const f: ListQuestionsResult = questionSet;
  // The agent projection is exactly what list_questions carries.
  const g: ToolResult<"list_questions">["questions"][number] = agentQuestion;
  // The typed call narrows result by tool name.
  const tools: SessionTools = { call: async () => ({}) as never };
  const h: Promise<ContextResult> = tools.call("context", {});
  const i: Promise<ToolResult<"submit">> = tools.call("submit", {
    answers: [{ question_id: "q", p_over: 0.5 }],
  });
  return [a, b, c, d, e, f, g, h, i];
}

test("every tool has exactly one definition, a phase list and a capability entry", () => {
  const names = TOOL_DEFINITIONS.map((d) => d.name);
  assert.deepEqual([...names].sort(), [...TOOL_NAMES].sort());
  assert.equal(new Set(names).size, names.length);
  for (const d of TOOL_DEFINITIONS) {
    assert.ok(d.phases.length > 0, d.name);
    assert.deepEqual(d.phases, TOOL_PHASES[d.name]);
    assert.ok(d.name in TOOL_CAPABILITY, d.name);
    assert.equal(d.input_schema.type, "object");
    assert.equal(d.input_schema.additionalProperties, false);
    assert.ok(d.description.length > 40, d.name);
  }
});
test("every capability in the brief's Environment tools table maps to one tool", () => {
  const capabilities = Object.keys(CAPABILITY_TOOLS);
  assert.equal(capabilities.length, 9);
  const mapped = Object.values(CAPABILITY_TOOLS);
  assert.equal(new Set(mapped).size, mapped.length);
  for (const name of mapped) assert.ok(TOOL_NAMES.includes(name));
});
test("phase legality: research and workspace tools are locked in commit; submit only in commit", () => {
  for (const [name, phases] of Object.entries(TOOL_PHASES)) {
    if (["context", "list_questions"].includes(name))
      assert.deepEqual(phases, ["pregame", "commit", "postgame"], name);
    else if (name === "submit") assert.deepEqual(phases, ["commit"]);
    else if (name === "begin_commit") assert.deepEqual(phases, ["pregame"]);
    else assert.ok(!phases.includes("commit"), name);
  }
});
test("definitions serialize deterministically and the hash is stable under key and array order", () => {
  const a = serializeToolDefinitions();
  const reordered = [...TOOL_DEFINITIONS].reverse().map((d) => ({
    phases: d.phases,
    input_schema: Object.fromEntries(Object.entries(d.input_schema).reverse()),
    description: d.description,
    name: d.name,
  }));
  assert.equal(serializeToolDefinitions(reordered), a);
  assert.equal(toolDefinitionsSha256(reordered), toolDefinitionsSha256());
  assert.match(toolDefinitionsSha256(), /^[a-f0-9]{64}$/);
  assert.notEqual(
    toolDefinitionsSha256([
      { ...TOOL_DEFINITIONS[0], description: "changed" },
      ...TOOL_DEFINITIONS.slice(1),
    ]),
    toolDefinitionsSha256(),
  );
  assert.equal(
    canonicalJson({ b: [1, { z: 1, y: 2 }], a: null }),
    '{"a":null,"b":[1,{"y":2,"z":1}]}',
  );
  assert.deepEqual(JSON.parse(a), JSON.parse(serializeToolDefinitions()));
});
test("no definition or visibility rule uses a type value the metering proxy rejects", () => {
  const banned = ["url", "file", "image", "document", "container_upload"];
  const walk = (v: unknown): void => {
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (typeof o.type === "string") assert.ok(!banned.includes(o.type), o.type);
    for (const child of Object.values(o)) walk(child);
  };
  walk(TOOL_DEFINITIONS);
  walk(VISIBILITY);
  // Messages API shape: only name, description, input_schema.
  for (const t of messagesApiTools())
    assert.deepEqual(Object.keys(t).sort(), [
      "description",
      "input_schema",
      "name",
    ]);
  assert.equal(messagesApiTools(["submit"]).length, 1);
});
test("SessionError serializes to the stable error shape", () => {
  const e = new SessionError(
    "validation_failed",
    "2 problems",
    ["missing q1", "unknown q9"],
    1,
  );
  assert.deepEqual(e.toJSON(), {
    error: "validation_failed",
    message: "2 problems",
    problems: ["missing q1", "unknown q9"],
    attempts_remaining: 1,
  });
  assert.deepEqual(new SessionError("cutoff_refused", "x").toJSON(), {
    error: "cutoff_refused",
    message: "x",
    problems: [],
    attempts_remaining: null,
  });
  assert.ok(e instanceof Error);
});
test("visibility rules cover every source the run profile can expose", () => {
  assert.deepEqual(Object.keys(VISIBILITY).sort(), [
    "game_history",
    "injuries",
    "lineups",
    "odds",
    "posts",
    "questions",
    "released_results",
    "transcripts",
  ]);
  for (const rule of Object.values(VISIBILITY)) {
    assert.ok(rule.exposes.length > 0);
    assert.ok(rule.never.length > 0);
  }
});
