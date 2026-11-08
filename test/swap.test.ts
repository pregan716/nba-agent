import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  readdirSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  candidateKey,
  candidateReasons,
  combinations,
  expandSwap,
  pinSwapContract,
  validateSwap,
  type CandidateSet,
  type SwapContract,
} from "../src/replay/swap.js";
import { scoreWindow, summarize } from "../src/replay/scoring.js";
import {
  buildSwapRequest,
  genericSwapAssembly,
  JEV_MODEL,
} from "../src/policy/request.js";
import { chronologicalFixture } from "../scripts/fixtures/chronological.js";
import { fitSwapBaselines } from "../src/replay/baselines.js";
import { RecordStore } from "../src/runner/record.js";
import { MeteringProxy } from "../src/runner/proxy.js";
import {
  policyHarness,
  policyVersion,
  replayPolicy,
} from "../src/policy/replay.js";
import { REPLAY_VERSIONS } from "../src/replay/types.js";
import { fixtureAssembler } from "./fixtures/runner/chronological.js";
import { evaluateRecord } from "../src/evaluation/evaluate.js";
import { readRecord } from "../src/evaluation/record.js";
import { compareRuns } from "../src/evaluation/compare.js";
import { PackageStore } from "../src/policy/package.js";
import { PolicyTools } from "../src/policy/tools.js";
import { PackageExecutionError } from "../src/policy/errors.js";
const fixture = () => chronologicalFixture().datasets[0];
const state = () => {
  const s = structuredClone(fixture().windows.find((w) => w.state)!.state!);
  s.celtics = ["a", "b", "c", "d", "e"];
  s.eligibleBench = ["f", "g"];
  return s;
};
const contract: SwapContract = {
  version: "jev-contract-v2",
  sizePrior: [0.6, 0.4, 0, 0, 0],
  training: [],
};
const near = (a: number, b: number) =>
  assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);
const prediction = (cs: CandidateSet[], p: number[]) => ({
  candidates: cs,
  substitution: { type: "noul", noul: 0.8 },
  swap: {
    type: "choice",
    probabilities: Object.fromEntries([
      ...cs.map((c, i) => [candidateKey(c), p[i]]),
      ["other", p.at(-1)!],
    ]),
  },
});
const singles = [
  { out: ["a"], in: ["f"] },
  { out: ["a"], in: ["g"] },
];
test("swap expansion conserves total mass, counts and inclusion marginals", () => {
  const s = state(),
    cs = [singles[0], { out: ["a", "b"], in: ["f", "g"] }];
  const d = validateSwap(prediction(cs, [0.2, 0.3, 0.5]), s, contract).swap!;
  const all = [1, 2].flatMap((k) =>
    combinations(s.celtics, k).flatMap((out) =>
      combinations(s.eligibleBench, k).map((inside) => ({ out, in: inside })),
    ),
  );
  const ps = all.map(
    (c) => d.listed[candidateKey(c)] ?? d.unlistedPerSet[c.out.length - 1],
  );
  near(
    ps.reduce((a, b) => a + b, 0),
    1,
  );
  for (const k of [1, 2])
    near(
      d.count[k],
      all.reduce((n, c, i) => n + (c.out.length === k ? ps[i] : 0), 0),
    );
  for (const [side, ids, m] of [
    ["out", s.celtics, d.exit],
    ["in", s.eligibleBench, d.entry],
  ] as const)
    for (const id of ids)
      near(
        m[id],
        all.reduce((n, c, i) => n + (c[side].includes(id) ? ps[i] : 0), 0),
      );
});
test("rounded probabilities normalize; invalid maps fall back per question", () => {
  const v = validateSwap(
    prediction(singles, [0.52, 0.52, 0]),
    state(),
    contract,
  );
  near(v.swap!.exit.a, 1);
  near(v.swap!.normalizedSwap[candidateKey(singles[0])], 0.5);
  for (const ps of [
    [1, 1, 1],
    [0, 0, 0],
    [-0.1, 0.6, 0.5],
    [NaN, 0.5, 0.5],
  ]) {
    const result = validateSwap(prediction(singles, ps), state(), contract);
    assert.equal(result.questions.swap!.valid, false);
    near(result.answers.substitution.noul, 0.8);
    near(
      Object.values(result.swap!.normalizedSwap).reduce((a, b) => a + b, 0),
      1,
    );
  }
  const raw = prediction(singles, [0.4, 0.4, 0.2]);
  delete raw.swap.probabilities.other;
  assert.equal(
    validateSwap(raw, state(), contract).questions.swap!.valid,
    false,
  );
});
test("exhaustive candidates, invalid fallback, zero prior support and empty bench", () => {
  const s = state();
  s.eligibleBench = ["f"];
  const cs = s.celtics.map((id) => ({ out: [id], in: ["f"] }));
  for (const ps of [
    [0.1, 0.1, 0.1, 0.1, 0.1, 0.5],
    [0, 0, 0, 0, 0, 1],
    [1, 1, 1, 1, 1, 1],
  ]) {
    const d = validateSwap(prediction(cs, ps), s, contract).swap!;
    assert.equal(d.other_unsupported, true);
    near(
      Object.values(d.listed).reduce((a, b) => a + b, 0),
      1,
    );
    near(d.entry.f, 1);
  }
  const d = validateSwap(prediction([cs[0]], [0.4, 0.6]), s, {
    ...contract,
    sizePrior: [0, 1, 0, 0, 0],
  }).swap!;
  near(d.unlistedPerSet[0], 0.15);
  s.eligibleBench = [];
  const a = genericSwapAssembly(s);
  assert.deepEqual(a.candidates, []);
  assert.deepEqual(Object.keys(buildSwapRequest(a, s).questions), [
    "substitution",
  ]);
  const w = {
    ...fixture().windows[0],
    state: s,
    actual: { players_out: [], players_in: [] },
    exclusions: [],
  };
  const result = scoreWindow(w, prediction([], [1]), null, contract);
  assert.equal(result.scores!.setLogLoss, null);
  assert.equal(result.scores!.exit, null);
  assert.deepEqual(result.validation!.action, {
    players_out: [],
    players_in: [],
  });
});
test("set scoring listed/unlisted swaps, perfect multi-player Brier and other argmax", () => {
  const s = state(),
    c = { out: ["a", "b"], in: ["f", "g"] };
  const w = {
    ...fixture().windows[0],
    state: s,
    actual: { players_out: c.out, players_in: c.in },
    exclusions: [],
  };
  const exact = scoreWindow(w, prediction([c], [1, 0]), null, contract);
  near(exact.scores!.exit!, 0);
  near(exact.scores!.entry!, 0);
  assert.equal(exact.scores!.candidateHit, 1);
  const raw = prediction([singles[0]], [0.1, 0.9]);
  for (const actual of [{ players_out: ["b"], players_in: ["f"] }, w.actual]) {
    const r = scoreWindow({ ...w, actual }, raw, null, contract),
      k = actual.players_out.length;
    near(
      r.scores!.setLogLoss!,
      -Math.log(k === 1 ? (0.9 * 0.6) / 9 : (0.9 * 0.4) / 10),
    );
    assert.equal(r.validation!.swap!.other_argmax, true);
    assert.deepEqual(r.validation!.action, {
      players_out: ["a"],
      players_in: ["f"],
    });
  }
  const fallback = scoreWindow(w, null, "assembler_error", contract);
  near(fallback.scores!.probability, 0.5);
  near(fallback.scores!.setLogLoss!, -Math.log(0.4 / 10));
  assert.deepEqual(fallback.validation!.action, {
    players_out: [],
    players_in: [],
  });
  const summary = summarize([exact, fallback]);
  assert.equal(summary.setN, 2);
  near(summary.candidateHitRate!, 0.5);
});
test("candidate validation and request construction reject malformed sets with window errors", () => {
  const s = state();
  const cases: [unknown, string][] = [
    [undefined, "no_candidates"],
    [[], "no_candidates"],
    [[{ out: ["a"], in: ["future"] }], "ineligible_entry"],
    [[{ out: ["future"], in: ["f"] }], "ineligible_exit"],
    [[{ out: ["a", "a"], in: ["f", "g"] }], "repeated_player"],
    [[singles[0], singles[0]], "repeated_set"],
    [[{ out: ["a"], in: ["f", "g"] }], "uneven_swap"],
    [Array(9).fill(singles[0]), "too_many_candidates"],
  ];
  for (const [cs, reason] of cases) {
    assert.ok(candidateReasons(cs, s).includes(reason));
    const a = genericSwapAssembly(s);
    a.candidates = cs as any;
    assert.throws(
      () => buildSwapRequest(a, s),
      (e: any) => e.windowOnly && e.message.includes(reason),
    );
  }
  const a = genericSwapAssembly(s);
  a.criteria.swap = { wrong: "wrong" };
  assert.throws(() => buildSwapRequest(a, s), /criteria_keys_mismatch/);
});
test("warm-up prior and baseline set distributions are pinned and normalized", () => {
  const dataset = fixture(),
    pin = pinSwapContract([dataset]),
    models = fitSwapBaselines([dataset]);
  assert.equal(pin.version, "jev-contract-v2");
  assert.equal(pin.training[0].inputHash, dataset.inputHash);
  for (const b of Object.values(models)) {
    const raw: any = b.predict(state());
    const v = validateSwap(raw, state(), pin, raw.degenerate);
    near(
      Object.values(v.swap!.count).reduce((a, b) => a + b, 0),
      1,
    );
    assert.ok(v.swap!.candidates.length <= 8);
  }
});
function cleanup(root: string) {
  const unlock = (p: string) => {
    if (lstatSync(p).isDirectory()) {
      chmodSync(p, 0o700);
      for (const f of readdirSync(p)) unlock(join(p, f));
    }
  };
  unlock(root);
  rmSync(root, { recursive: true, force: true });
}
test("v2 replay, resume, feedback, validation and evaluation use trusted candidates and pinned prior", async () => {
  const root = mkdtempSync(join(tmpdir(), "swap-replay-")),
    dataset = fixture(),
    pin = pinSwapContract([dataset]);
  let calls = 0;
  const proxy = new MeteringProxy(
    {
      count: async () => 0,
      create: async () => {
        throw Error("no analyst");
      },
    },
    {
      create: async (r) => {
        calls++;
        return {
          model: JEV_MODEL,
          usage: { input_tokens: 100, output_tokens: 0 },
          answers: {
            ...Object.fromEntries(
              Object.entries(r.questions).map(([key, q]) => [
                key,
                key === "substitution"
                  ? { type: "noul", noul: 0.8 }
                  : {
                      type: "choice",
                      probabilities: Object.fromEntries(
                        Object.keys(q.criteria).map((k, _, xs) => [
                          k,
                          1 / xs.length,
                        ]),
                      ),
                    },
              ]),
            ),
            degenerate: true,
            candidates: [],
          },
        };
      },
    },
  );
  await proxy.listen();
  const assembler = {
    ...fixtureAssembler,
    run: async (_p: string, s: any, _signal: AbortSignal, mode?: string) => ({
      value: mode === "load" ? { loaded: true } : genericSwapAssembly(s),
      computeSeconds: 0.01,
    }),
  };
  const workspace = join(root, "workspace"),
    path = join(workspace, "packages", dataset.gameId);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "assemble.py"), "pass");
  writeFileSync(
    join(path, "manifest.json"),
    JSON.stringify({ stateVersion: "state-v1" }),
  );
  const packages = new PackageStore(join(root, "frozen"));
  const receipt = await packages.freeze(
    dataset.gameId,
    path,
    () => "2025-01-01T00:00:00Z",
    "2025-10-01T00:00:00Z",
    assembler,
    new AbortController().signal,
  );
  const record = new RecordStore<any>(join(root, "record"), {
    schemaVersion: 1,
    kind: "replay-mvp",
    games: [{ gameId: dataset.gameId, index: 0, split: "development" }],
    releaseManifestSha256: dataset.release.sha256,
    datasetVersion: dataset.version,
    datasets: [{ gameId: dataset.gameId, inputHash: dataset.inputHash }],
    harness: { ...REPLAY_VERSIONS, policy: policyHarness(assembler, pin) },
    predictors: {
      policy: {
        id: "policy",
        policy: policyVersion(assembler, receipt, "test", pin),
      },
    },
    codeRevision: "test",
  });
  try {
    const opts = {
      dataset,
      predictorId: "policy",
      record,
      proxy,
      assembler,
      receipt,
      packagePath: join(packages.path(dataset.gameId), "package"),
      signal: new AbortController().signal,
      releaseAt: "2025-10-01T13:00:00Z",
      codeRevision: "test",
      swapContract: pin,
    };
    const trace = await replayPolicy(opts);
    assert.ok(trace.summary.setLogLoss !== null);
    const first = trace.windows.find((w) => w.result.scores)!;
    assert.ok(first.result.validation!.swap!.candidates.length > 0);
    assert.equal((first.result.raw as any).degenerate, undefined);
    const before = calls;
    assert.deepEqual(await replayPolicy(opts), trace);
    assert.equal(calls, before);
    const service = new PolicyTools(
      root,
      workspace,
      {
        gameId: dataset.gameId,
        scheduledStart: "2025-10-01T00:00:00Z",
        release: "2025-10-01T13:00:00Z",
      },
      [
        {
          gameId: dataset.gameId,
          scheduledStart: "2025-10-01T00:00:00Z",
          release: "2025-10-01T13:00:00Z",
        },
      ],
      assembler,
      [],
      () => "2025-10-01T13:00:00Z",
      [],
      pin,
    );
    service.saveFeedback(trace);
    assert.equal(
      (service.readFeedback("postgame") as any).summary!.setLogLoss,
      trace.summary.setLogLoss,
    );
    const evaluated = evaluateRecord(readRecord(join(root, "record")), "v2");
    assert.equal(evaluated[0].descriptors.jevContract, "jev-contract-v2");
    assert.ok(evaluated[0].totals.setLogLoss !== null);
    const legacy = structuredClone(evaluated[0]);
    legacy.descriptors.jevContract = "prediction-v1";
    assert.ok(
      compareRuns(evaluated[0], legacy, {
        resamples: 10,
        seed: 1,
      }).reasons.includes("jev_contract_mismatch"),
    );
    const same = compareRuns(evaluated[0], evaluated[0], {
      resamples: 10,
      seed: 1,
    });
    assert.equal(same.status, "compared");
    if (same.status === "compared")
      near(same.scores!.setLogLoss.difference!, 0);
  } finally {
    record.close();
    await proxy.close();
    cleanup(root);
  }
});
test("first-window invalid candidates score fallback without Jev; first-window execution raise invalidates game", async () => {
  for (const mode of ["missing", "empty", "ineligible", "raise"]) {
    const root = mkdtempSync(join(tmpdir(), "swap-error-")),
      d = fixture(),
      pin = pinSwapContract([d]);
    let calls = 0;
    const assembler = {
      ...fixtureAssembler,
      run: async (_p: string, s: any, _signal: AbortSignal, load?: string) => {
        if (load === "load")
          return { value: { loaded: true }, computeSeconds: 0 };
        if (mode === "raise") throw new PackageExecutionError("boom");
        const a: any = genericSwapAssembly(s);
        if (mode === "missing") delete a.candidates;
        else
          a.candidates =
            mode === "empty"
              ? []
              : [{ out: ["not-on-court"], in: [s.eligibleBench[0]] }];
        return { value: a, computeSeconds: 0 };
      },
    };
    const proxy = new MeteringProxy(
      {
        count: async () => 0,
        create: async () => {
          throw Error("no");
        },
      },
      {
        create: async () => {
          calls++;
          throw Error("must not call");
        },
      },
    );
    await proxy.listen();
    const path = join(root, "package");
    mkdirSync(path);
    writeFileSync(join(path, "assemble.py"), "pass");
    writeFileSync(join(path, "manifest.json"), '{"stateVersion":"state-v1"}');
    const store = new PackageStore(join(root, "frozen"));
    const receipt = await store.freeze(
      d.gameId,
      path,
      () => "2025-01-01T00:00:00Z",
      "2025-10-01T00:00:00Z",
      assembler,
      new AbortController().signal,
    );
    const record = new RecordStore<any>(join(root, "record"), {
      schemaVersion: 1,
      kind: "replay-mvp",
      releaseManifestSha256: d.release.sha256,
      datasetVersion: d.version,
      datasets: [{ gameId: d.gameId, inputHash: d.inputHash }],
      harness: { ...REPLAY_VERSIONS, policy: policyHarness(assembler, pin) },
      predictors: {
        p: { id: "p", policy: policyVersion(assembler, receipt, "test", pin) },
      },
    });
    try {
      const trace = await replayPolicy({
        dataset: d,
        predictorId: "p",
        record,
        proxy,
        assembler,
        receipt,
        packagePath: join(store.path(d.gameId), "package"),
        signal: new AbortController().signal,
        releaseAt: "2025-10-01T13:00:00Z",
        codeRevision: "test",
        swapContract: pin,
      });
      assert.equal(calls, 0);
      const eligible = trace.windows.filter(
        (w) => !w.result.window.exclusions.length,
      );
      assert.ok(
        eligible.every(
          (w) =>
            w.result.failure ===
            (mode === "raise" ? "invalid_package" : "assembler_error"),
        ),
      );
      assert.ok(
        eligible.every((w) =>
          mode === "raise"
            ? w.result.scores === null
            : w.result.scores !== null,
        ),
      );
    } finally {
      record.close();
      await proxy.close();
      cleanup(root);
    }
  }
});
test("validate_package returns swap answers and derived marginals, or candidate reasons", async () => {
  const root = mkdtempSync(join(tmpdir(), "swap-validation-")),
    s = state();
  s.gameId = "prior";
  let bad = false;
  const assembler = {
    ...fixtureAssembler,
    run: async (_p: string, s: any, _signal: AbortSignal, mode?: string) => ({
      value:
        mode === "load"
          ? { loaded: true }
          : { ...genericSwapAssembly(s), ...(bad ? { candidates: [] } : {}) },
      computeSeconds: 0.01,
    }),
  };
  const workspace = join(root, "workspace"),
    path = join(workspace, "packages", "current");
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "assemble.py"), "pass");
  writeFileSync(join(path, "manifest.json"), '{"stateVersion":"state-v1"}');
  const game = {
    gameId: "current",
    scheduledStart: "2025-10-22T23:00:00Z",
    release: "2025-10-23T13:00:00Z",
  };
  const prior = {
    gameId: "prior",
    scheduledStart: "2025-10-20T23:00:00Z",
    release: "2025-10-21T13:00:00Z",
  };
  const service = new PolicyTools(
    root,
    workspace,
    game,
    [prior, game],
    assembler,
    [{ gameId: "prior", state: s }],
    () => "2025-10-22T22:00:00Z",
    [],
    contract,
  );
  try {
    const result = await service.validate(
      "pregame",
      10,
      new AbortController().signal,
      { jev: true },
      async (r) =>
        Object.fromEntries(
          Object.entries(r.questions).map(([key, q]) => [
            key,
            key === "substitution"
              ? { type: "noul", noul: 0.7 }
              : {
                  type: "choice",
                  probabilities: Object.fromEntries(
                    Object.keys(q.criteria).map((k, _, xs) => [
                      k,
                      1 / xs.length,
                    ]),
                  ),
                },
          ]),
        ),
    );
    assert.ok(result.outputs[0].answers.swap);
    assert.ok(result.outputs[0].derived?.exit);
    assert.equal(result.summary?.meanSubstitutionProbability, 0.7);
    bad = true;
    writeFileSync(join(path, "assemble.py"), "# changed\npass");
    const invalid = await service.validate(
      "pregame",
      10,
      new AbortController().signal,
    );
    assert.match(invalid.outputs[0].error!, /no_candidates/);
  } finally {
    cleanup(root);
  }
});

test("generic swap candidates prefer rested rotation players over never-played entries", () => {
  const s = state();
  s.eligibleBench = ["never-a", "rested-b", "rested-c"];
  const template = s.players[0];
  s.players.push(
    { ...template, playerId: "never-a", restMs: null },
    { ...template, playerId: "rested-b", restMs: 0 },
    { ...template, playerId: "rested-c", restMs: 60000 },
  );
  assert.deepEqual(
    genericSwapAssembly(s).candidates.map((c) => c.in),
    [["rested-c"], ["rested-c", "rested-b"]],
  );
  // Never-played players remain eligible when needed, with deterministic ties.
  s.eligibleBench = ["never-a", "rested-b"];
  assert.deepEqual(
    genericSwapAssembly(s).candidates.map((c) => c.in),
    [["rested-b"], ["rested-b", "never-a"]],
  );
  s.players.find((p) => p.playerId === "rested-b")!.restMs = null;
  assert.deepEqual(
    genericSwapAssembly(s).candidates.map((c) => c.in),
    [["never-a"], ["never-a", "rested-b"]],
  );
});
