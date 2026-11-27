import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { RecordStore } from "../../runner/record.js";
import { digest, type RunConfig } from "../../runner/config.js";
import {
  replay,
  type ReplaySource,
  type TeamGame,
} from "../../game-loop/replay.js";
import { readPackage, type Package } from "../../game-loop/package.js";
import type { AgentRunner } from "../../game-loop/agents.js";
import { archiveRun } from "./archive.js";
import { pairedComparison, summarize } from "./scores.js";
import { EvaluationPool } from "./pool.js";
import { roundOneFinal } from "./seed.js";
import {
  developmentRequest,
  developmentGames,
  evaluationProfile,
  profileSchema,
  finalGames,
  lateStart,
} from "./profile.js";
import { before } from "../../data/time.js";
import { buildModels, type TrainingData } from "./training.js";

import {
  review,
  restoreAcceptance,
  type ReviewGate,
  type ReviewReceipt,
} from "../review/index.js";

export interface EvaluationHost {
  review: ReviewGate;
  root: string;
  config: RunConfig;
  source: ReplaySource;
  runAgent: AgentRunner;
  training: TrainingData;
  profile?: typeof evaluationProfile;
  /** Operator-only path, used exclusively by finalEvaluation. */
  roundOneFinal?: string;
}
function openPool(h: EvaluationHost) {
  const profile = profileSchema.parse(h.profile ?? evaluationProfile);
  const pool = new EvaluationPool(h.root, profile, digest(h.config));
  try {
    pool.recover((id) => accounting(join(h.root, "development", id)));
    return pool;
  } catch (e) {
    pool.close();
    throw e;
  }
}
function accounting(root: string): {
  usd: number;
  status: "complete" | "failed";
} {
  if (!existsSync(join(root, "record.sqlite")))
    return { usd: 0, status: "failed" };
  const r = new RecordStore(root);
  try {
    const holds = new Map(
      r.events("agent_reservation").map((e) => [e.seq, e.data.usd as number]),
    );
    for (const e of r.events("agent_settlement"))
      holds.set(e.data.reservation, e.data.actual);
    return {
      usd: [...holds.values()].reduce((s, n) => s + n, 0),
      status: r.events("replay_end").length === 1 ? "complete" : "failed",
    };
  } finally {
    r.close();
  }
}
async function execute(
  h: EvaluationHost,
  pool: EvaluationPool,
  root: string,
  pkg: Package,
  games: TeamGame[],
  development: boolean,
  ablation?: string,
) {
  const { hash } = readPackage(pkg);
  const trainedModels = pkg.training.length
    ? await pool.models(hash, () =>
        buildModels(h.config, pkg, h.training, h.root),
      )
    : {};
  return replay({
    root,
    config: h.config,
    source: h.source,
    runAgent: h.runAgent,
    package: pkg,
    profile: pool.profile.replay,
    games,
    development,
    trainedModels,
    agentsOff: ablation === "agents-off",
    clearArtifacts: ablation === "clear-artifacts",
  });
}
function results(root: string) {
  const archive = archiveRun(root);
  return {
    archive,
    system: summarize(archive.scores, "agent"),
    reference: summarize(archive.scores, "reference"),
    againstReference: pairedComparison(
      archive.scores,
      archive.scores,
      "reference",
    ),
  };
}
function agentGate(pool: EvaluationPool) {
  for (const row of pool.db
    .prepare(
      "SELECT id,games FROM runs WHERE kind='full' AND status='complete' AND id NOT IN (SELECT id FROM inherited_runs)",
    )
    .all()) {
    const games: TeamGame[] = JSON.parse(String(row.games));
    if (games.length !== pool.profile.windows.middle.count) continue;
    const db = new DatabaseSync(
      join(pool.root, "development", String(row.id), "record.sqlite"),
      { readOnly: true },
    );
    try {
      if (!db.prepare("SELECT 1 FROM events WHERE kind='replay_end'").get())
        continue;
      const expected = new Set(
        games.map((g) => JSON.stringify([g.teamId, g.gameId])),
      );
      const successful = db
        .prepare(
          "SELECT DISTINCT scope FROM events WHERE kind='agent_end' AND json_extract(data,'$.reply.ok')=1",
        )
        .all()
        .filter((e) => expected.has(String(e.scope)));
      if (successful.length >= Math.ceil(games.length / 2))
        return { met: true, qualifyingRunId: String(row.id) };
    } finally {
      db.close();
    }
  }
  return { met: false, qualifyingRunId: null };
}

/** Only these methods are installed in an architect session. Paths, environment,
 * budget, training data, and final-evaluation controls belong to the host. */
export function developmentService(host: EvaluationHost) {
  const pool = openPool(host);
  const path = (id: string) => join(host.root, "development", id);
  const previous = (id: string) => {
    pool.complete(id);
    return archiveRun(path(id));
  };
  return {
    async evaluate(raw: unknown, recorded?: (receipt: ReviewReceipt) => void) {
      const req = developmentRequest.parse(raw);
      const parent = "runId" in req ? pool.complete(req.runId) : null;

      const games = developmentGames(
        host.source.schedule,
        req,
        pool.profile,
        parent?.games,
      );
      const pkg = await review(
        host.root,
        host.review,
        "package" in req ? req.package : parent!.pkg,
        recorded,
      );
      const { hash } = readPackage(pkg);
      const id = pool.reserve(
        req.kind,
        "runId" in req ? req.runId : null,
        hash,
        pkg,
        games,
      );
      const root = path(id);
      try {
        mkdirSync(join(host.root, "development"), { recursive: true });
        const run = await execute(host, pool, root, pkg, games, true);
        const report = results(root);
        const againstPrevious =
          req.kind === "repeat"
            ? pairedComparison(
                report.archive.scores,
                previous(req.runId).scores,
              )
            : null;
        pool.settle(id, run.usd + run.unresolvedUsd, "complete");
        return { id, ...report, againstPrevious };
      } catch (e) {
        pool.settle(id, accounting(root).usd, "failed");
        throw e;
      }
    },
    round: () => ({
      round: pool.round()?.round ?? 1,
      baselineRunId: pool.round()?.baselineRunId ?? null,
    }),
    budget: () => ({
      ...pool.remaining(),
      ...(pool.round() ? { round: 2, agentGate: agentGate(pool) } : {}),
    }),
    async nominate(id: string, recorded?: (receipt: ReviewReceipt) => void) {
      await approveNomination(host, pool, id, recorded);
    },
    list: () =>
      pool
        .list()
        .map((run) =>
          pool.inherited(String(run.id)) ? { ...run, inherited: true } : run,
        ),
    refusals: () => pool.refusals(),
    archive: previous,
    /** Whether the run covers the late window, which no test run can reach.
     * Only its headline result goes back to the architect, so that it cannot
     * be studied game by game and tuned to (user decision, Nov 18, 2026). */
    reserved: (id: string) =>
      pool
        .complete(id)
        .games.some((g) => !before(g.tip, lateStart(pool.profile))),
    summary(id: string) {
      const { scores } = previous(id);
      return {
        system: summarize(scores, "agent"),
        reference: summarize(scores, "reference"),
        againstReference: pairedComparison(scores, scores, "reference"),
      };
    },
    /** The summary with everything below the whole sample removed. */
    headline(id: string) {
      const { scores, forecasts } = previous(id);
      const { games, teamGames, metrics, guardrailFlag } = pairedComparison(
        scores,
        scores,
        "reference",
      );
      return {
        system: { overall: summarize(scores, "agent").overall },
        reference: { overall: summarize(scores, "reference").overall },
        againstReference: {
          games,
          teamGames,
          metrics: Object.fromEntries(
            Object.entries(metrics).map(
              ([name, { ratio, delta, ratio90, delta90 }]) => [
                name,
                { ratio, delta, ratio90, delta90 },
              ],
            ),
          ),
          guardrailFlag,
        },
        fallbacks: forecasts.filter((f) => f.fallback).length,
      };
    },
    compare: (a: string, b: string) =>
      pairedComparison(previous(a).scores, previous(b).scores),
    close: () => pool.close(),
  };
}

async function approveNomination(
  host: EvaluationHost,
  pool: EvaluationPool,
  id: string,
  recorded?: (receipt: ReviewReceipt) => void,
) {
  if (pool.round() && !agentGate(pool).met)
    throw Error(
      "Round-two nomination requires a completed full evaluation with successful agent replies in at least half of its team-games",
    );
  const parent = pool.complete(id);
  if (parent.kind !== "full") throw Error("Nominate a full evaluation");
  const dev = archiveRun(join(host.root, "development", id));
  if (dev.hash !== parent.hash || readPackage(parent.pkg).hash !== parent.hash)
    throw Error("Nominee differs from the evaluated configuration");
  const guard = pairedComparison(dev.scores, dev.scores, "reference");
  if (!guard.games || guard.guardrailFlag)
    throw Error("Configuration ineligible for nomination");
  const nominee = pool.remaining().nominee;
  if (nominee === id) return restoreAcceptance(host.root, parent.pkg, recorded);
  if (nominee) throw Error("A different configuration was nominated");
  const pkg = await review(host.root, host.review, parent.pkg, recorded);
  pool.nominate(id);
  return pkg;
}

/** Operator-only entry point. A completed full development evaluation supplies
 * the immutable nominee and its trained weights. Final records stay separate. */
export async function finalEvaluation(host: EvaluationHost, id: string) {
  const pool = openPool(host);
  try {
    const games = finalGames(host.source.schedule);
    const round = pool.round();
    if (round && !host.roundOneFinal)
      throw Error(
        "Pass the round-one nominated final record for the round-two comparison",
      );
    const baseline = round
      ? await roundOneFinal(
          host.roundOneFinal!,
          round.baselineHash,
          round.sourceEnvironment,
        )
      : null;
    const expectedGames = new Set(
      games.map((g) => JSON.stringify([g.teamId, g.gameId, g.tip])),
    );
    if (
      baseline &&
      (baseline.scores.length !== games.length ||
        baseline.scores.some(
          (g) =>
            !expectedGames.has(JSON.stringify([g.teamId, g.gameId, g.tip])),
        ))
    )
      throw Error(
        "Round-one final team-games differ from the round-two final schedule",
      );
    const pkg = await approveNomination(host, pool, id);
    const dir = join(host.root, "final", id);
    mkdirSync(dir, { recursive: true });
    const modes = [
      "nominated",
      ...(Object.keys(pkg.agents).length ? ["agents-off"] : []),
      "clear-artifacts",
    ];
    // The runs are independent replays with their own records, so the ones
    // still to do run side by side (SPO-941). The weights are read once
    // first: pool.models is not safe to call for a missing hash from several
    // runs at once.
    if (pkg.training.length)
      await pool.models(readPackage(pkg).hash, () =>
        buildModels(host.config, pkg, host.training, host.root),
      );
    const ended = await Promise.allSettled(
      modes
        .map((mode) => [mode, join(dir, mode)])
        .filter(([, root]) => !existsSync(join(root, "record.sqlite")))
        .map(([mode, root]) =>
          execute(host, pool, root, pkg, games, false, mode),
        ),
    );
    // Every run is left to finish before a failure is reported: a completed
    // run is kept and is not paid for again.
    for (const run of ended) if (run.status === "rejected") throw run.reason;
    const runs: Record<string, ReturnType<typeof results>> = {};
    for (const mode of modes) runs[mode] = results(join(dir, mode));
    return {
      runs,
      ...(baseline
        ? {
            againstRoundOne: pairedComparison(
              runs.nominated.archive.scores,
              baseline.scores,
            ),
          }
        : {}),
      comparisons: Object.fromEntries(
        Object.keys(runs)
          .filter((k) => k !== "nominated")
          .map((k) => [
            k,
            pairedComparison(
              runs.nominated.archive.scores,
              runs[k].archive.scores,
            ),
          ]),
      ),
    };
  } finally {
    pool.close();
  }
}
