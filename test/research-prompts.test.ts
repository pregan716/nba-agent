import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { digest } from "../src/runner/config.js";
import { memoryVariant } from "../src/env/memory.js";
import { harnessConfig } from "../src/harness/version.js";
import {
  RESEARCH_PHASE_PROMPTS_V3,
  RESEARCH_SYSTEM_PROMPT_V3,
  memoryPermissionInstructions,
  promptTexts,
} from "../src/harness/prompts.js";
import { presetConfig } from "../src/harness/presets.js";
import { diagnosticSelection } from "../src/launch/run.js";

const VARIANTS = ["M0", "M1", "M2", "M3", "M4"] as const;
const base = (variant: (typeof VARIANTS)[number]) =>
  harnessConfig({
    implementation: "pi",
    promptSet: "research-v3",
    memory: memoryVariant(variant),
    effort: "high",
    thinking: "adaptive",
    sandboxImage: `none@sha256:${"0".repeat(64)}`,
    codeRevision: "test",
  });

test("research-v3 harness config carries every prompt and instruction text", () => {
  const h = base("M3");
  assert.equal(h.identity, "pi-research-v3");
  assert.equal(h.prompts.system, RESEARCH_SYSTEM_PROMPT_V3);
  assert.equal(h.prompts.pregame, RESEARCH_PHASE_PROMPTS_V3.pregame);
  assert.equal(h.prompts.postgame, RESEARCH_PHASE_PROMPTS_V3.postgame);
  for (const v of VARIANTS)
    assert.equal(
      h.prompts[`memory:${v}`],
      memoryPermissionInstructions(memoryVariant(v)),
    );
  assert.equal(
    h.memoryInstructions,
    memoryPermissionInstructions(memoryVariant("M3")),
  );
  // No infrastructure placeholder survives in a research configuration.
  assert.ok(
    !Object.values(h.prompts).includes(promptTexts("infrastructure").system),
  );
});

test("any prompt or instruction wording change is a new harness version", () => {
  const h = base("M3");
  const reference = digest(h);
  for (const key of Object.keys(h.prompts)) {
    const changed = structuredClone(h);
    changed.prompts[key] += " ";
    assert.notEqual(digest(changed), reference, key);
  }
  const changed = structuredClone(h);
  changed.memoryInstructions += " ";
  assert.notEqual(digest(changed), reference);
  // The prompt set itself separates research from infrastructure runs.
  const infrastructure = harnessConfig({
    implementation: "pi",
    memoryInstructions: "fixture",
    memory: memoryVariant("M3"),
    effort: "high",
    thinking: "adaptive",
    sandboxImage: `none@sha256:${"0".repeat(64)}`,
    codeRevision: "test",
  });
  assert.equal(infrastructure.identity, "pi-infrastructure-v3");
  assert.notEqual(digest(infrastructure), reference);
  // Variants share prompts and differ only in their own instruction text.
  assert.deepEqual(base("M0").prompts, h.prompts);
  assert.notEqual(base("M0").memoryInstructions, h.memoryInstructions);
});

test("each variant's instructions name exactly its permitted directories", () => {
  const paths = {
    coachProfile: ["memory/coach_profile.md", "memory/coach/"],
    bestPractices: ["memory/best_practices.md", "memory/practices/"],
    skills: ["skills/"],
  } as const;
  for (const v of VARIANTS) {
    const memory = memoryVariant(v),
      text = memoryPermissionInstructions(memory);
    assert.match(text, new RegExp(`variant ${v}\\)`));
    for (const gate of Object.keys(paths) as (keyof typeof paths)[])
      for (const path of paths[gate])
        assert.equal(text.includes(path), memory[gate].read, `${v} ${path}`);
    // Always-present areas and the feedback rule are stated for every variant.
    assert.match(text, /packages\/<game_id>\//);
    assert.match(text, /scratch\//);
    assert.match(text, /read_feedback/);
    // The cap is mentioned only where memory/ exists.
    assert.equal(
      text.includes("50,000 tokens"),
      memory.coachProfile.read || memory.bestPractices.read,
    );
  }
  assert.match(
    memoryPermissionInstructions(memoryVariant("M0")),
    /Nothing you write persists/,
  );
});

test("research-v3 requires v3 memory permissions", () => {
  assert.throws(
    () =>
      harnessConfig({
        implementation: "pi",
        promptSet: "research-v3",
        memory: {
          version: "memory-v1",
          horizon: "season",
          revision: "editable",
          process: "voluntary",
        } as any,
        effort: "high",
        thinking: "adaptive",
        sandboxImage: `none@sha256:${"0".repeat(64)}`,
        codeRevision: "test",
      }),
    /requires v3 memory permissions/,
  );
});

test("presets select research prompts and per-variant instructions", () => {
  const config = presetConfig({
    harness: "pi",
    promptSet: "research-v3",
    runId: "t",
    replicateId: "r1",
    purpose: "pilot",
    memory: memoryVariant("M1"),
    dataSources: [],
  });
  assert.equal(config.harness.identity, "pi-research-v3");
  assert.equal(
    config.harness.memoryInstructions,
    memoryPermissionInstructions(memoryVariant("M1")),
  );
});

test("research texts supply no team-specific names and state the contract", () => {
  const curated = JSON.parse(
    readFileSync("config/celtics-transactions-2025-26.json", "utf8"),
  );
  const texts = [
    RESEARCH_SYSTEM_PROMPT_V3,
    ...Object.values(RESEARCH_PHASE_PROMPTS_V3),
    ...VARIANTS.map((v) => memoryPermissionInstructions(memoryVariant(v))),
  ].join("\n");
  for (const p of [...curated.openingRoster, ...curated.players]) {
    assert.ok(!texts.includes(p.name), p.name);
    const surname = p.name.split(" ").at(-1)!;
    assert.doesNotMatch(texts, new RegExp(`\\b${surname}\\b`), surname);
  }
  assert.doesNotMatch(texts, /Mazzulla/);
  for (const term of [
    "jev_state",
    "instructions",
    "criteria",
    "diagnostics",
    "manifest.json",
    "stateVersion",
    "eligibleBench",
    "freeze_package",
    "validate_package",
    "read_feedback",
    "three_or_more",
  ])
    assert.ok(RESEARCH_SYSTEM_PROMPT_V3.includes(term), term);
});

test("the pilot can be limited to the first development games", () => {
  const schedule = Array.from({ length: 82 }, (_, i) => ({
    gameId: `g${String(i).padStart(2, "0")}`,
    scheduledStart: new Date(Date.UTC(2025, 9, 22 + i)).toISOString(),
  }));
  assert.equal(diagnosticSelection(schedule, "analyst").evaluation.length, 10);
  assert.deepEqual(
    diagnosticSelection(schedule, "analyst", 2).evaluation.map((g) => g.gameId),
    ["g00", "g01"],
  );
  for (const bad of [0, 11, 1.5])
    assert.throws(
      () => diagnosticSelection(schedule, "analyst", bad),
      /1 to 10/,
    );
});

test("the prompt describes the data, the trace file and the freeze lock", () => {
  // Found in the first pilot game: the agent rediscovered these by trial each session.
  for (const term of [
    "nba_data.table(name, columns)",
    "nba_data.query(sql)",
    "nba_data.session()",
    "canonical_sequence",
    "clock_remaining_ms",
    "home_lineup_before",
    "player_stints",
    "start_reason and end_reason",
    "player_box_scores",
    "player_profiles",
    "player_reference",
    "schedule (game_id, scheduled_start",
    "/workspace/feedback/<game_id>/trace.json",
    "result.window",
    "assembly.assembly",
  ])
    assert.ok(RESEARCH_SYSTEM_PROMPT_V3.includes(term), term);
  // The data reference names columns and tables, not what to conclude from them.
  assert.doesNotMatch(RESEARCH_SYSTEM_PROMPT_V3, /typically|usually|tends to/);
  for (const v of ["M1", "M2", "M3", "M4"] as const)
    assert.match(
      memoryPermissionInstructions(memoryVariant(v)),
      /before you call freeze_package/,
    );
  assert.doesNotMatch(
    memoryPermissionInstructions(memoryVariant("M0")),
    /freeze_package/,
  );
});

test("the prompt matches the SPO-857 environment", () => {
  const p = RESEARCH_SYSTEM_PROMPT_V3;
  // The manifest no longer carries hashes; the first game spent six calls on them.
  assert.doesNotMatch(p, /SHA-256/);
  assert.match(p, /Do not compute or list file hashes/);
  assert.match(p, /workspace_edit/);
  assert.match(p, /2024-25 instead/);
  assert.match(p, /include_metadata=true/);
  assert.match(p, /16,000 bytes/);
  assert.match(p, /first page only/);
  for (const v of ["M1", "M2", "M3"] as const) {
    const m = memoryPermissionInstructions(memoryVariant(v));
    assert.match(m, /tokens currently retained against the cap/);
    assert.match(m, /workspace_edit/);
  }
});
