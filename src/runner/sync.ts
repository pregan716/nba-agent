import { backup } from "node:sqlite";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { z } from "zod";
import { RecordStore } from "./record.js";
import { readBlob } from "./blobs.js";
import { digest } from "./config.js";
export interface CheckpointSink {
  has(key: string): Promise<boolean>;
  put(key: string, bytes: Buffer): Promise<void>;
}
export interface CheckpointSource {
  get(key: string): Promise<Buffer>;
}
/** Credentials belong to the runner host, never the session or harness. */
export class R2CheckpointSink implements CheckpointSink, CheckpointSource {
  constructor(
    private client: S3Client,
    private bucket: string,
    private prefix: string,
  ) {
    if (
      !bucket ||
      !prefix ||
      prefix.startsWith("/") ||
      prefix.split("/").includes("..")
    )
      throw Error("Explicit checkpoint destination required");
  }
  async has(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: `${this.prefix}/${key}`,
        }),
      );
      return true;
    } catch (error: any) {
      if (error.$metadata?.httpStatusCode === 404) return false;
      throw error; // Authorization and transport errors must not become overwrites.
    }
  }
  async get(key: string): Promise<Buffer> {
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: `${this.prefix}/${key}`,
      }),
    );
    if (!result.Body) throw Error("Missing checkpoint object body");
    return Buffer.from(await result.Body.transformToByteArray());
  }
  async put(key: string, bytes: Buffer): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: `${this.prefix}/${key}`,
        Body: bytes,
        ContentType: "application/octet-stream",
      }),
    );
  }
}
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const indexSchema = z.strictObject({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  head: hash,
  seq: z.number().int().positive(),
  objects: z.array(
    z.strictObject({
      key: z
        .string()
        .regex(/^(record\.sqlite|manifest\.json|blobs\/[a-f0-9]{64})$/),
      sha256: hash,
      bytes: z.number().int().nonnegative(),
    }),
  ),
});
type CheckpointIndex = z.infer<typeof indexSchema>;
function parseIndex(bytes: Buffer): CheckpointIndex {
  const index = indexSchema.parse(JSON.parse(bytes.toString("utf8")));
  const keys = index.objects.map((o) => o.key);
  if (
    new Set(keys).size !== keys.length ||
    !keys.includes("record.sqlite") ||
    !keys.includes("manifest.json")
  )
    throw Error("Invalid checkpoint index objects");
  return index;
}
/** v2: database/manifest stay per checkpoint; immutable blobs live once per run. */
export async function checkpoint(
  record: RecordStore,
  sink?: CheckpointSink,
): Promise<string> {
  const head = record.events().at(-1)!;
  const dir = join(record.root, "checkpoints", String(head.seq));
  mkdirSync(dir, { recursive: true });
  const marker = join(dir, "index.json");
  const prepared = join(dir, "prepared-index.json");
  let index: CheckpointIndex;
  if (existsSync(marker) || existsSync(prepared)) {
    index = {
      ...parseIndex(readFileSync(existsSync(marker) ? marker : prepared)),
      schemaVersion: 2,
    };
    if (index.head !== head.hash || index.seq !== head.seq)
      throw Error("Checkpoint head mismatch");
  } else {
    // SQLite online backup captures a consistent DB, not a possibly live WAL copy.
    await backup(record.db, join(dir, "record.sqlite"));
    writeFileSync(
      join(dir, "manifest.json"),
      readFileSync(join(record.root, "manifest.json")),
      { mode: 0o600 },
    );
    const keys = [
      "record.sqlite",
      "manifest.json",
      ...readdirSync(join(record.root, "blobs"))
        .sort()
        .map((h) => `blobs/${h}`),
    ];
    index = {
      schemaVersion: 2,
      head: head.hash,
      seq: head.seq,
      objects: keys.map((key) => {
        const bytes = key.startsWith("blobs/")
          ? readBlob(record.root, key.slice(6))
          : readFileSync(join(dir, key));
        return { key, sha256: sha256(bytes), bytes: bytes.length };
      }),
    };
  }
  // Persist the exact file index before the first remote write. If an upload
  // succeeds but its response is lost, retries must not replace published DB
  // bytes beneath an existing marker with a newly generated SQLite backup.
  const preparedTemporary = `${prepared}.tmp`;
  writeFileSync(preparedTemporary, JSON.stringify(index, null, 2), {
    mode: 0o600,
    flush: true,
  });
  renameSync(preparedTemporary, prepared);
  const m = record.events("manifest")[0].data;
  const runPrefix = `${m.config.runId}/${m.config.replicateId}`;
  const prefix = `${runPrefix}/${head.seq}-${head.hash}`;
  for (const object of index.objects) {
    const blob = object.key.startsWith("blobs/");
    const bytes = readFileSync(join(blob ? record.root : dir, object.key));
    if (bytes.length !== object.bytes || sha256(bytes) !== object.sha256)
      throw Error("Checkpoint object integrity mismatch");
    const key = `${blob ? runPrefix : prefix}/${object.key}`;
    if (sink && (!blob || !(await sink.has(key)))) await sink.put(key, bytes);
  }
  const bytes = Buffer.from(JSON.stringify(index, null, 2));
  // Both publication markers come last. Failed uploads leave no new marker;
  // already uploaded shared blobs survive and are skipped on the next attempt.
  if (sink) await sink.put(`${prefix}/index.json`, bytes);
  const temporaryMarker = join(dir, "index.json.tmp");
  writeFileSync(temporaryMarker, bytes, { mode: 0o600, flush: true });
  renameSync(temporaryMarker, marker);
  return dir;
}

/** Restore only indexed objects, validate everything, then atomically expose a fresh root.
 * Keys are relative to the sink's configured prefix, e.g. run/replicate/seq-hash/index.json.
 */
export async function restoreCheckpoint(
  source: CheckpointSource,
  indexKey: string,
  target: string,
): Promise<void> {
  if (
    !/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/[1-9][0-9]*-[a-f0-9]{64}\/index\.json$/.test(
      indexKey,
    )
  )
    throw Error("Invalid checkpoint index key");
  if (existsSync(target)) throw Error("Restore requires a fresh run root");
  const index = parseIndex(await source.get(indexKey));
  const [runId, replicateId, checkpointId] = indexKey.split("/");
  if (checkpointId !== `${index.seq}-${index.head}`)
    throw Error("Checkpoint head mismatch");
  mkdirSync(dirname(target), { recursive: true });
  const staging = mkdtempSync(join(dirname(target), ".restore-"));
  try {
    for (const object of index.objects) {
      const prefix =
        index.schemaVersion === 2 && object.key.startsWith("blobs/")
          ? `${runId}/${replicateId}`
          : `${runId}/${replicateId}/${checkpointId}`;
      const bytes = await source.get(`${prefix}/${object.key}`);
      if (bytes.length !== object.bytes || sha256(bytes) !== object.sha256)
        throw Error("Checkpoint object integrity mismatch");
      if (
        object.key.startsWith("blobs/") &&
        digest(bytes.toString("base64")) !== object.key.slice(6)
      )
        throw Error("Blob content address mismatch");
      const path = join(staging, object.key);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes, { mode: 0o600 });
    }
    const restored = new RecordStore(staging);
    try {
      const events = restored.events(),
        manifest = events[0]?.data;
      if (
        events.at(-1)?.hash !== index.head ||
        events.at(-1)?.seq !== index.seq ||
        manifest.config.runId !== runId ||
        manifest.config.replicateId !== replicateId
      )
        throw Error("Restored record does not match index");
    } finally {
      restored.close();
    }
    renameSync(staging, target);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
