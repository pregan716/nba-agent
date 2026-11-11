import assert from "node:assert/strict";
import { test } from "node:test";
import { forecastProfile } from "../src/projection/profile.js";
import {
  FORECAST_MEMORY_INSTRUCTIONS,
  FORECAST_SYSTEM_PROMPT,
  forecastPrompts,
} from "../src/projection/prompts.js";
import { forecastDefinitions } from "../src/projection/tools.js";
import { PROBE_PROMPT } from "../src/harness/probe.js";

const profile = (arm: "no-memory" | "full-memory") =>
  forecastProfile({
    arm,
    runId: "run",
    replicateId: "r1",
    purpose: "fixture",
    dataSources: [],
    sandboxImage: "local@sha256:" + "a".repeat(64),
    projectionImage: "local@sha256:" + "b".repeat(64),
  });
const everything = (arm: "no-memory" | "full-memory") => {
  const h = profile(arm).harness;
  return [
    ...Object.values(h.prompts),
    h.memoryInstructions,
    JSON.stringify(h.toolDefinitions),
  ].join("\n");
};

test("both arms share every prompt and differ only in what carries over", () => {
  const none = profile("no-memory").harness,
    full = profile("full-memory").harness;
  assert.deepEqual(none.prompts, { ...forecastPrompts });
  assert.deepEqual(full.prompts, none.prompts);
  assert.equal(none.prompts.system, FORECAST_SYSTEM_PROMPT);
  assert.equal(
    none.memoryInstructions,
    FORECAST_MEMORY_INSTRUCTIONS["no-memory"],
  );
  assert.equal(
    full.memoryInstructions,
    FORECAST_MEMORY_INSTRUCTIONS["full-memory"],
  );
  assert.notEqual(none.memoryInstructions, full.memoryInstructions);
  assert.match(full.memoryInstructions, /\/workspace\/memory/);
  assert.match(full.memoryInstructions, /\/workspace\/code/);
  assert.doesNotMatch(none.memoryInstructions, /\/workspace/);
});

// Carried evidence tools mention "odds observations" in their cutoff rule; game lines are visible.
test("nothing the analyst reads mentions the prop market", () => {
  for (const arm of ["no-memory", "full-memory"] as const)
    assert.doesNotMatch(
      everything(arm),
      /\bprops?\b|sportsbook|consensus|big over|\bover\/under\b|p_over|market|wager|\blines? (set|posted|offered)/i,
    );
});

test("nothing the analyst reads carries the retired substitution task", () => {
  for (const arm of ["no-memory", "full-memory"] as const)
    assert.doesNotMatch(
      everything(arm),
      /\bJev\b|decision_windows|freeze_package|validate_package|assemble\(|backtest|nba_starter/,
    );
});

test("the system prompt names every tool it relies on and the contract it describes", () => {
  const names = forecastDefinitions.map((t) => t.name);
  for (const tool of [
    "context",
    "reference_projection",
    "validate_forecast",
    "freeze_forecast",
    "read_feedback",
  ]) {
    assert.ok(names.includes(tool));
    assert.ok(FORECAST_SYSTEM_PROMPT.includes(tool), tool);
  }
  for (const text of [
    "forecast-v1",
    "p_play",
    "p_start",
    "fantasy_points",
    "5th, 10th, 25th, 50th, 75th, 90th and 95th",
    "85th percentile",
  ])
    assert.ok(FORECAST_SYSTEM_PROMPT.includes(text), text);
});

test("the contamination probe asks about Celtics minutes and roles", () => {
  assert.match(PROBE_PROMPT, /\n9\. Celtics player minutes and roles/);
});

test("the copying claim is limited to the primary scores and context is not requested first", () => {
  assert.match(
    FORECAST_SYSTEM_PROMPT,
    /copies it gets exactly its minutes, production and playing scores/,
  );
  assert.ok(FORECAST_SYSTEM_PROMPT.includes("ceiling.referenceWeighted"));
  assert.doesNotMatch(FORECAST_SYSTEM_PROMPT, /the same 15% chance/);
  assert.match(FORECAST_SYSTEM_PROMPT, /With no tie at that percentile/);
  assert.doesNotMatch(FORECAST_SYSTEM_PROMPT, /call it first/);
  assert.match(FORECAST_SYSTEM_PROMPT, /already in your first message/);
});
