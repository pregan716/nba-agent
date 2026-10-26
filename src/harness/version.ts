// Builds the `harness` block of a run config so that P4's manifest hash covers
// every component the brief lists under "Harness version": identity, prompts,
// memory-mode instructions, tool definitions and schemas, submission format and
// retry policy, loop parameters (effort, thinking, prompt caching), access method and SDK
// version, sandbox image digest, and code revision.

import { execFileSync } from "node:child_process";
import type { RunConfig } from "../runner/config.js";
import { SDK_VERSION } from "../runner/proxy.js";
import { TOOL_DEFINITIONS, serializeToolDefinitions } from "../env/tools.js";
import {
  MEMORY_INSTRUCTIONS,
  PHASE_PROMPTS,
  SYSTEM_PROMPT,
  memoryInstructions,
} from "./prompts.js";

export interface LoopParameters {
  /** `max_tokens` per model call before the proxy clamps it to the remaining allowance. */
  maxTokens: number;
  /** SDK client timeout per call, in milliseconds. Non-streaming calls need an explicit timeout. */
  timeoutMs: number;
  /** Hard stop on model turns per phase, as a loop safeguard; the budget is the real limit. */
  maxTurns: number;
  /** How many times the harness reminds a model that ended its turn without submitting. */
  nudges: number;
  /** Refresh the budget line (via the context tool) every N tool rounds. */
  contextEvery: number;
  /** Retries of a response whose tool call was cut at max_tokens, each with a larger allowance. */
  truncationRetries: number;
  /** Upper bound on the per-call max_tokens the retries may grow to (the proxy still clamps to budget). */
  maxTokensCeiling: number;
  /** Prompt-cache breakpoints per request: the 5-minute ephemeral cache on the last tool
   * definition and on the last block of the latest message, or none. Changes the request
   * shape, so it is part of the harness version. */
  promptCache: "ephemeral-5m" | "none";
}
export const DEFAULT_LOOP: LoopParameters = {
  maxTokens: 16000,
  timeoutMs: 10 * 60 * 1000,
  maxTurns: 200,
  nudges: 2,
  contextEvery: 5,
  truncationRetries: 2,
  maxTokensCeiling: 64000,
  promptCache: "ephemeral-5m",
};
export type BaselineName = "market" | "naive-stats" | "random-deviation";

export interface HarnessConfigOptions {
  memory: RunConfig["profile"]["memory"];
  effort: RunConfig["harness"]["loop"]["effort"];
  thinking: RunConfig["harness"]["loop"]["thinking"];
  sandboxImage: string;
  codeRevision?: string;
  loop?: Partial<LoopParameters>;
  /** A null baseline instead of the analyst. Baselines make no model calls. */
  baseline?: BaselineName;
  /** Random-deviation seed; part of the harness version. */
  seed?: number;
}

export function currentCodeRevision(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

export function harnessConfig(
  options: HarnessConfigOptions,
): RunConfig["harness"] {
  const loop = { ...DEFAULT_LOOP, ...options.loop };
  const baseline = options.baseline;
  return {
    identity: baseline ? `baseline-${baseline}-v1` : "homemade-analyst-v1",
    prompts: baseline
      ? { baseline: `${baseline} null baseline; no model calls` }
      : {
          system: SYSTEM_PROMPT,
          ...PHASE_PROMPTS,
          ...Object.fromEntries(
            Object.entries(MEMORY_INSTRUCTIONS).map(([k, v]) => [
              `memory:${k}`,
              v,
            ]),
          ),
        },
    memoryInstructions: baseline
      ? "n/a: baseline does not read instructions"
      : memoryInstructions(options.memory),
    toolDefinitions: baseline
      ? []
      : JSON.parse(serializeToolDefinitions(TOOL_DEFINITIONS)),
    submissionFormat: "answers-v1",
    retryPolicy: "two-resubmissions",
    loop: {
      effort: options.effort,
      thinking: options.thinking,
      parameters: {
        ...loop,
        ...(baseline ? { baseline } : {}),
        ...(options.seed !== undefined ? { seed: options.seed } : {}),
      },
    },
    accessMethod: "anthropic-sdk-via-metering-proxy",
    sdkVersion: SDK_VERSION,
    sandboxImage: options.sandboxImage,
    codeRevision: options.codeRevision ?? currentCodeRevision(),
  };
}
