import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  chmodSync,
  readdirSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  selectValidationSamples,
  stoppageType,
} from "../src/policy/validation.js";
import { PolicyTools } from "../src/policy/tools.js";
import { genericAssembly } from "../src/policy/request.js";
import { validateInput } from "../src/env/input.js";
import { releaseTime } from "../src/env/visibility.js";
import { fixtureAssembler } from "./fixtures/runner/chronological.js";
import { scriptedJev } from "../scripts/fixtures/chronological.js";
import type { ObservableState } from "../src/replay/types.js";
const state = (gameId: string, period = 1, kind = "timeout", sequence = 1) =>
  ({
    gameId,
    period,
    sequence,
    celtics: ["a", "b", "c", "d", "e"],
    eligibleBench: ["f", "g"],
    stoppage: { kind },
  }) as ObservableState;
const game = (gameId: string, scheduledStart: string) => ({
  gameId,
  scheduledStart,
  release: releaseTime(scheduledStart),
});
const signal = () => new AbortController().signal;
function clean(root: string) {
  const unlock = (p: string) => {
    if (lstatSync(p).isDirectory()) {
      chmodSync(p, 0o700);
      for (const n of readdirSync(p)) unlock(join(p, n));
    }
  };
  unlock(root);
  rmSync(root, { recursive: true, force: true });
}
test("selection spreads types, halves and distinct games deterministically", () => {
  const pool = Array.from({ length: 10 }, (_, g) =>
    [
      "timeout",
      "between_periods",
      "foul",
      "dead_ball_turnover",
      "violation",
    ].flatMap((kind, k) =>
      [1, 4].map((period) => ({
        gameId: `g${g}`,
        windowId: `w${k}-${period}`,
        state: state(`g${g}`, period, kind, k),
      })),
    ),
  ).flat();
  const releases = new Map(
    Array.from({ length: 10 }, (_, i) => [
      `g${i}`,
      `2025-10-${String(i + 1).padStart(2, "0")}`,
    ]),
  );
  const selected = selectValidationSamples(pool, 8, releases);
  assert.equal(selected.length, 8);
  assert.equal(
    new Set(selected.map((s) => `${s.gameId}:${s.windowId}`)).size,
    8,
  );
  assert.equal(new Set(selected.map((s) => stoppageType(s.state))).size, 5);
  assert.equal(new Set(selected.map((s) => s.state.period)).size, 2);
  assert.equal(new Set(selected.map((s) => s.gameId)).size, 8);
  assert.equal(selected[0].gameId, "g9");
  assert.deepEqual(
    selectValidationSamples([...pool].reverse(), 8, releases),
    selected,
  );
  assert.equal(selectValidationSamples(pool, 1, releases).length, 1);
  assert.equal(selectValidationSamples([pool[0]], 8, releases).length, 1);
  for (const samples of [0, 25, 1.5])
    assert.throws(
      () => validateInput("validate_package", { samples }),
      /Invalid tool input/,
    );
});

test("validation returns prior-state answers, summaries, isolated failures and fallback note", async () => {
  const root = mkdtempSync(join(tmpdir(), "validation-")),
    workspace = join(root, "workspace");
  const current = game("current", "2025-10-22T23:00:00Z");
  const fallback = [1, 2, 3].map((i) => ({
    ...game(`prior${i}`, `2024-10-${20 + i}T23:00:00Z`),
    inputHash: "fixture",
    windowId: `window${i}`,
    state: state(`prior${i}`, i, i === 2 ? "foul" : "timeout", i),
  }));
  const path = join(workspace, "packages/current");
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "assemble.py"), "pass");
  writeFileSync(
    join(path, "manifest.json"),
    JSON.stringify({ stateVersion: "state-v1" }),
  );
  const service = new PolicyTools(
    root,
    workspace,
    current,
    [current],
    fixtureAssembler,
    [],
    () => "2025-10-22T22:00:00Z",
    fallback,
  );
  let calls = 0;
  const jev = async (request: any, signal: AbortSignal) => {
    calls++;
    return ((await scriptedJev.create(request, signal)) as any).answers;
  };
  try {
    const dry = await service.validate(
      "pregame",
      10,
      signal(),
      { samples: 10 },
      jev,
    );
    assert.equal(calls, 0);
    assert.equal(dry.outputs.length, 3);
    assert.equal(dry.summary, null);
    assert.match(dry.note!, /Only three/);
    assert.ok(dry.outputs.every((o) => !Object.hasOwn(o, "answers")));
    const live = await service.validate(
      "pregame",
      10,
      signal(),
      { jev: true, samples: 10 },
      jev,
    );
    assert.equal(calls, 3);
    assert.equal(live.summary?.answered, 3);
    assert.equal(live.summary?.samples, 3);
    assert.equal(live.summary?.byStoppage.timeout.n, 2);
    assert.equal(live.summary?.byStoppage.foul.n, 1);
    const ps = live.outputs.map((o) => o.answers.substitution.noul);
    assert.equal(
      live.summary?.meanSubstitutionProbability,
      ps.reduce((a, b) => a + b, 0) / 3,
    );
    assert.deepEqual(
      live.outputs.map((o) => o.windowId),
      ["window1", "window2", "window3"],
    );
    assert.ok(!JSON.stringify(live).includes('"actual"'));
    let n = 0;
    const failed = await service.validate(
      "pregame",
      10,
      signal(),
      { jev: true },
      async (...args) => {
        if (++n === 2) throw Error("provider unavailable");
        return jev(...args);
      },
    );
    assert.equal(failed.summary?.answered, 2);
    assert.equal(failed.outputs[1].answers, null);
    assert.match(failed.outputs[1].error!, /provider unavailable/);
    assert.ok(failed.outputs[2].answers);
    const guarded = new PolicyTools(
      root,
      workspace,
      current,
      [current],
      {
        ...fixtureAssembler,
        run: async (path, s, signal, mode) =>
          mode === "load"
            ? fixtureAssembler.run(path, s, signal, mode)
            : {
                value: {
                  ...genericAssembly(s as ObservableState),
                  jev_state: "x".repeat(40000),
                },
                computeSeconds: 0.01,
              },
      },
      [],
      () => "2025-10-22T22:00:00Z",
      fallback,
    );
    const before = calls;
    const guard = await guarded.validate(
      "pregame",
      10,
      signal(),
      { jev: true },
      jev,
    );
    assert.equal(calls, before);
    assert.equal(guard.summary, null);
    assert.ok(
      guard.outputs.every(
        (o) =>
          o.answers === null &&
          /context upper bound/.test(o.error!) &&
          o.request,
      ),
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      service.validate("pregame", 10, controller.signal, { jev: true }, jev),
    );
  } finally {
    clean(root);
  }
});
