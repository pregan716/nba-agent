import type { MeteringProxy } from "../runner/proxy.js";
import type { RecordStore } from "../runner/record.js";
import { JEV_MODEL, type JevRequest } from "./request.js";
export interface ProbeFact {
  id: string;
  question: string;
  truth: boolean;
  source: string;
  /** Optional reporting group, e.g. `result:2025-26`. Never sent to Jev. */
  group?: string;
}
/** Truth and provenance remain outside the request. No evidence, tools or coaching state. */
export async function probeJev(
  facts: ProbeFact[],
  proxy: MeteringProxy,
  record: RecordStore<any>,
  signal: AbortSignal,
  /** Record scope; distinct per request when a probe is sent in batches. */
  scope = "jev-contamination-probe",
) {
  if (!facts.length || new Set(facts.map((f) => f.id)).size !== facts.length)
    throw Error("Invalid Jev probe facts");
  const request: JevRequest = {
    model: JEV_MODEL,
    state: "",
    questions: Object.fromEntries(
      facts.map((f) => [
        f.id,
        {
          type: "noul",
          instructions: f.question,
          criteria: {
            true: "The statement is true.",
            false: "The statement is false.",
          },
        },
      ]),
    ),
  };
  const response = await proxy.jev(request, record, scope, signal);
  const answers = response.response?.answers;
  const results = facts.map((f) => {
    const a = answers?.[f.id],
      p = a?.noul;
    const valid =
      a?.type === "noul" &&
      typeof p === "number" &&
      Number.isFinite(p) &&
      p >= 0 &&
      p <= 1;
    return {
      ...f,
      probability: valid ? p : null,
      correct: valid ? p >= 0.5 === f.truth : null,
      brier: valid ? (p - Number(f.truth)) ** 2 : null,
    };
  });
  const valid = results.filter((r) => r.probability !== null);
  const truthMean = (truth: boolean) => {
    const rows = valid.filter((r) => r.truth === truth);
    return rows.length
      ? rows.reduce((n, r) => n + r.probability!, 0) / rows.length
      : null;
  };
  const yes = truthMean(true),
    no = truthMean(false);
  const result = {
    model: JEV_MODEL,
    request,
    response,
    results,
    valid: valid.length,
    invalid: results.length - valid.length,
    accuracy: valid.length
      ? valid.filter((r) => r.correct).length / valid.length
      : null,
    chanceAccuracy: 0.5,
    brier: valid.length
      ? valid.reduce((n, r) => n + r.brier!, 0) / valid.length
      : null,
    chanceBrier: 0.25,
    discrimination: yes !== null && no !== null ? yes - no : null,
    interpretation:
      "Descriptive contamination diagnostic; small samples cannot establish absence of memorization.",
  };
  record.append("jev_contamination_probe", scope, result);
  return result;
}
