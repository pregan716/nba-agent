import { gunzipSync } from "node:zlib";
import { parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { VerifiedStore, type ObjectRef } from "./store.js";
import type { Row } from "./contracts.js";
export const jsonLines = (body: Buffer): Row[] =>
  body
    .toString()
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
export async function parquet(body: Buffer): Promise<Row[]> {
  const rows = await parquetReadObjects({
    file: body.buffer.slice(
      body.byteOffset,
      body.byteOffset + body.byteLength,
    ) as ArrayBuffer,
    compressors,
  });
  return JSON.parse(
    JSON.stringify(rows, (_, v) => {
      if (typeof v !== "bigint") return v;
      const number = Number(v);
      if (!Number.isSafeInteger(number))
        throw Error("Parquet integer exceeds safe JSON range");
      return number;
    }),
  );
}
export class Release {
  private constructor(
    readonly root: ObjectRef,
    readonly manifest: Row,
    private store: VerifiedStore,
    readonly objects: Map<string, ObjectRef>,
  ) {}
  static async open(root: ObjectRef, store: VerifiedStore): Promise<Release> {
    const manifest = await store.json(root),
      objects = new Map<string, ObjectRef>();
    const add = (key: string, sha256: string, bytes?: number) => {
      if (!key || !/^[a-f0-9]{64}$/.test(sha256))
        throw new Error("Invalid manifest reference");
      if (objects.has(key) && objects.get(key)!.sha256 !== sha256)
        throw new Error("Conflicting object hashes");
      objects.set(key, {
        bucket: root.bucket,
        key,
        sha256,
        ...(bytes === undefined ? {} : { bytes }),
      });
    };
    if (Array.isArray(manifest.objects))
      for (const ref of manifest.objects) add(ref.key, ref.sha256, ref.bytes);
    else if (manifest.objects)
      for (const [key, hash] of Object.entries(manifest.objects))
        add(manifest.object_prefix + key, hash as string);
    for (const field of ["partitions", "team_snapshot_partitions"])
      for (const ref of manifest[field] ?? [])
        add(ref.key, ref.sha256, ref.bytes);
    if (manifest.rows?.objectKey)
      add(manifest.rows.objectKey, manifest.rows.sha256);
    return new Release(root, manifest, store, objects);
  }
  ref(key: string): ObjectRef {
    const ref = this.objects.get(key);
    if (!ref) throw new Error(`Object not in manifest: ${key}`);
    return ref;
  }
  async bytes(key: string): Promise<Buffer> {
    return this.store.read(this.ref(key));
  }
  async rows(key: string): Promise<Row[]> {
    const body = await this.bytes(key);
    if (key.endsWith(".parquet")) return parquet(body);
    if (key.endsWith(".gz")) return jsonLines(gunzipSync(body));
    return jsonLines(body);
  }
  async table(
    name: string,
    phase?: string,
  ): Promise<{ row: Row; ref: ObjectRef }[]> {
    let keys: string[];
    if (this.manifest.tables) {
      const names = this.manifest.tables[name];
      if (!names) throw new Error(`Unknown table: ${name}`);
      keys = names
        .filter(
          (key: string) =>
            !phase ||
            key.includes(`/phase=${phase}/`) ||
            key.includes("/shared/"),
        )
        .map((key: string) => this.manifest.object_prefix + key);
    } else
      keys = [...this.objects.keys()].filter(
        (key) =>
          key.startsWith(this.manifest.prefix) &&
          key.endsWith(`/${name}.parquet`),
      );
    if (!keys.length) throw new Error(`No release table: ${name}`);
    const result: { row: Row; ref: ObjectRef }[] = [];
    for (const key of keys)
      for (const row of await this.rows(key))
        result.push({ row, ref: this.ref(key) });
    return result;
  }
}
