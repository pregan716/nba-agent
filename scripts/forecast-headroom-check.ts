// Input is analyze.py --baseline-props output from the holdout-filtered cached export.
import { readFileSync } from "node:fs";
import {
  bigMark,
  bigHit,
  topThree,
  type Stat,
} from "../src/evaluation/forecast/market.js";
const rows: {
  game_id: string;
  player_id: string;
  stat: Stat;
  line: number;
  actual: number;
  played: number;
  score: number;
}[] = JSON.parse(readFileSync(process.argv[2], "utf8"));
const games = Map.groupBy(rows, (r) => r.game_id);
if (games.size !== 70 || rows.length !== 1562)
  throw Error("Expected the 70-game headroom candidate pool");
let hits = 0,
  picks = 0,
  voids = 0;
for (const game of games.values()) {
  const selected = topThree(
    game.map((r) => ({
      ...r,
      playerId: String(r.player_id),
      probability: r.score,
    })),
  );
  for (const r of selected) {
    picks++;
    if (!r.played) voids++;
    hits += bigHit(Boolean(r.played), r.actual, bigMark(r.stat, r.line));
  }
}
console.log(
  JSON.stringify({ games: games.size, pool: rows.length, hits, picks, voids }),
);
if (picks !== 210 || hits !== 51 || voids !== 1)
  throw Error("Big-over headroom parity changed");
