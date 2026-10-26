import { isAbsolute, resolve } from "node:path";

/** Operational placement only; the cache's content keys still bind data and game identity. */
export function historyExportCacheDirectory(path?: string): string {
  if (path === undefined) {
    const fromEnv = process.env.NBA_HISTORY_EXPORT_CACHE;
    if (fromEnv !== undefined && !isAbsolute(fromEnv))
      throw Error("NBA_HISTORY_EXPORT_CACHE must be an absolute path");
    path = fromEnv ?? ".cache/history-export-v2";
  }
  if (!path.trim())
    throw Error("History export cache directory must not be empty");
  return resolve(path);
}
