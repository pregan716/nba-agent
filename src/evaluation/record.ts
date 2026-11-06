import { DatabaseSync } from "node:sqlite";
import { readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import type { Event } from "../runner/record.js";

export class EvaluationError extends Error {
  constructor(
    readonly reason: string,
    detail: string,
  ) {
    super(`${reason}: ${detail}`);
  }
}
export const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
export interface RecordedRun {
  source: { path: string; sha256: string; lastEventHash: string };
  manifest: any;
  events: Event[];
}
/** Opens only SQLite in read-only mode; never creates a manifest, journal or cache. */
export function readRecord(path: string): RecordedRun {
  const file = resolve(
    statSync(path).isDirectory() ? join(path, "record.sqlite") : path,
  );
  const bytes = readFileSync(file);
  if (bytes.subarray(0, 16).toString() !== "SQLite format 3\0")
    throw new EvaluationError("record_not_sqlite", file);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "delete")
      throw new EvaluationError(
        "unsupported_journal_mode",
        "Use a stable DELETE-mode record/checkpoint, not a WAL-dependent database",
      );
    db.exec("BEGIN");
    const rows = db
      .prepare(
        "SELECT seq,kind,scope,data,previous,hash,at FROM events ORDER BY seq",
      )
      .all();
    let previous = "genesis";
    const events = rows.map((row, i) => {
      if (
        row.seq !== i + 1 ||
        row.previous !== previous ||
        row.hash !== hash([row.kind, row.scope, row.data, row.previous, row.at])
      )
        throw new EvaluationError("record_integrity", `event ${row.seq}`);
      previous = row.hash as string;
      return {
        ...row,
        data: JSON.parse(row.data as string),
      } as unknown as Event;
    });
    if (
      events[0]?.kind !== "manifest" ||
      events.filter((e) => e.kind === "manifest").length !== 1
    )
      throw new EvaluationError("missing_manifest", file);
    if (!readFileSync(file).equals(bytes))
      throw new EvaluationError("record_changed_during_read", file);
    return {
      source: {
        path: file,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        lastEventHash: previous,
      },
      manifest: events[0].data,
      events,
    };
  } finally {
    db.close();
  }
}
