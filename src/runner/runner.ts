import {
  mkdirSync,
  existsSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  manifest as makeManifest,
  digest,
  type Game,
  type Manifest,
  type Phase,
  type Status,
  type Limit,
} from "./config.js";
import {
  RecordStore,
  snapshot,
  restore,
  diff,
  type Snapshot,
} from "./record.js";
import { Budget, LimitError } from "./budget.js";
import { MeteringProxy, type ModelEndpoint } from "./proxy.js";
import { checkpoint, type CheckpointSink } from "./sync.js";
import type { QuestionSet } from "../questions/builder.js";

export interface CodeResult {
  stdout: string;
  stderr: string;
  exitStatus: number | null;
  computeSeconds: number;
  truncated: boolean;
  limit: "wall_clock" | "compute" | null;
}
export interface SessionContext {
  game: Game;
  phase: Phase;
  cutoff: string;
  memory: Manifest["config"]["profile"]["memory"];
  dataSources: Manifest["config"]["profile"]["dataSources"];
}
export interface Validation {
  ok: boolean;
  errors: string[];
  value?: unknown;
  clips?: unknown[];
}
/** Trusted P3 adapter. Paths and persistence hooks are never exposed to the harness. */
export interface Environment {
  questions(): Promise<QuestionSet>;
  transition(phase: Phase, cutoff: string): Promise<void>;
  call(name: string, args: unknown, signal: AbortSignal): Promise<unknown>;
  validateSubmission(value: unknown): Promise<Validation>;
  execute(
    program: string,
    limits: {
      wallSeconds: number;
      computeSeconds: number;
      stdoutBytes: number;
      cpu: number;
      memoryBytes: number;
    },
    signal: AbortSignal,
  ): Promise<CodeResult>;
  close(): Promise<void>;
}
export type EnvironmentFactory = (
  context: SessionContext,
  trusted: { workspace: string; submission: unknown | null },
) => Promise<Environment>;
export interface SessionEndpoint {
  call(name: string, args?: unknown): Promise<unknown>;
}
export interface HarnessHandles {
  session: SessionEndpoint;
  model: ModelEndpoint;
  memoryInstructions: string;
}
export type Harness = (handles: HarnessHandles) => Promise<void>;

export class Runner {
  readonly record: RecordStore;
  readonly root: string;
  readonly workspace: string;
  #lock: string;
  #closed = false;
  #running = false;
  constructor(
    base: string,
    readonly manifest: Manifest,
    private proxy: MeteringProxy,
    private environment: EnvironmentFactory,
    private sink?: CheckpointSink,
  ) {
    const validated = makeManifest(manifest.config, manifest.games);
    if (digest(validated) !== digest(manifest))
      throw Error("Invalid manifest derivation");
    this.manifest = validated;
    this.root = resolve(
      base,
      manifest.config.runId,
      manifest.config.replicateId,
    );
    this.workspace = join(this.root, "workspace");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.#lock = join(this.root, "runner.lock");
    // OS PID is only meaningful on this host. Remote migration requires restoring
    // a published checkpoint into a new root (which contains no lock file).
    if (existsSync(this.#lock)) {
      const pid = Number(readFileSync(this.#lock, "utf8"));
      if (!Number.isInteger(pid) || pid < 1) throw Error("Invalid runner lock");
      try {
        process.kill(pid, 0);
        throw Error("Run already active");
      } catch (e: any) {
        if (e.code !== "ESRCH") throw e;
      }
      rmSync(this.#lock);
    }
    writeFileSync(this.#lock, String(process.pid), { flag: "wx", mode: 0o600 });
    try {
      this.record = new RecordStore(this.root, manifest);
      mkdirSync(this.workspace, { recursive: true, mode: 0o700 });
      mkdirSync(join(this.root, "blobs"), { recursive: true });
      const state = this.record
        .events()
        .reverse()
        .find((e) =>
          ["submission", "session_end", "session_start"].includes(e.kind),
        );
      if (state)
        restore(
          this.root,
          this.workspace,
          state.kind === "submission"
            ? state.data.value.workspace
            : state.kind === "session_end"
              ? state.data.after
              : state.data.before,
        );
      if (manifest.config.purpose === "scored" && !sink)
        throw Error("Scored runs require an R2 checkpoint sink");
    } catch (e) {
      rmSync(this.#lock, { force: true });
      throw e;
    }
  }
  async run(harness: Harness): Promise<void> {
    if (this.#running || this.#closed) throw Error("Runner unavailable");
    this.#running = true;
    try {
      // Retry publication before advancing after a previous sync failure.
      await checkpoint(this.record, this.sink);
      for (const game of this.manifest.games) {
        if (this.manifest.config.purpose === "pilot" && !game.development)
          continue;
        if (this.record.events("game_end", game.gameId).length) continue;
        for (const phase of ["pregame", "postgame"] as const) {
          const scope = `${game.gameId}:${phase}`;
          if (this.record.events("phase_end", scope).length) continue;
          await this.session(game, phase, harness);
          await checkpoint(this.record, this.sink);
        }
        this.record.append("game_end", game.gameId, {
          development: game.development,
          scoringEligible:
            this.manifest.config.purpose === "scored" &&
            !game.development &&
            this.record.events("submission", game.gameId).length === 1 &&
            this.record.events("phase_end", `${game.gameId}:pregame`)[0]?.data
              .status === "completed",
        });
        await checkpoint(this.record, this.sink);
      }
      if (!this.record.events("run_end").length)
        this.record.append("run_end", "run", {});
      await checkpoint(this.record, this.sink);
    } finally {
      this.#running = false;
    }
  }
  private async session(
    game: Game,
    phase: "pregame" | "postgame",
    harness: Harness,
  ): Promise<void> {
    const scope = `${game.gameId}:${phase}`,
      budget = new Budget(this.record, scope, this.manifest.config, phase);
    const prior = this.record.events("session_start", scope).at(-1);
    const frozen = this.record.events("submission", game.gameId)[0];
    const durableEnd =
      prior &&
      this.record
        .events("session_end", scope)
        .find((e) => e.data.attempt === prior.data.attempt);
    if (durableEnd && durableEnd.data.limit !== "interrupted") {
      this.record.append("phase_end", scope, {
        status: durableEnd.data.status,
        limit: durableEnd.data.limit,
      });
      return;
    }
    let before: Snapshot;
    if (
      prior &&
      !this.record
        .events("session_end", scope)
        .some((e) => e.data.attempt === prior.data.attempt)
    ) {
      // Roll back partial memory changes; a committed submission owns its exact
      // workspace checkpoint and is never re-delivered to a new pregame harness.
      before =
        phase === "pregame" && frozen
          ? frozen.data.value.workspace
          : prior.data.before;
      restore(this.root, this.workspace, before);
      this.record.append("session_end", scope, {
        attempt: prior.data.attempt,
        status: "infrastructure_failure",
        limit: "interrupted",
        before: prior.data.before,
        after: before,
        diff: diff(prior.data.before, before),
        usage: budget.totals(),
        elapsedMs: Date.now() - Date.parse(prior.at),
      });
    } else {
      if (
        phase === "pregame" &&
        this.manifest.config.profile.memory.horizon === "stateless"
      )
        restore(this.root, this.workspace, { files: {} });
      before = snapshot(this.root, this.workspace);
    }
    if (phase === "pregame" && frozen) {
      this.record.append("phase_end", scope, {
        status: "completed",
        limit: null,
        recoveredReceipt: frozen.data.receipt,
      });
      return;
    }
    if (
      phase === "postgame" &&
      this.manifest.config.profile.memory.horizon === "stateless"
    ) {
      this.record.append("clock", scope, { phase, cutoff: game.release });
      this.record.append("phase_end", scope, {
        status: "skipped",
        limit: null,
        reason: "stateless",
        before,
        after: before,
        diff: diff(before, before),
        usage: budget.totals(),
      });
      return;
    }
    const attempt = this.record.events("session_start", scope).length + 1;
    this.record.append("session_start", scope, {
      attempt,
      phase,
      before,
      cutoff: phase === "pregame" ? game.scheduledStart : game.release,
    });
    const controller = new AbortController();
    const started = Date.now();
    let environment: Environment | undefined,
      endpoint: ModelEndpoint | undefined,
      active = true,
      busy = false;
    let pending: Promise<unknown> | undefined;
    let status: Status = "completed",
      limit: Limit = null;
    const previousElapsed = this.record
      .events("session_end", scope)
      .reduce((n, e) => n + (e.data.elapsedMs ?? 0), 0);
    const remainingMs = Math.max(
      0,
      budget.caps.wallSeconds * 1000 - previousElapsed,
    );
    let timeout!: ReturnType<typeof setTimeout>;
    const expired = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new LimitError("wall_clock"));
      }, remainingMs);
    });
    try {
      const executeSession = async () => {
        environment = await this.environment(
          {
            game,
            phase: budget.stage,
            cutoff: phase === "pregame" ? game.scheduledStart : game.release,
            memory: this.manifest.config.profile.memory,
            dataSources: this.manifest.config.profile.dataSources,
          },
          {
            workspace: this.workspace,
            submission: frozen?.data.value.submission ?? null,
          },
        );
        const env = environment;
        if (!active || controller.signal.aborted) {
          await env.close();
          throw new LimitError("wall_clock");
        }
        this.record.append("clock", scope, {
          phase: budget.stage,
          cutoff: phase === "pregame" ? game.scheduledStart : game.release,
        });
        await env.transition(
          budget.stage,
          phase === "pregame" ? game.scheduledStart : game.release,
        );
        if (phase === "pregame") {
          const questions = await env.questions();
          if (!active || controller.signal.aborted)
            throw new LimitError("wall_clock");
          const existing = this.record.events("questions", game.gameId)[0];
          if (existing && digest(existing.data) !== digest(questions))
            throw Error("P3 changed the frozen question set");
          if (!existing)
            this.record.append("questions", game.gameId, questions);
        }
        if (!active || controller.signal.aborted)
          throw new LimitError("wall_clock");
        endpoint = this.proxy.issue(budget, controller.signal);
        const call = async (name: string, args?: unknown): Promise<unknown> => {
          if (!active || controller.signal.aborted)
            throw Error("Session closed");
          if (busy) throw Error("Concurrent environment calls refused");
          busy = true;
          const work = async () => {
            if (name === "context")
              return {
                game,
                phase: budget.stage,
                cutoff:
                  phase === "pregame" ? game.scheduledStart : game.release,
                budget: budget.remaining(),
              };
            if (name === "begin_commit") {
              if (endpoint && this.proxy.busy(endpoint))
                throw Error("Wait for the model call before committing");
              budget.commit();
              await env.transition("commit", game.scheduledStart);
              return { phase: "commit", budget: budget.remaining() };
            }
            if (
              budget.stage === "commit" &&
              !["submit", "list_questions"].includes(name)
            )
              throw Error(
                "Research and workspace tools are locked during commit",
              );
            if (
              this.manifest.config.profile.memory.horizon === "stateless" &&
              name.startsWith("workspace_")
            )
              throw Error("Stateless workspace tools disabled");
            // Submission remains possible when the research/tool allowance stops.
            if (name !== "submit") budget.tool(name, args);
            if (name === "submit") {
              if (budget.stage !== "commit")
                throw Error("Begin commit before submitting");
              const existing = this.record.events("submission", game.gameId)[0];
              const attempts = this.record.events(
                "submission_attempt",
                game.gameId,
              );
              if (!existing && attempts.length >= 3)
                budget.block("submission_attempts");
              const validated = await env.validateSubmission(args);
              if (!active || controller.signal.aborted)
                throw Error("Session closed");
              const attemptRecord = {
                attempt: attempts.length + 1,
                input: args,
                validation: validated,
              };
              if (!validated.ok) {
                if (!existing)
                  this.record.append(
                    "submission_attempt",
                    game.gameId,
                    attemptRecord,
                  );
                return validated;
              }
              if (validated.value === undefined)
                throw Error("P3 omitted normalized submission");
              const workspace =
                existing?.data.value.workspace ??
                snapshot(this.root, this.workspace);
              return this.record.submission(
                game.gameId,
                {
                  submission: validated.value,
                  clips: validated.clips ?? [],
                  workspace,
                },
                existing ? undefined : attemptRecord,
              );
            }
            if (name === "execute_code") {
              if (
                !this.manifest.config.profile.capabilities.enabled.includes(
                  name,
                )
              )
                throw Error("Capability disabled");
              if (typeof args !== "string")
                throw Error("Program must be a string");
              const sandbox = this.manifest.config.budget.sandbox;
              const allowance = Math.min(
                sandbox.perCallSeconds,
                budget.remaining().compute,
              );
              if (allowance <= 0) budget.block("compute");
              const reservation = budget.reserve(0, allowance, "code");
              this.record.append("code_start", scope, {
                reservation,
                program: args,
              });
              const result = await env.execute(
                args,
                {
                  wallSeconds: allowance,
                  computeSeconds: allowance,
                  stdoutBytes: sandbox.stdoutBytes,
                  cpu: sandbox.cpu,
                  memoryBytes: sandbox.memoryBytes,
                },
                AbortSignal.any([
                  controller.signal,
                  AbortSignal.timeout(Math.max(1, Math.ceil(allowance * 1000))),
                ]),
              );
              if (
                !Number.isFinite(result.computeSeconds) ||
                result.computeSeconds < 0
              )
                throw Error("Invalid compute meter");
              const trim = (s: string) => {
                let text = Buffer.from(s)
                  .subarray(0, sandbox.stdoutBytes)
                  .toString();
                while (Buffer.byteLength(text) > sandbox.stdoutBytes)
                  text = text.slice(0, -1);
                return text;
              };
              const recorded = {
                ...result,
                stdout: trim(result.stdout),
                stderr: trim(result.stderr),
                truncated:
                  result.truncated ||
                  Buffer.byteLength(result.stdout) > sandbox.stdoutBytes ||
                  Buffer.byteLength(result.stderr) > sandbox.stdoutBytes,
              };
              this.record.append("code_result", scope, {
                reservation,
                ...recorded,
              });
              budget.settle(reservation, 0, result.computeSeconds, recorded);
              return recorded;
            }
            if (
              !this.manifest.config.profile.capabilities.enabled.includes(name)
            )
              throw Error("Capability disabled");
            return env.call(name, args, controller.signal);
          };
          pending = work();
          try {
            const result = await pending;
            this.record.append("tool_result", scope, {
              name,
              args: args ?? null,
              result,
            });
            return result;
          } catch (e) {
            this.record.append("tool_error", scope, {
              name,
              message: e instanceof Error ? e.message : String(e),
            });
            throw e;
          } finally {
            busy = false;
            pending = undefined;
          }
        };
        const handles = Object.freeze({
          session: Object.freeze({ call }),
          model: endpoint,
          memoryInstructions: this.manifest.config.harness.memoryInstructions,
        });
        await harness(handles);
      };
      await Promise.race([executeSession(), expired]);
      if (
        phase === "postgame" ||
        !this.record.events("submission", game.gameId).length
      ) {
        const last = this.record.events("limit", scope).at(-1);
        const modelFailure = this.record
          .events("model_error", scope)
          .some((e) => !e.data.limit);
        status = last
          ? last.data.limit === "submission_attempts"
            ? "invalid_output"
            : "budget_exhausted"
          : modelFailure
            ? "infrastructure_failure"
            : phase === "postgame"
              ? "completed"
              : "invalid_output";
        limit =
          last?.data.limit ??
          (modelFailure
            ? "infrastructure"
            : phase === "postgame"
              ? null
              : "submission_attempts");
      }
    } catch (e) {
      status =
        e instanceof LimitError
          ? e.limit === "submission_attempts"
            ? "invalid_output"
            : "budget_exhausted"
          : "infrastructure_failure";
      limit = e instanceof LimitError ? e.limit : "infrastructure";
      this.record.append("session_error", scope, {
        attempt,
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      active = false;
      controller.abort();
      clearTimeout(timeout);
      await pending?.catch(() => {});
      if (endpoint) await this.proxy.revoke(endpoint);
      if (environment)
        try {
          await environment.close();
        } catch {
          status = "infrastructure_failure";
          limit = "infrastructure";
        }
    }
    const after = snapshot(this.root, this.workspace);
    this.record.append("session_end", scope, {
      attempt,
      status,
      limit,
      before,
      after,
      diff: diff(before, after),
      usage: budget.totals(),
      elapsedMs: Date.now() - started,
    });
    this.record.append("phase_end", scope, { status, limit });
  }
  close(): void {
    if (this.#running) throw Error("Cannot close active runner");
    if (this.#closed) return;
    this.#closed = true;
    this.record.close();
    rmSync(this.#lock, { force: true });
  }
}
