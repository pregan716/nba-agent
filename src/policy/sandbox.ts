import {
  STARTER_SPEC,
  starterMountArgs,
  type StarterMount,
} from "../starter/model.js";
import {
  AssemblerInfrastructureError,
  PackageExecutionError,
} from "./errors.js";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
const command = promisify(execFile);
export interface AssemblerLimits {
  wallSeconds: number;
  memoryBytes: number;
  outputBytes: number;
}
export interface AssemblyResult {
  value: unknown;
  computeSeconds: number;
}
export type BatchAssemblyResult =
  { value: unknown; error?: never } | { error: string; value?: never };
export interface Assembler {
  starter?: StarterMount;
  starterSpec?: typeof STARTER_SPEC;
  withStarter?(mount: StarterMount): Assembler;
  runBatch?(
    path: string,
    states: unknown[],
    signal: AbortSignal,
  ): Promise<BatchAssemblyResult[]>;
  image: string;
  limits: AssemblerLimits;
  run(
    path: string,
    state: unknown,
    signal: AbortSignal,
    mode?: "load" | "assemble",
  ): Promise<AssemblyResult>;
}
export class DockerAssembler implements Assembler {
  constructor(
    readonly image: string,
    readonly limits: AssemblerLimits,
    readonly starter?: StarterMount,
    readonly starterEnabled = !!starter,
  ) {
    if (!/@sha256:[a-f0-9]{64}$/.test(image))
      throw Error("Assembler image must be pinned");
    if (
      !Number.isFinite(limits.wallSeconds) ||
      limits.wallSeconds <= 0 ||
      !Number.isSafeInteger(limits.memoryBytes) ||
      limits.memoryBytes < 16777216 ||
      !Number.isSafeInteger(limits.outputBytes) ||
      limits.outputBytes < 1
    )
      throw Error("Invalid assembler limits");
  }
  get starterSpec() {
    return this.starterEnabled ? STARTER_SPEC : undefined;
  }
  withStarter(mount: StarterMount) {
    return new DockerAssembler(this.image, this.limits, mount, true);
  }
  async runBatch(
    path: string,
    states: unknown[],
    signal: AbortSignal,
  ): Promise<BatchAssemblyResult[]> {
    if (!states.length) return [];
    const result = await this.execute(path, states, signal, "batch");
    return result.value as BatchAssemblyResult[];
  }
  async run(
    path: string,
    state: unknown,
    signal: AbortSignal,
    mode: "load" | "assemble" = "assemble",
  ): Promise<AssemblyResult> {
    return this.execute(path, state, signal, mode);
  }
  private async execute(
    path: string,
    state: unknown,
    signal: AbortSignal,
    mode: "load" | "assemble" | "batch",
  ): Promise<AssemblyResult> {
    signal.throwIfAborted();
    const name = `nba-assembler-${randomUUID()}`,
      start = performance.now();
    const batch = mode === "batch" ? (state as unknown[]) : null;
    const wallSeconds = this.limits.wallSeconds * (batch?.length ?? 1);
    const args = [
      "create",
      "--interactive",
      "--name",
      name,
      "--label",
      `nba-assembler-package=${resolve(path)}`,
      "--network",
      "none",
      "--ipc",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "16",
      "--cpus",
      "1",
      "--memory",
      String(this.limits.memoryBytes),
      "--memory-swap",
      String(this.limits.memoryBytes),
      "--tmpfs",
      `/scratch:rw,noexec,nosuid,nodev,size=${this.limits.memoryBytes},uid=65534,gid=65534,mode=700`,
      "--mount",
      `type=bind,source=${resolve(path)},target=/package,readonly`,
      ...starterMountArgs(this.starter),
      this.image.replace(/^local@/, ""),
      ...(batch ? ["--batch"] : []),
    ];
    let child: ReturnType<typeof spawn> | undefined;
    let primaryError: unknown;
    try {
      await command("docker", args, {
        timeout: Math.ceil(this.limits.wallSeconds * 1000),
        signal,
      });
      signal.throwIfAborted();
      const remaining = wallSeconds * 1000 - (performance.now() - start);
      if (remaining <= 0)
        throw new PackageExecutionError("Assembler wall-clock limit");
      const value = await new Promise<unknown>((accept, reject) => {
        child = spawn("docker", ["start", "--attach", "--interactive", name], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "",
          stderr = "",
          size = 0;
        const results: BatchAssemblyResult[] = [];
        const fail = (error: Error) => {
          reject(error);
          child?.kill("SIGKILL");
        };
        const abort = () => fail(signal.reason ?? Error("Assembler aborted"));
        signal.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(
          () => fail(new PackageExecutionError("Assembler wall-clock limit")),
          remaining,
        );
        child.on("error", () => fail(Error("Assembler launch failed")));
        child.stdout!.on("data", (b) => {
          if (batch) {
            stdout += b.toString();
            let newline: number;
            while ((newline = stdout.indexOf("\n")) >= 0) {
              const line = stdout.slice(0, newline);
              stdout = stdout.slice(newline + 1);
              if (Buffer.byteLength(line) > this.limits.outputBytes + 128) {
                fail(new PackageExecutionError("Assembler batch output limit"));
                return;
              }
              try {
                const row = JSON.parse(line);
                if (
                  !row ||
                  typeof row !== "object" ||
                  !(
                    Object.hasOwn(row, "value") || typeof row.error === "string"
                  )
                )
                  throw Error();
                results.push(row);
                if (results.length > batch.length) throw Error();
              } catch {
                fail(new PackageExecutionError("Invalid assembler batch JSON"));
                return;
              }
            }
            if (Buffer.byteLength(stdout) > this.limits.outputBytes + 128)
              fail(new PackageExecutionError("Assembler batch output limit"));
          } else {
            size += b.length;
            if (size > this.limits.outputBytes)
              fail(new PackageExecutionError("Assembler output limit"));
            else stdout += b.toString();
          }
        });
        child.stderr!.on("data", (b) => {
          size += b.length;
          if (size > this.limits.outputBytes)
            fail(new PackageExecutionError("Assembler output limit"));
          else stderr += b.toString();
        });
        child.on("close", async (code) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          if (code !== 0) {
            try {
              const { stdout: details } = await command(
                "docker",
                ["inspect", name, "--format", "{{json .State}}"],
                { timeout: 10000 },
              );
              const state = JSON.parse(details);
              if (
                !state.StartedAt ||
                state.StartedAt.startsWith("0001-") ||
                state.Error
              )
                throw Error("Assembler container launch failed");
              reject(
                new PackageExecutionError(
                  `Assembler failed (${code}): ${stderr.slice(0, 1000)}`,
                ),
              );
            } catch (error) {
              reject(error);
            }
          } else
            try {
              if (batch) {
                if (results.length !== batch.length || stdout.trim())
                  throw Error();
                accept(results);
              } else accept(JSON.parse(stdout));
            } catch {
              reject(new PackageExecutionError("Invalid assembler JSON"));
            }
        });
        child.stdin!.on("error", () => {});
        if (batch) {
          // Queue frames without per-state Docker round trips. The supervisor
          // reads exact lengths (no read-ahead) and closes input in each child.
          for (const state of batch) {
            const body = Buffer.from(
              JSON.stringify({
                state,
                wallSeconds: this.limits.wallSeconds,
                outputBytes: this.limits.outputBytes,
              }),
            );
            const header = Buffer.alloc(4);
            header.writeUInt32BE(body.length);
            child.stdin!.write(header);
            child.stdin!.write(body);
          }
          child.stdin!.end();
        } else child.stdin!.end(JSON.stringify({ mode, state }));
      });
      return { value, computeSeconds: (performance.now() - start) / 1000 };
    } catch (error) {
      primaryError =
        signal.aborted || error instanceof PackageExecutionError
          ? error
          : new AssemblerInfrastructureError(
              "Assembler infrastructure failure",
              { cause: error },
            );
      throw primaryError;
    } finally {
      // Kill the container as well as the CLI on timeout/abort. No writable host mount.
      await command("docker", ["rm", "--force", name], {
        timeout: 10000,
      }).catch((e) => {
        if (!String(e.stderr).includes("No such container")) {
          if (primaryError instanceof Error)
            Object.defineProperty(primaryError, "cleanupError", { value: e });
          else throw e;
        }
      });
    }
  }
}
