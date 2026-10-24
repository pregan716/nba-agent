import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Environment, CodeResult } from "../runner/runner.js";
import type { RunConfig } from "../runner/config.js";
import type { WorkspacePort } from "./workspace.js";
import { SessionError } from "./contract.js";
const command = promisify(execFile);
type Limits = Parameters<Environment["execute"]>[1];
const trim = (encoded: string, cap: number) => {
  let result = Buffer.from(encoded, "base64").subarray(0, cap).toString("utf8");
  while (Buffer.byteLength(result) > cap) result = result.slice(0, -1);
  return result;
};

/** One trusted supervisor per session. Agent code never owns Docker or a host path. */
export class DockerSandbox {
  readonly name = `nba-session-${randomUUID()}`;
  #directory = mkdtempSync(join(tmpdir(), "nba-session-"));
  #process?: ReturnType<typeof spawn>;
  #starting?: Promise<void>;
  #creation?: Promise<unknown>;
  #closing?: Promise<void>;
  #closed = false;
  #busy = false;
  #dead = false;
  #allowance = 0;
  #result?: { resolve: (value: any) => void; reject: (error: Error) => void };
  #ready?: { resolve: () => void; reject: (error: Error) => void };
  #abort = new AbortController();
  #limits?: Limits;
  #port?: WorkspacePort;
  constructor(
    private config: RunConfig,
    private exporter: (
      directory: string,
      signal: AbortSignal,
    ) => Promise<unknown>,
    workspace?: WorkspacePort,
  ) {
    this.#port = workspace;
  }
  async #start(limits: Limits) {
    if (this.#closed) throw new SessionError("phase_refused", "Sandbox closed");
    await this.exporter(this.#directory, this.#abort.signal);
    this.#abort.signal.throwIfAborted();
    const pin = this.config.harness.sandboxImage;
    if (!/@sha256:[a-f0-9]{64}$/.test(pin))
      throw Error("Sandbox image must be pinned");
    // Locally built images can be pinned by immutable image ID as local@sha256:….
    const image = pin.startsWith("local@") ? pin.slice(6) : pin;
    const { stdout } = await command(
      "docker",
      ["image", "inspect", image, "--format", "{{.Id}}"],
      { timeout: 30000 },
    );
    if (!/^sha256:[a-f0-9]{64}$/.test(stdout.trim()))
      throw Error("Invalid sandbox image identity");
    this.#abort.signal.throwIfAborted();
    this.#limits = limits;
    const persistent =
      this.config.profile.memory.horizon !== "stateless" && !!this.#port;
    const args = [
      "create",
      "--interactive",
      "--name",
      this.name,
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "SETUID",
      "--cap-add",
      "SETGID",
      "--cap-add",
      "KILL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "64",
      "--cpus",
      String(limits.cpu),
      "--memory",
      String(limits.memoryBytes),
      "--memory-swap",
      String(limits.memoryBytes),
      "--tmpfs",
      `/scratch:rw,nosuid,nodev,size=${limits.memoryBytes},uid=1000,gid=1000,mode=755`,
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=16777216,mode=1777",
      "--mount",
      `type=bind,source=${this.#directory},target=/data,readonly`,
    ];
    if (persistent)
      args.push(
        "--cap-add",
        "SYS_ADMIN",
        "--device",
        "/dev/fuse",
        "--security-opt",
        "apparmor=unconfined",
        "--env",
        "WORKSPACE_MOUNT=1",
      );
    else
      args.push(
        "--tmpfs",
        `/workspace:rw,nosuid,nodev,size=${limits.memoryBytes},uid=1000,gid=1000,mode=755`,
      );
    args.push(image);
    this.#creation = command("docker", args, { timeout: 30000 });
    await this.#creation;
    this.#abort.signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      this.#ready = { resolve, reject };
      const child = (this.#process = spawn(
        "docker",
        ["start", "--attach", "--interactive", this.name],
        { stdio: ["pipe", "pipe", "pipe"] },
      ));
      child.stderr!.resume();
      child.on("error", () =>
        this.#fail(new Error("Docker sandbox could not start")),
      );
      child.on("close", () => {
        void this.#exited();
      });
      createInterface({ input: child.stdout! }).on("line", (line) => {
        try {
          this.#message(JSON.parse(line));
        } catch {
          this.#fail(new Error("Invalid sandbox protocol"));
          void this.close().catch(() => {});
        }
      });
    });
  }
  async #exited() {
    this.#dead = true;
    if (this.#closed) return;
    const pending = this.#result;
    if (pending) {
      try {
        const { stdout } = await command(
          "docker",
          ["inspect", this.name, "--format", "{{json .State}}"],
          { timeout: 3000 },
        );
        const state = JSON.parse(stdout);
        if (this.#closed || this.#result !== pending) return;
        if (state.OOMKilled === true && state.ExitCode === 137) {
          this.#result = undefined;
          // The supervisor's final CPU counter and output died with it. Retain
          // the full reservation, never fabricate a measured CPU delta.
          pending.resolve({
            stdout: "",
            stderr: Buffer.from(
              "Container OOM killed the supervisor; full compute allowance charged.",
            ).toString("base64"),
            exitStatus: 137,
            computeSeconds: this.#allowance,
            truncated: true,
            limit: "memory",
          });
          return;
        }
      } catch {
        /* Unknown exits remain errors; never infer OOM from SIGKILL alone. */
      }
    }
    if (!this.#closed)
      this.#fail(new Error("Docker sandbox exited unexpectedly"));
  }
  #send(value: unknown) {
    this.#process?.stdin?.write(JSON.stringify(value) + "\n");
  }
  #fail(error: Error) {
    this.#ready?.reject(error);
    this.#ready = undefined;
    this.#result?.reject(error);
    this.#result = undefined;
  }
  #message(message: any) {
    if (message.type === "ready") {
      this.#ready?.resolve();
      this.#ready = undefined;
      return;
    }
    if (message.type === "workspace") {
      try {
        if (this.#closed || !this.#busy || !this.#port)
          throw new SessionError("phase_refused", "Workspace unavailable");
        let value: unknown;
        if (message.operation === "list") value = this.#port.list(message.path);
        else if (message.operation === "read")
          value = this.#port.readBytes(message.path).toString("base64");
        else if (message.operation === "authorize")
          value = this.#port.authorize(message.operation_kind, message.path);
        else if (message.operation === "mkdir")
          value = this.#port.mkdir(message.path);
        else if (message.operation === "mutate")
          value = this.#port.mutate(
            message.operation_kind,
            message.path,
            Buffer.from(message.content ?? "", "base64"),
          );
        else throw Error("Unknown workspace operation");
        this.#send({
          type: "workspace_response",
          id: message.id,
          value: value ?? null,
        });
      } catch (error) {
        this.#send({
          type: "workspace_response",
          id: message.id,
          error: error instanceof SessionError ? error.code : "invalid_input",
        });
      }
      return;
    }
    if (message.type === "result") {
      this.#result?.resolve(message);
      this.#result = undefined;
      return;
    }
    this.#fail(
      new Error(
        `Sandbox supervisor failed: ${String(message.message).slice(0, 300)}`,
      ),
    );
  }
  async execute(
    program: string,
    limits: Limits,
    signal: AbortSignal,
  ): Promise<CodeResult> {
    if (this.#closed || this.#dead || this.#busy)
      throw new SessionError("phase_refused", "Sandbox unavailable");
    this.#busy = true;
    this.#allowance = limits.computeSeconds;
    const cancel = () => {
      void this.close().catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      signal.throwIfAborted();
      this.#starting ??= this.#start(limits);
      await this.#starting;
      if (this.#closed)
        throw new SessionError("phase_refused", "Sandbox closed");
      if (
        limits.cpu !== this.#limits!.cpu ||
        limits.memoryBytes !== this.#limits!.memoryBytes
      )
        throw Error("Sandbox resource limits changed within a session");
      // Give the supervisor time to report a limit before the fallback kills it.
      watchdog = setTimeout(
        cancel,
        Math.ceil(limits.wallSeconds * 1000) + 1000,
      );
      const message = await new Promise<any>((resolve, reject) => {
        this.#result = { resolve, reject };
        this.#send({ type: "execute", program, limits });
      });
      if (
        !Number.isFinite(message.computeSeconds) ||
        message.computeSeconds < 0 ||
        !Number.isInteger(message.exitStatus) ||
        ![null, "wall_clock", "compute", "memory"].includes(message.limit)
      )
        throw Error("Invalid sandbox result");
      return {
        stdout: trim(message.stdout, limits.stdoutBytes),
        stderr: trim(message.stderr, limits.stdoutBytes),
        exitStatus: message.exitStatus,
        computeSeconds: message.computeSeconds,
        truncated: !!message.truncated,
        limit: message.limit,
      };
    } finally {
      clearTimeout(watchdog);
      signal.removeEventListener("abort", cancel);
      this.#busy = false;
    }
  }
  close(): Promise<void> {
    this.#closing ??= this.#dispose();
    return this.#closing;
  }
  async #dispose() {
    this.#closed = true;
    this.#abort.abort();
    this.#fail(new SessionError("phase_refused", "Sandbox closed"));
    // Export may still be awaiting source I/O. Let it observe cancellation
    // before removing its directory, and let an in-flight create finish before rm.
    await this.#starting?.catch(() => {});
    await this.#creation?.catch(() => {});
    if (this.#creation) {
      try {
        await command("docker", ["rm", "--force", this.name], {
          timeout: 30000,
        });
      } catch (error: any) {
        if (!String(error.stderr).includes("No such container"))
          throw Error(`Sandbox cleanup failed: ${this.name}`);
      }
    }
    this.#process?.kill("SIGKILL");
    rmSync(this.#directory, { recursive: true, force: true });
  }
}
