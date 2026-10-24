// Null-baseline agents (brief, "Null baselines"). Each is a Harness on the same
// three handles as the analyst and uses only session tools; none makes a model
// call. They exist so the stateless agent's score has a reference, and so the
// scoring pipeline is exercised end to end without spending tokens.

import type { AgentQuestion, Answer, SubmitInput } from "../env/contract.js";
import type { Harness, HarnessHandles } from "../runner/runner.js";

const clip = (p: number) => Math.min(0.99, Math.max(0.01, p));

async function submitAll(
  { session }: HarnessHandles,
  answers: Answer[],
  notes: string,
) {
  await session.call("begin_commit", {});
  const input: SubmitInput = { answers, notes };
  return session.call("submit", input);
}

/** Skip postgame work; a baseline has nothing to reflect on. */
function pregameOnly(
  body: (
    handles: HarnessHandles,
    questions: AgentQuestion[],
    gameId: string,
  ) => Promise<void>,
): Harness {
  return async (handles) => {
    const context = await handles.session.call("context", {});
    if (context.phase === "postgame") return;
    const { questions } = await handles.session.call("list_questions", {});
    await body(handles, questions, context.game.game_id);
  };
}

/** p = q for every question. Scores exactly zero by construction. */
export const marketBaseline: Harness = pregameOnly(
  async (handles, questions) => {
    await submitAll(
      handles,
      questions.map((q) => ({ question_id: q.question_id, p_over: q.p_over })),
      "market baseline",
    );
  },
);

/** Deterministic small PRNG so a replicate with the same seed reproduces. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashSeed(seed: number, gameId: string) {
  let h = seed >>> 0;
  for (const ch of gameId) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
  return h;
}

/** p = q + U[-0.15, 0.15], clipped. Establishes the cost of noise around the market. */
export function randomDeviationBaseline(seed: number): Harness {
  return pregameOnly(async (handles, questions, gameId) => {
    const random = mulberry32(hashSeed(seed, gameId));
    await submitAll(
      handles,
      questions.map((q) => {
        const p = clip(q.p_over + (random() * 0.3 - 0.15));
        return {
          question_id: q.question_id,
          p_over: p,
          ...(Math.abs(p - q.p_over) >= 0.05
            ? {
                rationale:
                  "random-deviation baseline: uniform noise around the market",
              }
            : {}),
        };
      }),
      `random-deviation baseline, seed ${seed}`,
    );
  });
}

export interface NaiveStatsParameters {
  /** Games below which the baseline submits the market probability. */
  minimumGames: number;
  /** Shrinkage toward the market: weight on the empirical rate is n / (n + k). */
  shrinkage: number;
}
export const NAIVE_STATS: NaiveStatsParameters = {
  minimumGames: 5,
  shrinkage: 10,
};

/**
 * Documented simple model: for each question, take the player's eligible
 * 2025-26 box scores, estimate P(stat > line) as (overs + 0.5) / (n + 1), and
 * shrink toward the market by n / (n + k). Pushes (stat == line) count as not
 * over, which matches the line being a half-integer in this data. Players with
 * fewer than `minimumGames` eligible games get the market probability.
 */
export function naiveStatsBaseline(
  parameters: NaiveStatsParameters = NAIVE_STATS,
): Harness {
  return pregameOnly(async (handles, questions) => {
    const answers: Answer[] = [];
    const cache = new Map<string, number[]>();
    for (const q of questions) {
      const key = `${q.player.id}:${q.stat}`;
      let values = cache.get(key);
      if (!values) {
        values = [];
        let cursor: string | undefined;
        do {
          const page = await handles.session.call("query_game_history", {
            table: "player_box_scores",
            player_id: q.player.id,
            season: "2025-26",
            limit: 100,
            ...(cursor ? { cursor } : {}),
          });
          for (const row of page.rows) {
            const v = row[q.stat];
            if (typeof v === "number" && Number.isFinite(v)) values.push(v);
          }
          cursor = page.next_cursor ?? undefined;
        } while (cursor);
        cache.set(key, values);
      }
      const n = values.length;
      if (n < parameters.minimumGames) {
        answers.push({ question_id: q.question_id, p_over: q.p_over });
        continue;
      }
      const overs = values.filter((v) => v > q.line).length;
      const empirical = (overs + 0.5) / (n + 1);
      const w = n / (n + parameters.shrinkage);
      const p = clip(w * empirical + (1 - w) * q.p_over);
      answers.push({
        question_id: q.question_id,
        p_over: p,
        ...(Math.abs(p - q.p_over) >= 0.05
          ? {
              rationale: `naive-stats baseline: ${overs} of ${n} eligible 2025-26 games over ${q.line}, shrunk toward the market with k=${parameters.shrinkage}`,
            }
          : {}),
      });
    }
    await submitAll(handles, answers, "naive-stats baseline");
  });
}
