// Facts for the larger Jev contamination probe (SPO-855). Jev takes no prompt,
// so the probe asks typed true/false questions whose answers are regular-season
// facts, with an empty state, and compares discrimination against chance.
//
// Statement polarity is fixed by a hash of the fact id, never by the outcome,
// so "the Celtics usually win" or "starters usually play" cannot separate true
// statements from false ones. The prior season is the comparison group: a
// model may legitimately know it, which shows what recall would look like.
import { createHash } from "node:crypto";
import type { ProbeFact } from "./probe.js";

export interface ProbeGame {
  season: string;
  gameId: string;
  /** Calendar date of the game in America/New_York, YYYY-MM-DD. */
  date: string;
  opponent: string;
  celticsWon: boolean;
}
export interface ProbeAppearance {
  season: string;
  gameId: string;
  date: string;
  opponent: string;
  playerId: string;
  playerName: string;
  played: boolean;
}
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
export const spokenDate = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
};
/** Deterministic coin from an id; independent of any outcome. */
export const coin = (id: string) =>
  createHash("sha256").update(id).digest()[0] % 2 === 0;

export function winLossFacts(games: ProbeGame[], source: string): ProbeFact[] {
  return games.map((g) => {
    const id = `result_${g.season.replace("-", "_")}_${g.gameId}`,
      saysWon = coin(id);
    return {
      id,
      group: `result:${g.season}`,
      question: `The Boston Celtics ${saysWon ? "won" : "lost"} their NBA regular-season game against the ${g.opponent} on ${spokenDate(g.date)}.`,
      truth: saysWon === g.celticsWon,
      source,
    };
  });
}

export function appearanceFacts(
  rows: ProbeAppearance[],
  source: string,
): ProbeFact[] {
  return rows.map((r) => {
    const id = `played_${r.season.replace("-", "_")}_${r.gameId}_${r.playerId}`,
      saysPlayed = coin(id);
    return {
      id,
      group: `appearance:${r.season}`,
      question: `${r.playerName} ${saysPlayed ? "played" : "did not play"} in the Boston Celtics' NBA regular-season game against the ${r.opponent} on ${spokenDate(r.date)}.`,
      truth: saysPlayed === r.played,
      source,
    };
  });
}

/** One appearance fact per game: a roster player who played in between 20 % and
 * 80 % of the team's games, so that guessing from how often he plays is close
 * to a coin flip. Selection uses a hash of the game id only. */
export function selectAppearances(
  games: { gameId: string; roster: string[]; played: Set<string> }[],
): { gameId: string; playerId: string; played: boolean }[] {
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

export interface ProbeResultRow {
  group?: string;
  truth: boolean;
  probability: number | null;
}
/** Per-group descriptive statistics; chance is 0.5 accuracy, 0.25 Brier, 0 discrimination. */
export function summarizeProbeGroups(rows: ProbeResultRow[]) {
  const groups = new Map<string, ProbeResultRow[]>();
  for (const r of rows)
    groups.set(r.group ?? "ungrouped", [
      ...(groups.get(r.group ?? "ungrouped") ?? []),
      r,
    ]);
  const mean = (xs: number[]) =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  return Object.fromEntries(
    [...groups].sort().map(([group, all]) => {
      const valid = all.filter((r) => r.probability !== null),
        yes = mean(valid.filter((r) => r.truth).map((r) => r.probability!)),
        no = mean(valid.filter((r) => !r.truth).map((r) => r.probability!));
      return [
        group,
        {
          facts: all.length,
          invalid: all.length - valid.length,
          trueStatements: all.filter((r) => r.truth).length,
          accuracy: mean(
            valid.map((r) => Number(r.probability! >= 0.5 === r.truth)),
          ),
          brier: mean(
            valid.map((r) => (r.probability! - Number(r.truth)) ** 2),
          ),
          meanProbabilityTrue: yes,
          meanProbabilityFalse: no,
          discrimination: yes !== null && no !== null ? yes - no : null,
        },
      ];
    }),
  );
}
