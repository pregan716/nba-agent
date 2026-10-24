import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "@anthropic-ai/sdk/resources/messages";
import type { RunConfig } from "../../../src/runner/config.js";
import type { ModelProvider } from "../../../src/runner/proxy.js";
import type {
  EnvironmentFactory,
  Harness,
} from "../../../src/runner/runner.js";
import { buildQuestionSet } from "../../../src/questions/builder.js";
import type { ObjectRef } from "../../../src/data/store.js";
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
        enabled: [
          "list_questions",
          "workspace_read",
          "workspace_write",
          "execute_code",
        ],
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
      submissionReserve: 200,
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
      submissionFormat: "fixture-v1",
      retryPolicy: "two-resubmissions",
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
    devig: { layer: "fixture", manifestSha256: hash, methodologySha256: hash },
    policy: {
      version: "v1",
      lineSelection: "fixture",
      contributingBookRule: "fixture",
      minimumBooks: 1,
      developmentGames: 10,
      maxSubmissionAttempts: 3,
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
  const question = {
    question_id: `${context.game.gameId}:q`,
    player: { id: "player", name: "Fixture" },
    stat: "points",
    line: 1.5,
    p_over: 0.5,
  };
  return {
    async questions() {
      const ref = (key: string): ObjectRef => ({
        bucket: "pm-data-platform",
        key,
        sha256: "a".repeat(64),
      });
      const row = {
        espn_event_id: context.game.gameId,
        espn_player_id: "player",
        player_name: "Fixture",
        prop_type: "player_points",
        snapshot_kind: "scheduled_start",
        requested_at: context.game.scheduledStart,
        scheduled_start: context.game.scheduledStart,
        status: "ok",
        selected_line: 1.5,
        p_over: 0.5,
        p_under: 0.5,
        contributing_books: ["fixture"],
        contributing_book_count: 1,
      };
      const set = buildQuestionSet(
        {
          game_id: context.game.gameId,
          espn_event_id: context.game.gameId,
          scheduled_start: context.game.scheduledStart,
        },
        {
          manifest: ref("manifest"),
          methodology: ref("methodology"),
          consensus: ref("consensus"),
          bookLines: ref("pairs"),
          summaryRef: ref("summary"),
          rows: [row],
          pairs: [
            {
              ...row,
              bookmaker: "fixture",
              line: 1.5,
              over_price: -110,
              under_price: -110,
              contributes_to_consensus: true,
            },
          ],
          summary: {},
          playerIds: { player: "player" },
        },
      );
      question.question_id = set.questions[0].question_id;
      return set;
    },
    async transition(next) {
      phase = next;
    },
    async call(name, args) {
      if (name === "list_questions") return [question];
      if (name === "workspace_read")
        return existsSync(join(workspace, "notes.txt"))
          ? readFileSync(join(workspace, "notes.txt"), "utf8")
          : "";
      if (name === "workspace_write") {
        if (phase === "commit") throw Error("Locked");
        writeFileSync(join(workspace, "notes.txt"), String(args));
        return true;
      }
      throw Error("Unknown fixture tool");
    },
    async validateSubmission(value) {
      return value === "valid"
        ? {
            ok: true,
            errors: [],
            value: {
              answers: [
                {
                  question_id: question.question_id,
                  p_over: 0.5,
                  rationale: "",
                },
              ],
            },
          }
        : { ok: false, errors: ["Invalid fixture submission"] };
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
  const ctx = (await session.call("context")) as any;
  if (ctx.phase !== "postgame") {
    await session.call("begin_commit");
    await session.call("submit", "valid");
  } else await session.call("workspace_write", `reflected ${ctx.game.gameId}`);
};
