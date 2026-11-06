import { modelError } from "./retry.js";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { digest } from "./config.js";
import { writeBlob } from "./blobs.js";
import type { RecordStore } from "./record.js";
import { MEMORY_TOKEN_CAP } from "../env/memory.js";

export type MemoryFiles = Record<string, string>;
export type MemoryCounter = (files: MemoryFiles) => Promise<number>;
/** Reject binary memory rather than allowing uncounted retained bytes. */
export function textBytes(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    bytes,
  );
}
export function retainedFiles(
  root: string,
  visible: (path: string) => boolean = () => true,
): MemoryFiles {
  const files: MemoryFiles = {};
  const walk = (path: string) => {
    let entries;
    try {
      entries = readdirSync(join(root, path)).sort();
    } catch (e: any) {
      if (e.code === "ENOENT") return;
      throw e;
    }
    for (const name of entries) {
      const relative = path ? `${path}/${name}` : name;
      if (!visible(relative)) continue;
      const file = join(root, relative),
        stat = lstatSync(file);
      if (
        stat.isSymbolicLink() ||
        (!stat.isFile() && !stat.isDirectory()) ||
        (stat.isFile() && stat.nlink !== 1)
      )
        throw Error("Invalid retained memory entry");
      if (stat.isDirectory()) walk(relative);
      else files[relative] = textBytes(readFileSync(file));
    }
  };
  walk("memory");
  return files;
}
export function memoryRequest(files: MemoryFiles) {
  return {
    model: "claude-opus-4-6",
    max_tokens: 1,
    messages: [
      {
        role: "user" as const,
        content: JSON.stringify(
          Object.keys(files)
            .sort()
            .map((path) => ({ path, content: files[path] })),
        ),
      },
    ],
  };
}
/** Proposed counting protocol: pinned analyst count endpoint, no inference/budget charge.
 * The first recorded result for identical bytes is authoritative on resume. */
export function recordedMemoryCounter(
  record: RecordStore,
  scope: string,
  count: (request: ReturnType<typeof memoryRequest>) => Promise<number>,
): MemoryCounter {
  return async (files) => {
    if (!Object.keys(files).length) return 0;
    const request = memoryRequest(files),
      key = digest(request);
    const cached = record
      .events("memory_token_count")
      .find((e) => e.data.key === key);
    if (cached) return cached.data.tokens;
    let tokens: number;
    try {
      tokens = await count(request);
    } catch (error) {
      record.append("memory_token_count_error", scope, {
        key,
        model: request.model,
        error: modelError(error),
        requestBlob: writeBlob(
          record.root,
          Buffer.from(JSON.stringify(request)),
        ),
      });
      throw Error("Memory token counter unavailable; mutation refused");
    }
    if (!Number.isSafeInteger(tokens) || tokens < 0)
      throw Error("Invalid memory token count");
    record.append("memory_token_count", scope, {
      protocol: "analyst-count-snapshot-v1",
      key,
      model: request.model,
      tokens,
      requestBlob: writeBlob(record.root, Buffer.from(JSON.stringify(request))),
      researchBudgetCharged: false,
    });
    return tokens;
  };
}
export async function measureMemory(root: string, count: MemoryCounter) {
  const files = retainedFiles(root);
  let skillBytes = 0,
    skillFiles = 0;
  const walk = (path: string) => {
    let entries: string[];
    try {
      entries = readdirSync(path);
    } catch (e: any) {
      if (e.code === "ENOENT") return;
      throw e;
    }
    for (const name of entries) {
      const file = join(path, name),
        stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw Error("Invalid skill entry");
      if (stat.isDirectory()) walk(file);
      else {
        skillBytes += stat.size;
        skillFiles++;
      }
    }
  };
  walk(join(root, "skills"));
  return {
    tokens: await count(files),
    cap: MEMORY_TOKEN_CAP,
    bytes: Object.values(files).reduce((n, s) => n + Buffer.byteLength(s), 0),
    files: Object.keys(files).length,
    skills: { bytes: skillBytes, files: skillFiles },
    protocol: "analyst-count-snapshot-v1",
  };
}
