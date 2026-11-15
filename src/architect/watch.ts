// Read-only inspection of a pool directory while an architect iteration runs
// (SPO-907). The pilot's watcher polls this and stops the run on the first
// team-game of a full-size evaluation with no forecast, on repeated agent
// failures, or on spend. Test runs are left alone: showing the architect a
// failing configuration is what a test run is for.
import { existsSync } from "node:fs";
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

export function inspectPool(root: string, limits: WatchLimits) {
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
    if (run.status !== "running") {
      evaluationUsd += usd(run.charge);
      continue;
    }
    const id = String(run.id),
      kind = String(run.kind);
    const state = read(
      join(root, "development", id, "record.sqlite"),
      (db) => ({
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
            .prepare(
              "SELECT count(*) AS n FROM events WHERE kind='agent_error'",
            )
            .get()!.n,
        ),
      }),
    ) ?? { usd: 0, done: 0, missing: [], agentErrors: 0 };
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
    if (kind === "test") continue;
    const first = state.missing[0];
    if (first)
      stop ??= `No forecast for team-game ${first.scope} in ${kind} run ${id}: ${first.reason}`;
    else if (state.agentErrors > limits.maxAgentErrors)
      stop ??= `${state.agentErrors} failed agent calls in ${kind} run ${id}`;
  }
  const totalUsd = architectUsd + reviewerUsd + evaluationUsd;
  if (totalUsd > limits.maxUsd)
    stop ??= `Spend $${totalUsd.toFixed(2)} is over the $${limits.maxUsd} limit`;
  return { stop, totalUsd, architectUsd, reviewerUsd, evaluationUsd, active };
}
