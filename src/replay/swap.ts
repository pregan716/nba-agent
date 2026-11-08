import { rank, uniform, validateAction } from "./contract.js";
import type {
  DecisionDataset,
  ObservableState,
  Validation,
  Prediction,
  ValidatedPrediction,
} from "./types.js";
export const SWAP_CONTRACT = "jev-contract-v2" as const;
export interface CandidateSet {
  out: string[];
  in: string[];
}
export interface SwapContract {
  version: typeof SWAP_CONTRACT | "jev-contract-v3";
  sizePrior: number[];
  training: { gameId: string; inputHash: string }[];
}
export const candidateKey = (c: CandidateSet) =>
  `out:${[...c.out].sort().join(",")}|in:${[...c.in].sort().join(",")}`;
export function candidateReasons(raw: unknown, s: ObservableState): string[] {
  if (!Array.isArray(raw) || (!raw.length && s.eligibleBench.length))
    return ["no_candidates"];
  const reasons = new Set<string>();
  if (raw.length > 8) reasons.add("too_many_candidates");
  const seen = new Set<string>();
  for (const c of raw) {
    if (!c || !Array.isArray(c.out) || !Array.isArray(c.in)) {
      reasons.add("uneven_swap");
      continue;
    }
    if (!c.out.length || c.out.length !== c.in.length)
      reasons.add("uneven_swap");
    if (c.out.length > 5 || c.in.length > 5) reasons.add("oversized_swap");
    if (
      c.out.some(
        (id: unknown) => typeof id !== "string" || !s.celtics.includes(id),
      )
    )
      reasons.add("ineligible_exit");
    if (
      c.in.some(
        (id: unknown) =>
          typeof id !== "string" || !s.eligibleBench.includes(id),
      )
    )
      reasons.add("ineligible_entry");
    if (
      new Set(c.out).size !== c.out.length ||
      new Set(c.in).size !== c.in.length
    )
      reasons.add("repeated_player");
    const key = candidateKey(c);
    if (seen.has(key)) reasons.add("repeated_set");
    seen.add(key);
  }
  return [...reasons];
}
export function pinSwapContract(warmup: DecisionDataset[]): SwapContract {
  if (!warmup.length || warmup.some((d) => d.trainingOnly))
    throw Error("Warm-up datasets required for swap prior");
  const counts = [0, 0, 0, 0, 0];
  for (const d of warmup)
    for (const w of d.windows)
      if (!w.exclusions.length && w.state && w.actual) {
        const k = w.actual.players_out.length;
        if (k > 0 && k <= 5) counts[k - 1]++;
      }
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) throw Error("No warm-up substitutions for swap prior");
  return {
    version: SWAP_CONTRACT,
    sizePrior: counts.map((n) => n / total),
    training: warmup
      .map((d) => ({ gameId: d.gameId, inputHash: d.inputHash }))
      .sort((a, b) => a.gameId.localeCompare(b.gameId)),
  };
}
export function assertSwapContract(c: SwapContract) {
  if (
    ![SWAP_CONTRACT, "jev-contract-v3"].includes(c.version) ||
    c.sizePrior.length !== 5 ||
    c.sizePrior.some((p) => !Number.isFinite(p) || p < 0) ||
    Math.abs(c.sizePrior.reduce((a, b) => a + b, 0) - 1) > 1e-9
  )
    throw Error("Invalid swap size prior");
}
export function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - i + 1)) / i;
  return r;
}
export interface SwapDerived {
  candidates: CandidateSet[];
  normalizedSwap: Record<string, number>;
  listed: Record<string, number>;
  unlistedPerSet: number[];
  exit: Record<string, number>;
  entry: Record<string, number>;
  count: Record<string, number>;
  other_argmax: boolean;
  other_unsupported: boolean;
}
export function expandSwap(
  s: ObservableState,
  candidates: CandidateSet[],
  normalized: Record<string, number>,
  prior: number[],
): SwapDerived {
  const listed = Object.fromEntries(
    candidates.map((c) => [candidateKey(c), normalized[candidateKey(c)] ?? 0]),
  );
  const u = prior.map(
    (_, i) =>
      choose(s.celtics.length, i + 1) * choose(s.eligibleBench.length, i + 1) -
      candidates.filter((c) => c.out.length === i + 1).length,
  );
  const support = u.map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0),
    z = support.reduce((a, i) => a + prior[i], 0);
  const per = prior.map((p, i) =>
    u[i] > 0
      ? ((normalized.other ?? 0) * (z ? p / z : 1 / support.length)) / u[i]
      : 0,
  );
  const unsupported = !support.length && s.eligibleBench.length > 0;
  if (unsupported) {
    const sum = Object.values(listed).reduce((a, b) => a + b, 0);
    for (const key of Object.keys(listed))
      listed[key] = sum ? listed[key] / sum : 1 / candidates.length;
  }
  const inclusion = (id: string, side: "out" | "in") =>
    candidates.reduce(
      (a, c) => a + (c[side].includes(id) ? listed[candidateKey(c)] : 0),
      0,
    ) +
    per.reduce((a, p, i) => {
      const k = i + 1,
        all =
          side === "out"
            ? choose(s.celtics.length - 1, k - 1) *
              choose(s.eligibleBench.length, k)
            : choose(s.celtics.length, k) *
              choose(s.eligibleBench.length - 1, k - 1);
      return (
        a +
        p *
          (all -
            candidates.filter((c) => c.out.length === k && c[side].includes(id))
              .length)
      );
    }, 0);
  return {
    candidates,
    normalizedSwap: normalized,
    listed,
    unlistedPerSet: per,
    exit: Object.fromEntries(s.celtics.map((id) => [id, inclusion(id, "out")])),
    entry: Object.fromEntries(
      s.eligibleBench.map((id) => [id, inclusion(id, "in")]),
    ),
    count: Object.fromEntries(
      prior.map((_, i) => [
        String(i + 1),
        u[i] * per[i] +
          candidates
            .filter((c) => c.out.length === i + 1)
            .reduce((a, c) => a + listed[candidateKey(c)], 0),
      ]),
    ),
    other_argmax: rank(normalized)[0] === "other",
    other_unsupported: unsupported,
  };
}
const object = (v: any) => v && typeof v === "object" && !Array.isArray(v);
const prob = (p: any) =>
  typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1;
export function validateSwap(
  raw: any,
  s: ObservableState,
  contract: SwapContract,
  degenerate = false,
): ValidatedPrediction {
  assertSwapContract(contract);
  const candidates: CandidateSet[] = degenerate ? [] : (raw?.candidates ?? []);
  const invalid = degenerate ? [] : candidateReasons(candidates, s);
  if (invalid.length)
    throw Error(`Invalid recorded candidates: ${invalid.join(",")}`);
  const questions: Record<string, Validation> = {};
  const t = raw?.substitution;
  const tr = !object(t)
    ? ["missing_or_malformed_answer"]
    : t.type !== "noul"
      ? ["wrong_type"]
      : !prob(t.noul)
        ? ["probability_out_of_range"]
        : [];
  questions.substitution = { valid: !tr.length, reasons: tr };
  let normalized: Record<string, number> = {};
  if (s.eligibleBench.length) {
    const keys = [...candidates.map(candidateKey), "other"].sort(),
      a = raw?.swap,
      reasons: string[] = [];
    if (!object(a)) reasons.push("missing_or_malformed_answer");
    else {
      if (a.type !== "choice") reasons.push("wrong_type");
      if (!object(a.probabilities)) reasons.push("missing_probability_map");
      else {
        if (
          JSON.stringify(Object.keys(a.probabilities).sort()) !==
          JSON.stringify(keys)
        )
          reasons.push("option_keys_differ");
        if (!Object.values(a.probabilities).every(prob))
          reasons.push("probability_out_of_range");
        const total = Object.values(a.probabilities).reduce(
          (n: any, p: any) => n + p,
          0,
        ) as number;
        if (
          !Number.isFinite(total) ||
          total <= 0 ||
          Math.abs(total - 1) > 0.05 + 1e-12
        )
          reasons.push("probability_sum");
      }
    }
    questions.swap = { valid: !reasons.length, reasons };
    normalized = degenerate
      ? { other: 1 }
      : reasons.length
        ? uniform(keys)
        : Object.fromEntries(
            keys.map((k) => [
              k,
              a.probabilities[k] /
                (Object.values(a.probabilities).reduce(
                  (n: any, p: any) => n + p,
                  0,
                ) as number),
            ]),
          );
  }
  const derived = expandSwap(s, candidates, normalized, contract.sizePrior);
  const timing = tr.length ? 0.5 : t.noul;
  const winner = rank(derived.listed)[0],
    candidate = candidates.find((c) => candidateKey(c) === winner);
  const action =
    timing < 0.5 || !candidate
      ? { players_out: [], players_in: [] }
      : {
          players_out: [...candidate.out].sort(),
          players_in: [...candidate.in].sort(),
        };
  // Legacy-shaped derived fields keep historic reporting consumers readable; only the two actual questions are validated.
  const answers: Prediction = {
    substitution: { type: "noul", noul: timing },
    count: { type: "score", probabilities: derived.count },
    exit: { type: "choice", probabilities: derived.exit },
    entry: { type: "choice", probabilities: derived.entry },
  };
  return {
    answers,
    questions: questions as ValidatedPrediction["questions"],
    action,
    actionValidation: validateAction(action, s),
    swap: derived,
  };
}
export function combinations<T>(xs: T[], k: number): T[][] {
  if (k === 0) return [[]];
  return xs.flatMap((x, i) =>
    combinations(xs.slice(i + 1), k - 1).map((rest) => [x, ...rest]),
  );
}
