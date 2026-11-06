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
import { PolicyTools } from "../policy/tools.js";
import {
  policyHarness,
  policyVersion,
  replayPolicy,
} from "../policy/replay.js";
import { replay, type ReplayManifest } from "../replay/run.js";
import { fitBaselines } from "../replay/baselines.js";
import { REPLAY_VERSIONS, type DecisionDataset } from "../replay/types.js";

/** Until R5b provides and wires approved v3 prompts, no experimental run starts. */
export function validateLaunch(
  purpose: RunConfig["purpose"],
  assemblerImage: string,
) {
  if (purpose === "scored" && assemblerImage.startsWith("local@"))
    throw Error(
      "Scored runs require a published assembler digest; local@ is refused",
    );
  if (purpose !== "fixture")
    throw Error(
      "Pilot/scored runs require a v3 prompt set and memory instructions from R5b; only fixture runs are available",
    );
}

export function replayDescriptor(
  datasets: DecisionDataset[],
  jevContaminationProbe?: unknown,
): NonNullable<RunConfig["replay"]> {
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
    harness: { ...REPLAY_VERSIONS, policy: policyHarness(assembler) },
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
  validateLaunch(config.purpose, assembler.image);
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
  if (digest(config.harness.policy) !== digest(policyHarness(assembler)))
    throw Error("Assembler differs from run manifest");
  if (config.replay?.mode !== "variant")
    throw Error("Variant replay mode required");
  const m = manifest(config, schedule);
  if (m.games.some((g) => !datasets.some((d) => d.gameId === g.gameId)))
    throw Error("Missing game dataset");
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
            ? [{ gameId: d.gameId, state: w.state }]
            : [],
        ),
      ),
      () => cutoff,
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
            policy: policyVersion(assembler, receipt, config.codeRevision),
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
        signal: new AbortController().signal,
        releaseAt: game.release,
        codeRevision: config.codeRevision,
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
  schedule: { gameId: string; scheduledStart: string }[];
  record: RecordLog;
  assembler: Assembler;
  proxy: MeteringProxy;
}) {
  const { config, datasets, training, record, assembler, proxy } = options;
  validateLaunch(config.purpose, assembler.image);
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
  if (digest(config.harness.policy) !== digest(policyHarness(assembler)))
    throw Error("Assembler differs from baseline manifest");
  const fitted = fitBaselines(training);
  const m = manifest(config, options.schedule);
  for (const dataset of datasets) {
    const predictors: ReplayManifest["predictors"] = Object.fromEntries(
      Object.entries(fitted).map(([name, b]) => [
        name,
        { id: b.id, training: b.training, parameters: b.parameters },
      ]),
    );
    predictors.generic = {
      id: "generic-jev",
      policy: policyVersion(assembler, null, config.codeRevision),
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
      signal: new AbortController().signal,
      releaseAt: m.games.find((g) => g.gameId === dataset.gameId)!.release,
      codeRevision: config.codeRevision,
    });
  }
}
