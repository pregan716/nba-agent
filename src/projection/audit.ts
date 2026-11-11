// Counters for the offline reference audit (SPO-879, SPO-886). Pure: the script
// supplies each game's frozen reference forecast and its released Boston box.
import { distribution, minutes } from "./distribution.js";
import { quantities, type Forecast, type Quantity } from "./forecast.js";
import type { Outcome } from "./input.js";

const perQuantity = <T>(make: () => T) =>
  Object.fromEntries(quantities.map((q) => [q, make()])) as Record<Quantity, T>;

/** Games 21 onward (zero-based index 20) are the scored split. */
export const FIRST_SCORED_INDEX = 20;

export function emptyCounts() {
  return {
    games: 0,
    // Minutes: whole dated roster, with the DNP mass at zero. Production: players who played.
    coverage: perQuantity(() => ({ n: 0, inside1090: 0, inside2575: 0 })),
    // Minutes given playing, against the stated conditional range.
    conditionalMinutes: { n: 0, inside1090: 0, inside2575: 0 },
    // Players who played: which side the misses fall on, and the rate strictly above
    // the interpolated 85th percentile (the ceiling-game mark for fantasy points).
    tails: perQuantity(() => ({ n: 0, below10: 0, above90: 0, above85: 0 })),
  };
}
export type AuditCounts = ReturnType<typeof emptyCounts>;

/** Add one game to every supplied counter set; return its two misplaced-minutes figures. */
export function addGame(
  counters: AuditCounts[],
  forecast: Forecast,
  boston: Outcome[],
) {
  const box = new Map(boston.map((p) => [p.playerId, p]));
  const rows = new Map(forecast.players.map((p) => [p.playerId, p]));
  let expectedBox = 0,
    medianRoster = 0;
  for (const a of boston) {
    const f = rows.get(a.playerId);
    if (!f && a.played)
      throw Error(
        "Played outside dated roster: " + forecast.gameId + " " + a.playerId,
      );
    expectedBox +=
      Math.abs(a.minutes - (f ? minutes(f.p_play, f.minutes).mean : 0)) / 2;
  }
  for (const c of counters) c.games++;
  for (const f of rows.values()) {
    const a = box.get(f.playerId),
      dist = minutes(f.p_play, f.minutes);
    medianRoster += Math.abs((a?.minutes ?? 0) - dist.quantile(0.5)) / 2;
    for (const c of counters) {
      if (a?.played) {
        c.conditionalMinutes.n++;
        c.conditionalMinutes.inside1090 += Number(
          f.minutes[1] <= a.minutes && a.minutes <= f.minutes[5],
        );
        c.conditionalMinutes.inside2575 += Number(
          f.minutes[2] <= a.minutes && a.minutes <= f.minutes[4],
        );
      }
      for (const q of quantities) {
        const r = f[q];
        if (a?.played) {
          const y = a[q],
            t = c.tails[q];
          t.n++;
          t.below10 += Number(y < r[1]);
          t.above90 += Number(y > r[5]);
          t.above85 += Number(y > distribution(q, r).quantile(0.85));
        }
        if (q !== "minutes" && !a?.played) continue;
        const y = a?.[q] ?? 0,
          cover = c.coverage[q];
        const level = (p: number, index: number) =>
          q === "minutes" ? dist.quantile(p) : r[index];
        cover.n++;
        cover.inside1090 += Number(level(0.1, 1) <= y && y <= level(0.9, 5));
        cover.inside2575 += Number(level(0.25, 2) <= y && y <= level(0.75, 4));
      }
    }
  }
  return { expectedBox, medianRoster };
}

/** Games in schedule order. `all` covers every game, `scored` those from game 21 on. */
export function auditGames(games: { forecast: Forecast; boston: Outcome[] }[]) {
  const all = emptyCounts(),
    scored = emptyCounts();
  const perGame = games.map((g, index) =>
    addGame(
      index >= FIRST_SCORED_INDEX ? [all, scored] : [all],
      g.forecast,
      g.boston,
    ),
  );
  return { all, scored, perGame };
}
