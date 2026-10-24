import type { QuestionScorer } from "../env/results.js";

/** Positive means lower loss than market. The brief's displayed equation has
 * the opposite sign to its prose; use market loss minus agent loss. */
export const logSkill: QuestionScorer = (q) => {
  if (q.outcome !== "over" && q.outcome !== "under") return null;
  const p = q.agent_p_over,
    m = q.market_p_over;
  if (![p, m].every((v) => Number.isFinite(v) && v > 0 && v < 1))
    throw Error("Scoring requires probabilities strictly between zero and one");
  if (p === m) return 0;
  return q.outcome === "over"
    ? Math.log(p) - Math.log(m)
    : Math.log1p(-p) - Math.log1p(-m);
};
export function brierSkill(p: number, q: number, y: number): number {
  return p === q ? 0 : (q - y) ** 2 - (p - y) ** 2;
}
