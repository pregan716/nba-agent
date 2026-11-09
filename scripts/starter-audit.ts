// Real-data starter acceptance. No research-agent or Jev calls.
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openCorpus } from "../src/data/corpus.js";
import { DopplerStore } from "../src/data/store.js";
import { exportStarterTraining, fitStarter } from "../src/starter/model.js";
const image = process.argv.find((a) => a.startsWith("--image="))?.slice(8);
if (!image) throw Error("Pass --image=<pinned numerical assembler>");
const root = ".cache/starter-audit";
mkdirSync(root, { recursive: true });
const store = new DopplerStore();
try {
  const corpus = await openCorpus(store, process.cwd(), ".cache/objects");
  const game = { gameId: "0022500083", scheduledStart: "2025-10-22T23:30:00Z" };
  const sourceGame = (await corpus.pbp.games()).find(
    (g) => g.id === game.gameId,
  )!;
  game.scheduledStart = sourceGame.data.scheduled_tipoff;
  const input = join(root, "training.jsonl");
  const start = performance.now();
  const data = process.argv.includes("--reuse-export")
    ? JSON.parse(readFileSync(join(root, "data.json"), "utf8"))
    : await exportStarterTraining(
        corpus,
        game.scheduledStart,
        input,
        new AbortController().signal,
      );
  writeFileSync(join(root, "data.json"), JSON.stringify(data, null, 2));
  console.log(
    JSON.stringify({ data, loadSeconds: (performance.now() - start) / 1000 }),
  );
  const fitted = await fitStarter({
    input,
    root: mkdtempSync(join(root, "artifact-")),
    image,
    target: game,
    cutoff: game.scheduledStart,
    signal: new AbortController().signal,
  });
  writeFileSync(join(root, "fit.json"), JSON.stringify(fitted, null, 2) + "\n");
  console.log(JSON.stringify(fitted));
} finally {
  await store.close();
}
