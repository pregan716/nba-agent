import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { digest } from "../runner/config.js";
import type { FetchEvidenceResult } from "./contract.js";
export interface ExportBatch {
  table: string;
  rows: object[];
  columns?: string[];
}
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
/** Only accepts already filtered public projections from Session. No source adapter access. */
export async function writeSessionExport(
  directory: string,
  batches: AsyncIterable<ExportBatch>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  mkdirSync(join(directory, "evidence"), { recursive: true });
  chmodSync(directory, 0o755);
  const file = join(directory, "session.sqlite");
  const db = new DatabaseSync(file);
  const schemas = new Map<string, Set<string>>();
  try {
    db.exec("BEGIN");
    for await (const batch of batches) {
      signal.throwIfAborted();
      let columns = schemas.get(batch.table);
      if (!columns) {
        columns = new Set(["_row"]);
        schemas.set(batch.table, columns);
        db.exec(
          `CREATE TABLE ${quote(batch.table)} (_row INTEGER PRIMARY KEY)`,
        );
      }
      const rows = batch.rows.map(
        (row) => ({ ...row }) as Record<string, unknown>,
      );
      if (batch.table === "evidence")
        for (const row of rows) {
          const evidence = row as unknown as FetchEvidenceResult;
          const path = `evidence/${digest(evidence.evidence_id)}.txt`;
          writeFileSync(join(directory, path), evidence.text, { mode: 0o444 });
          row.text_path = path;
        }
      for (const key of new Set([
        ...(batch.columns ?? []),
        ...rows.flatMap(Object.keys),
      ]))
        if (!columns.has(key)) {
          db.exec(`ALTER TABLE ${quote(batch.table)} ADD COLUMN ${quote(key)}`);
          columns.add(key);
        }
      for (const row of rows) {
        const keys = Object.keys(row);
        if (!keys.length) continue;
        db.prepare(
          `INSERT INTO ${quote(batch.table)} (${keys.map(quote).join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
        ).run(
          ...keys.map((k) => {
            const v = row[k];
            return v === undefined || v === null
              ? null
              : typeof v === "boolean"
                ? Number(v)
                : typeof v === "string" || typeof v === "number"
                  ? v
                  : JSON.stringify(v);
          }),
        );
      }
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  chmodSync(file, 0o444);
  return file;
}
