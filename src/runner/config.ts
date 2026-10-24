import { createHash } from "node:crypto";
import { z } from "zod";
import { Temporal } from "@js-temporal/polyfill";
import { nextMorning } from "../data/time.js";

export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const name = z.string().min(1);
const id = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().finite().positive();
const integer = z.number().int().positive();
const nonnegative = z.number().finite().nonnegative();
const phaseBudget = z.strictObject({
  tokens: integer,
  computeSeconds: positive,
  toolCalls: integer,
  wallSeconds: positive,
});
export const configSchema = z.strictObject({
  runId: id,
  replicateId: id,
  team: z.literal("BOS"),
  season: z.literal("2025-26"),
  purpose: z.enum(["fixture", "pilot", "scored"]),
  host: z.enum(["local", "aws-ec2-ebs", "aws-fargate-efs"]),
  codeRevision: name,
  profile: z.strictObject({
    memory: z.strictObject({
      version: name,
      horizon: z.enum(["stateless", "season", "window"]),
      windowGames: z.number().int().min(1).max(82).optional(),
      revision: z.enum(["editable", "append-only"]),
      process: z.enum(["voluntary", "mandated-reflection"]),
    }),
    dataSources: z
      .array(
        z.strictObject({ type: name, release: name, manifestSha256: hash }),
      )
      .min(1),
    capabilities: z.strictObject({
      version: name,
      enabled: z.array(name).min(1),
    }),
    modelRoles: z.strictObject({
      version: name,
      analyst: z.literal("claude-opus-4-6"),
    }),
  }),
  budget: z.strictObject({
    id: name,
    pilotApproved: z.boolean(),
    pregame: phaseBudget,
    postgame: phaseBudget,
    submissionReserve: integer,
    warnRemainingTokens: integer,
    rollover: z.literal(false),
    sandbox: z.strictObject({
      perCallSeconds: positive.default(60),
      stdoutBytes: integer.default(1024 * 1024),
      cpu: positive.default(2),
      memoryBytes: integer.default(2 * 1024 * 1024 * 1024),
    }),
    price: z.strictObject({
      id: name,
      inputPerMillion: nonnegative,
      outputPerMillion: nonnegative,
      cacheReadPerMillion: nonnegative,
      cacheWrite5mPerMillion: nonnegative,
      cacheWrite1hPerMillion: nonnegative,
    }),
  }),
  harness: z.strictObject({
    identity: name,
    prompts: z.record(name, name),
    memoryInstructions: name,
    toolDefinitions: z.array(z.unknown()),
    submissionFormat: name,
    retryPolicy: z.literal("two-resubmissions"),
    loop: z.strictObject({
      effort: z.enum(["low", "medium", "high", "max"]),
      thinking: z.enum(["adaptive", "disabled"]),
      parameters: z.record(name, z.unknown()),
    }),
    accessMethod: z.literal("anthropic-sdk-via-metering-proxy"),
    sdkVersion: name,
    sandboxImage: z.string().regex(/@sha256:[a-f0-9]{64}$/),
    codeRevision: name,
  }),
  devig: z.strictObject({
    layer: name,
    manifestSha256: hash,
    methodologySha256: hash,
  }),
  policy: z.strictObject({
    version: name,
    lineSelection: name,
    contributingBookRule: name,
    minimumBooks: z.literal(1),
    developmentGames: z.literal(10),
    maxSubmissionAttempts: z.literal(3),
    release: z.literal("next-morning-09:00-America/New_York"),
  }),
  contaminationProbe: z
    .strictObject({
      model: z.literal("claude-opus-4-6"),
      prompt: name,
      output: name,
      executedAt: z.iso.datetime(),
      tools: z.tuple([]),
    })
    .nullable(),
});
export type RunConfig = z.infer<typeof configSchema>;
export interface ScheduledGame {
  gameId: string;
  scheduledStart: string;
}
export type Game = ScheduledGame & {
  index: number;
  development: boolean;
  release: string;
};
export type Phase = "pregame" | "commit" | "postgame";
export type Status =
  | "completed"
  | "budget_exhausted"
  | "invalid_output"
  | "infrastructure_failure"
  | "skipped";
export type Limit =
  | "tokens"
  | "research_tokens"
  | "compute"
  | "tool_calls"
  | "wall_clock"
  | "submission_attempts"
  | "interrupted"
  | "infrastructure"
  | null;
export interface Manifest {
  schemaVersion: 1;
  config: RunConfig;
  harnessVersion: string;
  games: Game[];
}
export function manifest(
  config: RunConfig,
  schedule: ScheduledGame[],
): Manifest {
  const c = configSchema.parse(config);
  if (
    (c.profile.memory.horizon === "window") !==
    (c.profile.memory.windowGames !== undefined)
  )
    throw Error(
      "Window memory requires windowGames; other horizons must omit it",
    );
  if (c.budget.submissionReserve >= c.budget.pregame.tokens)
    throw Error("Reserve must be smaller than pregame cap");
  if (
    c.profile.memory.horizon === "stateless" &&
    c.profile.memory.process !== "voluntary"
  )
    throw Error("Stateless runs cannot mandate reflection");
  if (c.purpose !== "fixture" && schedule.length !== 82)
    throw Error("Season requires all 82 games");
  if (
    c.purpose === "scored" &&
    (!c.budget.pilotApproved || !c.contaminationProbe || c.host === "local")
  )
    throw Error(
      "Scored runs require pilot budget, contamination probe and AWS persistent storage",
    );
  if (
    !schedule.length ||
    new Set(schedule.map((g) => g.gameId)).size !== schedule.length
  )
    throw Error("Empty or duplicate schedule");
  const games = schedule
    .map((g) => {
      if (!/^[a-zA-Z0-9_-]+$/.test(g.gameId)) throw Error("Invalid game ID");
      return {
        ...g,
        scheduledStart: Temporal.Instant.from(g.scheduledStart).toString(),
      };
    })
    .sort(
      (a, b) =>
        Temporal.Instant.compare(a.scheduledStart, b.scheduledStart) ||
        a.gameId.localeCompare(b.gameId),
    )
    .map((g, index) => ({
      ...g,
      index,
      development: index < 10,
      release: nextMorning(
        Temporal.Instant.from(g.scheduledStart)
          .toZonedDateTimeISO("America/New_York")
          .toPlainDate()
          .toString(),
      ),
    }));
  for (let i = 1; i < games.length; i++)
    if (
      Temporal.Instant.compare(games[i].scheduledStart, games[i - 1].release) <=
      0
    )
      throw Error("Schedule overlaps prior postgame release");
  return deepFreeze(
    JSON.parse(
      JSON.stringify({
        schemaVersion: 1,
        config: c,
        harnessVersion: digest(c.harness),
        games,
      }),
    ),
  );
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
