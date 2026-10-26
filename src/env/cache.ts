import { resolve } from "node:path";

/** Operational placement only; the cache's content keys still bind data and game identity. */
export function historyExportCacheDirectory(
  path = process.env.NBA_HISTORY_EXPORT_CACHE ?? ".cache/history-export-v2",
): string {
  if (!path.trim())
    throw Error("History export cache directory must not be empty");
  return resolve(path);
}
