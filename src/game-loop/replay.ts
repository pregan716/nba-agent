import { mkdirSync } from "node:fs";
import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import { before } from "../data/time.js";
import type { SessionSource } from "../env/source.js";
import { releaseTime } from "../env/visibility.js";
import type { Forecast } from "../projection/forecast.js";
import { ExcludedOutcome, type ReleasedGame } from "../projection/input.js";
import { releasedErrors } from "../projection/reference.js";
import { scoreGame } from "../projection/scoring.js";
import { lockForecast } from "../projection/session.js";
import { validateForecast, type Pregame } from "../projection/validation.js";
import type { RunConfig } from "../runner/config.js";
import { RecordStore } from "../runner/record.js";
import { approvedPackage } from "../evaluation/review/index.js";
import type { Package } from "./package.js";
import type { AgentRunner } from "./agents.js";
import { ReplayMeter } from "./meter.js";
import { agentDispatcher } from "./call.js";
import type { BuiltModels } from "./models.js";
import { stageArtifacts, type Artifacts } from "./artifacts.js";
import { gameSandbox } from "./sandbox.js";

export interface TeamGame {
  teamId: string;
  gameId: string;
  tip: string;
}
export interface ReplaySource {
  data: SessionSource;
  // All season team-games, including those preceding the evaluation window.
  schedule: TeamGame[];
  projection(game: TeamGame): Promise<{
    roster: Pregame["roster"];
    reference: Forecast;
    spread?: number | null;
    total?: number | null;
  }>;
  outcomes(game: TeamGame, exclusiveCutoff: string): Promise<ReleasedGame>;
}
export const defaultProfile = {
  usdPerTeamGame: 2,
  gameUsd: 10,
  gameMinutes: 45,
};
const profileSchema = z.strictObject({
  usdPerTeamGame: z.number().nonnegative(),
  gameUsd: z.number().nonnegative(),
  gameMinutes: z.number().positive().max(35791),
});
const writes = z.record(z.string(), z.json()).optional();
const action = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("agent"),
    name: z.string(),
    input: z.json(),
    state: z.json(),
  }),
  z.strictObject({ type: z.literal("finish"), forecast: z.json(), writes }),
]);
const scope = (g: TeamGame) => JSON.stringify([g.teamId, g.gameId]);
const compare = Temporal.Instant.compare;
type Receipt = {
  pre: Pregame;
  reference: Forecast;
  frozen: Forecast | null;
  costUsd: number;
  wallClockMs: number;
};
type GameScore = ReturnType<typeof scoreGame>;
type Score = GameScore | { gameId: string; status: "excluded"; reason: string };
/** One entry of ctx.referenceHistory. The architect prompt documents these keys. */
export function referenceEntry(
  gameId: string,
  forecast: Forecast,
  outcome: Parameters<typeof releasedErrors>[1] | string,
  teamId?: string,
): {
  gameId: string;
  forecast: Forecast;
  errors: ReturnType<typeof releasedErrors>;
  exclusion?: string;
} {
  return typeof outcome === "string"
    ? { gameId, forecast, errors: [], exclusion: outcome }
    : {
        gameId,
        forecast,
        errors: releasedErrors({ gameId, forecast }, outcome, teamId),
      };
}
export async function replay(options: {
  root: string;
  config: RunConfig;
  package: Package;
  games: TeamGame[];
  source: ReplaySource;
  runAgent: AgentRunner;
  profile?: typeof defaultProfile;
  trainedModels?: BuiltModels;
  agentsOff?: boolean;
  clearArtifacts?: boolean;
  development?: boolean;
}) {
  const { source, config, root, development = true } = options;
  const { pkg, hash } = approvedPackage(options.package);
  const profile = profileSchema.parse(options.profile ?? defaultProfile);
  const schedule = new Map(source.schedule.map((g) => [scope(g), g]));
  const games = options.games
    .map((g) => {
      const pinned = schedule.get(scope(g));
      if (!pinned || compare(pinned.tip, g.tip) !== 0)
        throw Error("Team-game differs from schedule");
      return pinned;
    })
    .sort((a, b) => compare(a.tip, b.tip) || scope(a).localeCompare(scope(b)));
  if (
    new Set(games.map(scope)).size !== games.length ||
    schedule.size !== source.schedule.length
  )
    throw Error("Duplicate team-game");
  mkdirSync(root, { mode: 0o700 }); // Exclusive creation: one owner and an empty run.
  const record = new RecordStore(root, {
    schemaVersion: "game-loop-v1",
    development,
    packageHash: hash,
    trainedModels: Object.fromEntries(
      Object.entries(options.trainedModels ?? {}).map(([k, v]) => [
        k,
        { format: v.format, sha256: v.sha256, bytes: v.bytes },
      ]),
    ),
    package: pkg,
    config,
    profile,
    games,
    agentsOff: !!options.agentsOff,
    clearArtifacts: !!options.clearArtifacts,
  });
  const receipts = new Map<string, Receipt>();
  const scores = new Map<string, Score>();
  const priorReferences = new Map<
    string,
    {
      gameId: string;
      forecast: Forecast;
      errors: ReturnType<typeof releasedErrors>;
      exclusion?: string;
    }
  >();
  const meter = new ReplayMeter(games.length * profile.usdPerTeamGame);
  // A team-game depends on another team's games only through league
  // artifacts, which a later tip can read. Without them, or when artifacts are
  // cleared before every game, each team runs in a lane of its own (SPO-941).
  const independent =
    !!options.clearArtifacts ||
    !Object.values(pkg.artifacts).includes("league");
  type Lane = {
    games: [number, TeamGame][];
    artifacts: Artifacts;
    visible: Artifacts;
    priorTip?: string;
  };
  const lanes = new Map<string, Lane>();
  for (const entry of games.entries()) {
    const key = independent ? entry[1].teamId : "";
    if (!lanes.has(key))
      lanes.set(key, { games: [], artifacts: new Map(), visible: new Map() });
    lanes.get(key)!.games.push(entry);
  }
  // Receipts enter the record in tip order whatever order the lanes finish
  // in, each with the artifact store as the single ordered loop would hold it.
  let artifacts: Artifacts = new Map();
  const finished: (
    | {
        id: string;
        team: string;
        receipt: object;
        writes?: Record<string, unknown>;
      }
    | undefined
  )[] = [];
  let committed = 0;
  function commit() {
    for (let done; (done = finished[committed]); committed++) {
      finished[committed] = undefined;
      if (options.clearArtifacts) artifacts.clear();
      if (done.writes)
        artifacts = stageArtifacts(
          artifacts,
          pkg.artifacts,
          done.team,
          done.writes,
        );
      record.append("team_game", done.id, {
        ...done.receipt,
        artifacts: [...artifacts.values()],
      });
    }
  }
  const halt = new AbortController();
  async function prepare(g: TeamGame) {
    const p = await source.projection(g);
    const pre = {
      gameId: g.gameId,
      tip: g.tip,
      roster: p.roster.map(({ playerId, inactive }) => ({
        playerId,
        inactive,
      })),
    };
    const valid = validateForecast(p.reference, pre);
    if (!valid.ok) throw Error("Invalid reference projection: " + valid.reason);
    return {
      pre,
      reference: valid.forecast,
      spread: p.spread ?? null,
      total: p.total ?? null,
    };
  }
  async function released(g: TeamGame, cutoff: string) {
    if (!before(releaseTime(g.tip), cutoff))
      throw Error("Unreleased team-game");
    const id = scope(g);
    const r = receipts.get(id);
    if (priorReferences.has(id)) return;
    const p = r ?? (await prepare(g));
    let result: Score | undefined;
    try {
      const outcome = await source.outcomes(g, cutoff);
      priorReferences.set(
        id,
        referenceEntry(g.gameId, p.reference, outcome, g.teamId),
      );
      if (r)
        result = scoreGame(r.pre, r.frozen, r.reference, outcome, r, g.teamId);
    } catch (error) {
      if (!(error instanceof ExcludedOutcome) || error.gameId !== g.gameId)
        throw error;
      result = { gameId: g.gameId, status: "excluded", reason: error.reason };
      priorReferences.set(
        id,
        referenceEntry(g.gameId, p.reference, error.reason),
      );
    }
    if (r && result) {
      scores.set(id, result);
      record.append("game_score", id, result);
    }
  }
  async function play(lane: Lane, index: number, g: TeamGame) {
    const preparationStart = performance.now();
    const id = scope(g),
      team = g.teamId;
    if (options.clearArtifacts) lane.artifacts.clear();
    if (
      options.clearArtifacts ||
      !lane.priorTip ||
      compare(lane.priorTip, g.tip) !== 0
    )
      lane.visible = new Map(lane.artifacts);
    lane.priorTip = g.tip;
    const { pre, reference, spread, total } = await prepare(g);
    let hostPreparationMs: number;
    let wallClockMs = 0;
    const gameMeter = meter.game(profile.gameUsd, record, id);
    let frozen: Forecast | null = null,
      reason: string | null = null,
      written: Record<string, unknown> | undefined;
    if (meter.available <= 0) {
      reason = "run_budget_exhausted";
      hostPreparationMs = performance.now() - preparationStart;
    } else {
      const history = source.schedule
        .filter((h) => h.teamId === team && before(releaseTime(h.tip), g.tip))
        .sort((a, b) => compare(a.tip, b.tip));
      for (const h of history) await released(h, g.tip);
      const previous = source.schedule
        .filter((h) => h.teamId === team && before(h.tip, g.tip))
        .sort((a, b) => compare(b.tip, a.tip))[0];
      const ctx = {
        teamId: team,
        ...pre,
        reference,
        spread,
        total,
        referenceHistory: history.map((h) => priorReferences.get(scope(h))),
        scores: history.flatMap((h) => {
          const score = scores.get(scope(h));
          return score ? [score] : [];
        }),
        feedback: previous ? (scores.get(scope(previous)) ?? null) : null,
        artifacts: Object.fromEntries(
          [...lane.visible.values()]
            .filter((a) => a.team === null || a.team === team)
            .map((a) => [a.name, a.value]),
        ),
      };
      const box = gameSandbox(
        config,
        source.data,
        {
          gameId: g.gameId,
          scheduledStart: g.tip,
          index,
          development,
          release: releaseTime(g.tip),
        },
        pkg,
        ctx,
        root,
        (entry) => record.append("sandbox_step", id, entry),
        options.trainedModels,
      );
      const duration = profile.gameMinutes * 60000;
      const controller = new AbortController();
      const { signal } = controller;
      // Another lane's failure ends the replay, so this game stops too.
      const stop = () => controller.abort();
      halt.signal.addEventListener("abort", stop);
      let started: number | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        halt.signal.throwIfAborted();
        await box.prepare();
        let deadline: number;
        const remainingSeconds = () =>
          Math.max(0, (deadline - performance.now()) / 1000);
        const invoke = (file: string, input: unknown) =>
          box.invoke(file, input, remainingSeconds(), signal);
        const call = agentDispatcher(
          pkg,
          g,
          id,
          record,
          gameMeter,
          !!options.agentsOff,
          options.runAgent,
          signal,
          invoke,
        );
        started = performance.now();
        deadline = started + duration;
        timeout = setTimeout(
          () => controller.abort(),
          Math.ceil(duration),
        ).unref();
        let argument: unknown = null;
        for (;;) {
          signal.throwIfAborted();
          const step = action.parse(await invoke(pkg.entry, argument));
          if (step.type === "finish") {
            const next = stageArtifacts(
              lane.artifacts,
              pkg.artifacts,
              team,
              step.writes,
            );
            const frozenAt = Temporal.Instant.from(g.tip)
              .subtract({ nanoseconds: 1 })
              .toString();
            const result = lockForecast(
              pre,
              step.forecast,
              () => ({
                phase: "pregame",
                now:
                  remainingSeconds() > 0 && !signal.aborted ? frozenAt : g.tip,
              }),
              (f) => {
                record.append("forecast_freeze", id, {
                  configurationHash: hash,
                  at: frozenAt,
                  forecast: f,
                });
                frozen = f;
                return true;
              },
            );
            if (!result.ok) throw Error(result.reason);
            lane.artifacts = next;
            written = step.writes;
            break;
          }
          const reply = await call(step.name, step.input);
          argument = { state: step.state, reply };
        }
      } catch (error) {
        reason =
          signal.aborted ||
          (started !== undefined && performance.now() - started >= duration)
            ? "wall_clock"
            : String(error);
      } finally {
        const end = performance.now();
        hostPreparationMs = (started ?? end) - preparationStart;
        if (started !== undefined) wallClockMs = end - started;
        clearTimeout(timeout);
        halt.signal.removeEventListener("abort", stop);
        await box.close();
      }
    }
    // A game cut short by another lane's failure is not a result.
    halt.signal.throwIfAborted();
    const receipt = {
      pre,
      reference,
      frozen,
      costUsd: gameMeter.usd,
      unresolvedUsd: gameMeter.unresolvedUsd,
      wallClockMs,
    };
    receipts.set(id, receipt);
    finished[index] = {
      id,
      team,
      writes: written,
      receipt: {
        ...receipt,
        hostPreparationMs,
        configurationHash: hash,
        reason,
        spread,
        total,
      },
    };
    commit();
  }
  try {
    const ended = await Promise.allSettled(
      [...lanes.values()].map(async (lane) => {
        try {
          for (const [index, g] of lane.games) {
            halt.signal.throwIfAborted();
            await play(lane, index, g);
          }
        } catch (error) {
          halt.abort(error);
          throw error;
        }
      }),
    );
    // The first failure, not the aborts it caused in the other lanes.
    if (halt.signal.aborted) throw halt.signal.reason;
    for (const lane of ended) if (lane.status === "rejected") throw lane.reason;
    for (const g of games)
      await released(
        g,
        Temporal.Instant.from(releaseTime(g.tip))
          .add({ nanoseconds: 1 })
          .toString(),
      );
    record.append("replay_end", "run", {
      usd: meter.usd,
      unresolvedUsd: meter.unresolvedUsd,
      teamGames: games.length,
    });
    record.verify();
    return { usd: meter.usd, unresolvedUsd: meter.unresolvedUsd, scores };
  } finally {
    record.close();
  }
}
