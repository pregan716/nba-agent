import { isMemoryV3, MEMORY_TOKEN_CAP } from "./memory.js";
import {
  retainedFiles,
  textBytes,
  type MemoryCounter,
} from "../runner/memory.js";
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
  existsSync,
} from "node:fs";
import { resolve, join, isAbsolute } from "node:path";
import type { RunConfig } from "../runner/config.js";
import {
  SessionError,
  type Phase,
  type WorkspaceEntry,
  type WorkspaceMutationResult,
} from "./contract.js";

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
    readonly packagesEnabled = false,
    private gameId?: string,
    private countMemory?: MemoryCounter,
    private feedback?: () => { gameId: string; content: Buffer } | undefined,
  ) {}
  get v3() {
    return isMemoryV3(this.memory);
  }
  visible(path: string) {
    try {
      this.authorize("list", false, path);
      return true;
    } catch {
      return false;
    }
  }
  get stateless() {
    return this.memory.horizon === "stateless";
  }
  authorize(operation: WorkspaceOperation, exists = false, path = "") {
    if (!["list", "read", "write", "append", "delete"].includes(operation))
      throw new SessionError(
        "invalid_input",
        "Unsupported workspace operation",
      );
    if (!["pregame", "postgame"].includes(this.phase()))
      throw new SessionError("phase_refused", "Workspace locked in this phase");
    if (isMemoryV3(this.memory)) {
      const memory = this.memory;
      const read = operation === "read" || operation === "list";
      const denied = () => {
        throw new SessionError("not_found", "Workspace entry unavailable");
      };
      if (!path) {
        if (read) return;
        return denied();
      }
      if (path === "scratch" || path.startsWith("scratch/")) return;
      if (path === "packages") {
        if (operation === "list") return;
        return denied();
      }
      if (path.startsWith("packages/")) {
        if (!this.gameId || path.split("/")[1] !== this.gameId) return denied();
        return;
      }
      if (path === "memory") {
        if (read && (memory.coachProfile.read || memory.bestPractices.read))
          return;
        return denied();
      }
      const gate =
        path === "memory/coach_profile.md" ||
        path === "memory/coach" ||
        path.startsWith("memory/coach/")
          ? memory.coachProfile
          : path === "memory/best_practices.md" ||
              path === "memory/practices" ||
              path.startsWith("memory/practices/")
            ? memory.bestPractices
            : path === "skills" || path.startsWith("skills/")
              ? memory.skills
              : undefined;
      if (
        !gate ||
        !gate[
          read ? "read" : exists || operation === "delete" ? "revise" : "create"
        ]
      )
        return denied();
      return;
    }
    if (
      this.memory.horizon === "stateless" &&
      !(
        this.packagesEnabled &&
        (path === "packages" || path.startsWith("packages/"))
      )
    )
      throw new SessionError(
        "memory_mode_refused",
        "Stateless workspace tools disabled",
      );
    if (
      !(
        this.packagesEnabled &&
        (path === "packages" || path.startsWith("packages/"))
      ) &&
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
  ): { path: string; bytes: number } | Promise<{ path: string; bytes: number }>;
}

/** Trusted service. Never give the harness its directory or mount it directly writable.
 * P3f must mediate mount operations through this service, including binary writes.
 * Legacy calls are synchronous; v3 mutations serialize counting and commit.
 * No other writer may own the directory.
 */
export class Workspace {
  #root: string;
  #changes: WorkspaceChange[] = [];
  #queue: Promise<unknown> = Promise.resolve();
  constructor(
    root: string,
    readonly policy: WorkspacePolicy,
    private runRoot: string,
    private gameId?: string,
    private countMemory?: MemoryCounter,
    private feedback?: () => { gameId: string; content: Buffer } | undefined,
  ) {
    this.#root = resolve(root);
    this.#ordinary(this.#root, true);
    if (policy.v3) {
      for (const path of [
        "scratch",
        "packages",
        gameId ? `packages/${gameId}` : "",
        "memory",
        "memory/coach",
        "memory/practices",
        "skills",
      ])
        if (path && policy.visible(path))
          mkdirSync(join(this.#root, path), { recursive: true, mode: 0o700 });
    }
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
    if (
      this.gameId &&
      path.startsWith("packages/") &&
      path.split("/")[1] !== this.gameId
    )
      throw new SessionError("not_found", "Package unavailable");
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
  #unlocked(path: string) {
    const parts = path.split("/");
    if (
      parts[0] === "packages" &&
      parts[1] &&
      existsSync(
        join(this.runRoot, "frozen-packages", parts[1], "receipt.json"),
      )
    )
      throw new SessionError("phase_refused", "Package is frozen");
  }
  authorize(operation: WorkspaceChange["operation"], path: string) {
    this.policy.authorize(operation, false, path);
    this.#unlocked(path);
    try {
      this.policy.authorize(operation, !!this.#exists(this.#path(path)), path);
    } catch (e) {
      this.#error(e);
    }
  }
  list(path = "") {
    const feedback =
      this.policy.v3 &&
      (!path || path === "feedback" || path.startsWith("feedback/"))
        ? this.feedback?.()
        : undefined;
    if (
      this.policy.v3 &&
      (path === "feedback" || path.startsWith("feedback/"))
    ) {
      if (!feedback)
        throw new SessionError("not_found", "Workspace entry unavailable");
      if (path === "feedback")
        return {
          entries: [
            {
              path: `feedback/${feedback.gameId}`,
              kind: "directory" as const,
              bytes: null,
            },
          ],
        };
      if (path === `feedback/${feedback.gameId}`)
        return {
          entries: [
            {
              path: `${path}/trace.json`,
              kind: "file" as const,
              bytes: feedback.content.length,
            },
          ],
        };
      throw new SessionError("not_found", "Workspace entry unavailable");
    }
    this.policy.authorize(
      "list",
      false,
      path === "" && this.policy.packagesEnabled && !this.policy.v3
        ? "packages"
        : path,
    );
    try {
      const target = this.#path(path, true);
      this.#ordinary(target, true);
      const entries: WorkspaceEntry[] = readdirSync(target)
        .filter((name) =>
          this.policy.v3
            ? this.policy.visible(path ? `${path}/${name}` : name)
            : path !== "" || !this.policy.stateless || name === "packages",
        )
        .filter(
          (name) => path !== "packages" || !this.gameId || name === this.gameId,
        )
        .sort()
        .map((name) => {
          const stat = this.#ordinary(join(target, name));
          return {
            path: path ? `${path}/${name}` : name,
            kind: stat.isDirectory() ? "directory" : "file",
            bytes: stat.isFile() ? stat.size : null,
          };
        });
      if (!path && feedback)
        entries.push({ path: "feedback", kind: "directory", bytes: null });
      return { entries: entries.sort((a, b) => a.path.localeCompare(b.path)) };
    } catch (e) {
      return this.#error(e);
    }
  }
  mkdir(path: string) {
    this.policy.authorize("write", false, path);
    this.#unlocked(path);
    try {
      const target = this.#path(path);
      mkdirSync(target, { recursive: true, mode: 0o700 });
      this.#ordinary(target, true);
    } catch (e) {
      this.#error(e);
    }
  }
  readBytes(path: string): Buffer {
    if (this.policy.v3 && path.startsWith("feedback/")) {
      const feedback = this.feedback?.();
      if (feedback && path === `feedback/${feedback.gameId}/trace.json`)
        return feedback.content;
      throw new SessionError("not_found", "Workspace entry unavailable");
    }
    this.policy.authorize("read", false, path);
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
    edit?: { old_text: string; new_text: string },
  ): WorkspaceMutationResult | Promise<WorkspaceMutationResult> {
    const edited = () => {
      if (!edit) return content;
      this.authorize("write", path);
      const text = textBytes(this.readBytes(path));
      const at = text.indexOf(edit.old_text);
      if (
        !edit.old_text ||
        at < 0 ||
        text.indexOf(edit.old_text, at + 1) !== -1
      )
        throw new SessionError(
          "invalid_input",
          "Edit requires exactly one occurrence of old_text",
        );
      return Buffer.from(
        text.slice(0, at) +
          edit.new_text +
          text.slice(at + edit.old_text.length),
      );
    };
    if (!this.policy.v3) return this.#mutate(operation, path, edited());
    // Serialize validation, counting and commit across tools and FUSE writers.
    const work = this.#queue.then(async () => {
      this.authorize(operation, path);
      content = edited();
      let memoryUsage: { retainedTokens: number; cap: number } | undefined;
      if (path.startsWith("memory/")) {
        if (!this.countMemory)
          throw Error("Analyst memory counter is not installed");
        const files = retainedFiles(this.#root, (path) =>
            this.policy.visible(path),
          ),
          current = await this.countMemory(files);
        try {
          if (operation === "delete") delete files[path];
          else
            files[path] =
              (operation === "append" ? (files[path] ?? "") : "") +
              textBytes(content);
        } catch {
          throw new SessionError("invalid_input", "Memory must be UTF-8 text");
        }
        const proposed = await this.countMemory(files);
        memoryUsage = { retainedTokens: proposed, cap: MEMORY_TOKEN_CAP };
        if (proposed > MEMORY_TOKEN_CAP)
          throw new SessionError(
            "memory_mode_refused",
            `Memory cap exceeded: current ${current} tokens; proposed ${proposed}; cap ${MEMORY_TOKEN_CAP}`,
          );
      }
      // Phase and freeze state may have changed while the counter was in flight.
      return {
        ...this.#mutate(operation, path, content),
        ...(memoryUsage ? { memoryUsage } : {}),
      };
    });
    this.#queue = work.catch(() => {});
    return work;
  }
  edit(path: string, old_text: string, new_text: string) {
    return this.mutate("write", path, Buffer.alloc(0), { old_text, new_text });
  }
  async memoryUsage() {
    const work = this.#queue.then(async () => {
      const files = retainedFiles(this.#root, (path) =>
        this.policy.visible(path),
      );
      if (!Object.keys(files).length)
        return { retainedTokens: 0, cap: MEMORY_TOKEN_CAP };
      if (!this.countMemory)
        throw Error("Analyst memory counter is not installed");
      return {
        retainedTokens: await this.countMemory(files),
        cap: MEMORY_TOKEN_CAP,
      };
    });
    this.#queue = work.catch(() => {});
    return work;
  }
  #mutate(
    operation: WorkspaceChange["operation"],
    path: string,
    content = Buffer.alloc(0),
  ) {
    if (
      !["write", "append", "delete"].includes(operation) ||
      !Buffer.isBuffer(content)
    )
      throw invalid();
    this.policy.authorize(operation, false, path);
    this.#unlocked(path);
    try {
      const target = this.#path(path),
        existing = this.#exists(target);
      this.policy.authorize(operation, !!existing, path);
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
  async idle() {
    await this.#queue;
  }
  changes(): WorkspaceChange[] {
    return structuredClone(this.#changes);
  }
}
