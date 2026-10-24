import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { digest } from "./config.js";
import type { Snapshot } from "./record.js";
import type { WorkspaceChange } from "../env/workspace.js";

/** Replay only writes from the last k games, not whole files inherited by them.
 * In particular, appending a new note never renews the older prefix's lifetime.
 */
export function windowSnapshot(
  root: string,
  changes: WorkspaceChange[],
): Snapshot {
  const contents = new Map<string, Buffer>();
  for (const change of changes) {
    if (change.operation === "delete") contents.delete(change.path);
    else {
      const bytes = Buffer.from(change.content!, "base64");
      contents.set(
        change.path,
        change.operation === "append"
          ? Buffer.concat([contents.get(change.path) ?? Buffer.alloc(0), bytes])
          : bytes,
      );
    }
  }
  const files: Record<string, string> = Object.create(null);
  mkdirSync(join(root, "blobs"), { recursive: true });
  for (const [path, bytes] of contents) {
    const hash = digest(bytes.toString("base64"));
    files[path] = hash;
    try {
      writeFileSync(join(root, "blobs", hash), bytes, {
        flag: "wx",
        mode: 0o600,
        flush: true,
      });
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
    }
  }
  return { files };
}
