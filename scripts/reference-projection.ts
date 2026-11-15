import { openCorpus } from "../src/data/corpus.js";
import { DopplerStore } from "../src/data/store.js";
import { projectionSource } from "../src/projection/input.js";
import {
  referenceTables,
  projectionModel,
} from "../src/projection/reference.js";

import { PlayByPlayAdapter } from "../src/data/adapters.js";
import { teamIds, teams, type Team } from "../src/data/teams.js";
const [gameId, image, root = ".cache/reference-projection", team = "BOS"] =
  process.argv.slice(2);
if (!gameId || !image || !teams.includes(team as Team))
  throw Error(
    "Usage: npm run projection -- GAME_ID PINNED_IMAGE [receipt-directory] [BOS|DEN|MEM|OKC|WAS]",
  );
const store = new DopplerStore();
try {
  const corpus = await openCorpus(store, process.cwd(), ".cache/objects");
  corpus.pbp = new PlayByPlayAdapter(corpus.pbp.release, true);
  const result = await referenceTables(
    await projectionSource(corpus),
    gameId,
    root,
    projectionModel(image),
    teamIds[team as Team],
  );
  process.stdout.write(JSON.stringify(result) + "\n");
} finally {
  store.close();
}
