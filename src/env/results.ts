import type { RecordEnvelope } from "../data/contracts.js";
import type { QuestionSet, Stat } from "../questions/builder.js";
import type { ReleasedQuestion, SubmitInput } from "./contract.js";

/** Narrow read-only P4 record port. Never returned directly to an agent. */
export interface RecordedGame {
  questions: QuestionSet;
  submission: SubmitInput | null;
}
export type Resolution = Pick<ReleasedQuestion, "actual" | "outcome">;
/** P6 supplies the scoring implementation; unavailable scores remain explicit null. */
export type QuestionScorer = (
  question: Resolution & { agent_p_over: number; market_p_over: number },
) => number | null;
export const pendingScorer: QuestionScorer = () => null;

/** Shared by released feedback and odds settlement; official stats, PBP participation. */
export function resolveOutcome(
  id: string,
  playerId: string,
  stat: Stat,
  line: number,
  boxes: RecordEnvelope[],
  summaries: RecordEnvelope[],
): Resolution {
  const box = boxes.filter((b) => b.data.player_id === playerId);
  const summary = summaries.filter((s) => s.data.player_id === playerId);
  const actual =
    box.length === 1 &&
    Number.isInteger(box[0].data[stat]) &&
    box[0].data[stat] >= 0
      ? (box[0].data[stat] as number)
      : null;
  const minutes = summary[0]?.data.reconstructed_minutes;
  const seconds =
    summary.length === 1 && typeof minutes === "number"
      ? minutes * 60
      : id === "0022500338" && box.length === 1 && summary.length === 0
        ? box[0].data.minutes_seconds
        : null;
  const outcome =
    seconds === 0
      ? "did_not_play"
      : actual === null ||
          typeof seconds !== "number" ||
          !Number.isFinite(seconds) ||
          seconds < 0
        ? "unresolved"
        : actual === line
          ? "push"
          : actual > line
            ? "over"
            : "under";
  return { actual, outcome };
}
