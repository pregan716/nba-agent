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
export interface Assembler {
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
  async run(
    path: string,
    state: unknown,
    signal: AbortSignal,
    mode: "load" | "assemble" = "assemble",
  ): Promise<AssemblyResult> {
    signal.throwIfAborted();
    const name = `nba-assembler-${randomUUID()}`,
      start = performance.now();
    const args = [
      "create",
      "--interactive",
      "--name",
      name,
      "--network",
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
      this.image.replace(/^local@/, ""),
    ];
    let child: ReturnType<typeof spawn> | undefined;
    let primaryError: unknown;
    try {
      await command("docker", args, {
        timeout: Math.ceil(this.limits.wallSeconds * 1000),
        signal,
      });
      signal.throwIfAborted();
      const remaining =
        this.limits.wallSeconds * 1000 - (performance.now() - start);
      if (remaining <= 0)
        throw new PackageExecutionError("Assembler wall-clock limit");
      const value = await new Promise<unknown>((accept, reject) => {
        child = spawn("docker", ["start", "--attach", "--interactive", name], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "",
          stderr = "",
          size = 0;
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
          size += b.length;
          if (size > this.limits.outputBytes)
            fail(new PackageExecutionError("Assembler output limit"));
          else stdout += b.toString();
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
              accept(JSON.parse(stdout));
            } catch {
              reject(new PackageExecutionError("Invalid assembler JSON"));
            }
        });
        child.stdin!.on("error", () => {});
        child.stdin!.end(JSON.stringify({ mode, state }));
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
