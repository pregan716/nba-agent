import { backup } from "node:sqlite";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { RecordStore } from "./record.js";
export interface CheckpointSink {
  put(key: string, bytes: Buffer): Promise<void>;
}
/** Credentials belong to the runner host, never the session or harness. */
export class R2CheckpointSink implements CheckpointSink {
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
export async function checkpoint(
  record: RecordStore,
  sink?: CheckpointSink,
): Promise<string> {
  const head = record.events().at(-1)!;
  const dir = join(record.root, "checkpoints", String(head.seq));
  mkdirSync(dir, { recursive: true });
  const db = join(dir, "record.sqlite");
  // SQLite online backup captures a consistent DB, not a possibly live WAL copy.
  await backup(record.db, db);
  const paths = [
    { key: "record.sqlite", path: db },
    { key: "manifest.json", path: join(record.root, "manifest.json") },
  ];
  for (const file of readdirSync(join(record.root, "blobs")))
    paths.push({
      key: `blobs/${file}`,
      path: join(record.root, "blobs", file),
    });
  const objects = [];
  const m = record.events("manifest")[0].data;
  const prefix = `${m.config.runId}/${m.config.replicateId}/${head.seq}-${head.hash}`;
  for (const file of paths) {
    const bytes = readFileSync(file.path),
      sha256 = createHash("sha256").update(bytes).digest("hex");
    objects.push({ key: file.key, sha256, bytes: bytes.length });
    if (file.key !== "record.sqlite") {
      const target = join(dir, file.key);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, bytes, { mode: 0o600 });
    }
    if (sink) await sink.put(`${prefix}/${file.key}`, bytes);
  }
  const index = Buffer.from(
    JSON.stringify(
      { schemaVersion: 1, head: head.hash, seq: head.seq, objects },
      null,
      2,
    ),
  );
  writeFileSync(join(dir, "index.json"), index);
  // Publication marker is last. A partial upload is never a complete checkpoint.
  if (sink) await sink.put(`${prefix}/index.json`, index);
  return dir;
}
