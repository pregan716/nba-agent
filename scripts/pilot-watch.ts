// Watcher for architect iterations and final evaluations (SPO-907, SPO-930).
// Polls the pool directory and
// stops the run's process group on the first missing forecast in a full-size
// evaluation, on repeated agent failures, on an evaluation that failed after
// the snapshot, or on spend. Reads only; needs no credentials.
//
//   npx tsx scripts/pilot-watch.ts POOL_DIR --max-usd=N --snapshot
//   npx tsx scripts/pilot-watch.ts POOL_DIR --max-usd=N --pid=PID --known=FILE
//     [--max-agent-errors=5] [--every=20] [--max-read-failures=6]
//
// --snapshot checks the arguments, fails if the pool is already over a limit,
// and prints the pool's run ids as JSON, to be
// taken before the run starts and passed back as --known. PID is the leader of
// the run's process group (start the run with setsid).
// Exit status: 0 the run ended by itself, 3 the watcher stopped it, 4 the
// watcher could not read the pool and stopped the run. On any other failure of
// the watcher the run is stopped too.
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { inspectPool } from "../src/architect/watch.js";

const [root, ...flags] = process.argv.slice(2);
const value = (name: string) =>
  flags.find((f) => f.startsWith(`--${name}=`))?.slice(name.length + 3);
const number = (name: string, fallback?: number) => {
  const raw = value(name);
  const n = raw === undefined ? fallback : Number(raw);
  if (n === undefined || !Number.isFinite(n) || n <= 0)
    throw Error(`Pass --${name}=<positive number>`);
  return n;
};
if (!root || root.startsWith("--")) throw Error("Pass the pool directory");
const limits = {
  maxUsd: number("max-usd"),
  maxAgentErrors: number("max-agent-errors", 5),
};
if (flags.includes("--snapshot")) {
  // A pool already over a limit must not start another paid run.
  const state = inspectPool(root, limits);
  if (state.stop) throw Error(state.stop);
  console.log(JSON.stringify(state.runs));
  process.exit(0);
}
const pid = number("pid"),
  every = number("every", 20),
  maxReadFailures = number("max-read-failures", 6);
const alive = () => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const stopRun = () => {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // The group has already gone.
  }
};
const log = (entry: object) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }));
try {
  const file = value("known");
  if (!file) throw Error("Pass --known=<snapshot file>");
  const known = new Set<string>(JSON.parse(readFileSync(file, "utf8")));
  let last = "",
    failures = 0;
  for (;;) {
    // Read the process state first, so a run that ends is still inspected once.
    const running = alive();
    let state;
    try {
      state = inspectPool(root, limits, known);
      failures = 0;
    } catch (error) {
      // The run holds a write lock for a moment at each commit. Look again,
      // but not for ever: an unreadable pool is an unmonitored run.
      log({ unreadable: `${error}`, failures: ++failures });
      if (failures >= maxReadFailures) {
        stopRun();
        log({ stopped: `Pool unreadable ${failures} times in a row` });
        process.exit(4);
      }
    }
    if (state) {
      const line = JSON.stringify({ ...state, stop: undefined });
      if (line !== last) log(state);
      last = line;
      if (state.stop) {
        stopRun();
        log({ stopped: state.stop });
        process.exit(3);
      }
      if (!running) {
        log({ ended: true });
        process.exit(0);
      }
    }
    await delay((running ? every : 1) * 1000);
  }
} catch (error) {
  stopRun();
  throw error;
}
