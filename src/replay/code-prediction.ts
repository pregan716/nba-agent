import { z } from "zod";
import { validateSwap, type SwapContract } from "./swap.js";
import { scoreWindow } from "./scoring.js";
import type { Window, WindowResult, Scores, ObservableState } from "./types.js";

export const CODE_CONTRACT = "jev-contract-v3" as const;
export const deferSchema = z
  .strictObject({ reason: z.string().trim().min(1).max(1000) })
  .nullable()
  .optional();
/** Trusted runner envelope, never accepted from an assembler or provider. */
export interface CodeAnswers {
  contract: typeof CODE_CONTRACT;
  prediction: unknown;
  candidates: unknown;
  defer: { reason: string } | null;
  shadow: unknown;
  shadowFailure: string | null;
  shadowError?: string | null;
}
export interface CodeResult {
  source: "package" | "jev";
  defer: CodeAnswers["defer"];
  invalidPrediction: boolean;
  shadowFailure: string | null;
  package: Omit<WindowResult, "window" | "code">;
  jev: Omit<WindowResult, "window" | "code">;
  regret: {
    timing: number;
    setLogLoss: number | null;
    exit: number | null;
    entry: number | null;
  } | null;
}
export function packageAnswer(prediction: unknown, candidates: unknown) {
  const p = prediction as any;
  return {
    substitution: p?.substitution ?? null,
    swap: p?.swap ?? null,
    candidates,
  };
}
export function validCodePrediction(
  prediction: unknown,
  candidates: unknown,
  state: ObservableState,
  contract: SwapContract,
) {
  const v = validateSwap(
    packageAnswer(prediction, candidates),
    state,
    contract,
  );
  return Object.values(v.questions).every((q) => q.valid);
}
export function scoreCodeWindow(
  window: Window,
  raw: CodeAnswers,
  contract: SwapContract,
): WindowResult {
  const v2 = { ...contract, version: "jev-contract-v2" as const };
  const invalid = !validCodePrediction(
    raw.prediction,
    raw.candidates,
    window.state!,
    contract,
  );
  const pkg = scoreWindow(
    window,
    packageAnswer(raw.prediction, raw.candidates),
    invalid ? "assembler_error" : null,
    v2,
  );
  const jev = scoreWindow(
    window,
    packageAnswer(raw.shadow, raw.candidates),
    raw.shadowFailure ? "provider_failure" : null,
    v2,
  );
  const chosen = raw.defer ? jev : pkg,
    alternative = raw.defer ? pkg : jev;
  const trim = ({ window: _w, code: _c, ...r }: WindowResult) => r;
  const diff = (key: "timing" | "setLogLoss" | "exit" | "entry") => {
    const a = chosen.scores?.[key],
      b = alternative.scores?.[key];
    return typeof a === "number" && typeof b === "number" ? a - b : null;
  };
  return {
    ...chosen,
    raw,
    contractVersion: CODE_CONTRACT,
    code: {
      source: raw.defer ? "jev" : "package",
      defer: raw.defer,
      invalidPrediction: invalid,
      shadowFailure: raw.shadowFailure
        ? raw.defer
          ? "provider_failure"
          : "shadow_provider_failure"
        : null,
      package: trim(pkg),
      jev: trim(jev),
      regret:
        chosen.scores && alternative.scores
          ? {
              timing: diff("timing")!,
              setLogLoss: diff("setLogLoss"),
              exit: diff("exit"),
              entry: diff("entry"),
            }
          : null,
    },
  };
}
/** Pair each counterfactual with the primary on the same windows. Raw package
 * scores are still retained in the trace when a deferred provider call fails. */
export function codeSummary(rows: WindowResult[]) {
  if (
    !rows.some(
      (r) => r.code || (r.contractVersion === CODE_CONTRACT && r.failure),
    )
  )
    return undefined;
  const eligible = rows.filter(
    (r) => !r.window.exclusions.length && r.window.state && r.window.actual,
  );
  const primary = eligible.filter((r) => r.scores);
  const tally = (values: string[]) =>
    Object.fromEntries(
      [...new Set(values)]
        .sort()
        .map((k) => [k, values.filter((v) => v === k).length]),
    );
  const metricKeys = ["timing", "setLogLoss", "exit", "entry"] as const;
  const averages = (values: (Scores | CodeResult["regret"])[]) =>
    Object.fromEntries(
      metricKeys.map((k) => {
        const ns = values.flatMap((v) =>
          typeof v?.[k] === "number" ? [v[k] as number] : [],
        );
        return [
          k,
          {
            n: ns.length,
            mean: ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : null,
          },
        ];
      }),
    );
  const missing = (r: WindowResult) =>
    r.code?.shadowFailure ??
    r.failure ??
    (r.window.exclusions.length ? "excluded_window" : "unavailable_answer");
  const paired = (which: "package" | "jev") => {
    const included = eligible.filter((r) => r.scores && r.code?.[which].scores);
    return {
      n: included.length,
      primaryN: primary.length,
      excluded: tally(
        eligible.filter((r) => !included.includes(r)).map(missing),
      ),
      primary: averages(included.map((r) => r.scores)),
      alternative: averages(included.map((r) => r.code![which].scores)),
    };
  };
  const regretRows = eligible.filter((r) => r.code?.regret);
  const shadowFailed = eligible.filter(
    (r) => r.code?.shadowFailure && !r.code.defer,
  ).length;
  const missingShadow = eligible.filter((r) => !r.code?.jev.scores).length;
  return {
    primaryN: primary.length,
    eligibleN: eligible.length,
    invalidPrediction: eligible.filter((r) => r.code?.invalidPrediction).length,
    deferred: tally(
      eligible
        .filter((r) => r.code?.defer)
        .map((r) => r.window.state!.stoppage.kind),
    ),
    shadowProviderFailures: shadowFailed,
    shadowProviderFailureRate: eligible.length
      ? shadowFailed / eligible.length
      : null,
    missingShadow,
    counterfactualFlag:
      eligible.length > 0 && missingShadow / eligible.length > 0.05,
    packageOnly: paired("package"),
    jevOnly: paired("jev"),
    regret: {
      n: regretRows.length,
      primaryN: primary.length,
      excluded: tally(eligible.filter((r) => !r.code?.regret).map(missing)),
      metrics: averages(regretRows.map((r) => r.code!.regret)),
    },
  };
}
