import { writeBlob } from "../runner/blobs.js";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  fsyncSync,
} from "node:fs";
import { resolve, join, isAbsolute } from "node:path";
import type { RunConfig } from "../runner/config.js";
import { SessionError, type Phase, type WorkspaceEntry } from "./contract.js";

export type WorkspaceOperation =
  "list" | "read" | "write" | "append" | "delete";
export interface WorkspaceChange {
  operation: "write" | "append" | "delete";
  path: string;
  sha256?: string;
}
/** Shared policy for tool calls and P3f's mediated filesystem operations. */
export class WorkspacePolicy {
  constructor(
    private memory: RunConfig["profile"]["memory"],
    private phase: () => Phase | "closed",
  ) {}
  authorize(operation: WorkspaceOperation, exists = false) {
    if (!["list", "read", "write", "append", "delete"].includes(operation))
      throw new SessionError(
        "invalid_input",
        "Unsupported workspace operation",
      );
    if (!["pregame", "postgame"].includes(this.phase()))
      throw new SessionError("phase_refused", "Workspace locked in this phase");
    if (this.memory.horizon === "stateless")
      throw new SessionError(
        "memory_mode_refused",
        "Stateless workspace tools disabled",
      );
    if (
      this.memory.revision === "append-only" &&
      (operation === "delete" || (operation === "write" && exists))
    )
      throw new SessionError(
        "memory_mode_refused",
        "Append-only workspace forbids replacing or deleting files",
      );
  }
}
const invalid = () =>
  new SessionError(
    "invalid_input",
    "Workspace requires relative paths and ordinary files/directories",
  );

/** P3f mount adapter receives only these bound operations, never a writable host path.
 * Unsupported filesystem operations (rename, link, truncate, mmap) must be refused.
 */
export interface WorkspacePort {
  authorize(operation: WorkspaceChange["operation"], path: string): void;
  mkdir(path: string): void;
  list(path?: string): { entries: WorkspaceEntry[] };
  readBytes(path: string): Buffer;
  mutate(
    operation: WorkspaceChange["operation"],
    path: string,
    content?: Buffer,
  ): { path: string; bytes: number };
}

/** Trusted service. Never give the harness its directory or mount it directly writable.
 * P3f must mediate mount operations through this service, including binary writes.
 * Calls are synchronous and runner-serialized; no other writer may own the directory.
 */
export class Workspace {
  #root: string;
  #changes: WorkspaceChange[] = [];
  constructor(
    root: string,
    readonly policy: WorkspacePolicy,
    private runRoot: string,
  ) {
    this.#root = resolve(root);
    this.#ordinary(this.#root, true);
  }
  #ordinary(path: string, directory = false) {
    const stat = lstatSync(path);
    if (
      stat.isSymbolicLink() ||
      (!stat.isDirectory() && !stat.isFile()) ||
      (stat.isFile() && stat.nlink !== 1) ||
      (directory && !stat.isDirectory())
    )
      throw invalid();
    return stat;
  }
  #path(path: string, root = false) {
    if (typeof path !== "string") throw invalid();
    if (root && path === "") return this.#root;
    if (
      !path ||
      isAbsolute(path) ||
      /^[a-z]:/i.test(path) ||
      path.includes("\\") ||
      path.includes("\0") ||
      path.split("/").some((p) => !p || p === "." || p === "..")
    )
      throw invalid();
    this.#ordinary(this.#root, true);
    const parts = path.split("/");
    let current = this.#root;
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]);
      try {
        this.#ordinary(current, i < parts.length - 1);
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    return current;
  }
  #exists(path: string) {
    try {
      return this.#ordinary(path);
    } catch (e: any) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }
  #error(e: unknown): never {
    if (e instanceof SessionError) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT")
      throw new SessionError("not_found", "Workspace entry not found");
    // Do not expose the host path from filesystem errors.
    throw invalid();
  }
  authorize(operation: WorkspaceChange["operation"], path: string) {
    this.policy.authorize(operation);
    try {
      this.policy.authorize(operation, !!this.#exists(this.#path(path)));
    } catch (e) {
      this.#error(e);
    }
  }
  list(path = "") {
    this.policy.authorize("list");
    try {
      const target = this.#path(path, true);
      this.#ordinary(target, true);
      const entries: WorkspaceEntry[] = readdirSync(target)
        .sort()
        .map((name) => {
          const stat = this.#ordinary(join(target, name));
          return {
            path: path ? `${path}/${name}` : name,
            kind: stat.isDirectory() ? "directory" : "file",
            bytes: stat.isFile() ? stat.size : null,
          };
        });
      return { entries };
    } catch (e) {
      return this.#error(e);
    }
  }
  mkdir(path: string) {
    this.policy.authorize("write");
    try {
      const target = this.#path(path);
      mkdirSync(target, { recursive: true, mode: 0o700 });
      this.#ordinary(target, true);
    } catch (e) {
      this.#error(e);
    }
  }
  readBytes(path: string): Buffer {
    this.policy.authorize("read");
    try {
      const target = this.#path(path);
      const fd = openSync(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1) throw invalid();
        return readFileSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch (e) {
      return this.#error(e);
    }
  }
  read(path: string) {
    const bytes = this.readBytes(path);
    return { path, content: bytes.toString("utf8"), bytes: bytes.length };
  }
  mutate(
    operation: WorkspaceChange["operation"],
    path: string,
    content = Buffer.alloc(0),
  ) {
    if (
      !["write", "append", "delete"].includes(operation) ||
      !Buffer.isBuffer(content)
    )
      throw invalid();
    this.policy.authorize(operation);
    try {
      const target = this.#path(path),
        existing = this.#exists(target);
      this.policy.authorize(operation, !!existing);
      if (existing && !existing.isFile()) throw invalid();
      // Persist journal bytes before mutating; failed operations may leave an
      // unreferenced blob, but successful operations never reference missing data.
      const sha256 =
        operation === "delete" ? undefined : writeBlob(this.runRoot, content);
      if (operation === "delete") {
        unlinkSync(target);
      } else {
        mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });
        const fd = openSync(
          target,
          constants.O_WRONLY |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK |
            (existing ? 0 : constants.O_CREAT | constants.O_EXCL) |
            (operation === "append" ? constants.O_APPEND : constants.O_TRUNC),
          0o600,
        );
        try {
          const stat = fstatSync(fd);
          if (!stat.isFile() || stat.nlink !== 1) throw invalid();
          writeFileSync(fd, content);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
      this.#changes.push({
        operation,
        path,
        ...(sha256 === undefined ? {} : { sha256 }),
      });
      return {
        path,
        bytes: operation === "delete" ? 0 : this.#ordinary(target).size,
      };
    } catch (e) {
      return this.#error(e);
    }
  }
  changes(): WorkspaceChange[] {
    return structuredClone(this.#changes);
  }
}
