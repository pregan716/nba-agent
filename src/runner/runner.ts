import { forecastTool } from "../projection/tools.js";
import { codeBytes } from "../env/workspace.js";
import type {
  ValidationInput,
  ValidationJev,
  ValidationResult,
} from "../policy/validation.js";
import { AssemblerInfrastructureError } from "../policy/errors.js";
import { capCodeOutput } from "../env/code-output.js";
import { restoreMemoryArtifacts } from "./memory-artifacts.js";
import { writeBlob } from "./blobs.js";
import { PackageStore } from "../policy/package.js";
import { isMemoryV3 } from "../env/memory.js";
import {
  recordedMemoryCounter,
  measureMemory,
  type MemoryCounter,
} from "./memory.js";
import {
  sweepOrphanContainers,
  sweepOwnOrphanContainers,
  sweepClaimHeld,
} from "./orphans.js";
import {
  WorkspacePolicy,
  type WorkspaceOperation,
  type WorkspaceChange,
  type WorkspacePort,
} from "../env/workspace.js";
import { windowSnapshot } from "./workspace.js";
import type { LifecyclePhase } from "../env/lifecycle.js";
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
import { Budget, LimitError, gameMetering } from "./budget.js";
import { MeteringProxy, type ModelEndpoint } from "./proxy.js";
import { checkpoint, type CheckpointSink } from "./sync.js";
import {
  SessionError,
  TOOL_CAPABILITY,
  TOOL_PHASES,
  type BudgetRemaining,
  type ContextResult,
  type SessionTools,
  type ToolName,
} from "../env/contract.js";
import { validateInput } from "../env/input.js";

export interface CodeResult {
  stdout: string;
  stderr: string;
  exitStatus: number | null;
  computeSeconds: number;
  truncated: boolean;
  limit: "wall_clock" | "compute" | "memory" | null;
}
export interface SessionContext {
  game: Game;
  phase: Phase;
  cutoff: string;
  capabilities: Manifest["config"]["profile"]["capabilities"]["enabled"];
  memory: Manifest["config"]["profile"]["memory"];
  dataSources: Manifest["config"]["profile"]["dataSources"];
}
/** Trusted P3 adapter. Paths and persistence hooks are never exposed to the harness. */
export interface Environment {
  context(budget: BudgetRemaining): Promise<ContextResult>;
  transition(phase: LifecyclePhase, cutoff: string): Promise<void>;
  call(name: string, args: unknown, signal: AbortSignal): Promise<unknown>;
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
  backtestPackage?(
    allowance: number,
    signal: AbortSignal,
    input?: import("../policy/backtest.js").BacktestInput,
  ): Promise<import("../policy/backtest.js").BacktestResult>;
  validatePackage?(
    allowance: number,
    signal: AbortSignal,
    input?: ValidationInput,
    jev?: ValidationJev,
  ): Promise<ValidationResult>;
  workspace?: WorkspacePort;
  workspaceChanges?(): WorkspaceChange[];
  boundaryAudit?(): Promise<unknown>;
  close(): Promise<void>;
}
export type EnvironmentFactory = (
  context: SessionContext,
  trusted: {
    workspace: string;
    root: string;
    record: RecordStore;
    countMemory?: MemoryCounter;
    signal?: AbortSignal;
  },
) => Promise<Environment>;
export interface SessionEndpoint extends SessionTools {
  /** Trusted harness transcript sink; never registered as a model tool. */
  recordHistory?(history: unknown): void;
  /** Register bounded harness shutdown before the session record is closed. */
  onClose?(cleanup: () => Promise<void>): void;
}
export interface HarnessHandles {
  session: SessionEndpoint;
  model: ModelEndpoint;
  memoryInstructions: string;
}
export type Harness = (handles: HarnessHandles) => Promise<void>;

export class Runner {
  #lifetime = new AbortController();
  get lifetimeSignal(): AbortSignal {
    return this.#lifetime.signal;
  }
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
    private replayGame?: (
      game: Game,
      trusted: { root: string; record: RecordStore; proxy: MeteringProxy },
    ) => Promise<void>,
  ) {
    const validated = makeManifest(manifest.config, manifest.games);
    if (digest(validated) !== digest(manifest))
      throw Error("Invalid manifest derivation");
    this.manifest = validated;
    if (
      isMemoryV3(validated.config.profile.memory) &&
      validated.config.harness.policy &&
      !replayGame
    )
      throw Error("V3 policy runs require trusted replay integration");
    if (
      validated.config.profile.memory.version === "memory-v1" &&
      validated.config.purpose !== "fixture"
    )
      throw Error(
        "Legacy memory-v1 is retained for historical fixtures only; select a v3 variant",
      );
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
    if (sweepClaimHeld(this.root))
      throw Error("Sandbox cleanup holds run root");
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
      if (sweepClaimHeld(this.root))
        throw Error("Sandbox cleanup holds run root");
      this.record = new RecordStore(this.root, manifest);
      mkdirSync(this.workspace, { recursive: true, mode: 0o700 });
      mkdirSync(join(this.root, "blobs"), { recursive: true });
      const state = this.record
        .events()
        .reverse()
        .find((e) => ["session_end", "session_start"].includes(e.kind));
      const publishedFreeze =
        state?.kind === "session_start" &&
        state.scope.endsWith(":pregame") &&
        isMemoryV3(manifest.config.profile.memory) &&
        manifest.config.harness.policy
          ? new PackageStore(join(this.root, "frozen-packages")).receipt(
              state.scope.split(":")[0],
            )
          : null;
      // A receipt can be atomically published just before the runner records it.
      // Preserve that live committed workspace; ordinary interrupted research
      // still rolls back to the session's starting snapshot.
      if (state && !publishedFreeze)
        restore(
          this.root,
          this.workspace,
          state.kind === "session_end" ? state.data.after : state.data.before,
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
      const removed = (containerId: string, name: string, runRoot: string) => {
        console.error(
          JSON.stringify({
            action: "orphan_container_removed",
            containerId,
            name,
            runRoot,
          }),
        );
      };
      // Own-root cleanup is mandatory before resuming workspace/session use.
      await sweepOwnOrphanContainers(this.root, removed);
      try {
        await sweepOrphanContainers(this.root, removed);
      } catch (error) {
        // Cross-root cleanup is best-effort, including on hosts without Docker.
        console.error(
          JSON.stringify({
            action: "orphan_sweep_unavailable",
            error: String(error),
          }),
        );
      }
      if (isMemoryV3(this.manifest.config.profile.memory))
        restoreMemoryArtifacts(this.root, this.record);
      // Retry publication before advancing after a previous sync failure.
      await this.checkpoint();
      for (const game of this.manifest.games) {
        // Keep season indexes/tags intact while executing only the pinned selection.
        const selected = this.manifest.config.replay?.datasets;
        if (selected && !selected.some((d) => d.gameId === game.gameId))
          continue;
        if (this.manifest.config.purpose === "pilot" && !game.development)
          continue;
        if (this.record.events("game_end", game.gameId).length) continue;
        for (const phase of ["pregame", "postgame"] as const) {
          const scope = `${game.gameId}:${phase}`;
          if (
            phase === "postgame" &&
            isMemoryV3(this.manifest.config.profile.memory) &&
            this.manifest.config.harness.policy
          ) {
            if (!this.replayGame)
              throw Error("V3 policy runs require trusted replay integration");
            if (!this.record.events("replay_completed", game.gameId).length) {
              const path = join(this.root, "feedback", game.gameId + ".json");
              if (!existsSync(path))
                await this.replayGame(game, {
                  root: this.root,
                  record: this.record,
                  proxy: this.proxy,
                });
              const trace = JSON.parse(readFileSync(path, "utf8"));
              if (
                trace.gameId !== game.gameId ||
                trace.releaseAt !== game.release
              )
                throw Error("Replay feedback identity mismatch");
              this.record.append("replay_completed", game.gameId, {
                feedbackHash: digest(trace),
                feedbackBlob: writeBlob(this.root, readFileSync(path)),
              });
            }
          }
          if (this.record.events("phase_end", scope).length) continue;
          const previousEnd = this.record
            .events("session_end", scope)
            .at(-1)?.seq;
          await this.session(game, phase, harness);
          const end = this.record.events("session_end", scope).at(-1);
          // Halt only for a failure produced by this invocation. An explicit
          // resume skips the failed session and continues at the next step.
          if (
            end &&
            end.seq !== previousEnd &&
            end.data.failureKind === "assembler_infrastructure"
          ) {
            this.record.append("run_halted", "run", {
              gameId: game.gameId,
              phase,
              failureKind: "assembler_infrastructure",
              sessionEndSeq: end.seq,
            });
            await this.checkpoint();
            return;
          }
          await this.checkpoint();
        }
        this.record.append("game_end", game.gameId, {
          ...(this.record.events("policy_game_end", game.gameId).at(-1)?.data ??
            {}),
          ...(this.manifest.config.profile.memory.version ===
          "forecast-memory-v1"
            ? {
                forecastStatus:
                  this.record.events("forecast_feedback", game.gameId)[0]?.data
                    .status ?? "unavailable",
                ...gameMetering(this.record, game.gameId),
                codeBytes: codeBytes(this.workspace),
              }
            : {}),
          development: game.development,
        });
        await this.checkpoint();
      }
      if (!this.record.events("run_end").length)
        this.record.append("run_end", "run", {});
      await this.checkpoint();
    } finally {
      this.#running = false;
    }
  }
  private counter(scope: string, signal = AbortSignal.timeout(30_000)) {
    return recordedMemoryCounter(this.record, scope, (request) =>
      this.proxy.countMemory(
        request,
        AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      ),
    );
  }
  private async checkpoint() {
    if (isMemoryV3(this.manifest.config.profile.memory)) {
      const size = await measureMemory(
        this.workspace,
        this.counter("checkpoint"),
      );
      this.record.append("memory_checkpoint", "run", {
        ...size,
        game:
          this.record.events("session_start").at(-1)?.scope.split(":")[0] ??
          null,
      });
    }
    await checkpoint(this.record, this.sink);
  }
  private async session(
    game: Game,
    phase: "pregame" | "postgame",
    harness: Harness,
  ): Promise<void> {
    const scope = `${game.gameId}:${phase}`,
      budget = new Budget(this.record, scope, this.manifest.config, phase);
    const prior = this.record.events("session_start", scope).at(-1);
    if (
      phase === "pregame" &&
      this.manifest.config.profile.memory.version === "forecast-memory-v1"
    ) {
      const lock = this.record.events("forecast_freeze", game.gameId)[0];
      if (lock) {
        restore(this.root, this.workspace, lock.data.workspace);
        if (!this.record.events("session_end", scope).length)
          this.record.append("session_end", scope, {
            attempt: prior?.data.attempt ?? 1,
            status: "completed",
            limit: null,
            before: prior?.data.before ?? lock.data.workspace,
            after: lock.data.workspace,
            usage: budget.totals(),
            elapsedMs: 0,
            recoveredFreeze: true,
          });
        this.record.append("phase_end", scope, {
          status: "completed",
          limit: null,
          recoveredFreeze: true,
        });
        return;
      }
    }
    if (
      phase === "pregame" &&
      isMemoryV3(this.manifest.config.profile.memory) &&
      this.manifest.config.harness.policy
    ) {
      const receipt = new PackageStore(
        join(this.root, "frozen-packages"),
      ).receipt(game.gameId);
      if (receipt) {
        // Receipt publication is the durable commit. Never restart research or
        // restore a pre-freeze workspace after this boundary.
        const committed = this.record
          .events("package_freeze", game.gameId)
          .at(-1);
        if (committed)
          restore(this.root, this.workspace, committed.data.workspace);
        rmSync(join(this.workspace, "scratch"), {
          recursive: true,
          force: true,
        });
        const after = snapshot(this.root, this.workspace);
        if (!committed)
          this.record.append("package_freeze", game.gameId, {
            receipt,
            workspace: after,
            recovered: true,
          });
        if (!this.record.events("session_end", scope).length)
          this.record.append("session_end", scope, {
            attempt: prior?.data.attempt ?? 1,
            status: "completed",
            limit: null,
            before: prior?.data.before ?? after,
            after,
            diff: diff(prior?.data.before ?? after, after),
            memorySize: await measureMemory(
              this.workspace,
              this.counter(scope),
            ),
            usage: budget.totals(),
            elapsedMs: 0,
            recoveredFreeze: true,
          });
        this.record.append("phase_end", scope, {
          status: "completed",
          limit: null,
          recoveredFreeze: true,
        });
        return;
      }
    }
    const durableEnd =
      prior &&
      this.record
        .events("session_end", scope)
        .find((e) => e.data.attempt === prior.data.attempt);
    const retry =
      prior &&
      durableEnd?.data.limit !== "interrupted" &&
      durableEnd?.data.status === "infrastructure_failure" &&
      durableEnd?.data.retryable !== false &&
      prior.data.attempt <
        (this.manifest.config.recovery?.maxSessionAttempts ?? 2);
    if (durableEnd && durableEnd.data.limit !== "interrupted" && !retry) {
      this.record.append("phase_end", scope, {
        status: durableEnd.data.status,
        limit: durableEnd.data.limit,
      });
      return;
    }
    let before: Snapshot;
    if (retry) {
      before = prior.data.before;
      restore(this.root, this.workspace, before);
      this.record.append("attempt_budget_reset", scope, {
        attempt: prior.data.attempt + 1,
      });
    } else if (
      prior &&
      !this.record
        .events("session_end", scope)
        .some((e) => e.data.attempt === prior.data.attempt)
    ) {
      before = prior.data.before;
      restore(this.root, this.workspace, before);
      this.record.append("session_end", scope, {
        attempt: prior.data.attempt,
        status: "infrastructure_failure",
        limit: "interrupted",
        before: prior.data.before,
        after: before,
        ...(isMemoryV3(this.manifest.config.profile.memory)
          ? {
              memorySize: await measureMemory(
                this.workspace,
                this.counter(scope),
              ),
            }
          : {}),
        diff: diff(prior.data.before, before),
        usage: budget.totals(),
        // Charge only observed work in this attempt, not the outage before resume.
        elapsedMs:
          this.record
            .events(undefined, scope)
            .filter((event) => event.seq > prior.seq)
            .reduce(
              (latest, event) => Math.max(latest, Date.parse(event.at)),
              Date.parse(prior.at),
            ) - Date.parse(prior.at),
      });
    } else {
      if (isMemoryV3(this.manifest.config.profile.memory)) {
        const memory = this.manifest.config.profile.memory;
        const current = snapshot(this.root, this.workspace);
        const policy = new WorkspacePolicy(
          memory,
          () => phase,
          true,
          game.gameId,
        );
        current.files = Object.fromEntries(
          Object.entries(current.files).filter(
            ([path]) => !path.startsWith("scratch/") && policy.visible(path),
          ),
        );
        restore(this.root, this.workspace, current);
      }
      if (
        phase === "pregame" &&
        this.manifest.config.profile.memory.horizon === "stateless"
      )
        restore(this.root, this.workspace, { files: {} });
      if (
        phase === "pregame" &&
        this.manifest.config.profile.memory.horizon === "window"
      ) {
        const k = this.manifest.config.profile.memory.windowGames!;
        const changes: WorkspaceChange[] = [];
        for (const previous of this.manifest.games.slice(
          Math.max(0, game.index - k),
          game.index,
        )) {
          for (const p of ["pregame", "postgame"] as const) {
            const ended = this.record
              .events("session_end", `${previous.gameId}:${p}`)
              .filter((e) => e.data.limit !== "interrupted")
              .at(-1)?.data;
            changes.push(...(ended?.workspaceChanges ?? []));
          }
        }
        restore(this.root, this.workspace, windowSnapshot(this.root, changes));
      }
      before = snapshot(this.root, this.workspace);
    }
    if (
      phase === "postgame" &&
      this.manifest.config.profile.memory.version !== "forecast-memory-v1" &&
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
      ...(isMemoryV3(this.manifest.config.profile.memory)
        ? {
            memorySize: await measureMemory(
              this.workspace,
              this.counter(scope),
            ),
          }
        : {}),
      cutoff: phase === "pregame" ? game.scheduledStart : game.release,
    });
    const controller = new AbortController();
    const started = Date.now();
    let environment: Environment | undefined,
      endpoint: ModelEndpoint | undefined,
      active = true,
      busy = false;
    let pending: Promise<unknown> | undefined;
    const harnessCleanup: Array<() => Promise<void>> = [];
    let assemblerFailure = false;
    let status: Status = "completed",
      limit: Limit = null;
    const previousElapsed = budget
      .events("session_end")
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
            capabilities: this.manifest.config.profile.capabilities.enabled,
            memory: this.manifest.config.profile.memory,
            dataSources: this.manifest.config.profile.dataSources,
          },
          {
            root: this.root,
            workspace: this.workspace,
            record: this.record,
            signal: controller.signal,
            ...(this.manifest.config.profile.memory.version !== "memory-v1"
              ? { countMemory: this.counter(scope, controller.signal) }
              : {}),
          },
        );
        const env = environment;
        if (
          this.manifest.config.profile.memory.horizon === "window" &&
          !env.workspaceChanges
        )
          throw Error("Window memory requires a workspace mutation journal");
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
        if (!active || controller.signal.aborted)
          throw new LimitError("wall_clock");
        endpoint = this.proxy.issue(budget, controller.signal);
        const call = async (name: string, args?: unknown): Promise<unknown> => {
          if (!active || controller.signal.aborted)
            throw new SessionError("phase_refused", "Session closed");
          if (busy)
            throw new SessionError(
              "phase_refused",
              "Concurrent environment calls refused",
            );
          busy = true;
          const work = async () => {
            if (
              this.manifest.config.profile.memory.version ===
              "forecast-memory-v1"
            ) {
              forecastTool(
                name,
                budget.stage,
                this.manifest.config.profile.memory.horizon === "season",
              );
              if (
                [
                  "reference_projection",
                  "validate_forecast",
                  "freeze_forecast",
                  "read_feedback",
                ].includes(name)
              ) {
                budget.tool(name, args);
                const result = await env.call(
                  name,
                  args ?? {},
                  controller.signal,
                );
                if (
                  name === "freeze_forecast" &&
                  (result as { ok: boolean }).ok
                ) {
                  await env.transition("commit", game.scheduledStart);
                }
                return result;
              }
            }
            validateInput(name, args ?? {});
            if (!Object.hasOwn(TOOL_PHASES, name))
              throw new SessionError("invalid_input", "Unknown tool");
            const tool = name as ToolName;
            if (!TOOL_PHASES[tool].includes(budget.stage))
              throw new SessionError(
                "phase_refused",
                "Tool locked in this phase",
              );
            const capability = TOOL_CAPABILITY[tool];
            if (
              capability &&
              !this.manifest.config.profile.capabilities.enabled.includes(
                capability,
              )
            )
              throw new SessionError(
                "capability_disabled",
                "Capability disabled",
              );
            const remaining = (): BudgetRemaining => {
              const r = budget.remaining();
              return {
                tokens: r.tokens,
                compute_seconds: r.compute,
                tool_calls: r.tools,
                warning: r.warning,
              };
            };
            if (name === "context") return env.context(remaining());
            if (
              name.startsWith("workspace_") &&
              !(
                isMemoryV3(this.manifest.config.profile.memory) &&
                ["workspace_list", "workspace_read"].includes(name) &&
                ((args as { path?: string }).path ?? "").split("/")[0] ===
                  "feedback"
              )
            )
              new WorkspacePolicy(
                this.manifest.config.profile.memory,
                () => budget.stage,
                !!this.manifest.config.harness.policy,
                game.gameId,
              ).authorize(
                name === "workspace_edit"
                  ? "write"
                  : (name.slice(10) as WorkspaceOperation),
                false,
                (args as { path?: string })?.path ||
                  (name === "workspace_list" &&
                  this.manifest.config.harness.policy &&
                  !isMemoryV3(this.manifest.config.profile.memory)
                    ? "packages"
                    : ""),
              );
            budget.tool(name, args);
            if (name === "backtest_package") {
              if (!env.backtestPackage)
                throw new SessionError(
                  "capability_disabled",
                  "Package backtest unavailable",
                );
              const allowance = Math.min(
                this.manifest.config.budget.sandbox.perCallSeconds,
                budget.remaining().compute,
              );
              if (allowance <= 0) budget.block("compute");
              const reservation = budget.reserve(0, allowance, "code");
              this.record.append("backtest_start", scope, {
                reservation,
                input: args ?? {},
                allowance,
              });
              const result = await env.backtestPackage(
                allowance,
                controller.signal,
                (args ?? {}) as import("../policy/backtest.js").BacktestInput,
              );
              if (
                !Number.isFinite(result.computeSeconds) ||
                result.computeSeconds < 0
              )
                throw Error("Invalid backtest meter");
              this.record.append("package_backtest", scope, result);
              budget.settle(reservation, 0, result.computeSeconds, result);
              return result;
            }
            if (name === "validate_package") {
              if (!env.validatePackage)
                throw new SessionError(
                  "capability_disabled",
                  "Package validation unavailable",
                );
              const allowance = Math.min(
                this.manifest.config.budget.sandbox.perCallSeconds,
                budget.remaining().compute,
              );
              if (allowance <= 0) budget.block("compute");
              const reservation = budget.reserve(0, allowance, "code");
              const validationScope = `${scope}:validation:${this.record.events("validation_start", scope).length + 1}`;
              this.record.append("validation_start", scope, {
                validationScope,
                input: args ?? {},
              });
              const result = await env.validatePackage(
                allowance,
                controller.signal,
                (args ?? {}) as ValidationInput,
                async (request, signal) => {
                  const response = await this.proxy.jev(
                    request,
                    this.record,
                    validationScope,
                    signal,
                  );
                  return response.response.answers;
                },
              );
              if (
                !Number.isFinite(result.computeSeconds) ||
                result.computeSeconds < 0
              )
                throw Error("Invalid validation meter");
              budget.settle(reservation, 0, result.computeSeconds, result);
              return result;
            }
            if (name === "execute_code") {
              const program = (args as { program: string }).program;
              const sandbox = this.manifest.config.budget.sandbox;
              const allowance = Math.min(
                sandbox.perCallSeconds,
                budget.remaining().compute,
              );
              if (allowance <= 0) budget.block("compute");
              const reservation = budget.reserve(0, allowance, "code");
              this.record.append("code_start", scope, {
                reservation,
                program,
              });
              const result = await env.execute(
                program,
                {
                  wallSeconds: allowance,
                  computeSeconds: allowance,
                  stdoutBytes: sandbox.stdoutBytes,
                  cpu: sandbox.cpu,
                  memoryBytes: sandbox.memoryBytes,
                },
                // Export/container setup is session work; the sandbox enforces
                // the per-program wall limit after setup and returns its meter.
                controller.signal,
              );
              if (
                !Number.isFinite(result.computeSeconds) ||
                result.computeSeconds < 0
              )
                throw Error("Invalid compute meter");
              const output = capCodeOutput(
                result.stdout,
                result.stderr,
                sandbox.stdoutBytes,
              );
              const recorded = {
                ...result,
                ...output,
                truncated: result.truncated || output.truncated,
              };
              this.record.append("code_result", scope, {
                reservation,
                ...recorded,
              });
              budget.settle(reservation, 0, result.computeSeconds, recorded);
              return {
                stdout: recorded.stdout,
                stderr: recorded.stderr,
                exit_status: recorded.exitStatus,
                compute_seconds: recorded.computeSeconds,
                truncated: recorded.truncated,
                limit: recorded.limit,
                ...(recorded.truncated
                  ? {
                      truncation_notice: `Code output truncated to ${sandbox.stdoutBytes} bytes across stdout and stderr; print a smaller summary or save results to a file.`,
                    }
                  : {}),
              };
            }
            return env.call(name, args ?? {}, controller.signal);
          };
          pending = work();
          try {
            const result = await pending;
            if (
              name === "freeze_package" &&
              isMemoryV3(this.manifest.config.profile.memory) &&
              result &&
              typeof result === "object" &&
              "packageHash" in result
            ) {
              await env.transition("commit", game.scheduledStart);
              if (!this.record.events("package_freeze", game.gameId).length)
                this.record.append("package_freeze", game.gameId, {
                  receipt: result,
                  workspace: snapshot(this.root, this.workspace),
                });
            }
            this.record.append("tool_result", scope, {
              name,
              args: args ?? null,
              result,
            });
            return result;
          } catch (e) {
            if (e instanceof AssemblerInfrastructureError)
              assemblerFailure = true;
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
          session: Object.freeze({
            call,
            onClose: (cleanup: () => Promise<void>) => {
              harnessCleanup.push(cleanup);
            },
            recordHistory: (history: unknown) => {
              this.record.append("harness_history", scope, {
                attempt,
                history,
              });
            },
          }) as SessionEndpoint,
          model: endpoint,
          memoryInstructions: this.manifest.config.harness.memoryInstructions,
        });
        await harness(handles);
      };
      await Promise.race([executeSession(), expired]);
      const last = budget.events("limit").at(-1);
      const modelFailure = budget
        .events("model_error")
        .some((e) => !e.data.limit && e.data.terminal !== false);
      status = assemblerFailure
        ? "infrastructure_failure"
        : last
          ? "budget_exhausted"
          : modelFailure
            ? "infrastructure_failure"
            : "completed";
      limit = assemblerFailure
        ? "infrastructure"
        : (last?.data.limit ?? (modelFailure ? "infrastructure" : null));
    } catch (e) {
      if (e instanceof AssemblerInfrastructureError) assemblerFailure = true;
      status =
        e instanceof LimitError
          ? "budget_exhausted"
          : e instanceof SessionError && e.code === "budget_exhausted"
            ? "budget_exhausted"
            : "infrastructure_failure";
      limit =
        e instanceof LimitError
          ? e.limit
          : e instanceof SessionError && e.code === "budget_exhausted"
            ? (budget.events("limit").at(-1)?.data.limit ?? "tool_calls")
            : "infrastructure";
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
      for (const cleanup of harnessCleanup) await cleanup();
      if (environment)
        try {
          try {
            if (phase === "postgame")
              await environment.transition("checkpoint", game.release);
          } finally {
            await environment.close();
          }
        } catch {
          status = "infrastructure_failure";
          limit = "infrastructure";
        }
    }
    if (isMemoryV3(this.manifest.config.profile.memory)) {
      rmSync(join(this.workspace, "scratch"), { recursive: true, force: true });
      if (phase === "postgame") {
        if (!environment?.boundaryAudit)
          this.record.append("boundary_audit_skipped", game.gameId, {
            attempt,
            status,
            reason: "environment_unavailable",
          });
        else
          try {
            this.record.append(
              "boundary_audit",
              game.gameId,
              await environment.boundaryAudit(),
            );
          } catch {
            this.record.append("boundary_audit_skipped", game.gameId, {
              attempt,
              status,
              reason: "audit_failed",
            });
          }
      }
    }
    const after = snapshot(this.root, this.workspace);
    this.record.append("session_end", scope, {
      attempt,
      ...(assemblerFailure
        ? { retryable: false, failureKind: "assembler_infrastructure" }
        : {}),
      status,
      limit,
      before,
      after,
      diff: diff(before, after),
      workspaceChanges: environment?.workspaceChanges?.() ?? [],
      ...(this.manifest.config.profile.memory.version === "forecast-memory-v1"
        ? { codeBytes: codeBytes(this.workspace) }
        : {}),
      ...(isMemoryV3(this.manifest.config.profile.memory)
        ? {
            memorySize: await measureMemory(
              this.workspace,
              this.counter(scope),
            ),
          }
        : {}),
      usage: budget.totals(),
      elapsedMs: Date.now() - started,
    });
    if (
      status === "infrastructure_failure" &&
      !assemblerFailure &&
      attempt < (this.manifest.config.recovery?.maxSessionAttempts ?? 2)
    ) {
      await this.session(game, phase, harness);
      return;
    }
    this.record.append("phase_end", scope, { status, limit });
  }
  close(): void {
    if (this.#running) throw Error("Cannot close active runner");
    if (this.#closed) return;
    this.#closed = true;
    this.#lifetime.abort(new Error("Runner closed"));
    this.record.close();
    rmSync(this.#lock, { force: true });
  }
}
