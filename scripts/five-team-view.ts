import { openCorpus } from "../src/data/corpus.js";
import { DopplerStore } from "../src/data/store.js";
import { fiveTeamData } from "../src/data/five-team.js";
import { writeView } from "../src/data/architect-view.js";
const [view, destination] = process.argv.slice(2);
if (!destination || (view !== "architect" && view !== "training"))
  throw Error("Usage: npm run data:view -- architect|training NEW_DIRECTORY");
const store = new DopplerStore();
try {
  await writeView(
    await fiveTeamData(
      await openCorpus(store, process.cwd(), ".cache/objects"),
    ),
    view,
    destination,
    new AbortController().signal,
  );
} finally {
  store.close();
}
