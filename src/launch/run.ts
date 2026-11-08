import { pinSwapContract } from "../replay/swap.js";
import { join } from "node:path";
import type { SessionSource } from "../env/source.js";
import { sessionEnvironment } from "../env/session.js";
import {
  digest,
  manifest,
  type RunConfig,
  type Game,
} from "../runner/config.js";
import type { RecordLog } from "../runner/record.js";
import { Runner } from "../runner/runner.js";
import type { MeteringProxy } from "../runner/proxy.js";
import type { Assembler } from "../policy/sandbox.js";
import { PolicyTools, type ValidationSample } from "../policy/tools.js";
import {
  policyHarness,
  policyVersion,
  replayPolicy,
} from "../policy/replay.js";
import { replay, type ReplayManifest } from "../replay/run.js";
import { fitBaselines, fitSwapBaselines } from "../replay/baselines.js";
import { REPLAY_VERSIONS, type DecisionDataset } from "../replay/types.js";

/** Pilot and scored runs use the v3 research prompts (SPO-855). Scored runs stay
 * refused here until the pilot's budget profile is approved, which is the
 * brief's one Open decision; the manifest also requires it. */
export function validateLaunch(
  purpose: RunConfig["purpose"],
  assemblerImage: string,
  harnessIdentity?: string,
) {
  if (purpose === "scored" && assemblerImage.startsWith("local@"))
    throw Error(
      "Scored runs require a published assembler digest; local@ is refused",
    );
  if (purpose !== "fixture" && harnessIdentity !== "pi-research-v3")
    throw Error(
      "Pilot/scored runs require the research-v3 prompt set under the Pi harness",
    );
  if (purpose === "scored")
    throw Error(
      "Scored runs require an approved research budget profile; none is approved yet",
    );
}

export function replayDescriptor(
  datasets: DecisionDataset[],
  jevContaminationProbe?: unknown,
): NonNullable<RunConfig["replay"]> {
  if (datasets.some((d) => d.trainingOnly))
    throw Error("Training-only datasets cannot be selected for replay");
  return {
    mode: "variant",
    versions: REPLAY_VERSIONS,
    datasets: datasets.map((d) => ({
      gameId: d.gameId,
      inputHash: d.inputHash,
      version: d.version,
      releaseManifestSha256: d.release.sha256,
    })),
    ...(jevContaminationProbe === undefined ? {} : { jevContaminationProbe }),
  };
}

/** A replay manifest view, with all events in the runner's single durable log.
 * No second SQLite database or checkpoint is needed. Window/call scopes already
 * bind game, input hash and predictor. */
export function replayRecord(
  record: RecordLog,
  key: string,
  expected: ReplayManifest,
): RecordLog {
  const saved = record.events("replay_manifest", key)[0];
  if (saved && digest(saved.data) !== digest(expected))
    throw Error("Replay manifest mismatch");
  const event = saved ?? record.append("replay_manifest", key, expected);
  return {
    root: record.root,
    events: (kind, scope) =>
      kind === "manifest"
        ? [{ ...event, kind: "manifest" }]
        : record.events(kind, scope),
    append: (kind, scope, data) => record.append(kind, scope, data),
    verify: () => record.verify(),
  };
}

function replayManifest(
  dataset: DecisionDataset,
  config: RunConfig,
  assembler: Assembler,
  predictors: ReplayManifest["predictors"],
): ReplayManifest {
  return {
    schemaVersion: 1,
    kind: "replay-mvp",
    releaseManifestSha256: dataset.release.sha256,
    datasetVersion: dataset.version,
    datasets: [{ gameId: dataset.gameId, inputHash: dataset.inputHash }],
    harness: {
      ...REPLAY_VERSIONS,
      policy: policyHarness(assembler, config.harness.policy?.swapContract),
    },
    predictors,
    codeRevision: config.codeRevision,
    ...(config.replay?.jevContaminationProbe
      ? {
          jevContaminationProbe: config.replay
            .jevContaminationProbe as ReplayManifest["jevContaminationProbe"],
        }
      : {}),
  };
}

export function chronologicalRunner(options: {
  validationSamples?: ValidationSample[];
  root: string;
  config: RunConfig;
  source: SessionSource;
  datasets: DecisionDataset[];
  schedule: { gameId: string; scheduledStart: string }[];
  assembler: Assembler;
  proxy: MeteringProxy;
}) {
  const { root, config, source, datasets, schedule, assembler, proxy } =
    options;
  validateLaunch(config.purpose, assembler.image, config.harness.identity);
  if (
    digest(config.replay?.validationSamples ?? []) !==
    digest(validationSampleDescriptors(options.validationSamples ?? []))
  )
    throw Error("Validation samples differ from run manifest");
  if (
    digest(config.replay?.versions) !== digest(REPLAY_VERSIONS) ||
    config.profile.modelRoles.jev !== "jev-1.14.0"
  )
    throw Error("Replay versions/model role differ from launcher");
  if (
    digest(config.replay?.datasets) !==
    digest(replayDescriptor(datasets).datasets)
  )
    throw Error("Decision datasets differ from run manifest");
  if (
    digest(config.harness.policy) !==
    digest(policyHarness(assembler, config.harness.policy?.swapContract))
  )
    throw Error("Assembler differs from run manifest");
  if (config.replay?.mode !== "variant")
    throw Error("Variant replay mode required");
  source.registerDecisionDatasets?.(datasets);
  const m = manifest(config, schedule);
  const tools = (
    game: Game,
    trusted: { root: string; workspace: string },
    cutoff: string,
  ) =>
    new PolicyTools(
      trusted.root,
      trusted.workspace,
      game,
      m.games,
      assembler,
      datasets.flatMap((d) =>
        d.windows.flatMap((w) =>
          w.state && !w.exclusions.length
            ? [{ gameId: d.gameId, windowId: w.id, state: w.state }]
            : [],
        ),
      ),
      () => cutoff,
      options.validationSamples ?? [],
      config.harness.policy?.swapContract,
    );
  const environment = sessionEnvironment(config, source, {
    policy: (context, trusted) =>
      tools(
        context.game,
        trusted,
        context.phase === "postgame"
          ? context.game.release
          : new Date(Date.parse(context.game.scheduledStart) - 1).toISOString(),
      ),
  });
  const runner = new Runner(
    root,
    m,
    proxy,
    environment,
    undefined,
    async (game, trusted) => {
      const service = tools(
        game,
        { root: trusted.root, workspace: runner.workspace },
        game.release,
      );
      const receipt = service.packages.receipt(game.gameId);
      const dataset = datasets.find((d) => d.gameId === game.gameId)!;
      const predictorId = "variant";
      const record = replayRecord(
        trusted.record,
        game.gameId,
        replayManifest(dataset, config, assembler, {
          variant: {
            id: predictorId,
            policy: policyVersion(
              assembler,
              receipt,
              config.codeRevision,
              config.harness.policy?.swapContract,
            ),
          },
        }),
      );
      const trace = await replayPolicy({
        dataset,
        predictorId,
        record,
        proxy,
        assembler,
        receipt,
        packagePath: join(service.packages.path(game.gameId), "package"),
        // Replay is outside a research session's budget/abort lifetime. Process
        // termination is the cancellation boundary; durable answers support resume.
        signal: new AbortController().signal,
        releaseAt: game.release,
        codeRevision: config.codeRevision,
        swapContract: config.harness.policy?.swapContract,
        ...(!receipt
          ? { invalidPackage: "Pregame ended without a frozen package" }
          : {}),
      });
      if (!trusted.record.events("policy_game_end", game.gameId).length)
        trusted.record.append("policy_game_end", game.gameId, {
          status:
            !receipt ||
            trace.windows.some((w) => w.result.failure === "invalid_package")
              ? "invalid_package"
              : "completed",
          inputHash: dataset.inputHash,
        });
      service.saveFeedback(trace);
    },
  );
  return runner;
}

export async function runBaselines(options: {
  config: RunConfig;
  datasets: DecisionDataset[];
  training: DecisionDataset[];
  priorTraining?: DecisionDataset[];
  schedule: { gameId: string; scheduledStart: string }[];
  record: RecordLog;
  assembler: Assembler;
  proxy: MeteringProxy;
}) {
  const { config, datasets, training, record, assembler, proxy } = options;
  validateLaunch(config.purpose, assembler.image, config.harness.identity);
  if (
    digest(config.replay?.versions) !== digest(REPLAY_VERSIONS) ||
    config.profile.modelRoles.jev !== "jev-1.14.0"
  )
    throw Error("Replay versions/model role differ from launcher");
  if (
    digest(config.replay?.datasets) !==
    digest(replayDescriptor(datasets).datasets)
  )
    throw Error("Baseline datasets differ from run manifest");
  if (config.replay?.mode !== "baselines")
    throw Error("Baseline replay mode required");
  if (
    digest(config.harness.policy) !==
    digest(policyHarness(assembler, config.harness.policy?.swapContract))
  )
    throw Error("Assembler differs from baseline manifest");
  const m = manifest(config, options.schedule);
  const priorTraining = options.priorTraining ?? [];
  const allTraining = [...training, ...priorTraining];
  if (
    new Set(allTraining.map((d) => d.gameId)).size !== allTraining.length ||
    allTraining.some((d) => datasets.some((e) => e.gameId === d.gameId))
  )
    throw Error(
      "Baseline training overlaps evaluation or contains duplicate games",
    );
  if (
    training.some(
      (d) =>
        d.trainingOnly ||
        m.games.some((g) => g.gameId === d.gameId && g.split === "holdout") ||
        ((config.purpose !== "fixture" || m.games.length === 82) &&
          !m.games.some((g) => g.gameId === d.gameId && g.split === "warm-up")),
    )
  )
    throw Error(
      "Baseline training must use warm-up games, never holdout games",
    );
  if (
    priorTraining.some(
      (d) =>
        d.trainingOnly?.season !== "2024-25" ||
        d.trainingOnly.rosterPolicy !== "same-game-box-score-v1" ||
        m.games.some((g) => g.gameId === d.gameId) ||
        !config.profile.dataSources.some(
          (s) =>
            s.type === "pbp-2024-25" && s.manifestSha256 === d.release.sha256,
        ),
    )
  )
    throw Error(
      "Prior training must use the pinned training-only 2024-25 datasets",
    );
  if (
    config.purpose !== "fixture" &&
    (training.length !== 10 || priorTraining.length !== 82)
  )
    throw Error(
      "Baseline training requires ten warm-up and 82 prior-season games",
    );
  if (
    config.harness.policy?.swapContract &&
    digest(config.harness.policy.swapContract) !==
      digest(pinSwapContract(training))
  )
    throw Error("Swap prior differs from warm-up datasets");
  const fitted = config.harness.policy?.swapContract
    ? fitSwapBaselines(training, allTraining)
    : fitBaselines(training, allTraining);
  for (const dataset of datasets) {
    const predictors: ReplayManifest["predictors"] = Object.fromEntries(
      Object.entries(fitted).map(([name, b]) => [
        name,
        { id: b.id, training: b.training, parameters: b.parameters },
      ]),
    );
    predictors.generic = {
      id: "generic-jev",
      policy: policyVersion(
        assembler,
        null,
        config.codeRevision,
        config.harness.policy?.swapContract,
      ),
    };
    const view = replayRecord(
      record,
      dataset.gameId,
      replayManifest(dataset, config, assembler, predictors),
    );
    for (const baseline of Object.values(fitted))
      await replay(dataset, baseline.id, baseline.predict, view);
    await replayPolicy({
      dataset,
      predictorId: "generic-jev",
      record: view,
      proxy,
      assembler,
      receipt: null,
      packagePath: "",
      // Replay is outside a research session's budget/abort lifetime. Process
      // termination is the cancellation boundary; durable answers support resume.
      signal: new AbortController().signal,
      releaseAt: m.games.find((g) => g.gameId === dataset.gameId)!.release,
      codeRevision: config.codeRevision,
      swapContract: config.harness.policy?.swapContract,
    });
  }
}

/** Corpus diagnostics retain the full season for stable split tags, but only load
 * development evaluation inputs (plus warm-up training for baselines). */
export function diagnosticSelection(
  schedule: { gameId: string; scheduledStart: string }[],
  mode: "analyst" | "baselines",
  /** Evaluate only the first `limit` development games (1 to 10). */
  limit = 10,
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10)
    throw Error("Game limit must be 1 to 10 development games");
  if (
    schedule.length !== 82 ||
    new Set(schedule.map((g) => g.gameId)).size !== 82
  )
    throw Error("Corpus diagnostics require the full 82-game season schedule");
  const games = [...schedule].sort(
    (a, b) =>
      Date.parse(a.scheduledStart) - Date.parse(b.scheduledStart) ||
      a.gameId.localeCompare(b.gameId),
  );
  return {
    evaluation: games.slice(0, limit),
    training: mode === "baselines" ? games.slice(10, 20) : [],
  };
}

export function validationSampleDescriptors(samples: ValidationSample[]) {
  return samples.map(({ state, ...sample }) => ({
    ...sample,
    stateHash: digest(state),
  }));
}
