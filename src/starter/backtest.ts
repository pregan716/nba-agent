import { digest } from "../runner/config.js";
import { BACKTEST_EXECUTION } from "../policy/execution.js";
import {
  eligibleBacktestGames,
  type BacktestData,
  type BacktestStarter,
} from "../policy/backtest.js";
import type { ObservableState } from "../replay/types.js";

/** Trusted pregame work, outside agent compute. Only observable states reach
 * prediction; outcomes remain in the scorer. Missing cache entries fail closed. */
export class StarterBacktestCache {
  private entries = new Map<string, Promise<BacktestStarter>>();
  prepare(
    predictor: BacktestStarter,
    data: BacktestData,
    gameId: string,
    cutoff: string,
    signal: AbortSignal,
  ): Promise<BacktestStarter> {
    signal.throwIfAborted();
    const key = `${predictor.hash}:${cutoff}`;
    const existing = this.entries.get(key);
    if (existing) return existing;
    const work = this.build(predictor, data, gameId, cutoff, signal);
    this.entries.set(key, work);
    void work.catch(() => {
      if (this.entries.get(key) === work) this.entries.delete(key);
    });
    return work;
  }
  private async build(
    predictor: BacktestStarter,
    data: BacktestData,
    gameId: string,
    cutoff: string,
    signal: AbortSignal,
  ): Promise<BacktestStarter> {
    const states = eligibleBacktestGames(data, gameId, cutoff).flatMap((g) =>
      g.dataset.windows
        .filter(
          (w) =>
            !w.exclusions.length &&
            w.state &&
            w.actual &&
            w.gameId === g.dataset.gameId &&
            w.state.gameId === g.dataset.gameId,
        )
        .map((w) => w.state!),
    );
    const starts = new Map(
      data.games.map((g) => [g.dataset.gameId, g.scheduledStart]),
    );
    const answers = new Map<
      string,
      { prediction: unknown; candidates: unknown }
    >();
    const controller = new AbortController();
    const abort = AbortSignal.any([signal, controller.signal]);
    let next = 0;
    const workers = Array.from(
      { length: BACKTEST_EXECUTION.concurrency },
      async () => {
        try {
          while (next < states.length) {
            abort.throwIfAborted();
            const batch = states.slice(
              next,
              next + BACKTEST_EXECUTION.batchSize,
            );
            next += BACKTEST_EXECUTION.batchSize;
            batch.sort(
              (a, b) =>
                starts.get(a.gameId)!.localeCompare(starts.get(b.gameId)!) ||
                a.gameId.localeCompare(b.gameId) ||
                a.sequence - b.sequence,
            );
            const values = predictor.predictBatch
              ? await predictor.predictBatch(batch, abort)
              : await (async () => {
                  const values = [];
                  for (const state of batch)
                    values.push(await predictor.predict(state, abort));
                  return values;
                })();
            if (values.length !== batch.length)
              throw Error("Incomplete starter cache");
            batch.forEach((state, i) =>
              answers.set(digest(state), structuredClone(values[i])),
            );
          }
        } catch (e) {
          controller.abort(e);
          throw e;
        }
      },
    );
    const settled = await Promise.allSettled(workers);
    const failed = settled.find((r) => r.status === "rejected");
    if (failed?.status === "rejected")
      throw controller.signal.reason ?? failed.reason;
    const predict = async (state: ObservableState, signal: AbortSignal) => {
      signal.throwIfAborted();
      const value = answers.get(digest(state));
      if (!value)
        throw Error("State absent from prepared starter backtest cache");
      return structuredClone(value);
    };
    return {
      hash: predictor.hash,
      predict,
      predictBatch: (states, signal) =>
        Promise.all(states.map((s) => predict(s, signal))),
    };
  }
}
