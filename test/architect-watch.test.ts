import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Iteration } from "../src/architect/iteration.js";
import { architectTools } from "../src/architect/tools.js";
import { inspectPool } from "../src/architect/watch.js";

const limits = { maxUsd: 100, maxAgentErrors: 2 };
function pool(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "watch-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const sql = (file: string, statements: string) => {
    const db = new DatabaseSync(join(root, file));
    db.exec(statements);
    db.close();
  };
  sql(
    "evaluations.sqlite",
    "CREATE TABLE runs(id TEXT PRIMARY KEY,kind TEXT,parent TEXT,hash TEXT,pkg TEXT,games TEXT,full INTEGER,charge INTEGER,status TEXT)",
  );
  return {
    root,
    sql,
    run(id: string, kind: string, status: string, chargeUsd: number) {
      sql(
        "evaluations.sqlite",
        `INSERT INTO runs VALUES('${id}','${kind}',NULL,'h','{}','[1,2,3]',1,${chargeUsd * 1e9},'${status}')`,
      );
      mkdirSync(join(root, "development", id), { recursive: true });
      sql(
        join("development", id, "record.sqlite"),
        "CREATE TABLE events(seq INTEGER PRIMARY KEY,kind TEXT,scope TEXT,data TEXT)",
      );
      return (kind: string, data: unknown, scope = "g") =>
        sql(
          join("development", id, "record.sqlite"),
          `INSERT INTO events(kind,scope,data) VALUES('${kind}','${scope}','${JSON.stringify(data)}')`,
        );
    },
  };
}

test("watcher reports spend and leaves a healthy run alone", (t) => {
  const p = pool(t);
  assert.equal(inspectPool(p.root, limits).stop, null);
  p.sql(
    "architect.sqlite",
    "CREATE TABLE iterations(id TEXT,spent INTEGER,held INTEGER); INSERT INTO iterations VALUES('a',4000000000,1000000000)",
  );
  p.sql(
    "reviews.sqlite",
    "CREATE TABLE reviews(id TEXT,reviewerUsd REAL); INSERT INTO reviews VALUES('r',0.25),('s',NULL)",
  );
  p.run("done", "test", "complete", 2);
  const event = p.run("live", "full", "running", 6);
  event("agent_reservation", { usd: 1 }); // seq 1, settled below
  event("agent_reservation", { usd: 0.5 }); // seq 2, still open
  event("agent_settlement", { reservation: 1, actual: 0.25 });
  event("team_game", { frozen: { p: 1 }, reason: null });
  const state = inspectPool(p.root, limits);
  assert.equal(state.stop, null);
  assert.equal(state.architectUsd, 5);
  assert.equal(state.reviewerUsd, 0.25);
  assert.equal(state.evaluationUsd, 2.75);
  assert.equal(state.totalUsd, 8);
  assert.deepEqual(state.active, [
    {
      id: "live",
      kind: "full",
      teamGames: 3,
      done: 1,
      missing: 0,
      agentErrors: 0,
      usd: 0.75,
    },
  ]);
  assert.match(inspectPool(p.root, { ...limits, maxUsd: 7.5 }).stop!, /Spend/);
});

test("watcher stops a full-size run on the first missing forecast, not a test run", (t) => {
  const p = pool(t);
  const missing = { frozen: null, reason: "Error: bad forecast" };
  p.run("t", "test", "running", 2)("team_game", missing, "x");
  assert.equal(inspectPool(p.root, limits).stop, null);
  // A finished run with a missing forecast is history, not a reason to stop.
  p.run("old", "full", "failed", 2)("team_game", missing, "x");
  assert.equal(inspectPool(p.root, limits).stop, null);
  const event = p.run("f", "check", "running", 2);
  event("team_game", { frozen: { p: 1 }, reason: null }, "first");
  event("team_game", missing, "second");
  assert.match(
    inspectPool(p.root, limits).stop!,
    /No forecast for team-game second in check run f: Error: bad forecast/,
  );
});

test("watcher stops a full-size run on repeated agent failures", (t) => {
  const p = pool(t);
  const event = p.run("f", "full", "running", 2);
  event("agent_error", { message: "x" });
  event("agent_error", { message: "x" });
  assert.equal(inspectPool(p.root, limits).stop, null);
  event("agent_error", { message: "x" });
  assert.match(inspectPool(p.root, limits).stop!, /3 failed agent calls/);
});

test("watcher stops on a run that failed since the snapshot, of any kind, and ignores earlier failures", (t) => {
  const p = pool(t);
  p.run("old", "full", "failed", 2);
  const known = new Set(inspectPool(p.root, limits).runs);
  assert.deepEqual([...known], ["old"]);
  assert.equal(inspectPool(p.root, limits, known).stop, null);
  // Started and failed between two polls: never seen running.
  p.run("new", "test", "failed", 0);
  assert.equal(inspectPool(p.root, limits).stop, null);
  assert.match(
    inspectPool(p.root, limits, known).stop!,
    /The test run new failed/,
  );
});

test("watcher reads a full-size run that completed since the snapshot", (t) => {
  const p = pool(t);
  const missing = { frozen: null, reason: "Error: bad forecast" };
  p.run("old", "full", "complete", 2)("team_game", missing, "x");
  const known = new Set(inspectPool(p.root, limits).runs);
  // A test run's gaps stay the architect's business after it completes too.
  p.run("t", "test", "complete", 0)("team_game", missing, "x");
  assert.equal(inspectPool(p.root, limits, known).stop, null);
  // Completed between two polls with no forecast on its last game.
  const event = p.run("f", "full", "complete", 2);
  event("team_game", { frozen: { p: 1 }, reason: null }, "first");
  assert.equal(inspectPool(p.root, limits, known).stop, null);
  event("team_game", missing, "last");
  const state = inspectPool(p.root, limits, known);
  assert.match(state.stop!, /No forecast for team-game last in full run f/);
  // Its settled charge is counted once, and it is not listed as active.
  assert.equal(state.evaluationUsd, 4);
  assert.deepEqual(state.active, []);
  const errors = p.run("e", "repeat", "complete", 0);
  for (let n = 0; n < 3; n++) errors("agent_error", { message: "x" });
  assert.match(
    inspectPool(p.root, limits, new Set([...known, "f"])).stop!,
    /3 failed agent calls in repeat run e/,
  );
});

const watcher = (...args: string[]) =>
  spawnSync("npx", ["tsx", "scripts/pilot-watch.ts", ...args], {
    encoding: "utf8",
  });
function victim(t: test.TestContext) {
  const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  const gone = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  return { pid: String(child.pid), gone };
}

test("watcher script refuses bad arguments before a run starts and takes a snapshot", (t) => {
  const p = pool(t);
  p.run("old", "full", "failed", 2);
  assert.notEqual(watcher(p.root, "--max-usd=abc", "--snapshot").status, 0);
  assert.notEqual(watcher(p.root, "--snapshot").status, 0);
  // The pool already holds $2 of evaluation spend: over a $1 ceiling.
  const over = watcher(p.root, "--max-usd=1", "--snapshot");
  assert.notEqual(over.status, 0);
  assert.equal(over.stdout, "");
  assert.match(over.stderr, /Spend \$2.00 is over the \$1 limit/);
  const snapshot = watcher(p.root, "--max-usd=5", "--snapshot");
  assert.equal(snapshot.status, 0);
  assert.deepEqual(JSON.parse(snapshot.stdout), ["old"]);
});

test("watcher script stops the run when it cannot monitor it", async (t) => {
  const p = pool(t);
  const known = join(p.root, "known.json");
  writeFileSync(known, "[]");
  // No snapshot file given: the watcher fails, and takes the run with it.
  const first = victim(t);
  assert.notEqual(
    watcher(p.root, "--max-usd=5", "--pid=" + first.pid).status,
    0,
  );
  await first.gone;
  // The pool cannot be read: bounded retries, then the run is stopped.
  writeFileSync(join(p.root, "architect.sqlite"), "not a database");
  const second = victim(t);
  const unreadable = watcher(
    p.root,
    "--max-usd=5",
    "--pid=" + second.pid,
    "--known=" + known,
    "--every=0.05",
    "--max-read-failures=2",
  );
  assert.equal(unreadable.status, 4);
  assert.match(unreadable.stdout, /Pool unreadable 2 times in a row/);
  await second.gone;
});

test("watcher script stops the run on a newly failed evaluation and exits 3", async (t) => {
  const p = pool(t);
  const known = join(p.root, "known.json");
  writeFileSync(known, "[]");
  p.run("new", "full", "failed", 0);
  const run = victim(t);
  const result = watcher(
    p.root,
    "--max-usd=5",
    "--pid=" + run.pid,
    "--known=" + known,
  );
  assert.equal(result.status, 3);
  assert.match(result.stdout, /The full run new failed/);
  await run.gone;
});

test("an operator restriction refuses other submission kinds and leaves the iteration open", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "only-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const i = new Iteration(root);
  t.after(() => i.close());
  const service = {} as Parameters<typeof architectTools>[1];
  const submit = architectTools(i, service, async () => null, ["test"]).find(
    (tool) => tool.name === "submit",
  )!;
  const reply = await submit.execute("id", {
    kind: "full",
    hypothesis: "h",
    expectedEffect: "e",
  });
  const block = reply.content[0];
  assert.equal(
    JSON.parse(block.type === "text" ? block.text : "{}").error,
    "This iteration accepts only: test",
  );
  assert.equal(i.status, "running");
});

function finalRun(p: ReturnType<typeof pool>, mode: string) {
  const directory = join("final", "nominee", mode);
  mkdirSync(join(p.root, directory), { recursive: true });
  const file = join(directory, "record.sqlite");
  p.sql(
    file,
    "CREATE TABLE events(seq INTEGER PRIMARY KEY,kind TEXT,scope TEXT,data TEXT)",
  );
  const event = (kind: string, data: unknown, scope = "g") => {
    const db = new DatabaseSync(join(p.root, file));
    try {
      db.prepare("INSERT INTO events(kind,scope,data) VALUES(?,?,?)").run(
        kind,
        scope,
        JSON.stringify(data),
      );
    } finally {
      db.close();
    }
  };
  event("manifest", { games: [1, 2, 3] });
  return event;
}

test("watcher reports an active final mode and stops at its first missing forecast without exposing outcomes", (t) => {
  const p = pool(t);
  const event = finalRun(p, "nominated");
  event("team_game", { frozen: { privateForecast: 98765 } }, "first");
  event("game_score", { privateScore: 12345 });
  const state = inspectPool(p.root, limits);
  assert.equal(state.stop, null);
  assert.deepEqual(state.active, [
    {
      id: "final/nominee/nominated",
      kind: "nominated",
      teamGames: 3,
      done: 1,
      missing: 0,
      agentErrors: 0,
      usd: 0,
    },
  ]);
  assert.deepEqual(state.runs, []);
  assert.doesNotMatch(
    JSON.stringify(state),
    /privateForecast|privateScore|98765|12345/,
  );
  event("team_game", { frozen: null, reason: "wall_clock" }, "MEM:last");
  assert.match(
    inspectPool(p.root, limits).stop!,
    /MEM:last.*nominated.*wall_clock/,
  );
});

test("final snapshots ignore completed modes while catching a newly completed mode", (t) => {
  const p = pool(t);
  const old = finalRun(p, "nominated");
  old("team_game", { frozen: null }, "old");
  old("replay_end", {});
  const next = finalRun(p, "clear-artifacts");
  const known = new Set(inspectPool(p.root, limits).runs);
  assert.deepEqual([...known], ["final/nominee/nominated"]);
  assert.equal(inspectPool(p.root, limits, known).stop, null);
  next("team_game", { frozen: null }, "new");
  next("replay_end", {});
  const state = inspectPool(p.root, limits, known);
  assert.match(state.stop!, /new.*clear-artifacts/);
  assert.deepEqual(state.active, []);
});

test("watcher counts settled and held final spend once and enforces per-mode agent failures", (t) => {
  const p = pool(t);
  p.run("development", "full", "complete", 2);
  const first = finalRun(p, "nominated");
  first("agent_reservation", { usd: 1 }); // seq 2 (after manifest)
  first("agent_settlement", { reservation: 2, actual: 0.25 });
  first("agent_error", {});
  first("agent_error", {});
  first("replay_end", {});
  const known = new Set(inspectPool(p.root, limits).runs);
  const second = finalRun(p, "agents-off");
  second("agent_reservation", { usd: 0.5 });
  second("agent_error", {});
  second("agent_error", {});
  const state = inspectPool(p.root, limits, known);
  assert.equal(state.stop, null);
  assert.equal(state.evaluationUsd, 2.75);
  assert.equal(state.totalUsd, 2.75);
  assert.match(
    inspectPool(p.root, { ...limits, maxUsd: 2.5 }, known).stop!,
    /Spend/,
  );
  second("agent_error", {});
  assert.match(
    inspectPool(p.root, limits, known).stop!,
    /3 failed agent calls in agents-off/,
  );
});

test("watcher script stops a final run and exits cleanly after a healthy final process ends", async (t) => {
  const p = pool(t);
  const known = join(p.root, "known.json");
  writeFileSync(known, "[]");
  const event = finalRun(p, "nominated");
  event("team_game", { frozen: { privateForecast: 98765 } });
  event("game_score", { privateScore: 12345 });
  event("replay_end", {});
  const ended = spawnSync(process.execPath, ["-e", ""]);
  const healthy = watcher(
    p.root,
    "--max-usd=5",
    "--known=" + known,
    "--pid=" + ended.pid,
  );
  assert.equal(healthy.status, 0);
  assert.match(healthy.stdout, /"ended":true/);
  assert.doesNotMatch(
    healthy.stdout,
    /privateForecast|privateScore|98765|12345/,
  );
  const bad = finalRun(p, "clear-artifacts");
  bad("team_game", { frozen: null, reason: "wall_clock" }, "DEN:last");
  bad("replay_end", {});
  const run = victim(t);
  const failed = watcher(
    p.root,
    "--max-usd=5",
    "--known=" + known,
    "--pid=" + run.pid,
  );
  assert.equal(failed.status, 3);
  assert.match(failed.stdout, /DEN:last.*clear-artifacts/);
  await run.gone;
});
