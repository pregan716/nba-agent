import { z } from "zod";
import { canonicalJson } from "../env/tools.js";
import { COUNT_KEYS, type ObservableState } from "../replay/types.js";
import { optionKeys } from "../replay/contract.js";
export const JEV_MODEL = "jev-1.14.0";
export const JEV_SETTINGS = {
  model: JEV_MODEL,
  inputUsdPerMillion: 0.042,
  retries: 1,
  perQuestionTokens: 32000,
  contextGuard: "utf8-bytes-plus-1024-v1",
  requestTokens: 64000,
  answerMapping: "score-index-v1",
} as const;
const strings = z.record(z.string(), z.string());
export const assemblySchema = z.strictObject({
  jev_state: z.string(),
  instructions: z.strictObject({
    substitution: z.string(),
    count: z.string(),
    exit: z.string(),
    entry: z.string(),
  }),
  criteria: z.strictObject({
    substitution: z.strictObject({ true: z.string(), false: z.string() }),
    count: strings,
    exit: strings,
    entry: strings,
  }),
  diagnostics: z.record(z.string(), z.json()),
});
export type Assembly = z.infer<typeof assemblySchema>;
export interface JevQuestion {
  type: "noul" | "choice" | "score";
  instructions: string;
  criteria: Record<string, string> | string[];
}
export interface JevRequest {
  model: typeof JEV_MODEL;
  state: string;
  questions: Record<string, JevQuestion>;
}
/** Conservative preflight until TypeSafe publishes its tokenizer. No chars/4 estimate. */
export function contextGuard(request: JevRequest) {
  for (const q of Object.values(request.questions))
    if (
      Buffer.byteLength(canonicalJson({ state: request.state, question: q })) +
        1024 >
      JEV_SETTINGS.perQuestionTokens
    )
      throw Error("Per-question context upper bound exceeds 32000 tokens");
  if (
    Buffer.byteLength(canonicalJson(request)) + 4096 >
    JEV_SETTINGS.requestTokens
  )
    throw Error("Request context upper bound exceeds 64000 tokens");
}
export function buildJevRequest(
  raw: unknown,
  state: ObservableState,
): JevRequest {
  const a = assemblySchema.parse(raw),
    keys = optionKeys(state);
  for (const q of ["count", "exit", "entry"] as const) {
    if (
      JSON.stringify(Object.keys(a.criteria[q]).sort()) !==
      JSON.stringify([...keys[q]].sort())
    )
      throw Error(`Assembler ${q} criteria keys differ`);
    if (q !== "count" && (keys[q].length < 1 || keys[q].length > 255))
      throw Error(`Unsupported ${q} option count`);
  }
  const request: JevRequest = {
    model: JEV_MODEL,
    state: a.jev_state,
    questions: {
      substitution: {
        type: "noul",
        instructions: a.instructions.substitution,
        criteria: a.criteria.substitution,
      },
      count: {
        type: "score",
        instructions: a.instructions.count,
        criteria: COUNT_KEYS.map((k) => a.criteria.count[k]),
      },
      exit: {
        type: "choice",
        instructions: a.instructions.exit,
        criteria: a.criteria.exit,
      },
      entry: {
        type: "choice",
        instructions: a.instructions.entry,
        criteria: a.criteria.entry,
      },
    },
  };
  contextGuard(request);
  return JSON.parse(canonicalJson(request));
}
/** Only translate the API's documented numeric score keys; never fill missing keys. */
export function mapJevAnswers(answers: any): unknown {
  if (!answers || typeof answers !== "object" || Array.isArray(answers))
    return answers;
  const mapped = structuredClone(answers),
    p = mapped.count?.probabilities;
  if (p && typeof p === "object" && !Array.isArray(p)) {
    // Unknown keys remain unknown, even if they look like one of our semantic keys.
    mapped.count.probabilities = Object.fromEntries(
      Object.entries(p).map(([k, v]) => [
        /^[0-3]$/.test(k) ? COUNT_KEYS[Number(k)] : `unexpected:${k}`,
        v,
      ]),
    );
  }
  return mapped;
}
export function genericAssembly(state: ObservableState): Assembly {
  return {
    jev_state: canonicalJson(state),
    instructions: {
      substitution:
        "Will the Boston Celtics coach substitute at this window? Predict actual coaching behavior.",
      count: "How many Celtics players will be replaced at this window?",
      exit: "Conditional on a substitution, which on-court Celtics player will exit?",
      entry:
        "Conditional on a substitution, which eligible Celtics bench player will enter?",
    },
    criteria: {
      substitution: {
        true: "At least one Celtics player is replaced.",
        false: "No Celtics substitution.",
      },
      count: {
        none: "No players replaced",
        one: "One player replaced",
        two: "Two players replaced",
        three_or_more: "Three or more players replaced",
      },
      exit: Object.fromEntries(
        state.celtics.map((p) => [p, `Celtics player ${p} exits`]),
      ),
      entry: Object.fromEntries(
        state.eligibleBench.map((p) => [p, `Celtics player ${p} enters`]),
      ),
    },
    diagnostics: { baseline: "generic-jev-v1" },
  };
}
