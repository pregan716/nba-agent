/** Fixed environment limits, identical for every variant. Never host-sized. */
export const BACKTEST_EXECUTION = {
  version: "parallel-backtest-v1",
  concurrency: 4,
  batchSize: 256,
  charging: "elapsed-wall-seconds",
  starterComparison: "trusted-pregame-cache",
} as const;
