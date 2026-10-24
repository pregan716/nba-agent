// Run-config presets for the launcher. Budget numbers are Open in the brief and
// are set by the pilot procedure; the values here are deliberately generous
// ceilings for the development-games pilot and are labelled as such. They are
// not an approved scored budget (`pilotApproved: false`).

import { readFileSync } from "node:fs";
import type { RunConfig } from "../runner/config.js";
import type { DatasetVersion } from "../env/contract.js";
import { harnessConfig, type BaselineName } from "./version.js";

export const PILOT_BUDGET: RunConfig["budget"] = {
  id: "pilot-generous-v0-not-approved",
  pilotApproved: false,
  pregame: {
    tokens: 3_000_000,
    computeSeconds: 900,
    toolCalls: 300,
    wallSeconds: 3 * 3600,
  },
  postgame: {
    tokens: 1_500_000,
    computeSeconds: 600,
    toolCalls: 150,
    wallSeconds: 2 * 3600,
  },
  submissionReserve: 200_000,
  warnRemainingTokens: 400_000,
  rollover: false,
  sandbox: {
    perCallSeconds: 120,
    stdoutBytes: 256 * 1024,
    cpu: 2,
    memoryBytes: 4 * 1024 * 1024 * 1024,
  },
  // Placeholder schedule in USD per million tokens. Verify against the current
  // price list and give it a real id before any cost claim is made.
  price: {
    id: "placeholder-verify-before-pilot",
    inputPerMillion: 5,
    outputPerMillion: 25,
    cacheReadPerMillion: 0.5,
    cacheWrite5mPerMillion: 6.25,
    cacheWrite1hPerMillion: 10,
  },
};

export interface PresetOptions {
  runId: string;
  replicateId: string;
  purpose: "fixture" | "pilot" | "scored";
  memory: RunConfig["profile"]["memory"];
  dataSources: DatasetVersion[];
  devig: RunConfig["devig"];
  effort?: RunConfig["harness"]["loop"]["effort"];
  baseline?: BaselineName;
  seed?: number;
  codeExecution?: boolean;
  contaminationProbe?: RunConfig["contaminationProbe"];
  host?: RunConfig["host"];
}

/** The locally built image pin written by `npm run sandbox:build`, if present. */
export function localSandboxImage(): string | null {
  try {
    return JSON.parse(readFileSync(".cache/sandbox-image.json", "utf8")).image;
  } catch {
    return null;
  }
}

export function presetConfig(options: PresetOptions): RunConfig {
  const image = options.codeExecution ? localSandboxImage() : null;
  if (options.codeExecution && !image)
    throw Error(
      "Code execution requires a pinned sandbox image (npm run sandbox:build)",
    );
  const enabled = [
    "search_and_fetch",
    "game_history",
    "odds_history",
    ...(options.memory.horizon === "stateless" ? [] : ["workspace"]),
    ...(options.codeExecution ? ["code_execution"] : []),
  ];
  return {
    runId: options.runId,
    replicateId: options.replicateId,
    team: "BOS",
    season: "2025-26",
    purpose: options.purpose,
    host: options.host ?? "local",
    codeRevision: "set-by-harnessConfig",
    profile: {
      memory: options.memory,
      dataSources: options.dataSources.map((v) => ({
        type: v.source,
        release: v.release,
        manifestSha256: v.manifest_sha256,
      })),
      capabilities: { version: "capabilities-v1", enabled },
      modelRoles: { version: "roles-v1", analyst: "claude-opus-4-6" },
    },
    budget: PILOT_BUDGET,
    harness: harnessConfig({
      memory: options.memory,
      effort: options.effort ?? "high",
      thinking: "adaptive",
      sandboxImage: image ?? `none@sha256:${"0".repeat(64)}`,
      baseline: options.baseline,
      seed: options.seed,
    }),
    devig: options.devig,
    policy: {
      version: "policy-v1",
      lineSelection: "median_book_main_lines",
      contributingBookRule: "all_books_with_valid_pair_at_selected_line",
      minimumBooks: 1,
      developmentGames: 10,
      maxSubmissionAttempts: 3,
      release: "next-morning-09:00-America/New_York",
    },
    contaminationProbe: options.contaminationProbe ?? null,
  };
}
