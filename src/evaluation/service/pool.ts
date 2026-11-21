import type { BuiltModels } from "../../game-loop/models.js";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { TeamGame } from "../../game-loop/replay.js";
import type { Package } from "../../game-loop/package.js";
import { canonicalJson } from "../../env/tools.js";
import type { evaluationProfile } from "./profile.js";

export class EvaluationPool {
  readonly db: DatabaseSync;
  private leases = new Map<string, DatabaseSync>();
  constructor(
    readonly root: string,
    readonly profile: typeof evaluationProfile,
    environment: string,
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    mkdirSync(join(root, "leases"), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(root, "evaluations.sqlite"));
    try {
      this.db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL,nominee TEXT);
    CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,parent TEXT,hash TEXT NOT NULL,pkg TEXT NOT NULL,games TEXT NOT NULL,full INTEGER NOT NULL,charge INTEGER NOT NULL,status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS refusals(id INTEGER PRIMARY KEY,kind TEXT,hash TEXT,reason TEXT NOT NULL,at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS models(hash TEXT PRIMARY KEY,weights TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS inherited_runs(id TEXT PRIMARY KEY,charge INTEGER NOT NULL,full INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS round_info(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);`);
      const value = canonicalJson({ profile, environment });
      this.db
        .prepare("INSERT OR IGNORE INTO settings VALUES(1,?,NULL)")
        .run(value);
      if (this.db.prepare("SELECT value FROM settings").get()?.value !== value)
        throw Error("Different evaluation profile or environment in this pool");
    } catch (e) {
      this.db.close();
      throw e;
    }
  }
  // A separate SQLite writer lock belongs to the evaluator process for the
  // duration of a run. The OS releases it on process death.
  private lock(id: string) {
    const lease = new DatabaseSync(join(this.root, "leases", id + ".sqlite"));
    try {
      lease.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
    } catch (e) {
      lease.close();
      if ((e as { errcode?: number }).errcode === 5) return false;
      throw e;
    }
    this.leases.set(id, lease);
    return true;
  }
  private unlock(id: string) {
    this.leases.get(id)?.close();
    this.leases.delete(id);
  }
  close() {
    for (const id of this.leases.keys()) this.unlock(id);
    this.db.close();
  }
  recover(
    inspect: (id: string) => { usd: number; status: "complete" | "failed" },
  ) {
    for (const { id } of this.db
      .prepare("SELECT id FROM runs WHERE status='running'")
      .all()) {
      const key = String(id);
      if (this.leases.has(key) || !this.lock(key)) continue;
      try {
        if (
          this.db.prepare("SELECT status FROM runs WHERE id=?").get(key)
            ?.status === "running"
        ) {
          const r = inspect(key);
          this.settle(key, r.usd, r.status);
        }
      } finally {
        this.unlock(key);
      }
    }
  }
  round() {
    const row = this.db
      .prepare("SELECT value FROM round_info WHERE id=1")
      .get();
    return row
      ? (JSON.parse(String(row.value)) as {
          round: 2;
          baselineRunId: string;
          baselineHash: string;
          sourceEnvironment: string;
        })
      : null;
  }
  inherited(id: string) {
    return !!this.db.prepare("SELECT 1 FROM inherited_runs WHERE id=?").get(id);
  }
  list() {
    return this.db
      .prepare(
        "SELECT id,kind,parent,hash,status,charge*1e-9 AS accountedUsd FROM runs ORDER BY rowid",
      )
      .all();
  }
  refusals() {
    return this.db
      .prepare("SELECT kind,hash,reason,at FROM refusals ORDER BY id")
      .all();
  }
  complete(id: string) {
    const row = this.db
      .prepare(
        "SELECT kind,hash,pkg,games FROM runs WHERE id=? AND status='complete'",
      )
      .get(id);
    if (!row) throw Error("Unknown completed development run");
    return {
      kind: String(row.kind),
      hash: String(row.hash),
      pkg: JSON.parse(String(row.pkg)) as Package,
      games: JSON.parse(String(row.games)) as TeamGame[],
    };
  }
  remaining() {
    const totals = this.db
      .prepare(
        "SELECT COALESCE(SUM(full),0) AS full, COALESCE(SUM(charge),0) AS charge FROM runs",
      )
      .get()!;
    return {
      nominee:
        this.db.prepare("SELECT nominee FROM settings").get()?.nominee ?? null,
      fullEvaluations: this.profile.fullLimit - Number(totals.full),
      evaluationUsd:
        (Math.round(1e9 * this.profile.poolUsd) - Number(totals.charge)) / 1e9,
    };
  }
  reserve(
    kind: string,
    parent: string | null,
    hash: string,
    pkg: Package,
    games: TeamGame[],
  ) {
    const full = Number(kind !== "test"),
      cost = Math.round(
        1e9 * games.length * this.profile.replay.usdPerTeamGame,
      );
    const id = randomUUID();
    let refusal = "";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const remaining = this.remaining();
      if (remaining.nominee) refusal = "Development closed after nomination";
      else if (full > remaining.fullEvaluations)
        refusal = "Full evaluation cap exceeded";
      else if (cost > Math.round(1e9 * remaining.evaluationUsd))
        refusal = "Evaluation dollar pool exceeded";
      if (refusal)
        this.db
          .prepare("INSERT INTO refusals(kind,hash,reason,at) VALUES(?,?,?,?)")
          .run(kind, hash, refusal, new Date().toISOString());
      else {
        if (!this.lock(id)) throw Error("Run reservation collision");
        this.db
          .prepare("INSERT INTO runs VALUES(?,?,?,?,?,?,?,?, 'running')")
          .run(
            id,
            kind,
            parent,
            hash,
            JSON.stringify(pkg),
            JSON.stringify(games),
            full,
            cost,
          );
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.unlock(id);
      this.db.exec("ROLLBACK");
      throw e;
    }
    if (refusal) throw Error(refusal);
    return id;
  }
  settle(id: string, usd: number, status: "complete" | "failed") {
    if (!Number.isFinite(usd) || usd < 0)
      throw Error("Invalid evaluation charge");
    const r = this.db
      .prepare(
        "UPDATE runs SET status=?,charge=? WHERE id=? AND status='running'",
      )
      .run(status, Math.round(usd * 1e9), id);
    if (r.changes !== 1) throw Error("Unknown reservation");
    this.unlock(id);
  }
  nominate(id: string) {
    const r = this.db
      .prepare(
        "UPDATE settings SET nominee=? WHERE (nominee IS NULL OR nominee=?) AND NOT EXISTS(SELECT 1 FROM runs WHERE status='running')",
      )
      .run(id, id);
    if (r.changes !== 1)
      throw Error("A run is active or a different configuration was nominated");
  }
  async models(hash: string, build: () => Promise<BuiltModels>) {
    const read = () =>
      this.db.prepare("SELECT weights FROM models WHERE hash=?").get(hash);
    if (!read())
      this.db
        .prepare("INSERT OR IGNORE INTO models VALUES(?,?)")
        .run(hash, JSON.stringify(await build()));
    return JSON.parse(String(read()!.weights)) as BuiltModels;
  }
}
