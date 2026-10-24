import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { digest } from "./config.js";

/** Use the same content address as P4 snapshots so full-file writes deduplicate. */
export function writeBlob(root: string, bytes: Buffer): string {
  const hash = digest(bytes.toString("base64"));
  mkdirSync(join(root, "blobs"), { recursive: true });
  try {
    writeFileSync(join(root, "blobs", hash), bytes, {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
  } catch (e: any) {
    if (e.code !== "EEXIST") throw e;
  }
  return hash;
}
export function readBlob(root: string, hash: string | undefined): Buffer {
  if (!hash || !/^[a-f0-9]{64}$/.test(hash))
    throw Error("Invalid workspace blob hash");
  const bytes = readFileSync(join(root, "blobs", hash));
  if (digest(bytes.toString("base64")) !== hash)
    throw Error("Workspace blob integrity mismatch");
  return bytes;
}
