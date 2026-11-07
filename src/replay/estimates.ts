import type { Event, RecordLog } from "../runner/record.js";
import { digest } from "../runner/config.js";
import type { WindowResult } from "./types.js";

const label = String.raw`\b(?:estimates?|estimated|probability|likelihood)\b`;
const gap = String.raw`[a-z\s:=\"'()_-]{0,60}`;
const number = String.raw`(?<![\w.+-])(\d+(?:\.\d+)?|\.\d+)\s*(%|percent\b)?(?!\w|\.\d)`;
const patterns = [
  new RegExp(`${label}${gap}${number}`, "gi"),
  new RegExp(`${number}${gap}${label}`, "gi"),
];

/** Heuristic, not a judgement about whether Jev used the asserted number. */
export function hasAssertedEstimate(text: string): boolean {
  return patterns.some((pattern) =>
    [...text.matchAll(pattern)].some((match) => {
      const value = Number(match[1]);
      return value >= 0 && value <= (match[2] ? 100 : 1);
    }),
  );
}

function texts(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object")
    return Object.values(value).flatMap(texts);
  return [];
}
const probability = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1;

/** One observation per window, regardless of retries or number of assertions.
 * Diagnostics are private and agreement alone does not establish anchoring.
 */
export function summarizeEstimates(
  results: WindowResult[],
  scope: string,
  events: Pick<Event, "kind" | "scope" | "data">[],
) {
  const assemblies = new Map(
    events
      .filter((e) => e.kind === "policy_assembly")
      .map((e) => [e.scope, e.data]),
  );
  let assertedEstimates = 0;
  const differences: number[] = [];
  for (const result of results) {
    if (result.window.exclusions.length || !result.window.state) continue;
    const assembled = assemblies.get(`${scope}:${digest(result.window.state)}`);
    if (!assembled) continue;
    // Scan only text that the request exposes, never diagnostics or option keys.
    const request = assembled.request;
    const visible = [
      request?.state,
      ...Object.values(request?.questions ?? {}).flatMap((q: any) => [
        q.instructions,
        q.criteria,
      ]),
    ];
    if (visible.flatMap(texts).some(hasAssertedEstimate)) assertedEstimates++;
    const diagnostics = assembled.assembly?.diagnostics;
    const answer = (result.raw as any)?.substitution?.noul;
    if (
      !diagnostics ||
      result.failure ||
      !result.validation?.questions.substitution.valid ||
      !probability(answer)
    )
      continue;
    // A stable lexical tie-break avoids counting one window more than once.
    const key = Object.keys(diagnostics)
      .sort()
      .find((key) => /sub/i.test(key) && probability(diagnostics[key]));
    if (key !== undefined)
      differences.push(Math.abs(diagnostics[key] - answer));
  }
  return {
    assertedEstimates,
    jevAgreementWithDiagnostics: differences.length
      ? {
          meanAbsoluteDifference:
            differences.reduce((sum, d) => sum + d, 0) / differences.length,
          count: differences.length,
        }
      : null,
  };
}

/** Read only this game's assemblies; season records may contain thousands. */
export function summarizeRecordedEstimates(
  results: WindowResult[],
  scope: string,
  record: Pick<RecordLog, "events">,
) {
  return summarizeEstimates(
    results,
    scope,
    results.flatMap((result) =>
      result.window.state && !result.window.exclusions.length
        ? record.events(
            "policy_assembly",
            `${scope}:${digest(result.window.state)}`,
          )
        : [],
    ),
  );
}
