// Facts for the larger Jev contamination probe (SPO-855). Jev takes no prompt,
// so the probe asks typed true/false questions whose answers are regular-season
// facts, with an empty state, and compares discrimination against chance.
//
// Statement polarity is fixed by a hash of the fact id, never by the outcome,
// which balances true and false statements. It does NOT remove the value of a
// prior: a model that only knows the team is good can put 0.75 on every "won"
// statement and 0.25 on every "lost" one and discriminate without knowing any
// result. `summarizeProbeGroups` therefore reports an outcome-blind,
// polarity-aware base-rate reference next to the observed statistics.
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
      positive: saysWon,
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
      positive: saysPlayed,
      subject: r.playerId,
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
  positive?: boolean;
  subject?: string;
}
type Stats = {
  accuracy: number | null;
  brier: number | null;
  discrimination: number | null;
};
const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
function stats(rows: { truth: boolean; p: number }[]): Stats {
  const yes = mean(rows.filter((r) => r.truth).map((r) => r.p)),
    no = mean(rows.filter((r) => !r.truth).map((r) => r.p));
  return {
    accuracy: mean(rows.map((r) => Number(r.p >= 0.5 === r.truth))),
    brier: mean(rows.map((r) => (r.p - Number(r.truth)) ** 2)),
    discrimination: yes !== null && no !== null ? yes - no : null,
  };
}
/** What a predictor scores if it knows only how often the positive outcome
 * happens (for the whole group, or for each subject) and nothing about any
 * single fact: it answers that rate for a positive statement and one minus it
 * for a negative one. The rate is the realized one, so this is a generous
 * reference: no model could know the rate that exactly in advance. */
function baseRateReference(
  rows: ProbeResultRow[],
  key: (r: ProbeResultRow) => string,
) {
  if (rows.some((r) => r.positive === undefined)) return null;
  const happened = (r: ProbeResultRow) => r.truth === r.positive;
  const rate = new Map<string, number>();
  for (const k of new Set(rows.map(key)))
    rate.set(
      k,
      mean(rows.filter((r) => key(r) === k).map((r) => Number(happened(r))))!,
    );
  return {
    positiveRate: mean(rows.map((r) => Number(happened(r)))),
    ...stats(
      rows.map((r) => ({
        truth: r.truth,
        p: r.positive ? rate.get(key(r))! : 1 - rate.get(key(r))!,
      })),
    ),
  };
}
const minus = (a: Stats, b: Stats | null) =>
  b && {
    accuracy:
      a.accuracy !== null && b.accuracy !== null
        ? a.accuracy - b.accuracy
        : null,
    brier: a.brier !== null && b.brier !== null ? a.brier - b.brier : null,
    discrimination:
      a.discrimination !== null && b.discrimination !== null
        ? a.discrimination - b.discrimination
        : null,
  };
/** Per-group descriptive statistics. Uninformed chance is 0.5 accuracy, 0.25
 * Brier, 0 discrimination; the base-rate references show how far a prior alone
 * goes, and `beyond…` is observed minus that reference on the valid answers. */
export function summarizeProbeGroups(rows: ProbeResultRow[]) {
  const groups = new Map<string, ProbeResultRow[]>();
  for (const r of rows)
    groups.set(r.group ?? "ungrouped", [
      ...(groups.get(r.group ?? "ungrouped") ?? []),
      r,
    ]);
  return Object.fromEntries(
    [...groups].sort().map(([group, all]) => {
      const valid = all.filter((r) => r.probability !== null),
        observed = stats(
          valid.map((r) => ({ truth: r.truth, p: r.probability! })),
        ),
        pooled = baseRateReference(valid, () => group),
        bySubject = valid.every((r) => r.subject !== undefined)
          ? baseRateReference(valid, (r) => r.subject!)
          : null;
      return [
        group,
        {
          facts: all.length,
          invalid: all.length - valid.length,
          trueStatements: all.filter((r) => r.truth).length,
          ...observed,
          meanProbabilityTrue: mean(
            valid.filter((r) => r.truth).map((r) => r.probability!),
          ),
          meanProbabilityFalse: mean(
            valid.filter((r) => !r.truth).map((r) => r.probability!),
          ),
          baseRateReference: pooled,
          beyondBaseRate: minus(observed, pooled),
          subjectRateReference: bySubject,
          beyondSubjectRate: minus(observed, bySubject),
        },
      ];
    }),
  );
}
