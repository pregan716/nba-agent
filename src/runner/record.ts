import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  copyFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join, relative } from "node:path";
import { digest, type Manifest } from "./config.js";

export interface Event {
  seq: number;
  kind: string;
  scope: string;
  data: any;
  previous: string;
  hash: string;
  at: string;
}
export class RecordStore {
  readonly db: DatabaseSync;
  constructor(
    readonly root: string,
    expected?: Manifest,
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(root, "record.sqlite"));
    this.db
      .exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, scope TEXT NOT NULL, data TEXT NOT NULL, previous TEXT NOT NULL, hash TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS immutable_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'immutable record'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'immutable record'); END;
      CREATE UNIQUE INDEX IF NOT EXISTS one_submission ON events(scope) WHERE kind='submission';
      CREATE INDEX IF NOT EXISTS events_scope_kind ON events(scope,kind);
      CREATE UNIQUE INDEX IF NOT EXISTS one_manifest ON events(kind) WHERE kind='manifest';`);
    this.verify();
    const saved = this.events("manifest")[0];
    if (saved && expected && digest(saved.data) !== digest(expected))
      throw Error("Run manifest mismatch; create a new run");
    if (saved && !existsSync(join(root, "manifest.json")))
      writeFileSync(
        join(root, "manifest.json"),
        JSON.stringify(saved.data, null, 2) + "\n",
        { mode: 0o600, flush: true },
      );
    if (
      saved &&
      readFileSync(join(root, "manifest.json"), "utf8") !==
        JSON.stringify(saved.data, null, 2) + "\n"
    )
      throw Error("Manifest file integrity mismatch");
    if (!saved) {
      if (!expected) throw Error("Missing manifest");
      this.append("manifest", "run", expected);
      writeFileSync(
        join(root, "manifest.json"),
        JSON.stringify(expected, null, 2) + "\n",
        { mode: 0o600 },
      );
    }
  }
  events(kind?: string, scope?: string): Event[] {
    const clauses: string[] = [],
      params: string[] = [];
    if (kind) {
      clauses.push("kind=?");
      params.push(kind);
    }
    if (scope) {
      clauses.push("scope=?");
      params.push(scope);
    }
    const query = `SELECT * FROM events ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY seq`;
    return (
      this.db.prepare(query).all(...params) as unknown as (Omit<
        Event,
        "data"
      > & { data: string })[]
    ).map((e) => ({ ...e, data: JSON.parse(e.data) }));
  }
  append(kind: string, scope: string, data: unknown): Event {
    return this.appendMany([{ kind, scope, data }])[0];
  }
  private appendMany(
    entries: { kind: string; scope: string; data: unknown }[],
  ): Event[] {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const events: Event[] = [];
      for (const { kind, scope, data } of entries) {
        const previous =
          (this.db
            .prepare("SELECT hash FROM events ORDER BY seq DESC LIMIT 1")
            .get()?.hash as string) ?? "genesis";
        const at = new Date().toISOString(),
          encoded = JSON.stringify(data),
          hash = digest([kind, scope, encoded, previous, at]);
        const result = this.db
          .prepare(
            "INSERT INTO events(kind,scope,data,previous,hash,at) VALUES(?,?,?,?,?,?)",
          )
          .run(kind, scope, encoded, previous, hash, at);
        events.push({
          seq: Number(result.lastInsertRowid),
          kind,
          scope,
          data: JSON.parse(encoded),
          previous,
          hash,
          at,
        });
      }
      this.db.exec("COMMIT");
      return events;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  verify(): void {
    let previous = "genesis";
    for (const row of this.db
      .prepare("SELECT * FROM events ORDER BY seq")
      .all()) {
      if (
        row.previous !== previous ||
        row.hash !==
          digest([row.kind, row.scope, row.data, row.previous, row.at])
      )
        throw Error("Record hash chain mismatch");
      previous = row.hash as string;
    }
  }
  submission(
    game: string,
    value: unknown,
    attempt?: unknown,
  ): { receipt: string } {
    const existing = this.events("submission", game)[0];
    const receipt = digest([game, value]);
    if (existing) {
      if (existing.data.receipt !== receipt)
        throw Error("Submission already frozen");
      return { receipt };
    }
    this.appendMany([
      ...(attempt
        ? [{ kind: "submission_attempt", scope: game, data: attempt }]
        : []),
      { kind: "submission", scope: game, data: { receipt, value } },
    ]);
    return { receipt };
  }
  close(): void {
    this.db.close();
  }
}

export interface Snapshot {
  files: Record<string, string>;
}
export function snapshot(root: string, workspace: string): Snapshot {
  const files: Record<string, string> = {};
  const blobs = join(root, "blobs");
  mkdirSync(blobs, { recursive: true });
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry),
        stat = lstatSync(path);
      if (
        stat.isSymbolicLink() ||
        (!stat.isDirectory() && !stat.isFile()) ||
        (stat.isFile() && stat.nlink > 1)
      )
        throw Error("Workspace must contain only ordinary files/directories");
      if (stat.isDirectory()) walk(path);
      else {
        const bytes = readFileSync(path),
          hash = digest(bytes.toString("base64"));
        Object.defineProperty(files, relative(workspace, path), {
          value: hash,
          enumerable: true,
          configurable: true,
          writable: true,
        });
        try {
          writeFileSync(join(blobs, hash), bytes, {
            flag: "wx",
            mode: 0o600,
            flush: true,
          });
        } catch (e: any) {
          if (e.code !== "EEXIST") throw e;
        }
      }
    }
  };
  walk(workspace);
  return { files };
}
export function restore(root: string, workspace: string, snap: Snapshot): void {
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  for (const [path, hash] of Object.entries(snap.files)) {
    if (
      path.startsWith("/") ||
      path.split(/[\\/]/).includes("..") ||
      !/^[a-f0-9]{64}$/.test(hash)
    )
      throw Error("Invalid snapshot path");
    const source = join(root, "blobs", hash),
      bytes = readFileSync(source);
    if (digest(bytes.toString("base64")) !== hash)
      throw Error("Snapshot integrity mismatch");
    const target = join(workspace, path);
    mkdirSync(join(target, ".."), { recursive: true });
    copyFileSync(source, target);
  }
}
export function diff(before: Snapshot, after: Snapshot) {
  return {
    added: Object.keys(after.files).filter(
      (p) => !Object.hasOwn(before.files, p),
    ),
    removed: Object.keys(before.files).filter(
      (p) => !Object.hasOwn(after.files, p),
    ),
    changed: Object.keys(after.files).filter(
      (p) =>
        Object.hasOwn(before.files, p) && before.files[p] !== after.files[p],
    ),
  };
}
