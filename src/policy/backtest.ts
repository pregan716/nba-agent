import { chmodSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { releaseTime } from "../env/visibility.js";
import { canonicalJson } from "../env/tools.js";
import { PackageStore } from "./package.js";
import type { Assembler } from "./sandbox.js";
import { AssemblerInfrastructureError } from "./errors.js";
import { codeAssemblySchema } from "./request.js";
import { deferSchema, packageAnswer } from "../replay/code-prediction.js";
import {
  candidateReasons,
  validateSwap,
  type SwapContract,
} from "../replay/swap.js";
import { scoreWindow, summarize } from "../replay/scoring.js";
import {
  BOS,
  type DecisionDataset,
  type ObservableState,
  type WindowResult,
} from "../replay/types.js";

export interface BacktestInput {
  per_window?: boolean;
}
export interface BacktestGame {
  scheduledStart: string;
  dataset: DecisionDataset;
}
export interface BacktestData {
  games: BacktestGame[];
  skipped?: { gameId: string; scheduledStart: string; reason: string }[];
}
export type BacktestSource = (
  cutoff: string,
  signal: AbortSignal,
) => Promise<BacktestData>;
/** Retain only the current cutoff, shared across calls and sessions for one runner.
 * A completed load is charged once; failed/aborted loads are never reused. */
export function cachedBacktestSource(source: BacktestSource): BacktestSource {
  let cached: { cutoff: string; data: Promise<BacktestData> } | undefined;
  return (cutoff, signal) => {
    signal.throwIfAborted();
    if (cached?.cutoff === cutoff) return cached.data;
    const entry = { cutoff, data: source(cutoff, signal) };
    cached = entry;
    void entry.data.catch(() => {
      if (cached === entry) cached = undefined;
    });
    return entry.data;
  };
}
/** A trusted future starter-model integration; never an agent-supplied predictor. */
export interface BacktestStarter {
  hash: string;
  predict(
    state: ObservableState,
    signal: AbortSignal,
  ): Promise<{ prediction: unknown; candidates: unknown }>;
}
/** Stop waiting at the call deadline; trusted loaders also observe the signal
 * between reads, so a pending object-store read cannot start further work. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
function report(rows: WindowResult[]) {
  return {
    ...summarize(rows),
    calibrationByStoppage: Object.fromEntries(
      [...new Set(rows.map((r) => r.window.state!.stoppage.kind))]
        .sort()
        .map((kind) => [
          kind,
          summarize(rows.filter((r) => r.window.state!.stoppage.kind === kind))
            .calibration,
        ]),
    ),
  };
}
export function scorePackage(
  window: WindowResult["window"],
  assembly: any,
  contract: SwapContract,
) {
  const reasons = candidateReasons(assembly?.candidates, window.state!);
  const raw = packageAnswer(assembly?.prediction, assembly?.candidates ?? null);
  if (!reasons.length) {
    const validation = validateSwap(raw, window.state!, contract);
    for (const [question, value] of Object.entries(validation.questions))
      for (const reason of value.reasons) reasons.push(`${question}:${reason}`);
  }
  return {
    reasons,
    result: scoreWindow(
      window,
      raw,
      reasons.length ? "assembler_error" : null,
      { ...contract, version: "jev-contract-v2" },
    ),
  };
}
/** Only observable states cross the assembler boundary. Outcomes stay in the scorer. */
export async function backtestPackage(options: {
  root: string;
  workspace: string;
  gameId: string;
  cutoff: string;
  clock: () => string;
  assembler: Assembler;
  contract: SwapContract;
  source: BacktestSource;
  allowance: number;
  signal: AbortSignal;
  input: BacktestInput;
  starter?: BacktestStarter;
}) {
  const { signal, assembler, contract } = options;
  if (!Number.isFinite(options.allowance) || options.allowance <= 0)
    throw Error("No backtest compute allowance");
  const start = performance.now();
  const deadline = AbortSignal.any([
    signal,
    AbortSignal.timeout(Math.ceil(options.allowance * 1000)),
  ]);
  const temporary = new PackageStore(
    join(options.root, "backtests", randomUUID()),
  );
  const rows: WindowResult[] = [],
    deferred: WindowResult[] = [],
    rest: WindowResult[] = [],
    starterRows: WindowResult[] = [];
  const starterErrors: { windowId: string; reason: string }[] = [];
  const invalid: Record<string, number> = {},
    wouldDefer: Record<string, number> = {};
  const details: {
    gameId: string;
    windowId: string;
    wouldDefer: boolean;
    reasons: string[];
    scores: WindowResult["scores"];
  }[] = [];
  let receipt: import("./package.js").PackageReceipt | null = null;
  let games: BacktestGame[] = [],
    skipped: BacktestData["skipped"] = [],
    total: number | null = null,
    complete = false,
    error: string | null = null;
  try {
    receipt = await temporary.freeze(
      options.gameId,
      join(options.workspace, "packages", options.gameId),
      options.clock,
      options.cutoff,
      assembler,
      deadline,
    );
    const cutoff = new Date(
      Math.min(Date.parse(options.cutoff), Date.parse(options.clock())),
    ).toISOString();
    const data = await abortable(options.source(cutoff, deadline), deadline);
    deadline.throwIfAborted();
    // Recheck trusted input at this boundary; a planted future dataset is never executed or returned.
    games = data.games
      .filter((g) => {
        const d = g.dataset,
          released = Date.parse(releaseTime(g.scheduledStart));
        const season = d.trainingOnly?.season;
        return (
          d.gameId !== options.gameId &&
          released < Date.parse(cutoff) &&
          (!d.teamId || d.teamId === BOS) &&
          (season === "2024-25"
            ? d.trainingOnly?.rosterPolicy === "same-game-box-score-v1"
            : !season ||
              (season === "2025-26" &&
                d.trainingOnly?.rosterPolicy === "season-pregame-v1"))
        );
      })
      .sort(
        (a, b) =>
          b.scheduledStart.localeCompare(a.scheduledStart) ||
          a.dataset.gameId.localeCompare(b.dataset.gameId),
      );
    skipped = (data.skipped ?? []).filter(
      (g) =>
        g.gameId !== options.gameId &&
        Date.parse(releaseTime(g.scheduledStart)) < Date.parse(cutoff),
    );
    const eligible = games.flatMap((g) =>
      g.dataset.windows.filter(
        (w) =>
          !w.exclusions.length &&
          w.state &&
          w.actual &&
          w.gameId === g.dataset.gameId &&
          w.state.gameId === g.dataset.gameId,
      ),
    );
    total = eligible.length;
    const batchSize = 256;
    let first: import("./sandbox.js").BatchAssemblyResult[] = [],
      second: import("./sandbox.js").BatchAssemblyResult[] = [];
    for (let index = 0; index < eligible.length; index++) {
      const w = eligible[index];
      if (assembler.runBatch && index % batchSize === 0) {
        const states = eligible
          .slice(index, index + batchSize)
          .map((w) => w.state);
        try {
          const path = join(temporary.path(options.gameId), "package");
          first = await assembler.runBatch(path, states, deadline);
          second = await assembler.runBatch(path, states, deadline);
          if (first.length !== states.length || second.length !== states.length)
            throw Error("Incomplete assembler batch");
        } catch (e) {
          deadline.throwIfAborted();
          if (e instanceof AssemblerInfrastructureError) throw e;
          first = second = states.map(() => ({
            error: "Assembler batch failed",
          }));
        }
      }
      deadline.throwIfAborted();
      let assembly: any = null,
        reasons: string[] = [],
        would = false;
      try {
        const path = join(temporary.path(options.gameId), "package");
        const a = assembler.runBatch
          ? first[index % batchSize]
          : await assembler.run(path, w.state, deadline);
        const b = assembler.runBatch
          ? second[index % batchSize]
          : await assembler.run(path, w.state, deadline);
        if (("error" in a && a.error) || ("error" in b && b.error))
          throw Error("Assembler failed");
        deadline.throwIfAborted();
        if (canonicalJson(a.value) !== canonicalJson(b.value))
          reasons.push("nondeterministic_assembly");
        assembly = a.value;
        const defer = deferSchema.safeParse(assembly?.defer);
        would = defer.success && !!defer.data;
        if (!defer.success) reasons.push("malformed_defer");
        if (!codeAssemblySchema.safeParse(assembly).success)
          reasons.push("invalid_assembly");
      } catch (e) {
        deadline.throwIfAborted();
        if (e instanceof AssemblerInfrastructureError) throw e;
        reasons.push("assembly_error");
      }
      const scored = scorePackage(w, assembly, contract);
      reasons.push(...scored.reasons);
      const result = reasons.length
        ? scoreWindow(w, scored.result.raw, "assembler_error", {
            ...contract,
            version: "jev-contract-v2",
          })
        : scored.result;
      // Score the starter on exactly the same completed windows, before committing this row.
      let starterResult: WindowResult | undefined;
      if (options.starter) {
        try {
          starterResult = scorePackage(
            w,
            await options.starter.predict(w.state!, deadline),
            contract,
          ).result;
        } catch (e) {
          deadline.throwIfAborted();
          starterErrors.push({
            windowId: w.id,
            reason:
              e instanceof Error ? e.message : "Starter prediction failed",
          });
        }
      }
      deadline.throwIfAborted();
      rows.push(result);
      if (starterResult) starterRows.push(starterResult);
      (would ? deferred : rest).push(result);
      if (would)
        wouldDefer[w.state!.stoppage.kind] =
          (wouldDefer[w.state!.stoppage.kind] ?? 0) + 1;
      for (const reason of new Set(reasons))
        invalid[reason] = (invalid[reason] ?? 0) + 1;
      if (options.input.per_window)
        details.push({
          gameId: w.gameId,
          windowId: w.id,
          wouldDefer: would,
          reasons: [...new Set(reasons)],
          scores: result.scores,
        });
    }
    complete = true;
  } catch (e) {
    signal.throwIfAborted();
    if (e instanceof AssemblerInfrastructureError) throw e;
    error = deadline.aborted
      ? "compute_limit"
      : e instanceof Error
        ? e.message
        : "Backtest failed";
  } finally {
    const unlock = (p: string) => {
      chmodSync(p, 0o700);
      for (const name of readdirSync(p)) {
        const child = join(p, name);
        if (lstatSync(child).isDirectory()) unlock(child);
      }
    };
    unlock(temporary.root);
    rmSync(temporary.root, { recursive: true, force: true });
  }
  return {
    label: "package-only; deferral ignored" as const,
    complete,
    error,
    eligibleWindows: total,
    package: receipt,
    games: games.map((g) => ({
      gameId: g.dataset.gameId,
      inputHash: g.dataset.inputHash,
      release: releaseTime(g.scheduledStart),
      roster: g.dataset.trainingOnly ?? {
        season: "2025-26",
        rosterPolicy: "season-pregame-v1",
      },
    })),
    skipped,
    summary: report(rows),
    invalidByReason: invalid,
    wouldDefer,
    split: { wouldDefer: report(deferred), nonDeferred: report(rest) },
    starter: options.starter
      ? {
          label: "in-sample" as const,
          hash: options.starter.hash,
          summary: report(starterRows),
          attemptedWindows: rows.length,
          errors: starterErrors,
        }
      : {
          label: "unavailable" as const,
          reason: "Starter model not installed",
        },
    ...(options.input.per_window ? { windows: details } : {}),
    computeSeconds: (performance.now() - start) / 1000,
  };
}
export type BacktestResult = Awaited<ReturnType<typeof backtestPackage>>;
