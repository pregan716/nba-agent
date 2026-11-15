// Watcher for an architect iteration (SPO-907). Polls the pool directory and
// stops the run's process group on the first missing forecast in a full-size
// evaluation, on repeated agent failures, or on spend. Reads only; needs no
// credentials.
//
//   npx tsx scripts/pilot-watch.ts POOL_DIR --pid=PID --max-usd=N [--max-agent-errors=5] [--every=20]
//
// PID is the leader of the run's process group (start the run with setsid).
// Exit status: 0 the run ended by itself, 3 the watcher stopped it.
import { setTimeout as delay } from "node:timers/promises";
import { inspectPool } from "../src/architect/watch.js";

const [root, ...flags] = process.argv.slice(2);
const flag = (name: string, fallback?: number) => {
  const raw = flags.find((f) => f.startsWith(`--${name}=`));
  const n = raw ? Number(raw.slice(name.length + 3)) : fallback;
  if (n === undefined || !Number.isFinite(n) || n <= 0)
    throw Error(`Pass --${name}=<positive number>`);
  return n;
};
if (!root) throw Error("Pass the pool directory");
const pid = flag("pid"),
  limits = {
    maxUsd: flag("max-usd"),
    maxAgentErrors: flag("max-agent-errors", 5),
  },
  every = flag("every", 20);
const alive = () => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
let last = "";
for (;;) {
  let state;
  try {
    state = inspectPool(root, limits);
  } catch (error) {
    // The run holds a write lock for a moment at each commit. Look again.
    console.log(
      JSON.stringify({ at: new Date().toISOString(), busy: `${error}` }),
    );
  }
  if (state) {
    const line = JSON.stringify({ ...state, stop: undefined });
    if (line !== last)
      console.log(JSON.stringify({ at: new Date().toISOString(), ...state }));
    last = line;
    if (state.stop) {
      if (alive()) process.kill(-pid, "SIGTERM");
      console.log(JSON.stringify({ stopped: state.stop }));
      process.exit(3);
    }
  }
  if (!alive()) {
    console.log(JSON.stringify({ ended: true }));
    process.exit(0);
  }
  await delay(every * 1000);
}
