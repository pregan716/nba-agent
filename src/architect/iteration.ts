import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

const units = 1e9;
export const architectLimits = { iterationUsd: 30, totalUsd: 350 };
// One writer for the architect workspace. A separate OS-released lock leaves
// committed notes and outstanding provider reservations durable after a crash.
export class Iteration {
  readonly id = randomUUID();
  readonly db!: DatabaseSync;
  private lock: DatabaseSync;
  status = "running";
  constructor(root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.lock = new DatabaseSync(join(root, "architect.lock.sqlite"));
    try {
      this.lock.exec("BEGIN EXCLUSIVE");
      this.db = new DatabaseSync(join(root, "architect.sqlite"));
      this.db
        .exec(`CREATE TABLE IF NOT EXISTS iterations(id TEXT PRIMARY KEY, started TEXT DEFAULT CURRENT_TIMESTAMP,status TEXT NOT NULL,spent INTEGER DEFAULT 0,held INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY, iteration TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents(area TEXT,name TEXT,content TEXT NOT NULL,PRIMARY KEY(area,name));
      CREATE TABLE IF NOT EXISTS hypotheses(name TEXT PRIMARY KEY,description TEXT NOT NULL,closed INTEGER DEFAULT 0);
      UPDATE iterations SET status='interrupted' WHERE status='running'`);
      this.db
        .prepare("INSERT INTO iterations(id,status) VALUES(?,'running')")
        .run(this.id);
    } catch (e) {
      this.db?.close();
      this.lock.close();
      throw e;
    }
  }
  record(kind: string, data: unknown) {
    this.db
      .prepare("INSERT INTO events(iteration,kind,data) VALUES(?,?,?)")
      .run(this.id, kind, JSON.stringify(data));
  }
  budget() {
    const row = this.db
      .prepare(
        "SELECT spent+held AS used,(SELECT sum(spent+held) FROM iterations) AS total FROM iterations WHERE id=?",
      )
      .get(this.id)!;
    const totalUsd = Math.max(
      0,
      architectLimits.totalUsd - Number(row.total) / units,
    );
    const sessionUsd = Math.max(
      0,
      Math.min(
        totalUsd,
        architectLimits.iterationUsd - Number(row.used) / units,
      ),
    );
    return {
      sessionUsd,
      totalUsd,
      ...(sessionUsd <= 3
        ? { warning: "Budget low. Save work and submit or nominate now." }
        : {}),
    };
  }
  reserve(usd: number) {
    const held = Math.round(usd * units);
    if (
      !Number.isSafeInteger(held) ||
      held <= 0 ||
      held > Math.round(this.budget().sessionUsd * units)
    )
      throw Error("Insufficient architect budget");
    if (
      !this.db
        .prepare("UPDATE iterations SET held=? WHERE id=? AND held=0")
        .run(held, this.id).changes
    )
      throw Error("Outstanding architect request");
    return (actual: number) => {
      const spent = Math.round(actual * units);
      if (!Number.isSafeInteger(spent) || spent < 0)
        throw Error("Invalid architect usage");
      if (
        !this.db
          .prepare(
            "UPDATE iterations SET held=0,spent=spent+? WHERE id=? AND held=?",
          )
          .run(spent, this.id, held).changes
      )
        throw Error("Invalid architect settlement");
      if (spent > held) throw Error("Architect provider exceeded reservation");
    };
  }
  close() {
    try {
      this.db
        .prepare("UPDATE iterations SET status=? WHERE id=?")
        .run(this.status, this.id);
    } finally {
      this.db.close();
      this.lock.close();
    }
  }
}
