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
  type PromptSet,
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

export function piLoop(forecast: boolean, overrides?: Partial<LoopParameters>) {
  return {
    ...DEFAULT_LOOP,
    maxTokens: forecast ? 32000 : DEFAULT_LOOP.maxTokens,
    ...overrides,
  };
}

export const PI_CONTRACT = {
  packageVersion: "1.5.0",
  provider: {
    id: "nba-metered",
    api: "anthropic-messages",
    baseUrl: "session.model.baseURL",
    apiKey: "session.model.apiKey",
    transport: "metered-assembled-stream-to-sse-v2",
  },
  forecastBudget:
    "per-tool-token-balance-and-phase-warnings-at-profile-threshold-and-half-v1",
  tools: {
    registration: "extension-registerTool-from-TOOL_DEFINITIONS",
    selection: "phase-capability-memory",
    guard: "TOOL_NAMES-and-offered-tools",
    builtins: false,
  },
  prompts: {
    system: "replace-entirely-before-agent-start",
    append: [],
    opening: "phase-prompt-and-context",
  },
  isolation:
    "fresh-process-empty-env-temp-cwd-agentdir-in-memory-no-discovery-v1",
  recovery: {
    compaction: false,
    retry: false,
    cacheWarming: false,
    truncation: "pi-paired-error-results",
    outputLimitContinuation: {
      limit: 3,
      prompt:
        "Your last response reached the output limit before it finished, and nothing in it was acted on. Continue from where you were. Keep your reasoning brief and make your next tool call.",
    },
    piRequestedThinkingLevel: "high",
    contextWindow: 200000,
  },
} as const;

export interface HarnessConfigOptions {
  memoryInstructions?: string;
  implementation?: "pi" | "homemade";
  /** Which prompt texts the harness runs with. `research-v3` requires a v3
   * memory profile and supplies its permission instructions. */
  promptSet?: PromptSet;
  memory: RunConfig["profile"]["memory"];
  effort: RunConfig["harness"]["loop"]["effort"];
  thinking: RunConfig["harness"]["loop"]["thinking"];
  sandboxImage: string;
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
  const loop =
    options.implementation === "pi"
      ? piLoop(options.memory.version === "forecast-memory-v1", options.loop)
      : { ...DEFAULT_LOOP, ...options.loop };
  return {
    identity:
      options.implementation === "pi"
        ? "pi-infrastructure-v3"
        : "replay-infrastructure-v2",
    ...(options.implementation === "pi" ? { pi: PI_CONTRACT } : {}),
    prompts: {
      system: SYSTEM_PROMPT,
      ...PHASE_PROMPTS,
      ...Object.fromEntries(
        Object.entries(MEMORY_INSTRUCTIONS).map(([k, v]) => [`memory:${k}`, v]),
      ),
    },
    memoryInstructions:
      options.memoryInstructions ?? memoryInstructions(options.memory),
    toolDefinitions: JSON.parse(serializeToolDefinitions(TOOL_DEFINITIONS)),
    loop: {
      effort: options.effort,
      thinking: options.thinking,
      parameters: {
        ...(options.implementation === "pi"
          ? {
              maxTokens: loop.maxTokens,
              timeoutMs: loop.timeoutMs,
              maxTurns: loop.maxTurns,
              promptCache: loop.promptCache,
            }
          : loop),
      },
    },
    accessMethod: "anthropic-sdk-via-metering-proxy",
    sdkVersion: SDK_VERSION,
    sandboxImage: options.sandboxImage,
    codeRevision: options.codeRevision ?? currentCodeRevision(),
  };
}
