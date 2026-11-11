// Pre-pilot check (SPO-886): run the evaluator's consensus capture over Celtics games
// 1-70 from the real pinned release. It must find the headroom check's candidate pool.
// Host only. No run record, session or model is involved.
//   npm run forecast:capture-check [-- HEADROOM_PROPS_JSON]
// The pool is compared by digest, not by count: every (game, player, stat, line, over
// probability) must equal the headroom export's, which docs/evidence/projection-headroom/
// scripts/export.ts builds through a separate join. With a path to that export's
// props.json the expected digest is recomputed from the file as well.
import { readFileSync } from "node:fs";
import { PlayByPlayAdapter } from "../src/data/adapters.js";
import { openCorpus } from "../src/data/corpus.js";
import { Identities } from "../src/data/identity.js";
import { DopplerStore } from "../src/data/store.js";
import { poolDigest, snapshots } from "../src/evaluation/forecast/capture.js";
import type { Snapshot, Stat } from "../src/evaluation/forecast/market.js";
import { projectionSource } from "../src/projection/input.js";
import type { Game } from "../src/runner/config.js";

const GAMES = 70,
  HEADROOM_POOL = 1562,
  // poolDigest of the holdout-filtered headroom export (SPO-878, revision 92f2ff8).
  HEADROOM_DIGEST =
    "b5d415c4bbe1e4d423f21070406ecaa6c2f3dab5f46cade9cbabca45e6ea0529";
const exportPath = process.argv[2];
if (exportPath) {
  const pool = new Map<string, Snapshot>();
  for (const [gameId, playerId, stat, line, market] of JSON.parse(
    readFileSync(exportPath, "utf8"),
  ) as [string, string, Stat, number, number][]) {
    if (!pool.has(gameId)) pool.set(gameId, { props: [], unavailable: 0 });
    pool.get(gameId)!.props.push({ playerId, stat, line, market });
  }
  if (poolDigest(pool) !== HEADROOM_DIGEST)
    throw Error("Headroom export does not match the pinned digest");
}
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
    digest: poolDigest(captured),
    exportVerified: Boolean(exportPath),
  };
  console.log(JSON.stringify(result));
  if (
    result.games !== GAMES ||
    result.props !== HEADROOM_POOL ||
    result.fewestPerGame < 1
  )
    throw Error(
      `Expected ${HEADROOM_POOL} usable props over ${GAMES} games (headroom check)`,
    );
  if (result.digest !== HEADROOM_DIGEST)
    throw Error(
      "Captured props differ from the headroom export in a game, player, stat, line or probability",
    );
} finally {
  store.close();
}
