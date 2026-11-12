import { dirname } from "node:path";
import {
  manifest as makeManifest,
  digest,
  type Manifest,
  type RunConfig,
} from "../../runner/config.js";
import {
  checkPilotBoundary,
  continuationData,
  pilotEnd,
} from "../../runner/continuation.js";
import { readBlob } from "../../runner/blobs.js";
import { readRecord, canonical, hash } from "../record.js";
import type { Feedback, Snapshot } from "./market.js";
import type { GameResult } from "./metrics.js";

export interface EvaluationRun {
  arm: "no-memory" | "full-memory";
  replicate: string;
  runId: string;
  source: string;
  common: string;
  armSettings: string;
  population: string;
  configurations: {
    firstGame: number;
    lastGame: number;
    configDigest: string;
    codeRevision: string;
    harnessVersion: string;
    budget: string;
  }[];
  games: GameResult[];
  excluded: { id: string; reason: string }[];
}
function comparisonSettings(config: RunConfig) {
  const memory = config.profile.memory;
  // Only the declared memory manipulation and run/replicate identifiers may differ.
  const { runId, replicateId, profile, harness, ...configRest } = config;
  const { memoryInstructions, toolDefinitions, ...harnessRest } = harness;
  const tools = toolDefinitions as { name: string }[];
  const common = hash(
    canonical([
      configRest,
      harnessRest,
      tools.filter((t) => !t.name.startsWith("workspace_")),
      profile.modelRoles,
      profile.dataSources,
      profile.capabilities.version,
      profile.capabilities.enabled.filter((c) => c !== "workspace"),
    ]),
  );
  return {
    common,
    armSettings: hash(
      canonical([
        memory,
        memoryInstructions,
        toolDefinitions,
        profile.capabilities,
      ]),
    ),
  };
}
export function loadForecastRun(
  path: string,
  range?: { first: number; last: number },
): EvaluationRun {
  const { manifest, events, source } = readRecord(path);
  const { config, games: schedule } = manifest as Manifest;
  const memory = config.profile.memory;
  if (
    memory.version !== "forecast-memory-v1" ||
    !events.some((e) => e.kind === "run_end")
  )
    throw Error("Expected a completed forecast run");
  const arm = memory.horizon === "season" ? "full-memory" : "no-memory";
  const gameEnds = events.filter((e) => e.kind === "game_end");
  const changes = events.filter((e) => e.kind === "continuation");
  const segments = [{ firstGame: 1, config }];
  let active = config;
  if (changes.length) {
    const [change] = changes;
    const next = makeManifest(change.data.config, schedule);
    const data = continuationData(manifest, next);
    checkPilotBoundary(
      manifest,
      gameEnds.filter((e) => e.seq < change.seq),
      events.filter((e) => e.kind === "run_end" && e.seq < change.seq),
    );
    const ends = events.filter((e) => e.kind === "continuation_end");
    if (
      changes.length !== 1 ||
      canonical(data) !== canonical(change.data) ||
      ends.length !== 1 ||
      ends[0].seq <= (gameEnds.at(-1)?.seq ?? change.seq)
    )
      throw Error("Invalid or incomplete pilot continuation");
    active = next.config;
    segments.push({ firstGame: data.firstGame, config: active });
  }
  const expected = schedule.filter(
    (g) =>
      config.purpose === "fixture" ||
      (config.purpose === "pilot" ? g.index < pilotEnd(active) : g.index < 70),
  );
  if (
    canonical(gameEnds.map((e) => e.scope)) !==
      canonical(expected.map((g) => g.gameId)) ||
    expected.some((g) => g.index >= 70)
  )
    throw Error("Incomplete, mismatched or holdout game list");
  const eligible = expected.filter(
    (g) => config.purpose !== "scored" || g.index >= 20,
  );
  if (
    range &&
    (!Number.isInteger(range.first) ||
      !Number.isInteger(range.last) ||
      range.first > range.last ||
      range.first < (eligible[0]?.index ?? 0) + 1 ||
      range.last > (eligible.at(-1)?.index ?? -1) + 1)
  )
    throw Error("Game range outside the evaluated run");
  const selected = eligible.filter(
    (g) => !range || (g.index + 1 >= range.first && g.index + 1 <= range.last),
  );
  const one = (kind: string, id: string) => {
    const matching = events.filter((e) => e.kind === kind && e.scope === id);
    if (matching.length !== 1)
      throw Error("Expected one " + kind + " for " + id);
    return matching[0].data;
  };
  const games: GameResult[] = [],
    excluded: EvaluationRun["excluded"] = [];
  const population = [];
  for (const g of selected) {
    const id = g.gameId,
      end = one("game_end", id),
      ref = one("reference_forecast", id),
      consensus = one("evaluator_consensus", id);
    if (
      consensus.version !== "forecast-consensus-v1" ||
      !config.profile.dataSources.some(
        (d) => d.type === "odds" && d.manifestSha256 === consensus.release,
      )
    )
      throw Error("Consensus pin mismatch for " + id);
    const released = one("forecast_feedback", id);
    const feedback = JSON.parse(
      readBlob(dirname(source.path), released.blob).toString(),
    );
    if (
      feedback.gameId !== id ||
      feedback.status !== end.forecastStatus ||
      released.status !== feedback.status
    )
      throw Error("Feedback identity mismatch for " + id);
    population.push([
      id,
      hash(canonical(ref)),
      hash(canonical(consensus)),
      feedback.status === "excluded"
        ? feedback.reason
        : hash(canonical([feedback.box, feedback.reference])),
    ]);
    if (feedback.status === "excluded") {
      excluded.push({ id, reason: feedback.reason });
      continue;
    }
    if (!["frozen", "no_forecast"].includes(feedback.status))
      throw Error("Unknown forecast status");
    const missing = events.filter(
      (e) => e.scope === id && e.kind === "forecast_missing",
    );
    if (
      feedback.status === "no_forecast"
        ? missing.length !== 1 ||
          events.some((e) => e.scope === id && e.kind === "forecast_freeze")
        : missing.length !== 0
    )
      throw Error("Forecast receipt status mismatch for " + id);
    const frozen =
      feedback.status === "frozen"
        ? one("forecast_freeze", id).forecast
        : ref.forecast;
    const f: Feedback = feedback;
    for (const [score, forecast] of [
      [f.agent, frozen],
      [f.reference, ref.forecast],
    ] as const) {
      const byId = (a: { playerId: string }, b: { playerId: string }) =>
        a.playerId.localeCompare(b.playerId);
      if (
        canonical(score.players.map((p) => p.forecast).sort(byId)) !==
        canonical([...forecast.players].sort(byId))
      )
        throw Error("Forecast differs from receipt for " + id);
    }
    const failed = events.some(
      (e) =>
        e.kind === "phase_end" &&
        e.scope.startsWith(id + ":") &&
        e.data.status === "infrastructure_failure",
    );
    if (
      ![end.costUsd, end.wallClockMs].every((x) => Number.isFinite(x) && x >= 0)
    )
      throw Error("Missing final game metering");
    games.push({
      id,
      index: g.index + 1,
      feedback: f,
      market: consensus as Snapshot,
      flagged: failed || f.status === "no_forecast",
      costUsd: end.costUsd,
      wallClockMs: end.wallClockMs,
    });
  }
  const settings = segments.map((s) => comparisonSettings(s.config));
  return {
    arm,
    replicate: config.replicateId,
    runId: config.runId,
    source: source.lastEventHash,
    common: hash(
      canonical([
        schedule,
        ...settings.map((s, i) => [segments[i].firstGame, s.common]),
      ]),
    ),
    armSettings: hash(canonical(settings.map((s) => s.armSettings))),
    configurations: segments.flatMap((s, i) => {
      const games = selected.filter(
        (g) =>
          g.index + 1 >= s.firstGame &&
          g.index + 1 < (segments[i + 1]?.firstGame ?? Infinity),
      );
      return games.length
        ? [
            {
              firstGame: games[0].index + 1,
              lastGame: games.at(-1)!.index + 1,
              configDigest: digest(s.config),
              codeRevision: s.config.codeRevision,
              harnessVersion: digest(s.config.harness),
              budget: s.config.budget.id,
            },
          ]
        : [];
    }),
    population: hash(canonical(population)),
    games,
    excluded,
  };
}
