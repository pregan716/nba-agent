import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  writeFileSync,
  chmodSync,
  existsSync,
  copyFileSync,
  readFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { Temporal } from "@js-temporal/polyfill";
import type { RecordEnvelope } from "../data/contracts.js";
import type { SessionSource } from "./source.js";
import {
  GAME_HISTORY_TABLES,
  type ColumnDefinition,
  type Scalar,
} from "./contract.js";
import { visible, releasedGame } from "./visibility.js";
import { randomUUID } from "node:crypto";
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
  append = false,
) {
  signal.throwIfAborted();
  mkdirSync(join(directory, "evidence"), { recursive: true });
  chmodSync(directory, 0o755);
  const file = join(directory, "session.sqlite");
  if (append && existsSync(file)) chmodSync(file, 0o644);
  const db = new DatabaseSync(file);
  const schemas = new Map<string, Set<string>>();
  try {
    db.exec("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF");
    for await (const batch of batches) {
      signal.throwIfAborted();
      let columns = schemas.get(batch.table);
      if (!columns) {
        columns = new Set(["_row"]);
        schemas.set(batch.table, columns);
        db.exec(
          `CREATE TABLE IF NOT EXISTS ${quote(batch.table)} (_row INTEGER PRIMARY KEY)`,
        );
      }
      if (append)
        for (const c of db
          .prepare(`PRAGMA table_info(${quote(batch.table)})`)
          .all())
          columns.add(String(c.name));
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
      const keys = [...columns].filter((k) => k !== "_row");
      db.exec("BEGIN");
      const statement = keys.length
        ? db.prepare(
            `INSERT INTO ${quote(batch.table)} (${keys.map(quote).join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
          )
        : undefined;
      for (const row of rows) {
        statement?.run(
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
      db.exec("COMMIT");
    }
  } finally {
    db.close();
  }
  chmodSync(file, 0o444);
  return file;
}

/** Shared published-column allowlist: no internal envelope or arbitrary source fields. */
export function projectHistory(
  record: RecordEnvelope,
  definitions: ColumnDefinition[],
  cutoff?: string,
): Record<string, Scalar> {
  const row: Record<string, Scalar> = {};
  for (const { name } of definitions) {
    if (!Object.hasOwn(record.data, name)) continue;
    const value = record.data[name];
    row[name === "type" ? "kind" : name] =
      value === null || ["string", "number", "boolean"].includes(typeof value)
        ? value
        : JSON.stringify(value);
  }
  if (cutoff && typeof record.data.birth_date === "string") {
    const date = Temporal.Instant.from(cutoff)
      .toZonedDateTimeISO("America/New_York")
      .toPlainDate();
    row.age_on_replay_date = Temporal.PlainDate.from(
      record.data.birth_date,
    ).until(date, { largestUnit: "years" }).years;
  }
  return row;
}
/** Corpus adapters opt into cross-process caching only with pinned, immutable inputs.
 * Other adapters (including fixtures) use temporary caches and cutoff keys.
 */
export async function mountGameShards(
  directory: string,
  source: SessionSource,
  games: RecordEnvelope[],
  cutoff: string,
  signal: AbortSignal,
) {
  const transient = !source.exportCacheDirectory;
  const cache =
    source.exportCacheDirectory ??
    mkdtempSync(join(tmpdir(), "nba-history-cache-"));
  try {
    mkdirSync(cache, { recursive: true });
    const entries = games.map((game) => {
      const key = digest([
        "history-export-v4",
        source.versions,
        game,
        source.exportCacheDirectory ? null : cutoff,
      ]);
      return { game, key, target: join(cache!, key + ".sqlite.gz") };
    });
    const missing = entries.filter((e) => !existsSync(e.target));
    if (missing.length) {
      const staging = join(cache, randomUUID());
      const selected = new Map(missing.map((e) => [e.game.id, e]));
      try {
        for (const table of GAME_HISTORY_TABLES) {
          const definitions = await source.columns(table);
          const columns = definitions.map((c) =>
            c.name === "type" ? "kind" : c.name,
          );
          async function* fallback() {
            for (const { game } of missing)
              yield { gameId: game.id, ...(await source.history(table, game)) };
          }
          const batches =
            source.exportHistory?.(
              table,
              missing.map((e) => e.game),
            ) ?? fallback();
          const seen = new Set<string>();
          for await (const batch of batches) {
            signal.throwIfAborted();
            const entry = selected.get(batch.gameId);
            if (!entry)
              throw Error("Export adapter returned an unselected game");
            const releasedAt = releasedGame(entry.game).availableAt;
            if (
              source.exportCacheDirectory &&
              batch.records.some((r) => !visible(r, releasedAt))
            )
              throw Error("History record is later than its game release");
            const rows = batch.reason
              ? []
              : batch.records
                  .filter((r) => visible(r, cutoff))
                  .map((r) => projectHistory(r, definitions));
            async function* projected() {
              yield { table, columns, rows };
              yield {
                table: "unavailable",
                columns: ["table", "game_id", "reason"],
                rows: batch.reason
                  ? [{ table, game_id: entry!.game.id, reason: batch.reason }]
                  : [],
              };
            }
            await writeSessionExport(
              join(staging, entry.key),
              projected(),
              signal,
              true,
            );
            seen.add(batch.gameId);
          }
          for (const entry of missing.filter((e) => !seen.has(e.game.id))) {
            async function* empty() {
              yield { table, columns, rows: [] };
            }
            await writeSessionExport(
              join(staging, entry.key),
              empty(),
              signal,
              true,
            );
          }
        }
        signal.throwIfAborted();
        for (const entry of missing) {
          signal.throwIfAborted();
          const compressed = join(staging, entry.key, "shard.sqlite.gz");
          writeFileSync(
            compressed,
            gzipSync(readFileSync(join(staging, entry.key, "session.sqlite")), {
              level: 6,
            }),
            { mode: 0o444 },
          );
          renameSync(compressed, entry.target);
        }
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    }
    mkdirSync(join(directory, "games"), { recursive: true, mode: 0o755 });
    chmodSync(directory, 0o755);
    for (const entry of entries) {
      signal.throwIfAborted();
      copyFileSync(
        entry.target,
        join(directory, "games", entry.key + ".sqlite.gz"),
      );
    }
  } finally {
    if (transient) rmSync(cache, { recursive: true, force: true });
  }
}
