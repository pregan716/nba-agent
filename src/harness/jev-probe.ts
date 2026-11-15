// Facts and statistics for the Jev contamination probe, for any team (SPO-906).
// Carried from the v3 probe (docs/archive/v3/code/src/policy/probe-facts.ts)
// with the team made a parameter. Jev takes no prompt, so the probe asks typed
// true/false questions whose answers are regular-season facts, with an empty
// state, and compares what it says with chance and with a base-rate reference.
//
// Statement polarity is fixed by a hash of the fact id, never by the outcome,
// which balances true and false statements. It does not remove the value of a
// prior: a model that only knows a team is good can lean toward "won" and
// discriminate without knowing any result. The summary therefore reports an
// outcome-blind base-rate reference beside the observed statistics.
import { createHash } from "node:crypto";

export interface ProbeFact {
  id: string;
  question: string;
  truth: boolean;
  /** Reporting group, e.g. `result:2025-26:DEN`. Never sent to Jev. */
  group: string;
  /** Whether the statement asserts the positive outcome (won, played). */
  positive: boolean;
  /** What the statement is about, for per-subject base rates (a player id). */
  subject?: string;
}
export interface ProbeGame {
  season: string;
  gameId: string;
  /** Calendar date of the game in US Eastern time, YYYY-MM-DD. */
  date: string;
  team: string;
  teamName: string;
  opponent: string;
  won: boolean;
}
export interface ProbeAppearance extends Omit<ProbeGame, "won"> {
  playerId: string;
  playerName: string;
  played: boolean;
}
const MONTHS =
  "January February March April May June July August September October November December".split(
    " ",
  );
const spokenDate = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
};
/** Deterministic coin from an id; independent of any outcome. */
const coin = (id: string) =>
  createHash("sha256").update(id).digest()[0] % 2 === 0;

export function winLossFacts(games: ProbeGame[]): ProbeFact[] {
  return games.map((g) => {
    const id = `result_${g.team}_${g.gameId}`,
      saysWon = coin(id);
    return {
      id,
      group: `result:${g.season}:${g.team}`,
      positive: saysWon,
      question: `The ${g.teamName} ${saysWon ? "won" : "lost"} their NBA regular-season game against the ${g.opponent} on ${spokenDate(g.date)}.`,
      truth: saysWon === g.won,
    };
  });
}
export function appearanceFacts(rows: ProbeAppearance[]): ProbeFact[] {
  return rows.map((r) => {
    const id = `played_${r.team}_${r.gameId}_${r.playerId}`,
      saysPlayed = coin(id);
    return {
      id,
      group: `appearance:${r.season}:${r.team}`,
      positive: saysPlayed,
      subject: r.playerId,
      question: `${r.playerName} ${saysPlayed ? "played" : "did not play"} in the ${r.teamName}' NBA regular-season game against the ${r.opponent} on ${spokenDate(r.date)}.`,
      truth: saysPlayed === r.played,
    };
  });
}
/** One appearance fact per game: a roster player who played in between 20% and
 * 80% of the team's games, so that guessing from how often he plays is close to
 * a coin flip. Selection uses a hash of the game id only. */
export function selectAppearances(
  games: { gameId: string; roster: string[]; played: Set<string> }[],
) {
  const appearances = new Map<string, number>(),
    eligible = new Map<string, number>();
  for (const g of games)
    for (const p of g.roster) {
      eligible.set(p, (eligible.get(p) ?? 0) + 1);
      if (g.played.has(p)) appearances.set(p, (appearances.get(p) ?? 0) + 1);
    }
  const uncertain = new Set(
    [...eligible]
      .filter(([p, n]) => {
        const rate = (appearances.get(p) ?? 0) / n;
        return n >= 10 && rate >= 0.2 && rate <= 0.8;
      })
      .map(([p]) => p),
  );
  return games.flatMap((g) => {
    const candidates = g.roster.filter((p) => uncertain.has(p)).sort();
    if (!candidates.length) return [];
    const pick =
      candidates[
        createHash("sha256").update(g.gameId).digest().readUInt32BE(0) %
          candidates.length
      ];
    return [{ gameId: g.gameId, playerId: pick, played: g.played.has(pick) }];
  });
}

export type ProbeRow = ProbeFact & { probability: number | null };
const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
function stats(rows: { truth: boolean; p: number }[]) {
  const yes = mean(rows.filter((r) => r.truth).map((r) => r.p)),
    no = mean(rows.filter((r) => !r.truth).map((r) => r.p));
  return {
    accuracy: mean(rows.map((r) => Number(r.p >= 0.5 === r.truth))),
    brier: mean(rows.map((r) => (r.p - Number(r.truth)) ** 2)),
    discrimination: yes !== null && no !== null ? yes - no : null,
  };
}
/** What a predictor scores if it knows only how often the positive outcome
 * happens in the group and nothing about any single fact. The rate is the
 * realised one, so this is a generous reference. */
function baseRate(rows: ProbeRow[]) {
  const happened = (r: ProbeRow) => r.truth === r.positive;
  const rate = mean(rows.map((r) => Number(happened(r))))!;
  return {
    positiveRate: rate,
    ...stats(
      rows.map((r) => ({ truth: r.truth, p: r.positive ? rate : 1 - rate })),
    ),
  };
}
/** Descriptive statistics for a set of answered facts. Uninformed chance is 0.5
 * accuracy, 0.25 Brier and 0 discrimination. */
export function summarize(all: ProbeRow[]) {
  const valid = all.filter((r) => r.probability !== null),
    observed = stats(valid.map((r) => ({ truth: r.truth, p: r.probability! }))),
    reference = valid.length ? baseRate(valid) : null;
  return {
    facts: all.length,
    invalid: all.length - valid.length,
    trueStatements: all.filter((r) => r.truth).length,
    ...observed,
    baseRateReference: reference,
    brierBeyondBaseRate:
      observed.brier !== null && reference?.brier != null
        ? observed.brier - reference.brier
        : null,
  };
}
export function summarizeGroups(
  rows: ProbeRow[],
  key: (r: ProbeRow) => string,
) {
  const groups = Map.groupBy(rows, key);
  return Object.fromEntries(
    [...groups].sort().map(([name, group]) => [name, summarize(group)]),
  );
}
