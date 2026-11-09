import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  readdirSync,
  lstatSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chronologicalFixture } from "../scripts/fixtures/chronological.js";
import { fixtureAssembler } from "./fixtures/runner/chronological.js";
import { genericSwapAssembly, JEV_MODEL } from "../src/policy/request.js";
import { pinSwapContract } from "../src/replay/swap.js";
import {
  CODE_CONTRACT,
  type CodeAnswers,
} from "../src/replay/code-prediction.js";
import { scoreWindow, summarize } from "../src/replay/scoring.js";
import { PackageStore } from "../src/policy/package.js";
import { RecordStore } from "../src/runner/record.js";
import { MeteringProxy } from "../src/runner/proxy.js";
import { JevHttpError } from "../src/runner/jev.js";
import {
  policyHarness,
  policyVersion,
  replayPolicy,
} from "../src/policy/replay.js";
import { REPLAY_VERSIONS } from "../src/replay/types.js";
import { evaluateRecord } from "../src/evaluation/evaluate.js";
import { readRecord } from "../src/evaluation/record.js";
import { compareRuns } from "../src/evaluation/compare.js";
import { feedbackPage } from "../src/policy/feedback.js";
import { PolicyTools } from "../src/policy/tools.js";

const fixture = () => chronologicalFixture().datasets[0];
function cleanup(p: string) {
  if (lstatSync(p).isDirectory()) {
    chmodSync(p, 0o700);
    for (const f of readdirSync(p)) cleanup(join(p, f));
  } else chmodSync(p, 0o600);
}
function answers(a: any, p: number) {
  return {
    substitution: { type: "noul", noul: p },
    ...(Object.keys(a.criteria.swap).length
      ? {
          swap: {
            type: "choice",
            probabilities: Object.fromEntries(
              Object.keys(a.criteria.swap).map((k, _, xs) => [
                k,
                1 / xs.length,
              ]),
            ),
          },
        }
      : {}),
  };
}

test("v3 selects the scored answer and preserves failures, pair counts and regret", () => {
  const d = fixture(),
    w = structuredClone(
      d.windows.find(
        (w) => !w.exclusions.length && w.actual?.players_in.length,
      )!,
    );
  const contract = { ...pinSwapContract([d]), version: CODE_CONTRACT };
  const a = genericSwapAssembly(w.state!);
  const raw: CodeAnswers = {
    contract: CODE_CONTRACT,
    prediction: answers(a, 0.2),
    candidates: a.candidates,
    defer: null,
    shadow: answers(a, 0.8),
    shadowFailure: null,
  };
  const run = (changes: Partial<CodeAnswers>) =>
    scoreWindow(w, { ...raw, ...changes }, null, contract);
  const own = run({}),
    deferred = run({ defer: { reason: "rotation" } });
  assert.equal(own.scores!.probability, 0.2);
  assert.equal(deferred.scores!.probability, 0.8);
  assert.ok(Math.abs(own.code!.regret!.timing - 0.6) < 1e-10);
  assert.ok(Math.abs(deferred.code!.regret!.timing + 0.6) < 1e-10);
  const bad = run({ prediction: null }),
    badDeferred = run({ prediction: null, defer: { reason: "rotation" } });
  assert.equal(bad.failure, "assembler_error");
  assert.equal(bad.scores!.probability, 0.5);
  assert.equal(badDeferred.failure, null);
  assert.equal(badDeferred.scores!.probability, 0.8);
  assert.equal(badDeferred.code!.package.scores!.probability, 0.5);
  const shadowBad = run({ shadow: null });
  assert.equal(shadowBad.scores!.probability, 0.2);
  assert.equal(shadowBad.code!.jev.scores!.probability, 0.5);
  const failed = run({ shadow: null, shadowFailure: "provider_failure" });
  assert.equal(failed.failure, null);
  assert.equal(failed.scores!.probability, 0.2);
  assert.equal(failed.code!.regret, null);
  assert.equal(failed.code!.shadowFailure, "shadow_provider_failure");
  const deferredFail = run({
    shadow: null,
    shadowFailure: "provider_failure",
    defer: { reason: "rotation" },
  });
  assert.equal(deferredFail.failure, "provider_failure");
  assert.equal(deferredFail.scores, null);
  assert.equal(deferredFail.code!.package.scores!.probability, 0.2);
  const summary = summarize([
    own,
    deferred,
    bad,
    badDeferred,
    shadowBad,
    failed,
    deferredFail,
  ]);
  assert.equal(summary.providerFailureRate, 1 / 7);
  assert.equal(summary.code!.shadowProviderFailures, 1);
  assert.equal(summarize([failed]).providerFailureFlag, false);
  assert.equal(summary.code!.invalidPrediction, 2);
  assert.equal(summary.code!.primaryN, 6);
  assert.equal(summary.code!.packageOnly.n, 6);
  assert.equal(summary.code!.jevOnly.n, 5);
  assert.equal(summary.code!.regret.n, 5);
  assert.equal(summary.code!.jevOnly.alternative.timing.n, 5);
  assert.equal(summary.code!.counterfactualFlag, true);
  const empty = structuredClone(w);
  empty.state!.eligibleBench = [];
  empty.actual = { players_out: [], players_in: [] };
  const er = scoreWindow(
    empty,
    {
      ...raw,
      candidates: [],
      prediction: { substitution: { type: "noul", noul: 0.1 } },
      shadow: { substitution: { type: "noul", noul: 0.4 } },
    },
    null,
    contract,
  );
  assert.equal(er.scores!.setLogLoss, null);
  assert.equal(er.code!.invalidPrediction, false);
  assert.equal(summarize([er]).code!.regret.metrics.setLogLoss.n, 0);
});

test("v3 policy replay records, resumes, validates and evaluates trusted package/shadow answers", async () => {
  for (const scenario of [
    "package",
    "deferred",
    "invalid",
    "invalid-deferred",
    "shadow-fails",
    "deferred-fails",
    "malformed",
    "bad-candidates",
  ]) {
    const root = mkdtempSync(join(tmpdir(), "code-replay-"));
    const dataset = fixture();
    dataset.windows = dataset.windows
      .filter((w) => !w.exclusions.length && w.state && w.actual)
      .slice(0, 1);
    const contract = {
      ...pinSwapContract([fixture()]),
      version: CODE_CONTRACT,
    };
    let calls = 0;
    const assembly = (s: any) => {
      const a: any = genericSwapAssembly(s);
      a.prediction = scenario.startsWith("invalid") ? null : answers(a, 0.2);
      a.defer = scenario.includes("deferred") ? { reason: "rotation" } : null;
      if (scenario === "malformed") a.defer = true;
      if (scenario === "bad-candidates") a.candidates = [];
      return a;
    };
    const assembler = {
      ...fixtureAssembler,
      run: async (_p: string, s: any, _signal: AbortSignal, mode?: string) => ({
        value: mode === "load" ? { loaded: true } : assembly(s),
        computeSeconds: 0.01,
      }),
    };
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
          if (scenario.endsWith("fails"))
            throw new JevHttpError(429, "unavailable", "0");
          return {
            model: JEV_MODEL,
            usage: { input_tokens: 10, output_tokens: 0 },
            answers: {
              ...answers(
                { criteria: { swap: r.questions.swap?.criteria ?? {} } },
                0.8,
              ),
              candidates: [],
              degenerate: true,
              contract: CODE_CONTRACT,
            },
          };
        },
      },
    );
    await proxy.listen();
    const workspace = join(root, "workspace"),
      path = join(workspace, "packages", dataset.gameId);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "assemble.py"), "pass");
    writeFileSync(
      join(path, "manifest.json"),
      JSON.stringify({ stateVersion: "state-v1" }),
    );
    const packages = new PackageStore(join(root, "frozen"));
    const signal = new AbortController().signal;
    const receipt = await packages.freeze(
      dataset.gameId,
      path,
      () => "2025-01-01T00:00:00Z",
      "2025-10-01T00:00:00Z",
      assembler,
      signal,
    );
    const record = new RecordStore<any>(join(root, "record"), {
      schemaVersion: 1,
      kind: "replay-mvp",
      games: [{ gameId: dataset.gameId, index: 0, split: "development" }],
      releaseManifestSha256: dataset.release.sha256,
      datasetVersion: dataset.version,
      datasets: [{ gameId: dataset.gameId, inputHash: dataset.inputHash }],
      harness: {
        ...REPLAY_VERSIONS,
        policy: policyHarness(assembler, contract),
      },
      predictors: {
        policy: {
          id: "policy",
          policy: policyVersion(assembler, receipt, "test", contract),
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
        signal,
        releaseAt: "2025-10-01T13:00:00Z",
        codeRevision: "test",
        swapContract: contract,
      };
      const trace = await replayPolicy(opts);
      const r = trace.windows[0].result;
      if (scenario === "malformed" || scenario === "bad-candidates") {
        assert.equal(calls, 0);
        assert.equal(r.failure, "assembler_error");
        assert.equal(trace.summary.scored, 1);
      } else {
        assert.equal(calls, scenario.endsWith("fails") ? 2 : 1);
        assert.equal(
          r.code!.source,
          scenario.includes("deferred") ? "jev" : "package",
        );
        assert.equal(r.code!.invalidPrediction, scenario.startsWith("invalid"));
        assert.ok((r.code!.package.raw as any).candidates.length > 0);
      }
      const before = calls;
      assert.deepEqual(await replayPolicy(opts), trace);
      assert.equal(calls, before);
      const feedback = feedbackPage(trace);
      if (r.code) assert.equal(feedback.windows[0].code!.source, r.code.source);
      const evaluated = evaluateRecord(
        readRecord(join(root, "record")),
        scenario,
      )[0];
      assert.equal(evaluated.descriptors.jevContract, CODE_CONTRACT);
      assert.deepEqual(evaluated.totals.code, trace.summary.code);
      const v2 = structuredClone(evaluated);
      v2.descriptors.jevContract = "jev-contract-v2";
      assert.ok(
        compareRuns(evaluated, v2, { resamples: 10, seed: 1 }).reasons.includes(
          "jev_contract_mismatch",
        ),
      );
      if (scenario === "package") {
        const game = {
          gameId: dataset.gameId,
          scheduledStart: "2025-10-01T00:00:00Z",
          release: "2025-10-01T13:00:00Z",
        };
        const tools = new PolicyTools(
          root,
          workspace,
          game,
          [game],
          assembler,
          [],
          () => "2025-09-30T23:00:00Z",
          [
            {
              gameId: "practice",
              scheduledStart: "2025-01-01T00:00:00Z",
              release: "2025-01-01T14:00:00Z",
              inputHash: "practice",
              state: { ...dataset.windows[0].state!, gameId: "practice" },
            },
          ],
          contract,
        );
        const result = await tools.validate("pregame", 10, signal, {
          jev: false,
          samples: 1,
        });
        assert.equal(result.outputs[0].predictionValid, true);
        assert.equal(result.outputs[0].defer, null);
        assert.equal(
          (result.outputs[0].prediction as any).substitution.noul,
          0.2,
        );
      }
    } finally {
      record.close();
      await proxy.close();
      cleanup(root);
      rmSync(root, { recursive: true, force: true });
    }
  }
});
