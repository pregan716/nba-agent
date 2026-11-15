import { join } from "node:path";
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
import {
  developmentRequest,
  developmentGames,
  evaluationProfile,
  profileSchema,
  finalGames,
} from "./profile.js";
import { buildModels, type TrainingData } from "./training.js";

import {
  review,
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
        const run = await execute(host, pool, root, pkg, games);
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
    budget: () => pool.remaining(),
    nominate(id: string) {
      eligibleNominee(host, pool, id);
      pool.nominate(id);
    },
    list: () => pool.list(),
    refusals: () => pool.refusals(),
    archive: previous,
    summary(id: string) {
      const { scores } = previous(id);
      return {
        system: summarize(scores, "agent"),
        reference: summarize(scores, "reference"),
        againstReference: pairedComparison(scores, scores, "reference"),
      };
    },
    compare: (a: string, b: string) =>
      pairedComparison(previous(a).scores, previous(b).scores),
    close: () => pool.close(),
  };
}

function eligibleNominee(
  host: EvaluationHost,
  pool: EvaluationPool,
  id: string,
) {
  const parent = pool.complete(id);
  if (parent.kind !== "full") throw Error("Nominate a full evaluation");
  const dev = archiveRun(join(host.root, "development", id));
  const guard = pairedComparison(dev.scores, dev.scores, "reference");
  if (!guard.games || guard.guardrailFlag)
    throw Error("Configuration ineligible for nomination");
  return parent;
}

/** Operator-only entry point. A completed full development evaluation supplies
 * the immutable nominee and its trained weights. Final records stay separate. */
export async function finalEvaluation(host: EvaluationHost, id: string) {
  const pool = openPool(host);
  try {
    const parent = eligibleNominee(host, pool, id);
    const games = finalGames(host.source.schedule);
    const pkg = await review(host.root, host.review, parent.pkg);
    pool.nominate(id);
    const dir = join(host.root, "final", id);
    mkdirSync(dir, { recursive: true });
    const runs: Record<string, ReturnType<typeof results>> = {};
    for (const mode of [
      "nominated",
      ...(Object.keys(parent.pkg.agents).length ? ["agents-off"] : []),
      "clear-artifacts",
    ]) {
      const root = join(dir, mode);
      if (!existsSync(join(root, "record.sqlite")))
        await execute(host, pool, root, pkg, games, mode);
      runs[mode] = results(root);
    }
    return {
      runs,
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
