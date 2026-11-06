// Builds the `harness` block of a run config so that P4's manifest hash covers
// every component the brief lists under "Harness version": identity, prompts,
// memory-mode instructions, tool definitions and schemas, loop parameters (effort, thinking, prompt caching), access method and SDK
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
  contextEvery: 5,
  truncationRetries: 2,
  maxTokensCeiling: 64000,
  promptCache: "ephemeral-5m",
};

export interface HarnessConfigOptions {
  memory: RunConfig["profile"]["memory"];
  effort: RunConfig["harness"]["loop"]["effort"];
  thinking: RunConfig["harness"]["loop"]["thinking"];
  sandboxImage: string;
  policy?: RunConfig["harness"]["policy"];
  codeRevision?: string;
  loop?: Partial<LoopParameters>;
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
  return {
    identity: "replay-infrastructure-v2",
    prompts: {
      system: SYSTEM_PROMPT,
      ...PHASE_PROMPTS,
      ...Object.fromEntries(
        Object.entries(MEMORY_INSTRUCTIONS).map(([k, v]) => [`memory:${k}`, v]),
      ),
    },
    memoryInstructions: memoryInstructions(options.memory),
    toolDefinitions: JSON.parse(serializeToolDefinitions(TOOL_DEFINITIONS)),
    loop: {
      effort: options.effort,
      thinking: options.thinking,
      parameters: {
        ...loop,
      },
    },
    accessMethod: "anthropic-sdk-via-metering-proxy",
    sdkVersion: SDK_VERSION,
    sandboxImage: options.sandboxImage,
    ...(options.policy ? { policy: options.policy } : {}),
    codeRevision: options.codeRevision ?? currentCodeRevision(),
  };
}
