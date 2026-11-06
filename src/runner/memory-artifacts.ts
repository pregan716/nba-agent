import { canonicalJson } from "../env/tools.js";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  mkdtempSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { PackageStore } from "../policy/package.js";
import { sha256 } from "../data/store.js";
import { readBlob } from "./blobs.js";
import { digest } from "./config.js";
import { restore, type RecordStore, type Snapshot } from "./record.js";

/** Rehydrate trusted artifacts after moving a blob-backed runner checkpoint.
 * Agent mounts still use the phase-filtered workspace/feedback adapters. */
export function restoreMemoryArtifacts(root: string, record: RecordStore) {
  const packages = new PackageStore(join(root, "frozen-packages"));
  for (const event of record.events("package_freeze")) {
    const { receipt, workspace } = event.data;
    const existing = packages.receipt(event.scope);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(receipt))
        throw Error("Frozen receipt differs from record");
      continue;
    }
    const prefix = `packages/${event.scope}/`,
      files: Snapshot["files"] = Object.create(null);
    for (const [name, hash] of Object.entries(receipt.files) as [
      string,
      string,
    ][]) {
      const blob = workspace.files[prefix + name];
      if (sha256(readBlob(root, blob)) !== hash)
        throw Error("Frozen package blob differs from receipt");
      files[name] = blob;
    }
    mkdirSync(packages.root, { recursive: true });
    const stage = mkdtempSync(join(packages.root, ".restore-"));
    try {
      restore(root, join(stage, "package"), { files });
      writeFileSync(join(stage, "receipt.json"), JSON.stringify(receipt), {
        mode: 0o400,
        flush: true,
      });
      renameSync(stage, packages.path(event.scope));
      packages.receipt(event.scope); // validate the package manifest too
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
  for (const event of record.events("replay_completed")) {
    const bytes = readBlob(root, event.data.feedbackBlob);
    if (digest(JSON.parse(bytes.toString())) !== event.data.feedbackHash)
      throw Error("Feedback blob differs from record");
    const path = join(root, "feedback", event.scope + ".json");
    if (existsSync(path)) {
      if (!readFileSync(path).equals(bytes))
        throw Error("Feedback differs from record");
      continue;
    }
    mkdirSync(join(root, "feedback"), { recursive: true });
    const temp = path + ".restore";
    writeFileSync(temp, bytes, { mode: 0o400, flush: true });
    renameSync(temp, path);
  }
}
