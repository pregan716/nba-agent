import { distribution } from "../../projection/distribution.js";
import type { scoreGame } from "../../projection/scoring.js";

export type Feedback = ReturnType<typeof scoreGame>;
export const dispersion = {
  points: 2.33,
  rebounds: 1.09,
  assists: 1.08,
} as const;
export type Stat = keyof typeof dispersion;
export interface Prop {
  playerId: string;
  stat: Stat;
  line: number;
  market: number;
}
export interface Snapshot {
  props: Prop[];
  unavailable: number;
}
export const bigMark = (stat: Stat, line: number) =>
  line + Math.sqrt(line * dispersion[stat]);
export const bigHit = (played: boolean, actual: number, mark: number) =>
  Number(played && actual >= mark);
export const clip = (p: number) => Math.min(0.98, Math.max(0.02, p));

export function topThree<
  T extends { playerId: string; stat: Stat; probability: number },
>(pool: T[]) {
  return [...pool]
    .sort(
      (a, b) =>
        b.probability - a.probability ||
        a.playerId.localeCompare(b.playerId, "en", { numeric: true }) ||
        a.stat.localeCompare(b.stat),
    )
    .slice(0, 3);
}
export function scoreProps(
  f: Feedback,
  snapshot: Snapshot,
  side: "agent" | "reference",
) {
  const players = new Map(f[side].players.map((p) => [p.playerId, p]));
  const pool = snapshot.props.map((prop) => {
    const player = players.get(prop.playerId);
    if (!player)
      throw Error("Off-roster prop in " + f.gameId + ": " + prop.playerId);
    const conditional = distribution(prop.stat, player.forecast[prop.stat]);
    const mark = bigMark(prop.stat, prop.line);
    return {
      ...prop,
      tier: player.tier,
      mark,
      over: clip(conditional.probability(prop.line, ">")),
      probability: player.forecast.p_play * conditional.probability(mark, ">="),
    };
  });
  const picks = new Set(topThree(pool));
  return pool.map((prop) => {
    const actual = players.get(prop.playerId)!.actual;
    return {
      ...prop,
      gameId: f.gameId,
      picked: picks.has(prop),
      played: actual.played,
      y: Number(actual[prop.stat] > prop.line),
      hit: bigHit(actual.played, actual[prop.stat], prop.mark),
    };
  });
}
export type ScoredProp = ReturnType<typeof scoreProps>[number];
