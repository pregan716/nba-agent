import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export type Bucket =
  | "pm-data-platform"
  | "sports-nba-data"
  | "sports-text"
  | "sports-transcription";
export interface ObjectRef {
  bucket: Bucket;
  key: string;
  sha256: string;
  bytes?: number;
}
export interface ObjectStore {
  get(bucket: Bucket, key: string): Promise<Buffer>;
}
export const sha256 = (body: Uint8Array) =>
  createHash("sha256").update(body).digest("hex");
export function verify(body: Buffer, ref: ObjectRef): Buffer {
  if (
    !/^[a-f0-9]{64}$/.test(ref.sha256) ||
    sha256(body) !== ref.sha256 ||
    (ref.bytes !== undefined && body.length !== ref.bytes)
  ) {
    throw new Error(`Integrity mismatch: ${ref.bucket}/${ref.key}`);
  }
  return body;
}
export class VerifiedStore {
  constructor(
    private store: ObjectStore,
    private cache?: string,
  ) {}
  async read(ref: ObjectRef): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(ref.sha256))
      throw new Error("Invalid object digest");
    const path = this.cache && `${this.cache}/${ref.sha256}`;
    if (path) {
      try {
        return verify(await readFile(path), ref);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const body = verify(await this.store.get(ref.bucket, ref.key), ref);
    if (path) {
      await mkdir(this.cache!, { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, body);
      await rename(temporary, path);
    }
    return body;
  }
  async json<T = any>(ref: ObjectRef): Promise<T> {
    return JSON.parse((await this.read(ref)).toString());
  }
}

// This handle belongs only to trusted environment code. Doppler injects secrets into
// the worker, never into the caller or analyst harness. No LIST/PUT operation exists.
export class DopplerStore implements ObjectStore {
  private workers = new Map<Bucket, ChildProcessWithoutNullStreams>();
  private pending = new Map<
    number,
    {
      resolve: (body: Buffer) => void;
      reject: (error: Error) => void;
      bucket: Bucket;
    }
  >();
  private sequence = 0;
  get(bucket: Bucket, key: string): Promise<Buffer> {
    let worker = this.workers.get(bucket);
    if (!worker) {
      const config = bucket === "pm-data-platform" ? "prd" : "dev";
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => !/^(R2_|AWS_|ANTHROPIC_|OPENAI_)/.test(name),
        ),
      );
      worker = spawn(
        "doppler",
        [
          "run",
          "--project",
          bucket,
          "--config",
          config,
          "--no-fallback",
          "--",
          process.execPath,
          fileURLToPath(
            new URL("../../scripts/r2-worker.mjs", import.meta.url),
          ),
          bucket,
          config,
        ],
        { env, stdio: "pipe" },
      );
      this.workers.set(bucket, worker);
      const fail = () => {
        this.workers.delete(bucket);
        for (const [id, pending] of this.pending)
          if (pending.bucket === bucket) {
            pending.reject(
              new Error(`R2 reader failed for ${bucket}; check Doppler access`),
            );
            this.pending.delete(id);
          }
      };
      worker.on("error", fail);
      worker.on("exit", fail);
      // Do not forward SDK or Doppler diagnostics, which may include configuration.
      worker.stderr.resume();
      createInterface({ input: worker.stdout }).on("line", (line) => {
        try {
          const message = JSON.parse(line),
            pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          if (message.error)
            pending.reject(
              new Error(`R2 read failed: ${bucket}/${message.key}`),
            );
          else pending.resolve(Buffer.from(message.body, "base64"));
        } catch {
          fail();
          worker!.kill();
        }
      });
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, bucket });
      worker!.stdin.write(JSON.stringify({ id, key }) + "\n");
    });
  }
  close() {
    for (const worker of this.workers.values()) worker.kill();
  }
}
