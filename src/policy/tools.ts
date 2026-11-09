import {
  CODE_CONTRACT,
  validCodePrediction,
} from "../replay/code-prediction.js";
import { validateSwap, type SwapContract } from "../replay/swap.js";
import { validateInput } from "../env/input.js";
import { contextGuard, mapJevAnswers } from "./request.js";
import { validatePrediction } from "../replay/contract.js";
import {
  selectValidationSamples,
  stoppageType,
  windowId,
  type Candidate,
  type ValidationInput,
  type ValidationJev,
  type ValidationOutput,
  type ValidationResult,
  type ValidationSummary,
} from "./validation.js";
import { AssemblerInfrastructureError } from "./errors.js";
import { feedbackPage, type FeedbackQuery } from "./feedback.js";
import { randomUUID } from "node:crypto";
import { releaseTime } from "../env/visibility.js";
import { join } from "node:path";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  chmodSync,
  readdirSync,
  lstatSync,
  rmSync,
} from "node:fs";
import type { Assembler } from "./sandbox.js";
import { PackageStore } from "./package.js";
import { assembleRequest, type PolicyTrace } from "./replay.js";
import type { ObservableState } from "../replay/types.js";
import { SessionError, type Phase } from "../env/contract.js";
export interface ValidationSample {
  windowId?: string;
  gameId: string;
  scheduledStart: string;
  release: string;
  inputHash: string;
  state: ObservableState;
}
export interface PolicyGame {
  gameId: string;
  scheduledStart: string;
  release: string;
}
/** Trusted service. Games and validation samples come from the runner, never tool arguments. */
export class PolicyTools {
  readonly packages: PackageStore;
  constructor(
    readonly root: string,
    readonly workspace: string,
    readonly game: PolicyGame,
    readonly schedule: PolicyGame[],
    readonly assembler: Assembler,
    readonly samples: Candidate[],
    private clock: () => string,
    readonly fallbackSamples: ValidationSample[] = [],
    readonly swapContract?: SwapContract,
  ) {
    if (
      new Set(schedule.map((g) => g.gameId)).size !== schedule.length ||
      schedule.some(
        (g) =>
          !/^[A-Za-z0-9_-]+$/.test(g.gameId) ||
          !Number.isFinite(Date.parse(g.scheduledStart)) ||
          Date.parse(g.release) !== Date.parse(releaseTime(g.scheduledStart)),
      )
    )
      throw Error("Invalid policy schedule");
    this.packages = new PackageStore(join(root, "frozen-packages"));
    if (
      schedule.filter(
        (g) =>
          g.gameId === game.gameId &&
          g.scheduledStart === game.scheduledStart &&
          g.release === game.release,
      ).length !== 1
    )
      throw Error("Current game absent from policy schedule");
  }
  async freeze(phase: Phase, signal: AbortSignal) {
    if (phase !== "pregame")
      throw new SessionError("phase_refused", "Freeze is pregame only");
    try {
      return await this.packages.freeze(
        this.game.gameId,
        join(this.workspace, "packages", this.game.gameId),
        this.clock,
        this.game.scheduledStart,
        this.assembler,
        signal,
      );
    } catch (e) {
      signal.throwIfAborted();
      if (e instanceof AssemblerInfrastructureError) throw e;
      return {
        status: "invalid_package" as const,
        reason: e instanceof Error ? e.message : "Invalid package",
      };
    }
  }
  async validate(
    phase: Phase,
    allowance: number,
    signal: AbortSignal,
    input: ValidationInput = {},
    jev?: ValidationJev,
  ): Promise<ValidationResult> {
    validateInput("validate_package", input);
    if (phase !== "pregame")
      throw new SessionError("phase_refused", "Validation is pregame only");
    if (!(allowance > 0)) throw Error("No validation compute allowance");
    const start = performance.now(),
      deadline = AbortSignal.any([
        signal,
        AbortSignal.timeout(Math.ceil(allowance * 1000)),
      ]);
    // Temporary validated snapshot is separate from the game's final freeze.
    const temporary = new PackageStore(
      join(
        this.root,
        "local-validation",
        String(Date.now()) + "-" + Math.random().toString(16).slice(2),
      ),
    );
    const outputs: ValidationOutput[] = [];
    let note: string | undefined;
    const answered: { type: string; p: number }[] = [];
    const summary = (): ValidationSummary | null => {
      if (!input.jev || !answered.length) return null;
      const byStoppage: ValidationSummary["byStoppage"] = {};
      for (const type of new Set(answered.map((a) => a.type))) {
        const rows = answered.filter((a) => a.type === type);
        byStoppage[type] = {
          n: rows.length,
          meanSubstitutionProbability:
            rows.reduce((s, a) => s + a.p, 0) / rows.length,
        };
      }
      return {
        samples: outputs.length,
        answered: answered.length,
        meanSubstitutionProbability:
          answered.reduce((s, a) => s + a.p, 0) / answered.length,
        byStoppage,
      };
    };
    try {
      const receipt = await temporary.freeze(
        this.game.gameId,
        join(this.workspace, "packages", this.game.gameId),
        this.clock,
        this.game.scheduledStart,
        this.assembler,
        deadline,
      );
      const released = (g: PolicyGame) =>
        g.gameId !== this.game.gameId &&
        Date.parse(g.release) <= Date.parse(this.clock()) &&
        Date.parse(g.release) < Date.parse(this.game.scheduledStart);
      const hasEarlier = this.schedule.some(released);
      const samples = hasEarlier
        ? this.samples.filter((s) => {
            const g = this.schedule.find((g) => g.gameId === s.gameId);
            return g && released(g) && s.state.gameId === s.gameId;
          })
        : this.fallbackSamples.filter(
            (s) =>
              released(s) &&
              Date.parse(s.release) < Date.parse(this.clock()) &&
              s.state.gameId === s.gameId &&
              Number.isFinite(Date.parse(s.scheduledStart)) &&
              s.release === releaseTime(s.scheduledStart) &&
              Date.parse(s.scheduledStart) < Date.parse("2025-07-01T00:00:00Z"),
          );
      const count = input.samples ?? 3;
      const selected = hasEarlier
        ? selectValidationSamples(
            samples,
            count,
            new Map(this.schedule.map((g) => [g.gameId, g.release])),
          )
        : samples.slice(0, Math.min(count, 3));
      if (!hasEarlier && count > 3)
        note =
          "Only three fixed prior-season states exist; returning the available released states.";
      for (const sample of selected) {
        deadline.throwIfAborted();
        const output: ValidationOutput = {
          gameId: sample.gameId,
          windowId: windowId(sample),
          request: null,
          diagnostics: null,
          ...(input.jev ? { answers: null } : {}),
        };
        outputs.push(output);
        try {
          const result = await assembleRequest(
            this.assembler,
            join(temporary.path(this.game.gameId), "package"),
            receipt,
            sample.state,
            join(temporary.root, "cache"),
            deadline,
            true,
            this.swapContract,
          );
          output.request = result.request;
          if (this.swapContract?.version === CODE_CONTRACT) {
            output.prediction = result.assembly.prediction ?? null;
            output.defer = result.assembly.defer ?? null;
            output.predictionValid = validCodePrediction(
              output.prediction,
              result.assembly.candidates,
              sample.state,
              this.swapContract,
            );
          }
          output.diagnostics = result.assembly.diagnostics;
          contextGuard(result.request);
          if (input.jev) {
            if (!jev) throw Error("Jev validation provider unavailable");
            const raw = mapJevAnswers(await jev(result.request, deadline));
            deadline.throwIfAborted();
            const checked = this.swapContract
              ? validateSwap(
                  {
                    ...(raw as object),
                    candidates: result.assembly.candidates,
                  },
                  sample.state,
                  this.swapContract,
                )
              : validatePrediction(raw, sample.state);
            if (Object.values(checked.questions).some((q) => !q.valid))
              throw Error("Invalid Jev validation answers");
            output.answers = raw;
            if (checked.swap) output.derived = checked.swap;
            answered.push({
              type: stoppageType(sample.state),
              p: checked.answers.substitution.noul,
            });
          }
        } catch (e) {
          deadline.throwIfAborted();
          if (e instanceof AssemblerInfrastructureError) throw e;
          output.error =
            e instanceof Error ? e.message : "Validation sample failed";
        }
      }
      return {
        outputs,
        summary: summary(),
        ...(note ? { note } : {}),
        computeSeconds: (performance.now() - start) / 1000,
        error: null,
      };
    } catch (e) {
      signal.throwIfAborted();
      if (e instanceof AssemblerInfrastructureError) throw e;
      return {
        outputs,
        summary: summary(),
        ...(note ? { note } : {}),
        computeSeconds: (performance.now() - start) / 1000,
        error: e instanceof Error ? e.message : "Validation failed",
      };
    } finally {
      const unlock = (path: string) => {
        chmodSync(path, 0o700);
        for (const name of readdirSync(path)) {
          const child = join(path, name);
          if (lstatSync(child).isDirectory()) unlock(child);
        }
      };
      unlock(temporary.root);
      rmSync(temporary.root, { recursive: true, force: true });
    }
  }
  readFeedback(phase: Phase, gameId?: string, query: FeedbackQuery = {}) {
    if (!Number.isFinite(Date.parse(this.clock())))
      throw new SessionError("not_found", "Feedback unavailable");
    const ordered = [...this.schedule].sort(
      (a, b) => Date.parse(a.scheduledStart) - Date.parse(b.scheduledStart),
    );
    const index = ordered.findIndex((g) => g.gameId === this.game.gameId);
    const allowed =
      phase === "pregame"
        ? ordered[index - 1]
        : phase === "postgame"
          ? ordered[index]
          : undefined;
    if (
      !allowed ||
      (gameId !== undefined && gameId !== allowed.gameId) ||
      Date.parse(allowed.release) > Date.parse(this.clock())
    )
      throw new SessionError("not_found", "Feedback unavailable");
    const path = join(this.root, "feedback", allowed.gameId + ".json");
    if (!existsSync(path))
      throw new SessionError("not_found", "Feedback unavailable");
    const trace = JSON.parse(readFileSync(path, "utf8")) as PolicyTrace;
    if (trace.gameId !== allowed.gameId || trace.releaseAt !== allowed.release)
      throw Error("Feedback identity mismatch");
    return feedbackPage(trace, query);
  }
  saveFeedback(trace: PolicyTrace) {
    const game = this.schedule.find((g) => g.gameId === trace.gameId);
    if (
      !game ||
      game.release !== trace.releaseAt ||
      trace.windows.some((w) => w.result.window.gameId !== trace.gameId)
    )
      throw Error("Feedback game mismatch");
    const root = join(this.root, "feedback");
    mkdirSync(root, { recursive: true });
    const path = join(root, trace.gameId + ".json"),
      text = JSON.stringify(trace);
    if (existsSync(path)) {
      if (readFileSync(path, "utf8") !== text)
        throw Error("Feedback already published");
      return;
    }
    const temp = path + "." + randomUUID();
    writeFileSync(temp, text, { flag: "wx", mode: 0o400, flush: true });
    renameSync(temp, path);
  }
}
