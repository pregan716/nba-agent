// Offline SPO-879 audit. Schedule metadata fixes the population before any outcome is opened.
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { PlayByPlayAdapter } from "../src/data/adapters.js";
import { openCorpus } from "../src/data/corpus.js";
import { DopplerStore } from "../src/data/store.js";
import { projectionSource } from "../src/projection/input.js";
import {
  projectionModel,
  referenceTables,
} from "../src/projection/reference.js";
import { auditGames } from "../src/projection/audit.js";
import { BOS } from "../src/replay/types.js";

const [image, output, root = ".cache/reference-projection", count = "70"] =
  process.argv.slice(2);
if (!image || !output)
  throw Error(
    "Usage: tsx scripts/reference-audit.ts PINNED_IMAGE OUTPUT_JSON [receipt-directory]",
  );
const gameCount = Number(count);
if (!Number.isInteger(gameCount) || gameCount < 1 || gameCount > 70)
  throw Error("Audit supports games 1–70 only");
const store = new DopplerStore();
try {
  const corpus = await openCorpus(store, process.cwd(), ".cache/objects");
  corpus.pbp = new PlayByPlayAdapter(corpus.pbp.release, true);
  const source = await projectionSource(corpus);
  const games = source.schedule
    .filter((g) => g.boston && g.season === "2025-26")
    .sort((a, b) => a.tip.localeCompare(b.tip))
    .slice(0, gameCount);
  if (games.length !== gameCount) throw Error("Incomplete schedule");
  const last = games[gameCount - 1],
    model = projectionModel(image);
  const timedFit = {
    ...model,
    fit: (d: Parameters<typeof model.fit>[0]) => {
      console.error("Fitting", d.gameId, d.tip);
      return model.fit(d);
    },
  };
  const start = performance.now();
  const tables = await referenceTables(source, last.gameId, root, timedFit);
  const initialSeconds = (performance.now() - start) / 1000;
  const repeat = performance.now();
  await referenceTables(source, last.gameId, root, model);
  const warmSeconds = (performance.now() - repeat) / 1000;
  const forecasts = new Map(
    [...tables.history, tables.tonight].map((r) => [r.gameId, r]),
  );
  const scoredGames = [];
  for (const game of games) {
    // Read only this game's outcomes at release. Never open game 71 to score game 70.
    const boston = (
      await source.outcomes(
        game,
        new Date(Date.parse(game.release) + 1).toISOString(),
      )
    ).players.filter((p) => p.teamId === BOS);
    scoredGames.push({
      forecast: forecasts.get(game.gameId)!.forecast,
      boston,
    });
  }
  const counts = auditGames(scoredGames);
  const perGame = games.map((game, i) => ({
    gameId: game.gameId,
    modelHash: forecasts.get(game.gameId)!.modelHash,
    ...counts.perGame[i],
  }));
  writeFileSync(
    output,
    JSON.stringify(
      {
        harnessHash: tables.harnessHash,
        image,
        games: perGame.length,
        expectedBox:
          perGame.reduce((s, g) => s + g.expectedBox, 0) / games.length,
        medianRoster:
          perGame.reduce((s, g) => s + g.medianRoster, 0) / games.length,
        coverage: counts.all.coverage,
        conditionalMinutes: counts.all.conditionalMinutes,
        tails: counts.all.tails,
        // Games 21-70: the same counters over the scored split.
        scored: counts.scored,
        initialSeconds,
        warmSeconds,
        perGame,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  store.close();
}
