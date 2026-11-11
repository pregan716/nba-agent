// Pre-pilot check (SPO-886): run the evaluator's consensus capture over Celtics games
// 1-70 from the real pinned release. It must find the headroom check's candidate pool.
// Host only. No run record, session or model is involved.
//   npm run forecast:capture-check
import { readFileSync } from "node:fs";
import { PlayByPlayAdapter } from "../src/data/adapters.js";
import { openCorpus } from "../src/data/corpus.js";
import { Identities } from "../src/data/identity.js";
import { DopplerStore } from "../src/data/store.js";
import { snapshots } from "../src/evaluation/forecast/capture.js";
import { projectionSource } from "../src/projection/input.js";
import type { Game } from "../src/runner/config.js";

const GAMES = 70,
  HEADROOM_POOL = 1562;
const store = new DopplerStore();
try {
  const corpus = await openCorpus(store, process.cwd(), ".cache/objects");
  // Schedule columns only, as in the reference audit: no outcome is decoded.
  corpus.pbp = new PlayByPlayAdapter(corpus.pbp.release, true);
  const ids = new Identities();
  for (const row of JSON.parse(readFileSync("config/identities.json", "utf8")))
    ids.add(row);
  const games = (await projectionSource(corpus)).schedule
    .filter((g) => g.boston && g.season === "2025-26")
    .sort((a, b) => a.tip.localeCompare(b.tip))
    .slice(0, GAMES)
    .map((g, index): Game => ({
      gameId: g.gameId,
      scheduledStart: g.tip,
      index,
      development: index < 10,
      release: g.release,
    }));
  if (games.length !== GAMES) throw Error("Incomplete schedule");
  const captured = snapshots(games, ids, await corpus.odds.auditRows());
  const counts = [...captured.values()].map((s) => s.props.length);
  const result = {
    games: captured.size,
    props: counts.reduce((a, b) => a + b, 0),
    unavailable: [...captured.values()].reduce((a, s) => a + s.unavailable, 0),
    fewestPerGame: Math.min(...counts),
    mostPerGame: Math.max(...counts),
  };
  console.log(JSON.stringify(result));
  if (result.games !== GAMES || result.props !== HEADROOM_POOL)
    throw Error(
      `Expected ${HEADROOM_POOL} usable props over ${GAMES} games (headroom check)`,
    );
} finally {
  store.close();
}
