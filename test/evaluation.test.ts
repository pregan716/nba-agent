import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  copyFileSync,
  readdirSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { RecordStore } from "../src/runner/record.js";
import { scoreWindow, summarize } from "../src/replay/scoring.js";
import {
  REPLAY_VERSIONS,
  type Window,
  type Prediction,
} from "../src/replay/types.js";
import { chronologicalFixture } from "../scripts/fixtures/chronological.js";
import { memoryVariant } from "../src/env/memory.js";
import { JEV_SETTINGS } from "../src/policy/request.js";
import { readRecord, hash } from "../src/evaluation/record.js";
import { evaluateRecord } from "../src/evaluation/evaluate.js";
import { compareRuns, replicateSpread } from "../src/evaluation/compare.js";
import { buildReport, markdown } from "../src/evaluation/report.js";

const temp = () => mkdtempSync(join(tmpdir(), "nba-evaluation-"));
const remove = (root: string) => rmSync(root, { recursive: true, force: true });
const close = (a: number | null, b: number) =>
  assert.ok(a !== null && Math.abs(a - b) < 1e-10, `${a} != ${b}`);
const baseline = (p: number): Prediction => ({
  substitution: { type: "noul", noul: p },
  count: {
    type: "score",
    probabilities: { none: 0, one: 0, two: 1, three_or_more: 0 },
  },
  exit: {
    type: "choice",
    probabilities: { a: 0.2, b: 0.2, c: 0.2, d: 0.2, e: 0.2 },
  },
  entry: { type: "choice", probabilities: { f: 1 / 3, g: 1 / 3, h: 1 / 3 } },
});
interface Options {
  memoryVariant?: "M0" | "M3";
  interruptedJev?: boolean;
  games?: number;
  probabilities?: number[];
  p?: number;
  secondNoSub?: boolean;
  missing?: boolean;
  failure?: "provider_failure" | "assembler_error" | "invalid_package";
  excluded?: boolean;
  rawInvalid?: boolean;
  index?: number;
  version?: string;
  harness?: string;
  budget?: string;
  replicate?: string;
  predictor?: string;
  unknownSpend?: boolean;
  incomplete?: boolean;
  estimateSummary?: boolean;
  firstBetweenPeriods?: boolean;
  state?: string;
  jev?: any;
}
function fixture(root: string, options: Options = {}) {
  const version = options.version ?? chronologicalFixture().datasets[0].version;
  const predictor = options.predictor ?? "variant";
  const games = Array.from({ length: options.games ?? 2 }, (_, i) => i).map(
    (i) => ({ gameId: `g${i + 1}`, index: (options.index ?? 20) + i }),
  );
  const ds = games.map((g) => ({
    gameId: g.gameId,
    inputHash: hash(g.gameId),
    version,
    releaseManifestSha256: "a".repeat(64),
  }));
  const jev = options.jev ?? JEV_SETTINGS;
  const stateVersion = options.state ?? "state-v1";
  const config = {
    runId: "fixture",
    replicateId: options.replicate ?? "r1",
    purpose: "fixture",
    codeRevision: "fixture-only",
    profile: {
      memory: memoryVariant(options.memoryVariant ?? "M3"),
      modelRoles: { jev: jev.model },
    },
    budget: { id: options.budget ?? "fixture", price: { id: "fixture-only" } },
    harness: { policy: { jev }, identity: "fixture" },
    replay: {
      mode: predictor === "variant" ? "variant" : "baselines",
      versions: { ...REPLAY_VERSIONS, state: stateVersion },
      datasets: ds,
    },
  };
  const manifest = {
    games,
    config,
    harnessVersion: options.harness ?? "harness-v1",
  };
  const record = new RecordStore<any>(root, manifest);
  try {
    for (let i = 0; i < games.length; i++) {
      const game = games[i],
        d = ds[i],
        scope = `${game.gameId}:${d.inputHash}:${predictor}`;
      record.append("replay_manifest", game.gameId, {
        schemaVersion: 1,
        kind: "replay-mvp",
        datasets: [d],
        datasetVersion: version,
        releaseManifestSha256: d.releaseManifestSha256,
        harness: { ...REPLAY_VERSIONS, state: stateVersion, policy: { jev } },
        predictors: { [predictor]: { id: predictor } },
        codeRevision: "fixture-only",
      });
      const w = structuredClone(chronologicalFixture().datasets[0].windows[0]);
      w.gameId = game.gameId;
      w.id = `${game.gameId}-w`;
      w.datasetVersion = version;
      w.releaseManifestSha256 = d.releaseManifestSha256;
      w.state!.gameId = game.gameId;
      w.state!.version = stateVersion as any;
      w.actual =
        i === 1 && options.secondNoSub
          ? { players_out: [], players_in: [] }
          : { players_out: ["a", "b"], players_in: ["f", "g"] };
      if (i === 0 && options.firstBetweenPeriods) {
        w.kind = "between_periods";
        w.state!.stoppage.kind = "between_periods";
      }
      if (i === 1 && options.excluded) w.exclusions = ["fixture_excluded"];
      const rows =
        i === 1 && options.missing
          ? []
          : [
              scoreWindow(
                w,
                options.rawInvalid
                  ? {}
                  : baseline(options.probabilities?.[i] ?? options.p ?? 0.5),
                i === 1 ? (options.failure ?? null) : null,
              ),
            ];
      for (const result of rows)
        record.append("replay_window", scope, {
          releaseManifestSha256: d.releaseManifestSha256,
          datasetVersion: version,
          result,
        });
      if (!options.incomplete)
        record.append("replay_summary", scope, {
          summary: {
            ...summarize(rows),
            ...(options.estimateSummary
              ? { assertedEstimates: 0, jevAgreementWithDiagnostics: null }
              : {}),
          },
        });
      const researchScope = `${game.gameId}:pregame`;
      record.append("session_start", researchScope, { attempt: 1 });
      record.append("model_request", researchScope, {
        reservation: game.gameId,
      });
      if (!options.unknownSpend)
        record.append("settlement", researchScope, {
          id: game.gameId,
          details: { usd: 2 },
        });
      record.append("session_end", researchScope, {
        attempt: 1,
        elapsedMs: 1000,
        diff: { added: ["memory/coach_profile.md"], changed: [], removed: [] },
        memorySize: { tokens: 123, cap: 50000 },
      });
      record.append("memory_checkpoint", "run", {
        game: game.gameId,
        tokens: 123,
        cap: 50000,
      });
      const callScope = scope + ":" + "b".repeat(64);
      record.append("jev_request", callScope, { attempt: 0 });
      if (options.interruptedJev)
        record.append("jev_request", callScope, { attempt: 0 });
      record.append("jev_response", callScope, {
        attempt: 0,
        usd: 1,
        latencyMs: 500,
      });
      record.append("policy_assembly", callScope, { computeSeconds: 0.25 });
    }
  } finally {
    record.close();
  }
  return { path: root, label: "fixture" };
}
const evaluated = (path: string, label = "fixture") =>
  evaluateRecord(readRecord(path), label)[0];

test("record-only constant baseline matches hand Brier, scale-by-k selection and top-k", () => {
  const root = temp();
  try {
    fixture(root, { secondNoSub: true, predictor: "constant-v1:fixture" });
    const run = evaluated(root);
    close(run.totals.timingBrier, 0.25);
    close(run.totals.exitBrier, 0.24);
    close(run.totals.entryBrier, 2 / 9);
    close(run.totals.exitTopK, 1);
    close(run.totals.entryTopK, 1);
    close(run.totals.exitTop1, 1);
    close(run.totals.entryTop1, 1);
    close(run.totals.precision, 0.5);
    close(run.totals.recall, 1);
    close(run.totals.exactAction, 0.5);
    close(run.totals.partialOverlap, 0.5);
    assert.equal(run.totals.calibration[5].n, 2);
    close(run.totals.calibration[5].observed, 0.5);
    assert.equal(run.cost.analystUsd, 0);
    assert.equal(run.cost.jevUsd, 2);
  } finally {
    remove(root);
  }
});
test("unscored or missing windows are dropped from both comparison sides with reasons", () => {
  const root = temp();
  try {
    fixture(join(root, "a"));
    fixture(join(root, "b"), { failure: "provider_failure" });
    fixture(join(root, "c"), { missing: true });
    const a = evaluated(join(root, "a"), "a"),
      b = evaluated(join(root, "b"), "b");
    const c = compareRuns(a, b, { resamples: 100, seed: 7 });
    assert.equal(c.status, "compared");
    if (c.status !== "compared") throw Error();
    assert.equal(c.matchedWindows, 1);
    assert.equal(c.dropped.count, 1);
    assert.equal(c.dropped.reasons["right:provider_failure"], 1);
    assert.deepEqual(b.providerFailureGames, ["g2"]);
    const missing = compareRuns(a, evaluated(join(root, "c")), {
      resamples: 100,
      seed: 7,
    });
    assert.equal(missing.status, "compared");
    if (missing.status !== "compared") throw Error();
    assert.equal(missing.dropped.reasons["right:missing_window"], 1);
  } finally {
    remove(root);
  }
});
test("comparison refuses dataset/state/Jev mismatches and flags harness/budget changes", () => {
  const root = temp();
  try {
    fixture(join(root, "a"));
    const a = evaluated(join(root, "a"));
    for (const [name, opts, reason] of [
      ["dataset", { version: "different" }, "decision_dataset_mismatch"],
      ["state", { state: "state-future" }, "state_schema_mismatch"],
      [
        "jev",
        { jev: { ...JEV_SETTINGS, model: "other" } },
        "jev_model_or_settings_mismatch",
      ],
    ] as const) {
      fixture(join(root, name), opts);
      const c = compareRuns(a, evaluated(join(root, name)), {
        resamples: 10,
        seed: 0,
      });
      assert.equal(c.status, "refused");
      assert.ok(c.reasons.includes(reason));
    }
    fixture(join(root, "flag"), { harness: "other", budget: "other" });
    const c = compareRuns(a, evaluated(join(root, "flag")), {
      resamples: 10,
      seed: 0,
    });
    assert.deepEqual(c.flags, [
      "harness_version_differs",
      "budget_profile_differs",
    ]);
    assert.equal(c.status, "compared");
    const changed = structuredClone(a);
    changed.descriptors.games[0].gameId = "other";
    assert.ok(compareRuns(a, changed).reasons.includes("game_list_mismatch"));
  } finally {
    remove(root);
  }
});
test("baseline profiles and comparison axes distinguish predictors from memory variants", () => {
  const root = temp();
  try {
    fixture(join(root, "m3"));
    fixture(join(root, "m0"), { memoryVariant: "M0" });
    const m3 = evaluated(join(root, "m3"));
    const m0 = evaluated(join(root, "m0"));
    const options = { resamples: 10, seed: 0 };
    assert.deepEqual(compareRuns(m3, m0, options).differingAxes, ["memory"]);
    const baselines = ["constant", "statistical", "generic-jev"].map(
      (predictor) => {
        const path = join(root, predictor);
        fixture(path, { predictor, memoryVariant: "M0" });
        const run = evaluated(path);
        assert.equal(run.descriptors.profile.memory, null);
        assert.equal(run.descriptors.profile.baseline, predictor);
        assert.deepEqual(
          run.descriptors.profile.modelRoles,
          m0.descriptors.profile.modelRoles,
        );
        for (const [left, right] of [
          [m3, run],
          [run, m3],
        ]) {
          const comparison = compareRuns(left, right, options);
          assert.equal(comparison.status, "compared");
          assert.deepEqual(comparison.differingAxes, ["predictor"]);
        }
        return run;
      },
    );
    assert.deepEqual(
      compareRuns(baselines[0], baselines[1], options).differingAxes,
      ["predictor"],
    );
  } finally {
    remove(root);
  }
});
test("bootstrap is deterministic; constant per-game differences have zero-width intervals", () => {
  const root = temp();
  try {
    fixture(join(root, "a"), { p: 0.25 });
    fixture(join(root, "b"), { p: 0.5 });
    const a = evaluated(join(root, "a")),
      b = evaluated(join(root, "b"));
    const c = compareRuns(a, b, { resamples: 1000, seed: 854 });
    assert.deepEqual(c, compareRuns(a, b, { resamples: 1000, seed: 854 }));
    assert.equal(c.status, "compared");
    if (c.status !== "compared") throw Error();
    assert.deepEqual(c.scores.timingBrier.interval90, [-0.3125, -0.3125]);
    assert.equal(c.scores.timingBrier.sensitivity.length, 2);
    assert.ok(c.scores.timingBrier.sensitivity.every((s) => s.change === 0));
    assert.equal(c.scores.timingBrier.cost.left.totalUsd, 6);
    close(c.scores.timingBrier.cost.left.recordedSeconds, 3.5);
    close(c.scores.timingBrier.efficiency.right.scorePerUsd, 0.25 / 6);
  } finally {
    remove(root);
  }
});
test("failures, exclusions, clipping and invalid-question reasons use existing scoring", () => {
  const root = temp();
  try {
    fixture(join(root, "invalid"), {
      rawInvalid: true,
      failure: "assembler_error",
    });
    const invalid = evaluated(join(root, "invalid"));
    assert.equal(invalid.totals.invalidQuestions.entry, 2);
    assert.equal(
      invalid.totals.invalidReasons["entry:missing_or_malformed_answer"],
      2,
    );
    assert.equal(invalid.totals.failures.assembler_error, 1);
    fixture(join(root, "package"), { failure: "invalid_package" });
    assert.deepEqual(evaluated(join(root, "package")).invalidPackageGames, [
      "g2",
    ]);
    fixture(join(root, "excluded"), { excluded: true });
    assert.equal(
      evaluated(join(root, "excluded")).totals.excluded.fixture_excluded,
      1,
    );
    fixture(join(root, "clips"), { p: 0 });
    assert.equal(evaluated(join(root, "clips")).totals.clipped, 2);
    fixture(join(root, "cost"), { unknownSpend: true });
    assert.equal(evaluated(join(root, "cost")).cost.totalUsd, null);
    fixture(join(root, "partial"), { incomplete: true });
    assert.deepEqual(
      compareRuns(invalid, evaluated(join(root, "partial"))).reasons,
      ["incomplete_replay"],
    );
  } finally {
    remove(root);
  }
});
test("holdout is refused before report output; development/warm-up never enter headline", () => {
  const root = temp();
  try {
    const holdout = fixture(join(root, "holdout"), { index: 70 });
    assert.throws(() => buildReport([holdout]), /holdout_not_revealed/);
    const revealed = buildReport([holdout], {
      resamples: 10,
      seed: 1,
      revealHoldout: true,
    });
    assert.equal(revealed.runs[0].headline.scored, 0);
    assert.equal(revealed.runs[0].holdout.scored, 2);
    for (const index of [0, 10]) {
      const input = fixture(join(root, String(index)), { index });
      const report = buildReport([input]);
      assert.equal(report.runs[0].headline.scored, 0);
      assert.equal(report.runs[0].totals.scored, 2);
    }
  } finally {
    remove(root);
  }
});
test("matched replicate spread and empty human annotation slots are deterministic", () => {
  const root = temp();
  try {
    fixture(join(root, "a"), { p: 0.25, replicate: "r1" });
    fixture(join(root, "b"), { p: 0.5, replicate: "r2" });
    const a = evaluated(join(root, "a"), "a"),
      b = evaluated(join(root, "b"), "b");
    const spread = replicateSpread([a, b])[0];
    assert.equal(spread.status, "matched_scored_windows");
    assert.equal(spread.scores?.timingBrier.min, 0.25);
    assert.equal(spread.scores?.timingBrier.max, 0.5625);
    assert.ok(
      a.memoryDiagnostics.every(
        (g) =>
          g.annotation === "" &&
          g.checkpoints.length === 1 &&
          g.sessions[0].diff.added.length === 1,
      ),
    );
    const report = buildReport(
      [
        { label: "a", path: join(root, "a") },
        { label: "b", path: join(root, "b") },
      ],
      { resamples: 100, seed: 1 },
    );
    assert.equal(report.learningCurves.length, 2);
    assert.ok(markdown(report).includes("loss/USD"));
  } finally {
    remove(root);
  }
});
test("report command needs only copied SQLite, not the run manifest file, source tree or caches", () => {
  const root = temp();
  try {
    fixture(join(root, "original"));
    const detached = join(root, "detached");
    mkdirSync(detached);
    const path = join(detached, "record.sqlite");
    copyFileSync(join(root, "original", "record.sqlite"), path);
    remove(join(root, "original"));
    const before = readFileSync(path);
    const out = join(root, "output");
    execFileSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        resolve("scripts/evaluate.ts"),
        `--record=detached=${path}`,
        `--out=${out}`,
        "--seed=7",
        "--resamples=100",
      ],
      { cwd: detached, stdio: "pipe" },
    );
    assert.deepEqual(readFileSync(path), before);
    assert.deepEqual(readdirSync(detached), ["record.sqlite"]);
    assert.equal(
      JSON.parse(readFileSync(join(out, "report.json"), "utf8")).runs[0]
        .headline.timingBrier,
      0.25,
    );
    assert.ok(readFileSync(join(out, "report.md"), "utf8").includes("scored"));
  } finally {
    remove(root);
  }
});
test("hash-chain tampering is refused and committed gate summaries are not mistaken for window records", () => {
  const root = temp();
  try {
    fixture(root);
    const db = new DatabaseSync(join(root, "record.sqlite"));
    db.exec(
      "DROP TRIGGER immutable_update; UPDATE events SET data='{}' WHERE seq=2;",
    );
    db.close();
    assert.throws(() => readRecord(root), /record_integrity/);
    for (const path of [
      "docs/evidence/replay-mvp/audit.json",
      "docs/evidence/policy/gate2-live.json",
    ]) {
      const evidence = JSON.parse(readFileSync(path, "utf8"));
      assert.match(
        evidence.datasetVersion ?? evidence.manifest.datasetVersion,
        /^windows-v2:/,
      );
      assert.throws(() => readRecord(path), /record_not_sqlite/);
    }
  } finally {
    remove(root);
  }
});

test("a resumed Jev attempt cannot price or time its interrupted predecessor", () => {
  const root = temp();
  try {
    fixture(root, { interruptedJev: true });
    const cost = evaluated(root).cost;
    assert.equal(cost.unknownJevCalls, 2);
    assert.equal(cost.knownUsd, 6);
    assert.equal(cost.totalUsd, null);
    assert.equal(cost.recordedSeconds, null);
  } finally {
    remove(root);
  }
});

test("sensitivity reports the five largest game influences and incomplete cost is explicit", () => {
  const root = temp();
  try {
    fixture(join(root, "a"), { games: 7, p: 0.25 });
    fixture(join(root, "b"), {
      games: 7,
      probabilities: [0.5, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25],
    });
    const c = compareRuns(
      evaluated(join(root, "a")),
      evaluated(join(root, "b")),
      { resamples: 100, seed: 3 },
    );
    assert.equal(c.status, "compared");
    if (c.status !== "compared") throw Error();
    assert.equal(c.scores.timingBrier.sensitivity.length, 5);
    assert.equal(c.scores.timingBrier.sensitivity[0].removedGame, "g1");
    close(c.scores.timingBrier.sensitivity[0].difference, 0);
    assert.throws(
      () =>
        buildReport([{ label: "a", path: join(root, "a") }], {
          resamples: 0,
          seed: 1,
        }),
      /bootstrap_options/,
    );
  } finally {
    remove(root);
  }
});

test("marginal loss reductions use signed extra dollars and hours, with undefined zero/unknown deltas", () => {
  const root = temp();
  try {
    fixture(join(root, "left"), { p: 0.25 });
    fixture(join(root, "right"), { p: 0.5 });
    const left = evaluated(join(root, "left")),
      right = evaluated(join(root, "right"));
    const compare = () => {
      const c = compareRuns(left, right, { resamples: 20, seed: 1 });
      assert.equal(c.status, "compared");
      if (c.status !== "compared") throw Error();
      return c;
    };
    assert.equal(
      compare().scores.timingBrier.marginal.lossReductionPerExtraUsd,
      null,
    );
    assert.equal(
      compare().scores.timingBrier.marginal.lossReductionPerExtraHour,
      null,
    );
    for (const g of right.games) {
      g.cost.totalUsd! += 1;
      g.cost.recordedSeconds! += 1800;
    }
    const s = compare().scores.timingBrier;
    close(s.marginal.lossReduction, 0.3125);
    close(s.marginal.lossReductionPerExtraUsd, 0.15625);
    close(s.marginal.lossReductionPerExtraHour, 0.3125);
    assert.equal(s.cost.deltaUsd, 2);
    assert.equal(s.cost.deltaRecordedSeconds, 3600);
    assert.ok(
      s.sensitivity.every((s) => s.marginal.lossReductionPerExtraUsd !== null),
    );
    for (const g of right.games) {
      g.cost.totalUsd! -= 2;
      g.cost.recordedSeconds = 0;
    }
    close(
      compare().scores.timingBrier.marginal.lossReductionPerExtraUsd,
      -0.15625,
    );
    for (const g of right.games) {
      g.cost.totalUsd = null;
      g.cost.recordedSeconds = null;
    }
    for (const s of Object.values(compare().scores)) {
      assert.equal(s.marginal.lossReductionPerExtraUsd, null);
      assert.equal(s.marginal.lossReductionPerExtraHour, null);
    }
    const report = buildReport(
      [
        { label: "left", path: join(root, "left") },
        { label: "right", path: join(root, "right") },
      ],
      { resamples: 20, seed: 1 },
    );
    assert.match(markdown(report), /lossReductionPerExtraUsd/);
    assert.match(markdown(report), /null means undefined/);
  } finally {
    remove(root);
  }
});

test("extended estimate summaries preserve completeness and comparisons with legacy records", () => {
  const root = temp();
  try {
    fixture(join(root, "old"));
    fixture(join(root, "new"), { estimateSummary: true });
    const comparison = compareRuns(
      evaluated(join(root, "old")),
      evaluated(join(root, "new")),
      { resamples: 10, seed: 1 },
    );
    assert.equal(comparison.status, "compared");
  } finally {
    remove(root);
  }
});

test("report attaches baseline reference columns, statistical skill and mid-period bootstrap", () => {
  const root = temp();
  try {
    fixture(join(root, "variant"), { p: 0.8 });
    fixture(join(root, "statistical"), { predictor: "statistical", p: 0.5 });
    const report = buildReport(
      [{ label: "variant", path: join(root, "variant") }],
      {
        resamples: 20,
        seed: 2,
        baselines: [{ label: "reference", path: join(root, "statistical") }],
      },
    );
    const run = report.runs.find((r) => r.variant)!;
    close(run.totals.timingSkillVsStatistical, 1 - 0.04 / 0.25);
    assert.equal(run.games[0].metrics.baselines.statistical.metrics?.scored, 1);
    const comparison = report.comparisons[0].diagnostic;
    assert.equal(comparison.status, "compared");
    assert.ok(comparison.differingAxes.includes("predictor"));
    assert.equal(comparison.midPeriod.status, "compared");
    const text = markdown(report);
    assert.match(text, /midPeriod/);
    assert.match(text, /decomposition.reliability/);
    assert.match(text, /exitMRR/);
    assert.match(text, /generic-jev/);
    fixture(join(root, "bad"), {
      predictor: "statistical",
      version: "different",
    });
    assert.throws(
      () =>
        buildReport([{ label: "v", path: join(root, "variant") }], {
          resamples: 10,
          seed: 1,
          baselines: [{ label: "b", path: join(root, "bad") }],
        }),
      /decision_dataset_mismatch/,
    );
  } finally {
    remove(root);
  }
});

test("legacy scoring fields are checked while new reports are recomputed", () => {
  const root = temp();
  try {
    fixture(root);
    const record = readRecord(root);
    // In-memory legacy projection leaves the on-disk immutable record untouched.
    const scoreKeys = [
      "exitLogLoss",
      "entryLogLoss",
      "exitMRR",
      "entryMRR",
      "exitLogLossClips",
      "entryLogLossClips",
    ];
    const summaryKeys = [
      ...scoreKeys,
      "n",
      "playerN",
      "timingConstantBrier",
      "timingSkillVsConstant",
      "timingSkillVsConstantReason",
      "timingSkillVsStatistical",
      "timingSkillVsStatisticalReason",
      "meanPredicted",
      "observedRate",
      "brierDecomposition",
      "midPeriod",
      "byStoppage",
    ];
    for (const e of record.events) {
      if (e.kind === "replay_window")
        for (const key of scoreKeys) delete e.data.result.scores[key];
      if (e.kind === "replay_summary")
        for (const key of summaryKeys) delete e.data.summary[key];
    }
    const run = evaluateRecord(record, "legacy")[0];
    assert.ok(run.games.every((g) => g.complete));
    close(run.totals.exitLogLoss, Math.log(5));
    record.events.find(
      (e) => e.kind === "replay_window",
    )!.data.result.scores.timing = 0.123;
    assert.throws(() => evaluateRecord(record, "tampered"), /score_mismatch/);
  } finally {
    remove(root);
  }
});

test("matched mid-period bootstrap excludes boundary windows on both sides", () => {
  const root = temp();
  try {
    fixture(join(root, "left"), {
      firstBetweenPeriods: true,
      probabilities: [0.9, 0.3],
    });
    fixture(join(root, "right"), {
      firstBetweenPeriods: true,
      probabilities: [0.6, 0.8],
    });
    const compared = compareRuns(
      evaluated(join(root, "left")),
      evaluated(join(root, "right")),
      { resamples: 30, seed: 7 },
    );
    assert.equal(compared.status, "compared");
    assert.equal(compared.midPeriod.status, "compared");
    if (
      compared.status !== "compared" ||
      compared.midPeriod.status !== "compared"
    )
      throw Error();
    assert.equal(compared.matchedWindows, 2);
    assert.equal(compared.midPeriod.matchedWindows, 1);
    assert.equal(compared.midPeriod.matchedGames, 1);
    close(compared.midPeriod.scores.timingBrier.left, 0.49);
    close(compared.midPeriod.scores.timingBrier.right, 0.04);
    close(compared.midPeriod.scores.timingBrier.interval90[0], -0.45);
    close(compared.midPeriod.scores.timingBrier.interval90[1], -0.45);
  } finally {
    remove(root);
  }
});
