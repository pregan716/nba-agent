// P5 prompts (SPO-781). Every string here is part of the harness version: the
// run config carries these texts and the manifest hashes them, so a wording
// change is a new harness version by construction.
//
// The brief's "Guard against unnecessary process" applies: these prompts state
// the task, the access rules, the output contract and the scoring. They do not
// prescribe a research checklist, a claims ontology or a projection model.

import type { RunConfig } from "../runner/config.js";

// Infrastructure-only prompts until the v2 task contract is implemented.
export const SYSTEM_PROMPT = `You are operating in a cutoff-filtered NBA replay environment. Use only the evidence returned by the tools. The current session has no prediction or scoring task installed. Respect the session budget and workspace permissions.`;
export const PHASE_PROMPTS = {
  pregame:
    "Inspect the available pregame evidence if needed. Finish when done.",
  postgame:
    "The cutoff has advanced to the next morning. You may inspect newly available game data and update permitted workspace files. Finish when done.",
  postgame_mandated:
    "Review newly available game data and record your reflection in the permitted workspace. Finish when done.",
} as const;
export type PhasePromptName = keyof typeof PHASE_PROMPTS;

/** Appended to every persistent memory mode. It says what kinds of things are
 * worth carrying; it supplies none of them, so the stateless arm is unchanged
 * and the persistent arms differ from it only by having a workspace. */
const WORKING_AIDS = `Durable working aids belong in the workspace as much as judgments: a sheet of the data schema you have learned (tables, column names and types, id conventions), query snippets and scripts you will run again. Each session starts with no conversation history, so anything you would otherwise rediscover with the tools every game is worth writing down once.`;

export const MEMORY_INSTRUCTIONS = {
  stateless: `Memory mode: stateless. Nothing persists between games. You start every game with no notes, no scripts and no conversation history, and there is no workspace. Everything you want to use must come from the tools in this session.`,
  "season-editable": `Memory mode: persistent, editable. Your workspace persists across the whole season and is yours alone. Anything in it was written by you in an earlier session: notes, hypotheses, scripts, fitted models, cached tables. You may read, create, overwrite, append to and delete files during pregame research and during postgame; it is locked during commit. Your past rationales and notes are not shown to you by the environment; if you want them later, keep them in the workspace. Scripts saved there can be run again with execute_code, where the workspace is mounted at /workspace. ${WORKING_AIDS}`,
  "season-append-only": `Memory mode: persistent, append-only. Your workspace persists across the whole season. You may create new files and append to existing ones during pregame research and during postgame, but you cannot overwrite or delete anything already written. A revised note or script is a new file. Your past rationales and notes are not shown to you by the environment; if you want them later, keep them in the workspace. ${WORKING_AIDS}`,
  window: `Memory mode: persistent with a limited window. Your workspace carries into this game only what you wrote during the previous few games; older writes have expired, including the earlier parts of files you appended to. Write what you want your near-future self to have. ${WORKING_AIDS}`,
} as const;
export type MemoryInstructionName = keyof typeof MEMORY_INSTRUCTIONS;

/** Select the memory-mode instruction for a run profile. */
export function memoryInstructionName(
  memory: RunConfig["profile"]["memory"],
): MemoryInstructionName {
  if (memory.horizon === "stateless") return "stateless";
  if (memory.horizon === "window") return "window";
  return memory.revision === "append-only"
    ? "season-append-only"
    : "season-editable";
}
export function memoryInstructions(
  memory: RunConfig["profile"]["memory"],
): string {
  if (memory.version === "memory-permissions-v1")
    throw Error(
      "V3 memory instructions must be supplied by R5b or an explicit fixture",
    );
  return MEMORY_INSTRUCTIONS[memoryInstructionName(memory)];
}
