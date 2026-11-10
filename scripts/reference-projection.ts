import { openCorpus } from "../src/data/corpus.js";
import { DopplerStore } from "../src/data/store.js";
import { projectionSource } from "../src/projection/input.js";
import {
  referenceTables,
  projectionModel,
} from "../src/projection/reference.js";

const [gameId, image, root = ".cache/reference-projection"] =
  process.argv.slice(2);
if (!gameId || !image)
  throw Error(
    "Usage: npm run projection -- GAME_ID PINNED_IMAGE [receipt-directory]",
  );
const store = new DopplerStore();
try {
  const corpus = await openCorpus(store, process.cwd(), ".cache/objects");
  const result = await referenceTables(
    await projectionSource(corpus),
    gameId,
    root,
    projectionModel(image),
  );
  process.stdout.write(JSON.stringify(result) + "\n");
} finally {
  store.close();
}
