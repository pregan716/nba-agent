import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
