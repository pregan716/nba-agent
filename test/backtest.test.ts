import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readdirSync,
  chmodSync,
  lstatSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import {
  chronologicalFixture,
  scriptedAnalyst,
  scriptedJev,
} from "../scripts/fixtures/chronological.js";
import {
  fixtureAssembler,
  fixtureLaunchConfig,
} from "./fixtures/runner/chronological.js";
import { backtestPackage } from "../src/policy/backtest.js";
import { genericSwapAssembly } from "../src/policy/request.js";
import { pinSwapContract } from "../src/replay/swap.js";
import { packageAnswer } from "../src/replay/code-prediction.js";
import { scoreWindow, summarize } from "../src/replay/scoring.js";
import { policyHarness } from "../src/policy/replay.js";
import { chronologicalRunner } from "../src/launch/run.js";
import { MeteringProxy } from "../src/runner/proxy.js";
import type { ObservableState, DecisionDataset } from "../src/replay/types.js";
import { TOOL_DEFINITIONS, toolDefinitionsSha256 } from "../src/env/tools.js";
import { validateInput } from "../src/env/input.js";

function clean(root: string) {
  function unlock(p: string) {
    if (lstatSync(p).isDirectory()) {
      chmodSync(p, 0o700);
      for (const n of readdirSync(p)) unlock(join(p, n));
    }
  }
  unlock(root);
  rmSync(root, { recursive: true, force: true });
}
function assembly(s: ObservableState, defer: boolean, invalid = false) {
  const a = genericSwapAssembly(s);
  return {
    ...a,
    prediction: {
      substitution: { type: "noul", noul: invalid ? 2 : 0.3 },
      swap: {
        type: "choice",
        probabilities: Object.fromEntries(
          Object.keys(a.criteria.swap!).map((k, _, xs) => [k, 1 / xs.length]),
        ),
      },
    },
    defer: defer ? { reason: "uncertain" } : null,
  };
}
function dataset(id: string, prior = false) {
  const d = structuredClone(chronologicalFixture().datasets[0]);
  d.gameId = id;
  if (prior)
    d.trainingOnly = {
      season: "2024-25",
      rosterPolicy: "same-game-box-score-v1",
    };
  for (const w of d.windows) {
    w.gameId = id;
    w.id = `${id}:${w.id}`;
    if (w.state) w.state.gameId = id;
  }
  return d;
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), "backtest-")),
    workspace = join(root, "workspace");
  const p = join(workspace, "packages/current");
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, "assemble.py"), "pass");
  writeFileSync(
    join(p, "manifest.json"),
    JSON.stringify({ stateVersion: "state-v1" }),
  );
  const games = [
    { dataset: dataset("old", true), scheduledStart: "2025-04-01T00:00:00Z" },
    { dataset: dataset("recent"), scheduledStart: "2025-11-01T00:00:00Z" },
  ];
  const contract = pinSwapContract([games[1].dataset]);
  return { root, workspace, games, contract };
}
for (const mode of ["part", "all", "invalid", "candidates"] as const)
  test(`backtest ${mode}: scorer parity, all windows and deferral splits`, async () => {
    const s = setup();
    const outputs = (state: ObservableState) => {
      const a = assembly(
        state,
        mode !== "part" || state.gameId === "old",
        mode === "invalid" && state.gameId === "old",
      );
      return mode === "candidates" && state.gameId === "old"
        ? { ...a, candidates: [] }
        : a;
    };
    const seen: string[] = [];
    const assembler = {
      ...fixtureAssembler,
      async run(
        path: string,
        state: unknown,
        signal: AbortSignal,
        mode?: "load" | "assemble",
      ) {
        if (mode === "load")
          return fixtureAssembler.run(path, state, signal, mode);
        assert.ok(!Object.hasOwn(state as object, "actual"));
        seen.push((state as ObservableState).gameId);
        return {
          value: outputs(state as ObservableState),
          computeSeconds: 0.001,
        };
      },
    };
    try {
      const result = await backtestPackage({
        ...s,
        gameId: "current",
        cutoff: "2025-11-03T00:00:00Z",
        clock: () => "2025-11-02T23:59:59Z",
        assembler,
        source: async () => ({
          games: [
            ...s.games,
            {
              dataset: dataset("future"),
              scheduledStart: "2025-11-10T00:00:00Z",
            },
          ],
        }),
        allowance: 10,
        signal: new AbortController().signal,
        input: { per_window: true },
        starter: {
          hash: "fixture-starter",
          predict: async (state) => assembly(state, false),
        },
      });
      const eligible = s.games.flatMap((g) =>
        g.dataset.windows.filter(
          (w) => !w.exclusions.length && w.state && w.actual,
        ),
      );
      assert.equal(result.complete, true);
      assert.match(result.label, /package-only/);
      assert.ok(!seen.includes("future"));
      const expected = eligible.map((w) =>
        scoreWindow(
          w,
          packageAnswer(
            outputs(w.state!).prediction,
            outputs(w.state!).candidates,
          ),
          ["invalid", "candidates"].includes(mode) && w.gameId === "old"
            ? "assembler_error"
            : null,
          s.contract,
        ),
      );
      // Compare the selected old/recent rows directly with the evaluation scorer.
      for (const row of expected)
        assert.deepEqual(
          result.windows!.find((w) => w.windowId === row.window.id)!.scores,
          row.scores,
        );
      assert.equal(result.summary.scored, result.eligibleWindows);
      assert.equal(
        result.split.wouldDefer.scored + result.split.nonDeferred.scored,
        result.summary.scored,
      );
      if (mode !== "part") assert.equal(result.split.nonDeferred.scored, 0);
      assert.equal(result.starter.label, "in-sample");
      if (result.starter.label === "in-sample")
        assert.equal(result.starter.summary.scored, result.summary.scored);
      if (mode === "invalid")
        assert.ok(
          result.invalidByReason["substitution:probability_out_of_range"] > 0,
        );
      if (mode === "candidates")
        assert.ok(result.invalidByReason.no_candidates > 0);
      assert.ok(
        result.games.find((g) => g.gameId === "old")!.roster.rosterPolicy ===
          "same-game-box-score-v1",
      );
    } finally {
      clean(s.root);
    }
  });

test("strict release cutoff, no future counts, and aggregate scorer parity", async () => {
  const s = setup();
  try {
    const result = await backtestPackage({
      ...s,
      gameId: "current",
      cutoff: "2025-11-03T00:00:00Z",
      clock: () => "2025-11-02T14:00:00Z",
      assembler: {
        ...fixtureAssembler,
        run: async (p, state, signal, mode) =>
          mode === "load"
            ? fixtureAssembler.run(p, state, signal, mode)
            : {
                value: assembly(state as ObservableState, false),
                computeSeconds: 0,
              },
      },
      source: async () => ({
        games: [
          ...s.games,
          {
            dataset: dataset("planted"),
            scheduledStart: "2025-11-02T00:00:00Z",
          },
        ],
      }),
      allowance: 10,
      signal: new AbortController().signal,
      input: {},
    });
    assert.ok(!JSON.stringify(result).includes("planted"));
    const expected = s.games
      .flatMap((g) =>
        g.dataset.windows.filter(
          (w) => !w.exclusions.length && w.state && w.actual,
        ),
      )
      .map((w) => {
        const a = assembly(w.state!, false);
        return scoreWindow(
          w,
          packageAnswer(a.prediction, a.candidates),
          null,
          s.contract,
        );
      });
    const summary = summarize(expected);
    for (const [key, value] of Object.entries(summary))
      assert.deepEqual((result.summary as any)[key], value, key);
    assert.equal(result.windows, undefined);
    assert.equal(result.starter.label, "unavailable");
  } finally {
    clean(s.root);
  }
});

test("compute deadline stops assembly and identifies incomplete results", async () => {
  const s = setup();
  let calls = 0;
  try {
    const result = await backtestPackage({
      ...s,
      gameId: "current",
      cutoff: "2025-11-03T00:00:00Z",
      clock: () => "2025-11-02T23:00:00Z",
      source: async () => ({ games: s.games }),
      assembler: {
        ...fixtureAssembler,
        run: async (p, state, signal, mode) => {
          if (mode === "load")
            return fixtureAssembler.run(p, state, signal, mode);
          calls++;
          await delay(1000, null, { signal });
          return {
            value: assembly(state as ObservableState, true),
            computeSeconds: 1,
          };
        },
      },
      allowance: 0.03,
      signal: new AbortController().signal,
      input: {},
    });
    assert.equal(result.complete, false);
    assert.equal(result.error, "compute_limit");
    assert.equal(result.summary.scored, 0);
    assert.ok(result.eligibleWindows! > 0);
    assert.equal(calls, 1);
    assert.ok(result.computeSeconds < 0.5);
    assert.deepEqual(readdirSync(join(s.root, "backtests")), []);
  } finally {
    clean(s.root);
  }
});

test("tool schema changes harness hash and rejects selection or Jev arguments", () => {
  assert.notEqual(
    toolDefinitionsSha256(),
    toolDefinitionsSha256(
      TOOL_DEFINITIONS.filter((t) => t.name !== "backtest_package"),
    ),
  );
  for (const input of [{ jev: true }, { game_id: "future" }, { per_window: 1 }])
    assert.throws(() => validateInput("backtest_package", input));
});

test("runner records each package backtest and charges compute with no Jev calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "backtest-runner-"));
  const data = fixtureLaunchConfig("M0");
  data.config.profile.capabilities.enabled.push("code_execution");
  const contract = {
    ...pinSwapContract(data.datasets),
    version: "jev-contract-v3" as const,
  };
  const assembler = {
    ...fixtureAssembler,
    run: async (
      p: string,
      state: unknown,
      signal: AbortSignal,
      mode?: "load" | "assemble",
    ) =>
      mode === "load"
        ? fixtureAssembler.run(p, state, signal, mode)
        : {
            value: assembly(state as ObservableState, true),
            computeSeconds: 0.001,
          },
  };
  data.config.harness.policy = policyHarness(assembler, contract);
  const proxy = new MeteringProxy(scriptedAnalyst(), scriptedJev);
  await proxy.listen();
  const runner = chronologicalRunner({
    root,
    ...data,
    assembler,
    proxy,
    backtestSource: async () => ({
      games: data.datasets.map((dataset, i) => ({
        dataset,
        scheduledStart: data.schedule[i].scheduledStart,
      })),
    }),
  });
  try {
    await runner.run(async ({ session }) => {
      const context = await session.call("context", {});
      if (context.phase !== "pregame") return;
      const id = context.game.game_id;
      await session.call("workspace_write", {
        path: `packages/${id}/assemble.py`,
        content: "pass",
      });
      await session.call("workspace_write", {
        path: `packages/${id}/manifest.json`,
        content: JSON.stringify({ stateVersion: "state-v1" }),
      });
      const before = runner.record.events("jev_request").length;
      const result = await session.call("backtest_package", {});
      assert.equal(result.complete, true);
      assert.equal(runner.record.events("jev_request").length, before);
      await session.call("freeze_package", {});
    });
    assert.equal(runner.record.events("backtest_start").length, 2);
    assert.equal(runner.record.events("package_backtest").length, 2);
    const settlements = runner.record
      .events("settlement")
      .filter((e) => e.data.details?.label?.startsWith("package-only"));
    assert.equal(settlements.length, 2);
    assert.ok(
      settlements.every((e) => e.data.tokens === 0 && e.data.compute > 0),
    );
    // The exact result is retained in the settlement as well as the package record.
    assert.ok(
      runner.record.events("settlement").some((e) => e.data.compute > 0),
    );
  } finally {
    runner.close();
    await proxy.close();
    clean(root);
  }
});

test("a stalled history load is bounded and does not pretend the history is empty", async () => {
  const s = setup();
  try {
    const result = await backtestPackage({
      ...s,
      gameId: "current",
      cutoff: "2025-11-03T00:00:00Z",
      clock: () => "2025-11-02T23:00:00Z",
      assembler: fixtureAssembler,
      source: async () => {
        await delay(100);
        return { games: s.games };
      },
      allowance: 0.02,
      signal: new AbortController().signal,
      input: {},
    });
    assert.equal(result.complete, false);
    assert.equal(result.error, "compute_limit");
    assert.equal(result.eligibleWindows, null);
    assert.equal(result.summary.scored, 0);
  } finally {
    clean(s.root);
  }
});

test("batched execution matches individual scores and isolates starter errors", async () => {
  const s = setup();
  let batches = 0;
  try {
    const result = await backtestPackage({
      ...s,
      gameId: "current",
      cutoff: "2025-11-03T00:00:00Z",
      clock: () => "2025-11-02T23:59:59Z",
      assembler: {
        ...fixtureAssembler,
        runBatch: async (_p, states) => {
          batches++;
          return states.map((state) => ({
            value: assembly(state as ObservableState, true),
          }));
        },
      },
      source: async () => ({ games: s.games }),
      allowance: 10,
      signal: new AbortController().signal,
      input: {},
      starter: {
        hash: "broken",
        predict: async () => {
          throw Error("starter failed");
        },
      },
    });
    assert.equal(batches, 2);
    assert.equal(result.complete, true);
    assert.equal(result.summary.scored, result.eligibleWindows);
    assert.equal(result.split.nonDeferred.scored, 0);
    assert.equal(result.starter.label, "in-sample");
    if (result.starter.label === "in-sample") {
      assert.equal(result.starter.summary.scored, 0);
      assert.equal(result.starter.errors.length, result.summary.scored);
      assert.equal(result.starter.attemptedWindows, result.summary.scored);
    }
  } finally {
    clean(s.root);
  }
});

test("history is loaded once for a cutoff, and aborted loads are not cached", async () => {
  const { cachedBacktestSource } = await import("../src/policy/backtest.js");
  let loads = 0;
  const source = cachedBacktestSource(async (cutoff) => {
    loads++;
    if (cutoff === "bad") throw Error("failed");
    return { games: [] };
  });
  const signal = new AbortController().signal;
  await source("a", signal);
  await source("a", signal);
  assert.equal(loads, 1);
  await source("b", signal);
  assert.equal(loads, 2);
  await assert.rejects(source("bad", signal));
  await assert.rejects(source("bad", signal));
  assert.equal(loads, 4);
});
