import {
  CODE_CONTRACT,
  deferSchema,
  type CodeAnswers,
} from "../replay/code-prediction.js";
import { codeAssemblySchema, buildCodeRequest } from "./request.js";
import { type SwapContract } from "../replay/swap.js";
import {
  swapAssemblySchema,
  buildSwapRequest,
  genericSwapAssembly,
} from "./request.js";
import { ZodError } from "zod";
import { PackageExecutionError } from "./errors.js";
import { JevHttpError } from "../runner/jev.js";
import {
  mkdirSync,
  readFileSync,
  existsSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalJson } from "../env/tools.js";
import { digest } from "../runner/config.js";
import type { RecordLog } from "../runner/record.js";
import type { MeteringProxy } from "../runner/proxy.js";
import {
  replay,
  PredictorFailure,
  type ReplayManifest,
} from "../replay/run.js";
import {
  REPLAY_VERSIONS,
  type DecisionDataset,
  type ObservableState,
} from "../replay/types.js";
import { summarizeRecordedEstimates } from "../replay/estimates.js";
import { summarize } from "../replay/scoring.js";
import type { Assembler } from "./sandbox.js";
import { packageFiles, type PackageReceipt } from "./package.js";
import { sha256 } from "../data/store.js";
import {
  assemblySchema,
  buildJevRequest,
  genericAssembly,
  JEV_SETTINGS,
  mapJevAnswers,
} from "./request.js";
export function policyHarness(
  assembler: Assembler,
  swapContract?: SwapContract,
) {
  return {
    api: "assemble-v1",
    ...(swapContract ? { swapContract } : {}),
    assemblerImage: assembler.image,
    limits: assembler.limits,
    jev: JEV_SETTINGS,
    determinism: "double-run-and-content-cache-v1",
  } as const;
}
export function policyVersion(
  assembler: Assembler,
  receipt: PackageReceipt | null,
  codeRevision: string,
  swapContract?: SwapContract,
) {
  return {
    api: "assemble-v1",
    ...(swapContract ? { swapContract } : {}),
    replay: REPLAY_VERSIONS,
    image: assembler.image,
    limits: assembler.limits,
    jev: JEV_SETTINGS,
    package: receipt,
    codeRevision,
    baseline: receipt ? null : "generic-jev-v1",
    determinism: "double-run-and-content-cache-v1",
  };
}
/** Cache only validated, byte-identical double executions; identity binds package, state and image. */
export async function assembleRequest(
  assembler: Assembler,
  path: string,
  receipt: PackageReceipt,
  state: ObservableState,
  cache: string,
  signal: AbortSignal,
  // Validation returns oversized drafts with a guard error; replay stays guarded.
  validationOnly = false,
  swapContract?: SwapContract,
) {
  const hashes = Object.fromEntries(
    [...packageFiles(path).files].map(([k, v]) => [k, sha256(v)]),
  );
  if (canonicalJson(hashes) !== canonicalJson(receipt.files))
    throw Error("Frozen package changed");
  const identity = {
    package: receipt.packageHash,
    state,
    image: assembler.image,
    limits: assembler.limits,
    api: "assemble-v1",
    ...(swapContract ? { swapContract } : {}),
    ...(validationOnly ? { validationOnly: true } : {}),
  };
  const key = digest(canonicalJson(identity)),
    target = join(cache, key + ".json");
  if (existsSync(target)) {
    const saved = JSON.parse(readFileSync(target, "utf8"));
    if (
      digest(canonicalJson(saved.identity)) !== key ||
      digest(canonicalJson(saved.result)) !== saved.resultHash
    )
      throw Error("Assembly cache integrity mismatch");
    return { ...saved.result, computeSeconds: 0, cacheHit: true };
  }
  const deadline = AbortSignal.any([
    signal,
    AbortSignal.timeout(Math.ceil(assembler.limits.wallSeconds * 1000)),
  ]);
  const execute = async () => {
    try {
      return await assembler.run(path, state, deadline);
    } catch (error) {
      signal.throwIfAborted();
      if (deadline.aborted)
        throw new PackageExecutionError("Assembler wall-clock limit");
      throw error;
    }
  };
  const a = await execute(),
    b = await execute();
  signal.throwIfAborted();
  const code = swapContract?.version === CODE_CONTRACT;
  const schema = code
    ? codeAssemblySchema
    : swapContract
      ? swapAssemblySchema
      : assemblySchema;
  const assembly = schema.parse(a.value);
  if (canonicalJson(assembly) !== canonicalJson(schema.parse(b.value)))
    throw new PackageExecutionError("Nondeterministic assembler output");
  if (code && !deferSchema.safeParse((assembly as any).defer).success)
    throw new PackageExecutionError("malformed_defer", true);
  const result = {
    assembly,
    request: (code
      ? buildCodeRequest
      : swapContract
        ? buildSwapRequest
        : buildJevRequest)(assembly, state, !validationOnly),
  };
  mkdirSync(cache, { recursive: true });
  const temporary = target + "." + randomUUID();
  writeFileSync(
    temporary,
    canonicalJson({
      identity,
      result,
      resultHash: digest(canonicalJson(result)),
    }),
    { mode: 0o600, flush: true },
  );
  renameSync(temporary, target);
  return {
    ...result,
    computeSeconds: a.computeSeconds + b.computeSeconds,
    cacheHit: false,
  };
}
export async function replayPolicy(options: {
  dataset: DecisionDataset;
  predictorId: string;
  record: RecordLog;
  proxy: MeteringProxy;
  assembler: Assembler;
  receipt: PackageReceipt | null;
  packagePath: string;
  signal: AbortSignal;
  releaseAt: string;
  codeRevision: string;
  invalidPackage?: string;
  swapContract?: SwapContract;
}) {
  const { dataset, record, proxy, assembler, receipt, predictorId, signal } =
    options;
  signal.throwIfAborted();
  const version = policyVersion(
    assembler,
    receipt,
    options.codeRevision,
    options.swapContract,
  );
  const manifest = record.events("manifest")[0].data;
  if (
    canonicalJson(manifest.harness.policy) !==
    canonicalJson(policyHarness(assembler, options.swapContract))
  )
    throw Error("Assembler harness mismatch");
  const configured = manifest.predictors;
  if (
    !Object.values(configured).some(
      (p: any) => p.id === predictorId && digest(p.policy) === digest(version),
    )
  )
    throw Error("Policy absent from replay manifest");
  const scope = `${dataset.gameId}:${dataset.inputHash}:${predictorId}`;
  const results = await replay(
    dataset,
    predictorId,
    async (state) => {
      signal.throwIfAborted();
      const callScope = scope + ":" + digest(state);
      const saved = record.events("policy_prediction", callScope).at(-1);
      if (saved) {
        if (saved.data.failure)
          throw new PredictorFailure(saved.data.failure, saved.data.message);
        return saved.data.answers;
      }
      if (options.invalidPackage) {
        record.append("policy_prediction", callScope, {
          failure: "invalid_package",
          message: options.invalidPackage,
        });
        throw new PredictorFailure("invalid_package", options.invalidPackage);
      }
      let assembled: any;
      const attempted = record
        .events("policy_attempt", scope)
        .some((e) => e.data.callScope !== callScope);
      record.append("policy_attempt", scope, {
        callScope,
        stateHash: digest(state),
      });
      try {
        assembled = receipt
          ? await assembleRequest(
              assembler,
              options.packagePath,
              receipt,
              state,
              join(record.root, "assembly-cache"),
              signal,
              false,
              options.swapContract,
            )
          : {
              assembly: options.swapContract
                ? genericSwapAssembly(state)
                : genericAssembly(state),
              request: options.swapContract
                ? buildSwapRequest(genericSwapAssembly(state), state)
                : buildJevRequest(genericAssembly(state), state),
              computeSeconds: 0,
              cacheHit: false,
            };
        record.append("policy_assembly", callScope, assembled);
      } catch (error) {
        signal.throwIfAborted();
        if (
          !(error instanceof PackageExecutionError) &&
          !(error instanceof ZodError)
        )
          throw error;
        const failure =
          attempted ||
          (error instanceof PackageExecutionError && error.windowOnly)
            ? "assembler_error"
            : "invalid_package";
        const message =
          error instanceof Error ? error.message : "Assembler failed";
        record.append("policy_prediction", callScope, { failure, message });
        throw new PredictorFailure(failure, message);
      }
      const code = options.swapContract?.version === CODE_CONTRACT;
      const envelope = (
        shadow: unknown,
        shadowFailure: string | null,
      ): CodeAnswers => ({
        contract: CODE_CONTRACT,
        prediction: receipt
          ? (assembled.assembly.prediction ?? null)
          : {
              substitution: { type: "noul", noul: 0.5 },
              ...(state.eligibleBench.length
                ? {
                    swap: {
                      type: "choice",
                      probabilities: Object.fromEntries(
                        Object.keys(assembled.assembly.criteria.swap).map(
                          (k, _, a) => [k, 1 / a.length],
                        ),
                      ),
                    },
                  }
                : {}),
            },
        candidates: assembled.assembly.candidates,
        defer: receipt
          ? (deferSchema.parse(assembled.assembly.defer) ?? null)
          : { reason: "generic Jev baseline" },
        shadow: shadow ?? null,
        shadowFailure: shadowFailure ? "provider_failure" : null,
        shadowError: shadowFailure,
      });
      try {
        // Resume a received response after a crash before its scoring record was written.
        const received = record.events("jev_response", callScope).at(-1)?.data;
        const response =
          received?.modelValid && received?.usageValid
            ? received
            : await proxy.jev(assembled.request, record, callScope, signal);
        signal.throwIfAborted();
        const mapped = mapJevAnswers(response.response?.answers);
        const answers = options.swapContract
          ? {
              substitution: (mapped as any)?.substitution,
              swap: (mapped as any)?.swap,
              candidates: assembled.assembly.candidates,
            }
          : mapped;
        const scored = code ? envelope(mapped, null) : answers;
        record.append("policy_prediction", callScope, {
          answers: scored ?? null,
          failure: null,
        });
        return scored;
      } catch (error) {
        signal.throwIfAborted();
        const message =
          error instanceof Error ? error.message : "Provider failed";
        const failure =
          error instanceof JevHttpError &&
          error.status === 400 &&
          JSON.stringify(error.detail).includes("max_tokens_exceeded")
            ? "assembler_error"
            : "provider_failure";
        if (code && failure === "provider_failure") {
          const answers = envelope(null, message);
          record.append("policy_prediction", callScope, {
            answers,
            failure: null,
          });
          return answers;
        }
        record.append("policy_prediction", callScope, { failure, message });
        throw new PredictorFailure(failure, message);
      }
    },
    record,
  );
  signal.throwIfAborted();
  const windows = results.map((result) => {
    const callScope = scope + ":" + digest(result.window.state);
    return {
      result,
      assembly:
        record.events("policy_assembly", callScope).at(-1)?.data ?? null,
      jev: record.events("jev_response", callScope).map((e) => e.data),
      errors: record.events("jev_error", callScope).map((e) => e.data),
    };
  });
  const responses = windows.flatMap((w) => w.jev);
  const trace = {
    gameId: dataset.gameId,
    celticsHome: dataset.celticsHome ?? null,
    datasetVersion: dataset.version,
    inputHash: dataset.inputHash,
    releaseAt: options.releaseAt,
    package: receipt,
    policy: version,
    windows,
    summary: {
      ...summarize(results),
      ...summarizeRecordedEstimates(results, scope, record),
    },
    usage: {
      input_tokens: responses.reduce(
        (n, r) => n + (r.usage?.input_tokens ?? 0),
        0,
      ),
      output_tokens: responses.reduce(
        (n, r) => n + (r.usage?.output_tokens ?? 0),
        0,
      ),
      usd: responses.reduce((n, r) => n + (r.usd ?? 0), 0),
      latencyMs: responses.reduce((n, r) => n + r.latencyMs, 0),
    },
  };
  if (!record.events("policy_trace", scope).length)
    record.append("policy_trace", scope, trace);
  return trace;
}
export type PolicyTrace = Awaited<ReturnType<typeof replayPolicy>>;
