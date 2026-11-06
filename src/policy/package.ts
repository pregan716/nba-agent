import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  renameSync,
  rmSync,
  chmodSync,
  existsSync,
  mkdtempSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { sha256 } from "../data/store.js";
import { canonicalJson } from "../env/tools.js";
import { STATE_VERSION } from "../replay/types.js";
import type { Assembler } from "./sandbox.js";
const file = z
  .string()
  .regex(/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/)
  .refine((s) => !s.split("/").some((x) => x === "." || x === ".."));
export const packageSchema = z.strictObject({
  stateVersion: z.literal(STATE_VERSION),
  components: z.record(file, z.string().regex(/^[a-f0-9]{64}$/)).optional(),
  notes: z.string().optional(),
});
export interface PackageReceipt {
  gameId: string;
  packageHash: string;
  manifestHash: string;
  stateVersion: typeof STATE_VERSION;
  files: Record<string, string>;
}
/** No symlinks, hard links, devices, unlisted files or paths outside the package. */
export function packageFiles(directory: string) {
  const files = new Map<string, Buffer>();
  let size = 0;
  function walk(path: string, prefix = "") {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw Error("Package must contain ordinary files/directories");
    for (const name of readdirSync(path).sort()) {
      const key = prefix + name;
      file.parse(key);
      const p = join(path, name),
        s = lstatSync(p);
      if (
        s.isSymbolicLink() ||
        (!s.isFile() && !s.isDirectory()) ||
        (s.nlink > 1 && s.isFile())
      )
        throw Error("Package links and special files refused");
      if (s.isDirectory()) walk(p, key + "/");
      else {
        size += s.size;
        if (size > 8 * 1024 * 1024 || files.size >= 256)
          throw Error("Package size limit");
        files.set(key, readFileSync(p));
      }
    }
  }
  walk(directory);
  const manifest = packageSchema.parse(
    JSON.parse(files.get("manifest.json")?.toString() ?? "null"),
  );
  const declared = manifest.components
      ? Object.keys(manifest.components).sort()
      : [...files.keys()].filter((k) => k !== "manifest.json").sort(),
    actual = [...files.keys()].filter((k) => k !== "manifest.json").sort();
  if (
    canonicalJson(declared) !== canonicalJson(actual) ||
    !declared.includes("assemble.py")
  )
    throw Error(
      "Package component list must include every file and assemble.py",
    );
  for (const key of declared)
    if (
      manifest.components &&
      sha256(files.get(key)!) !== manifest.components[key]
    )
      throw Error(`Package hash mismatch: ${key}`);
  return { files, manifest };
}
export class PackageStore {
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }
  path(gameId: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(gameId)) throw Error("Invalid game id");
    return join(this.root, gameId);
  }
  receipt(gameId: string): PackageReceipt | null {
    const path = this.path(gameId);
    if (!existsSync(path)) return null;
    const { files } = packageFiles(join(path, "package"));
    const receipt = JSON.parse(
      readFileSync(join(path, "receipt.json"), "utf8"),
    );
    const hashes = Object.fromEntries(
      [...files].map(([k, v]) => [k, sha256(v)]),
    );
    if (
      receipt.gameId !== gameId ||
      canonicalJson(receipt.files) !== canonicalJson(hashes) ||
      receipt.packageHash !== sha256(Buffer.from(canonicalJson(hashes)))
    )
      throw Error("Frozen package integrity mismatch");
    return receipt;
  }
  async freeze(
    gameId: string,
    source: string,
    clock: () => string,
    cutoff: string,
    assembler: Assembler,
    signal: AbortSignal,
  ): Promise<PackageReceipt> {
    const before = () => {
      if (
        !Number.isFinite(Date.parse(clock())) ||
        !(Date.parse(clock()) < Date.parse(cutoff))
      )
        throw Error("Package freeze cutoff passed");
    };
    before();
    const { files } = packageFiles(source),
      hashes = Object.fromEntries([...files].map(([k, v]) => [k, sha256(v)]));
    const receipt: PackageReceipt = {
      gameId,
      packageHash: sha256(Buffer.from(canonicalJson(hashes))),
      manifestHash: hashes["manifest.json"],
      stateVersion: STATE_VERSION,
      files: hashes,
    };
    const existing = this.receipt(gameId);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(receipt))
        throw Error("Package already frozen");
      return existing;
    }
    const stage = mkdtempSync(join(this.root, ".freeze-"));
    try {
      mkdirSync(join(stage, "package"));
      for (const [name, bytes] of files) {
        const path = join(stage, "package", name);
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, bytes, { mode: 0o444, flush: true });
      }
      const loaded = await assembler.run(
        join(stage, "package"),
        null,
        signal,
        "load",
      );
      if (canonicalJson(loaded.value) !== '{"loaded":true}')
        throw Error("Package load validation failed");
      before();
      signal.throwIfAborted();
      writeFileSync(join(stage, "receipt.json"), canonicalJson(receipt), {
        mode: 0o444,
        flush: true,
      });
      // All agent filesystem operations are mediated; the snapshot is outside their mounts.
      const lock = (path: string) => {
        for (const n of readdirSync(path)) {
          const p = join(path, n);
          if (lstatSync(p).isDirectory()) lock(p);
        }
        chmodSync(path, 0o555);
      };
      lock(stage);
      renameSync(stage, this.path(gameId));
      return receipt;
    } finally {
      if (existsSync(stage)) {
        const unlock = (p: string) => {
          chmodSync(p, 0o700);
          for (const n of readdirSync(p)) {
            const c = join(p, n);
            if (lstatSync(c).isDirectory()) unlock(c);
          }
        };
        unlock(stage);
        rmSync(stage, { recursive: true, force: true });
      }
    }
  }
}
