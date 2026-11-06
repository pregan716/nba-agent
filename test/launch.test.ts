import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
  chmodSync,
  readdirSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  fixtureAssembler,
  fixtureLaunchConfig,
} from "./fixtures/runner/chronological.js";
import {
  chronologicalRunner,
  runBaselines,
  validateLaunch,
} from "../src/launch/run.js";
import {
  scriptedAnalyst,
  scriptedJev,
} from "../scripts/fixtures/chronological.js";
import { MeteringProxy } from "../src/runner/proxy.js";
import { piHarness } from "../src/harness/pi.js";
import { RecordStore } from "../src/runner/record.js";
import { manifest } from "../src/runner/config.js";
import { scoreWindow } from "../src/replay/scoring.js";

function clean(root: string) {
  const unlock = (p: string) => {
    if (lstatSync(p).isDirectory()) {
      chmodSync(p, 0o700);
      for (const name of readdirSync(p)) unlock(join(p, name));
    }
  };
  unlock(root);
  rmSync(root, { recursive: true, force: true });
}
function verify(record: RecordStore, variant: "M0" | "M3") {
  assert.equal(record.events("game_end").length, 2);
  assert.equal(record.events("package_freeze").length, 2);
  assert.equal(record.events("replay_completed").length, 2);
  assert.equal(record.events("replay_summary").length, 2);
  assert.ok(
    record.events("phase_end").every((e) => e.data.status === "completed"),
  );
  const feedback = record
    .events("tool_result", "current:pregame")
    .find((e) => e.data.name === "read_feedback");
  assert.equal(feedback?.data.result.gameId, "prior");
  const reads = record
    .events("tool_result", "current:pregame")
    .filter((e) => e.data.name === "workspace_read");
  if (variant === "M3")
    assert.equal(
      reads.find((e) => e.data.args.path === "memory/coach_profile.md")?.data
        .result.content,
      "reflection-prior",
    );
  else
    assert.ok(
      !reads.some((e) => e.data.args.path === "memory/coach_profile.md"),
    );
  assert.ok(!reads.some((e) => e.data.args.path.startsWith("packages/prior")));
  assert.ok(
    !reads.some((e) =>
      ["scratch/reflection.txt", "feedback/current/trace.json"].includes(
        e.data.args.path,
      ),
    ),
  );
  assert.ok(
    record
      .events("tool_error", "current:pregame")
      .some((e) => e.data.name === "workspace_read"),
  );
  const windows = record.events("replay_window");
  assert.ok(windows.length > 0);
  for (const e of windows) {
    const r = e.data.result;
    assert.deepEqual(scoreWindow(r.window, r.raw, r.failure), r);
  }
  record.verify();
}

test("launcher refuses pilot/scored until R5b, and local scored assembler images", () => {
  assert.throws(
    () => validateLaunch("pilot", fixtureAssembler.image),
    /v3 prompt set/,
  );
  assert.throws(
    () => validateLaunch("scored", "registry@sha256:" + "a".repeat(64)),
    /v3 prompt set/,
  );
  assert.throws(
    () => validateLaunch("scored", "local@sha256:" + "a".repeat(64)),
    /local@/,
  );
});
for (const variant of ["M0", "M3"] as const)
  test(`Pi ${variant}: full chronological lifecycle and baselines share windows`, async () => {
    const root = mkdtempSync(join(tmpdir(), "nba-launch-"));
    const data = fixtureLaunchConfig(variant);
    const proxy = new MeteringProxy(scriptedAnalyst(), scriptedJev);
    await proxy.listen();
    const runner = chronologicalRunner({
      root,
      ...data,
      assembler: fixtureAssembler,
      proxy,
    });
    try {
      await runner.run(piHarness({ model: "claude-opus-4-6" }));
      verify(runner.record, variant);
      const responses = runner.record.events("jev_response").length;
      await runner.run(piHarness({ model: "claude-opus-4-6" }));
      assert.equal(runner.record.events("jev_response").length, responses);
      verify(runner.record, variant);
      const baselineConfig = structuredClone(data.config);
      baselineConfig.replay!.mode = "baselines";
      const record = new RecordStore(
        join(root, "baselines"),
        manifest(baselineConfig, data.schedule),
      );
      try {
        await runBaselines({
          ...data,
          config: baselineConfig,
          record,
          assembler: fixtureAssembler,
          proxy,
          training: data.datasets.slice(0, 1),
        });
        const expected = runner.record
          .events("replay_window")
          .map((e) => e.data.result.window.id)
          .sort();
        const groups = new Map<string, string[]>();
        for (const e of record.events("replay_window")) {
          const predictor = e.scope.split(":").slice(2).join(":");
          groups.set(predictor, [
            ...(groups.get(predictor) ?? []),
            e.data.result.window.id,
          ]);
        }
        assert.equal(groups.size, 3);
        for (const ids of groups.values())
          assert.deepEqual(ids.sort(), expected);
        const before = record.events().length;
        await runBaselines({
          ...data,
          config: baselineConfig,
          record,
          assembler: fixtureAssembler,
          proxy,
          training: data.datasets.slice(0, 1),
        });
        assert.equal(record.events().length, before);
      } finally {
        record.close();
      }
    } finally {
      runner.close();
      await proxy.close();
      clean(root);
    }
  });

function child(root: string, crash = "none", invalid = "none") {
  const process = spawn(
    globalThis.process.execPath,
    [
      "--import",
      "tsx",
      resolve("test/fixtures/runner/chronological.ts"),
      root,
      "M3",
      crash,
      invalid,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  process.stdout.on("data", (b) => (output += b));
  process.stderr.on("data", (b) => (output += b));
  const done = new Promise<void>((yes, no) => {
    process.on("error", no);
    process.on("exit", (code, signal) =>
      code === 0 || signal === "SIGKILL" ? yes() : no(Error(output)),
    );
  });
  return { process, done };
}
for (const point of ["pregame", "freeze", "replay", "postgame"])
  test(
    `SIGKILL during ${point} resumes without duplicating frozen receipts or Jev answers`,
    { timeout: 60000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), "nba-launch-crash-"));
      let running: ReturnType<typeof child> | undefined;
      try {
        running = child(root, point);
        for (let n = 0; !existsSync(join(root, "stopped")); n++) {
          if (n > 1500) throw Error("Crash fixture did not reach boundary");
          await Promise.race([
            delay(20),
            running.done.then(() => {
              throw Error("Child exited before boundary");
            }),
          ]);
        }
        running.process.kill("SIGKILL");
        await running.done;
        running = child(root);
        await running.done;
        const record = new RecordStore(join(root, "fixture-M3", "r1"));
        try {
          verify(record, "M3");
          const calls = readFileSync(join(root, "jev-calls.jsonl"), "utf8")
            .trim()
            .split("\n");
          assert.equal(calls.length, record.events("jev_response").length);
          assert.equal(
            new Set(record.events("jev_response").map((e) => e.scope)).size,
            calls.length,
          );
          const count = record.events("replay_completed").length;
          assert.equal(count, 2);
        } finally {
          record.close();
        }
      } finally {
        running?.process.kill("SIGKILL");
        await running?.done.catch(() => {});
        clean(root);
      }
    },
  );

test(
  "first-window invalid package records game status and continues to next game",
  { timeout: 60000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "nba-launch-invalid-"));
    try {
      await child(root, "none", "invalid").done;
      const record = new RecordStore(join(root, "fixture-M3", "r1"));
      try {
        assert.equal(
          record.events("game_end", "prior")[0].data.status,
          "invalid_package",
        );
        assert.equal(
          record.events("game_end", "current")[0].data.status,
          "completed",
        );
        assert.equal(record.events("replay_completed").length, 2);
      } finally {
        record.close();
      }
    } finally {
      clean(root);
    }
  },
);
