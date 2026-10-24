import { readBlob, writeBlob } from "./blobs.js";
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
      const bytes = readBlob(root, change.sha256);
      contents.set(
        change.path,
        change.operation === "append"
          ? Buffer.concat([contents.get(change.path) ?? Buffer.alloc(0), bytes])
          : bytes,
      );
    }
  }
  const files: Record<string, string> = Object.create(null);
  for (const [path, bytes] of contents) files[path] = writeBlob(root, bytes);
  return { files };
}
