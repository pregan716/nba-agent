// Read-only inspection of development and final runs (SPO-907, SPO-930).
// The watcher polls this and stops the run on the first
// team-game of a full-size evaluation with no forecast, on repeated agent
// failures, on an evaluation that failed since the watcher started, or on
// spend. A test run's missing forecasts are left alone: showing the architect
// a failing configuration is what a test run is for. A failed run of any kind
// is different: the replay itself threw, which is an infrastructure failure.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface WatchLimits {
  /** Model dollars across the pool: architect, reviewer and evaluations. */
  maxUsd: number;
  /** Failed agent calls tolerated in one full-size evaluation. */
  maxAgentErrors: number;
}
function read<T>(file: string, query: (db: DatabaseSync) => T): T | undefined {
  if (!existsSync(file)) return undefined;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=2000");
    return query(db);
  } finally {
    db.close();
  }
}
const usd = (units: unknown) => Number(units ?? 0) / 1e9;

/** Settled spend plus reservations still open, as the pool accounts a run. */
function recordSpend(db: DatabaseSync) {
  const holds = new Map<number, number>();
  for (const e of db
    .prepare("SELECT seq,data FROM events WHERE kind='agent_reservation'")
    .all())
    holds.set(Number(e.seq), JSON.parse(String(e.data)).usd);
  for (const e of db
    .prepare("SELECT data FROM events WHERE kind='agent_settlement'")
    .all()) {
    const d = JSON.parse(String(e.data));
    holds.set(d.reservation, d.actual);
  }
  return [...holds.values()].reduce((s, n) => s + n, 0);
}

function runState(file: string) {
  return (
    read(file, (db) => ({
      usd: recordSpend(db),
      done: Number(
        db
          .prepare("SELECT count(*) AS n FROM events WHERE kind='team_game'")
          .get()!.n,
      ),
      missing: db
        .prepare(
          "SELECT scope,json_extract(data,'$.reason') AS reason FROM events WHERE kind='team_game' AND json_extract(data,'$.frozen') IS NULL ORDER BY seq",
        )
        .all(),
      agentErrors: Number(
        db
          .prepare("SELECT count(*) AS n FROM events WHERE kind='agent_error'")
          .get()!.n,
      ),
    })) ?? { usd: 0, done: 0, missing: [], agentErrors: 0 }
  );
}

/** `known` holds the run ids that existed before this invocation started.
 * A run outside it that has failed stops the watcher, even if it started and
 * failed between two polls, and a full-size run outside it is checked for
 * missing forecasts and agent failures after it completes as well as while it
 * runs. Final modes use final/<nominee>/<mode> ids; only completed modes enter
 * the snapshot. Without `known`, every completed run is history. */
export function inspectPool(
  root: string,
  limits: WatchLimits,
  known?: ReadonlySet<string>,
) {
  const architectUsd =
    read(join(root, "architect.sqlite"), (db) =>
      usd(
        db.prepare("SELECT sum(spent+held) AS n FROM iterations").get()?.n ?? 0,
      ),
    ) ?? 0;
  const reviewerUsd =
    read(join(root, "reviews.sqlite"), (db) =>
      Number(
        db.prepare("SELECT sum(reviewerUsd) AS n FROM reviews").get()?.n ?? 0,
      ),
    ) ?? 0;
  const runs =
    read(join(root, "evaluations.sqlite"), (db) =>
      db
        .prepare("SELECT id,kind,games,charge,status FROM runs ORDER BY rowid")
        .all(),
    ) ?? [];
  let evaluationUsd = 0,
    stop: string | null = null;
  const active: {
    id: string;
    kind: string;
    teamGames: number;
    done: number;
    missing: number;
    agentErrors: number;
    usd: number;
  }[] = [];
  for (const run of runs) {
    const id = String(run.id),
      kind = String(run.kind);
    const running = run.status === "running",
      fresh = !!known && !known.has(id);
    if (!running) {
      evaluationUsd += usd(run.charge);
      if (run.status === "failed" && fresh)
        stop ??= `The ${kind} run ${id} failed`;
      // A full-size run that finished since the snapshot is still read, so a
      // missing forecast on its last games is not lost between two polls.
      if (!fresh || kind === "test") continue;
    }
    const state = runState(join(root, "development", id, "record.sqlite"));
    if (running) {
      evaluationUsd += state.usd;
      active.push({
        id,
        kind,
        teamGames: JSON.parse(String(run.games)).length,
        done: state.done,
        missing: state.missing.length,
        agentErrors: state.agentErrors,
        usd: state.usd,
      });
    }
    if (kind === "test") continue;
    const first = state.missing[0];
    if (first)
      stop ??= `No forecast for team-game ${first.scope} in ${kind} run ${id}: ${first.reason}`;
    else if (state.agentErrors > limits.maxAgentErrors)
      stop ??= `${state.agentErrors} failed agent calls in ${kind} run ${id}`;
  }
  // Final runs have no row in evaluations.sqlite. Only replay_end marks a
  // completed mode; a record can already exist while the replay is running.
  const finalRoot = join(root, "final");
  const finalRuns: string[] = [];
  for (const nominee of existsSync(finalRoot)
    ? readdirSync(finalRoot, { withFileTypes: true })
    : []) {
    if (!nominee.isDirectory()) continue;
    for (const mode of ["nominated", "agents-off", "clear-artifacts"]) {
      const file = join(finalRoot, nominee.name, mode, "record.sqlite");
      const status = read(file, (db) => ({
        complete: !!db
          .prepare("SELECT 1 FROM events WHERE kind='replay_end'")
          .get(),
        teamGames: Number(
          db
            .prepare(
              "SELECT json_array_length(data,'$.games') AS n FROM events WHERE kind='manifest'",
            )
            .get()?.n ?? 0,
        ),
      }));
      if (!status) continue;
      const id = `final/${nominee.name}/${mode}`;
      if (status.complete) finalRuns.push(id);
      const state = runState(file);
      evaluationUsd += state.usd;
      if (!status.complete)
        active.push({
          id,
          kind: mode,
          teamGames: status.teamGames,
          done: state.done,
          missing: state.missing.length,
          agentErrors: state.agentErrors,
          usd: state.usd,
        });
      if (status.complete && (!known || known.has(id))) continue;
      const first = state.missing[0];
      if (first)
        stop ??= `No forecast for team-game ${first.scope} in ${mode} run ${id}: ${first.reason}`;
      else if (state.agentErrors > limits.maxAgentErrors)
        stop ??= `${state.agentErrors} failed agent calls in ${mode} run ${id}`;
    }
  }
  const totalUsd = architectUsd + reviewerUsd + evaluationUsd;
  if (totalUsd > limits.maxUsd)
    stop ??= `Spend $${totalUsd.toFixed(2)} is over the $${limits.maxUsd} limit`;
  return {
    stop,
    totalUsd,
    architectUsd,
    reviewerUsd,
    evaluationUsd,
    active,
    runs: [...runs.map((r) => String(r.id)), ...finalRuns],
  };
}
