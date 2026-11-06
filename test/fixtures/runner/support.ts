import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "@anthropic-ai/sdk/resources/messages";
import type { RunConfig } from "../../../src/runner/config.js";
import type { ModelProvider } from "../../../src/runner/proxy.js";
import type {
  EnvironmentFactory,
  Harness,
} from "../../../src/runner/runner.js";
export function fixtureConfig(
  runId = "fixture",
  horizon: "stateless" | "season" = "season",
): RunConfig {
  const hash = "a".repeat(64);
  return {
    runId,
    replicateId: "r1",
    team: "BOS",
    season: "2025-26",
    purpose: "fixture",
    host: "local",
    codeRevision: "fixture-only",
    profile: {
      memory: {
        version: "memory-v1",
        horizon,
        revision: "editable",
        process: "voluntary",
      },
      dataSources: [
        { type: "fixture", release: "fixture-v1", manifestSha256: hash },
      ],
      capabilities: {
        version: "fixture-v1",
        enabled: ["workspace", "code_execution"],
      },
      modelRoles: { version: "v1", analyst: "claude-opus-4-6" },
    },
    budget: {
      id: "fixture-only-not-pilot-approved",
      pilotApproved: false,
      pregame: {
        tokens: 1000,
        computeSeconds: 10,
        toolCalls: 30,
        wallSeconds: 10,
      },
      postgame: {
        tokens: 500,
        computeSeconds: 5,
        toolCalls: 10,
        wallSeconds: 5,
      },
      warnRemainingTokens: 100,
      rollover: false,
      sandbox: {
        perCallSeconds: 2,
        stdoutBytes: 128,
        cpu: 1,
        memoryBytes: 1024 * 1024,
      },
      price: {
        id: "fixture-not-for-cost-claims",
        inputPerMillion: 5,
        outputPerMillion: 25,
        cacheReadPerMillion: 0.5,
        cacheWrite5mPerMillion: 6.25,
        cacheWrite1hPerMillion: 10,
      },
    },
    harness: {
      identity: "fixture-stub",
      prompts: { system: "Fixture only" },
      memoryInstructions: "Use only scoped session tools.",
      toolDefinitions: [],
      loop: { effort: "high", thinking: "adaptive", parameters: {} },
      accessMethod: "anthropic-sdk-via-metering-proxy",
      sdkVersion: JSON.parse(
        readFileSync(
          new URL(
            "../../../node_modules/@anthropic-ai/sdk/package.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ).version,
      sandboxImage: `fixture@sha256:${hash}`,
      codeRevision: "fixture-only",
    },
    policy: {
      version: "v1",
      developmentGames: 10,
      release: "next-morning-09:00-America/New_York",
    },
    contaminationProbe: null,
  };
}
export const sdkMessage = {
  id: "msg_fixture",
  type: "message",
  role: "assistant",
  model: "claude-opus-4-6",
  content: [{ type: "text", text: "fixture" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: 11,
    output_tokens: 7,
    cache_read_input_tokens: 13,
    cache_creation_input_tokens: 17,
    cache_creation: {
      ephemeral_5m_input_tokens: 12,
      ephemeral_1h_input_tokens: 5,
    },
  },
} as Message;
export const provider: ModelProvider = {
  count: async () => 41,
  create: async () => structuredClone(sdkMessage),
};
export const environment: EnvironmentFactory = async (
  context,
  { workspace },
) => {
  let phase = context.phase;
  return {
    async context(budget) {
      return {
        team: {
          team_id: "1610612738",
          abbreviation: "BOS",
          name: "Boston Celtics",
        },
        season: "2025-26",
        game: {
          game_id: context.game.gameId,
          game_index: context.game.index + 1,
          opponent: {
            team_id: "opponent",
            abbreviation: "OPP",
            name: "Fixture opponent",
          },
          home: true,
          scheduled_start: context.game.scheduledStart,
          venue: null,
        },
        phase,
        cutoff: context.cutoff,
        budget,
        capabilities: [...context.capabilities].sort(),
        memory: {
          horizon: context.memory.horizon!,
          revision: context.memory.revision!,
          process: context.memory.process!,
        },
      };
    },
    async transition(next) {
      if (next !== "initialize" && next !== "checkpoint") phase = next;
    },
    async call(name, args) {
      if (name === "workspace_read") {
        const content = existsSync(join(workspace, "notes.txt"))
          ? readFileSync(join(workspace, "notes.txt"), "utf8")
          : "";
        return {
          path: "notes.txt",
          content,
          bytes: Buffer.byteLength(content),
        };
      }
      if (name === "workspace_write") {
        if (phase === "commit") throw Error("Locked");
        const content = (args as { content: string }).content;
        writeFileSync(join(workspace, "notes.txt"), content);
        return { path: "notes.txt", bytes: Buffer.byteLength(content) };
      }
      throw Error("Unknown fixture tool");
    },
    async execute(program) {
      return {
        stdout: program,
        stderr: "",
        exitStatus: 0,
        computeSeconds: 0.1,
        truncated: false,
        limit: null,
      };
    },
    async close() {},
  };
};
export const harness: Harness = async ({ session }) => {
  const ctx = await session.call("context", {});
  if (ctx.phase === "postgame")
    await session.call("workspace_write", {
      path: "notes.txt",
      content: `reflected ${ctx.game.game_id}`,
    });
};
