import type { RecordLog } from "../runner/record.js";
import { digest } from "../runner/config.js";
import { scoreWindow, summarize } from "./scoring.js";
import { REPLAY_VERSIONS } from "./types.js";
import type {
  DecisionDataset,
  Failure,
  ObservableState,
  WindowResult,
} from "./types.js";
export type Predictor = (state: ObservableState) => unknown | Promise<unknown>;
export interface ReplayManifest {
  schemaVersion: 1;
  kind: "replay-mvp";
  releaseManifestSha256: string;
  datasetVersion: string;
  datasets: { gameId: string; inputHash: string }[];
  harness: typeof REPLAY_VERSIONS & {
    policy?: ReturnType<typeof import("../policy/replay.js").policyHarness>;
  };
  predictors: Record<string, { id: string; [key: string]: unknown }>;
  codeRevision: string;
  jevContaminationProbe?: Awaited<
    ReturnType<typeof import("../policy/probe.js").probeJev>
  >;
}
export class PredictorFailure extends Error {
  constructor(
    readonly kind: Failure,
    message: string,
  ) {
    super(message);
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export async function replay(
  dataset: DecisionDataset,
  predictorId: string,
  predict: Predictor,
  record: RecordLog,
): Promise<WindowResult[]> {
  if (dataset.trainingOnly)
    throw Error("Training-only roster cannot be replayed for evaluation");
  const manifest = record.events("manifest")[0].data as ReplayManifest;
  const { policy: _policy, ...baseHarness } = manifest.harness;
  if (
    digest(baseHarness) !== digest(REPLAY_VERSIONS) ||
    !Object.values(manifest.predictors).some((p) => p.id === predictorId)
  )
    throw Error("Predictor or harness absent from replay manifest");
  if (
    manifest.releaseManifestSha256 !== dataset.release.sha256 ||
    manifest.datasetVersion !== dataset.version ||
    !manifest.datasets.some(
      (d) => d.gameId === dataset.gameId && d.inputHash === dataset.inputHash,
    )
  )
    throw Error("Dataset absent from replay manifest");
  const scope = `${dataset.gameId}:${dataset.inputHash}:${predictorId}`,
    saved = record.events("replay_window", scope);
  const results: WindowResult[] = [];
  let packageInvalid = saved.some(
    (e) => e.data.result.failure === "invalid_package",
  );
  let attempted = saved.some(
    (e) => e.data.result.validation || e.data.result.failure,
  );
  for (const window of dataset.windows) {
    const previous = saved.find((e) => e.data.result.window.id === window.id);
    if (previous) {
      if (digest(previous.data.result.window) !== digest(window))
        throw Error("Replay window mismatch");
      results.push(previous.data.result);
      continue;
    }
    let raw: unknown = null,
      failure: Failure | null = null;
    if (packageInvalid) failure = "invalid_package";
    else if (!window.exclusions.length && window.state && window.actual)
      try {
        raw = await predict(freeze(structuredClone(window.state)));
      } catch (e) {
        if (!(e instanceof PredictorFailure)) throw e;
        if (e.kind === "invalid_package" && attempted)
          throw Error(
            "invalid_package must be determined on the first eligible window",
          );
        failure = e.kind;
        packageInvalid = e.kind === "invalid_package";
      }
    if (!window.exclusions.length && window.state && window.actual)
      attempted = true;
    const result = scoreWindow(window, raw, failure);
    results.push(result);
    record.append("replay_window", scope, {
      releaseManifestSha256: dataset.release.sha256,
      datasetVersion: dataset.version,
      result,
    });
  }
  if (!record.events("replay_summary", scope).length) {
    record.append("replay_ledger", scope, {
      releaseManifestSha256: dataset.release.sha256,
      datasetVersion: dataset.version,
      entries: dataset.ledger,
    });
    record.append("replay_summary", scope, {
      releaseManifestSha256: dataset.release.sha256,
      datasetVersion: dataset.version,
      summary: summarize(results),
    });
  }
  record.verify();
  return results;
}
