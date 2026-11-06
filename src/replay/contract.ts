import {
  COUNT_KEYS,
  type Action,
  type ObservableState,
  type Prediction,
  type Question,
  type ValidatedPrediction,
  type Validation,
} from "./types.js";
export const uniform = (keys: readonly string[]): Record<string, number> =>
  Object.fromEntries(keys.map((k) => [k, 1 / keys.length]));
export function optionKeys(state: ObservableState) {
  return {
    count: [...COUNT_KEYS],
    exit: [...state.celtics].sort(),
    entry: [...state.eligibleBench].sort(),
  };
}
export function rank(map: Record<string, number>): string[] {
  return Object.keys(map).sort(
    (a, b) => map[b] - map[a] || a.localeCompare(b, "en"),
  );
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const probability = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
export function validateAction(
  action: Action,
  state: ObservableState,
): Validation {
  const reasons: string[] = [];
  if (!Array.isArray(action?.players_out) || !Array.isArray(action?.players_in))
    return { valid: false, reasons: ["malformed_action"] };
  const outs = action.players_out,
    ins = action.players_in;
  if (outs.length !== ins.length) reasons.push("uneven_swap");
  if (new Set(outs).size !== outs.length || new Set(ins).size !== ins.length)
    reasons.push("duplicate_player");
  if (outs.some((p) => !state.celtics.includes(p)))
    reasons.push("ineligible_exit");
  if (ins.some((p) => !state.eligibleBench.includes(p)))
    reasons.push("ineligible_entry");
  const five = [...state.celtics.filter((p) => !outs.includes(p)), ...ins];
  if (five.length !== 5 || new Set(five).size !== 5)
    reasons.push("illegal_five");
  return { valid: reasons.length === 0, reasons };
}
export function validatePrediction(
  raw: unknown,
  state: ObservableState,
): ValidatedPrediction {
  const keys = optionKeys(state);
  const answers: Prediction = {
    substitution: { type: "noul", noul: 0.5 },
    count: { type: "score", probabilities: uniform(keys.count) },
    exit: { type: "choice", probabilities: uniform(keys.exit) },
    entry: { type: "choice", probabilities: uniform(keys.entry) },
  };
  const questions = {} as Record<Question, Validation>;
  for (const q of ["substitution", "count", "exit", "entry"] as const) {
    const value = object(raw) ? raw[q] : undefined,
      reasons: string[] = [];
    if (!object(value)) reasons.push("missing_or_malformed_answer");
    else {
      if (value.type !== answers[q].type) reasons.push("wrong_type");
      if (q === "substitution") {
        if (!probability(value.noul)) reasons.push("probability_out_of_range");
      } else if (!object(value.probabilities))
        reasons.push("missing_probability_map");
      else {
        if (
          JSON.stringify(Object.keys(value.probabilities).sort()) !==
          JSON.stringify([...keys[q]].sort())
        )
          reasons.push("option_keys_differ");
        if (!Object.values(value.probabilities).every(probability))
          reasons.push("probability_out_of_range");
      }
    }
    questions[q] = { valid: reasons.length === 0, reasons };
    // Project the answer; never mutate, fill missing keys, or carry extra raw fields.
    if (!reasons.length && object(value)) {
      if (q === "substitution")
        answers.substitution.noul = value.noul as number;
      else
        answers[q].probabilities = Object.fromEntries(
          keys[q].map((k) => [
            k,
            (value.probabilities as Record<string, number>)[k],
          ]),
        );
    }
  }
  const level = [...COUNT_KEYS].sort(
    (a, b) =>
      answers.count.probabilities[b] - answers.count.probabilities[a] ||
      COUNT_KEYS.indexOf(a) - COUNT_KEYS.indexOf(b),
  )[0];
  const k = { none: 1, one: 1, two: 2, three_or_more: 3 }[level];
  const action =
    answers.substitution.noul < 0.5
      ? { players_out: [], players_in: [] }
      : {
          players_out: rank(answers.exit.probabilities).slice(0, k),
          players_in: rank(answers.entry.probabilities).slice(0, k),
        };
  return {
    answers,
    questions,
    action,
    actionValidation: validateAction(action, state),
  };
}
