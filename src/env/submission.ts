import type { QuestionSet } from "../questions/builder.js";
import type { Validation } from "../runner/runner.js";
import { SessionError, type SubmitInput, type ClipEvent } from "./contract.js";
import { validateInput } from "./input.js";

/** Collect structural and question-specific problems before rejecting atomically. */
export function validateSubmission(
  input: unknown,
  set: QuestionSet,
): Validation {
  const errors: string[] = [];
  const clips: ClipEvent[] = [];
  try {
    validateInput("submit", input);
  } catch (e) {
    if (!(e instanceof SessionError)) throw e;
    errors.push(...e.problems);
  }
  const value = input as SubmitInput | null;
  const answers = Array.isArray(value?.answers) ? value.answers : [];
  const known = new Map(set.questions.map((q) => [q.question_id, q]));
  const seen = new Set<string>();
  const normalized: SubmitInput["answers"] = [];
  for (const a of answers) {
    if (!a || typeof a !== "object") continue;
    const id = a.question_id;
    if (typeof id !== "string") continue;
    if (seen.has(id)) errors.push(`Duplicate question_id: ${id}`);
    seen.add(id);
    const q = known.get(id);
    if (!q) errors.push(`Unknown question_id: ${id}`);
    if (typeof a.p_over !== "number" || !Number.isFinite(a.p_over)) continue;
    const p = Math.max(0.01, Math.min(0.99, a.p_over));
    if (p !== a.p_over)
      clips.push({ question_id: id, submitted: a.p_over, clipped_to: p });
    // Tolerance covers binary representation at the exact five-point boundary.
    if (
      q &&
      Math.abs(p - q.p_over) >= 0.05 - 1e-12 &&
      (typeof a.rationale !== "string" || !a.rationale.trim())
    )
      errors.push(`Rationale required for question_id: ${id}`);
    normalized.push({
      question_id: id,
      p_over: p,
      ...(a.rationale !== undefined ? { rationale: a.rationale } : {}),
      ...(a.evidence_refs !== undefined
        ? { evidence_refs: structuredClone(a.evidence_refs) }
        : {}),
    });
  }
  for (const id of known.keys())
    if (!seen.has(id)) errors.push(`Missing question_id: ${id}`);
  if (errors.length) return { ok: false, errors, clips };
  normalized.sort((a, b) => a.question_id.localeCompare(b.question_id));
  return {
    ok: true,
    errors,
    clips,
    value: {
      answers: normalized,
      ...(value?.notes !== undefined ? { notes: value.notes } : {}),
    } satisfies SubmitInput,
  };
}
