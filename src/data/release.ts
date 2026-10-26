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
export interface RowCacheLimits {
  maxEntries: number;
  /** Sum of serialized decoded row sizes; excludes transient decoder memory. */
  maxBytes: number;
}
const DEFAULT_ROW_CACHE: RowCacheLimits = {
  maxEntries: 8,
  maxBytes: 128 * 1024 * 1024,
};
function freezeRows<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeRows(child);
    Object.freeze(value);
  }
  return value;
}
export class Release {
  private rowCache = new Map<string, { rows: Row[]; bytes: number }>();
  private rowCacheBytes = 0;
  private rowLoads = new Map<string, Promise<Row[]>>();
  private constructor(
    readonly root: ObjectRef,
    readonly manifest: Row,
    private store: VerifiedStore,
    readonly objects: Map<string, ObjectRef>,
    private rowCacheLimits: RowCacheLimits,
  ) {}
  static async open(
    root: ObjectRef,
    store: VerifiedStore,
    rowCacheLimits: RowCacheLimits = DEFAULT_ROW_CACHE,
  ): Promise<Release> {
    if (
      ![rowCacheLimits.maxEntries, rowCacheLimits.maxBytes].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      )
    )
      throw Error("Invalid row cache limits");
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
    return new Release(root, manifest, store, objects, { ...rowCacheLimits });
  }
  /** Follow the source-manifest hash pinned by this release, never a live latest pointer. */
  async sourceRelease(): Promise<Release> {
    const source = this.manifest.sourceManifest;
    if (!source?.manifest || !source.sha256)
      throw Error("Missing pinned source manifest");
    return Release.open(
      { bucket: this.root.bucket, key: source.manifest, sha256: source.sha256 },
      this.store,
    );
  }
  ref(key: string): ObjectRef {
    const ref = this.objects.get(key);
    if (!ref) throw new Error(`Object not in manifest: ${key}`);
    return ref;
  }
  async bytes(key: string): Promise<Buffer> {
    return this.store.read(this.ref(key));
  }
  /** Shared immutable decoded rows. Clone before modifying. Visibility is still
   * enforced by the Session on every read, never by this cutoff-independent cache. */
  async rows(key: string): Promise<Row[]> {
    const ref = this.ref(key); // Even a cache hit must be a manifest-listed object.
    const format = key.endsWith(".parquet")
      ? "parquet"
      : key.endsWith(".gz")
        ? "gzip"
        : "jsonl";
    const cacheKey = `${format}:${ref.sha256}`;
    const cached = this.rowCache.get(cacheKey);
    if (cached) {
      this.rowCache.delete(cacheKey);
      this.rowCache.set(cacheKey, cached);
      return cached.rows;
    }
    const pending = this.rowLoads.get(cacheKey);
    if (pending) return pending;
    const load = async () => {
      const body = await this.store.read(ref);
      const rows = freezeRows(
        format === "parquet"
          ? await parquet(body)
          : jsonLines(format === "gzip" ? gunzipSync(body) : body),
      );
      const bytes = Buffer.byteLength(JSON.stringify(rows));
      const limits = this.rowCacheLimits;
      // Oversized objects remain readable but never evict useful entries.
      if (limits.maxEntries > 0 && bytes <= limits.maxBytes) {
        while (
          this.rowCache.size >= limits.maxEntries ||
          this.rowCacheBytes + bytes > limits.maxBytes
        ) {
          const oldest = this.rowCache.keys().next().value!;
          this.rowCacheBytes -= this.rowCache.get(oldest)!.bytes;
          this.rowCache.delete(oldest);
        }
        this.rowCache.set(cacheKey, { rows, bytes });
        this.rowCacheBytes += bytes;
      }
      return rows;
    };
    const request = load();
    this.rowLoads.set(cacheKey, request);
    try {
      return await request;
    } finally {
      this.rowLoads.delete(cacheKey);
    }
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
