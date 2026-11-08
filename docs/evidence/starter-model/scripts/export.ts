// Offline hazard-model experiment: export decision windows for 2024-25 (training-only
// roster policy) and 2025-26 games 1-20 (development + warm-up). Games 21+ are never loaded.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { DopplerStore } from "../../../../src/data/store.js";
import { openCorpus } from "../../../../src/data/corpus.js";
import { Identities } from "../../../../src/data/identity.js";
import { corpusSource } from "../../../../src/env/source.js";
import {
  auditPregames,
  loadReplayInputs,
  loadPriorSeasonTraining,
} from "../../../../src/replay/load.js";
import { buildDataset } from "../../../../src/replay/dataset.js";

const out = ".cache/hazard";
mkdirSync(out, { recursive: true });
const store = new DopplerStore();
const corpus = await openCorpus(store, process.cwd(), ".cache/objects");
const mappings = JSON.parse(readFileSync("config/identities.json", "utf8"));
const ids = new Identities();
for (const m of mappings) ids.add(m);
const source = await corpusSource(corpus, ids);
const schedule = (await source.games())
  .filter(
    (g) =>
      g.data.season === "2025-26" &&
      [g.data.home_team_id, g.data.away_team_id].includes("1610612738"),
  )
  .map((g) => ({
    gameId: g.id,
    scheduledStart: g.data.scheduled_tipoff as string,
  }))
  .sort(
    (a, b) =>
      a.scheduledStart.localeCompare(b.scheduledStart) ||
      a.gameId.localeCompare(b.gameId),
  );
if (schedule.length !== 82) throw Error("expected 82 games");
const first20 = schedule.slice(0, 20);
const current = (
  await loadReplayInputs(
    corpus,
    await auditPregames(
      corpus,
      first20.map((g) => g.gameId),
      mappings,
    ),
  )
).map((input) => buildDataset(input));
const prior = await loadPriorSeasonTraining(corpus);
const rows: string[] = [];
const emit = (d: any, season: string, index: number, start: string) => {
  for (const w of d.windows)
    rows.push(
      JSON.stringify({
        season,
        index,
        gameId: d.gameId,
        scheduledStart: start,
        window: w,
      }),
    );
};
first20.forEach((g, i) =>
  emit(
    current.find((d) => d.gameId === g.gameId),
    "2025-26",
    i + 1,
    g.scheduledStart,
  ),
);
const priorGames = (await corpus.priorPbp.games())
  .filter((g) => prior.some((d) => d.gameId === g.id))
  .sort((a, b) => a.data.scheduled_tipoff.localeCompare(b.data.scheduled_tipoff));
priorGames.forEach((g, i) =>
  emit(
    prior.find((d) => d.gameId === g.id),
    "2024-25",
    i + 1,
    g.data.scheduled_tipoff,
  ),
);
writeFileSync(`${out}/windows.jsonl`, rows.join("\n") + "\n");
writeFileSync(
  `${out}/datasets.json`,
  JSON.stringify({
    dev: first20.slice(0, 10).map((g) => current.find((d) => d.gameId === g.gameId)),
    warm: first20.slice(10, 20).map((g) => current.find((d) => d.gameId === g.gameId)),
    prior,
  }),
);
writeFileSync(
  `${out}/schedule.json`,
  JSON.stringify(first20.map((g, i) => ({ ...g, index: i + 1 })), null, 1),
);
console.log(
  `windows=${rows.length} current=${current.length} prior=${prior.length}`,
);
