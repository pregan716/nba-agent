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
import {
  percentiles,
  quantities,
  type Range,
} from "../src/projection/forecast.js";
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
const levels = [0, ...percentiles.map((p) => p / 100), 1];
function minutes(p: number, r: Range) {
  const values = [0, ...r, r[6] + r[6] - r[5]];
  const mean =
    p *
    values
      .slice(1)
      .reduce(
        (s, x, i) => s + (x + values[i]) * 0.5 * (levels[i + 1] - levels[i]),
        0,
      );
  function quantile(t: number) {
    if (t <= 1 - p || p === 0) return 0;
    const u = (t - (1 - p)) / p;
    const i = levels.findIndex((l, j) => j > 0 && l >= u);
    return (
      values[i - 1] +
      ((values[i] - values[i - 1]) * (u - levels[i - 1])) /
        (levels[i] - levels[i - 1])
    );
  }
  return { mean, quantile };
}
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
  const coverage = Object.fromEntries(
    quantities.map((q) => [q, { n: 0, inside1090: 0, inside2575: 0 }]),
  );
  const conditionalMinutes = { n: 0, inside1090: 0, inside2575: 0 };
  const perGame = [];
  for (const game of games) {
    const record = forecasts.get(game.gameId)!;
    // Read only this game's outcomes at release. Never open game 71 to score game 70.
    const actual = (
      await source.outcomes(
        game,
        new Date(Date.parse(game.release) + 1).toISOString(),
      )
    ).players.filter((p) => p.teamId === BOS);
    const box = new Map(actual.map((p) => [p.playerId, p]));
    const forecast = new Map(
      record.forecast.players.map((p) => [p.playerId, p]),
    );
    let expectedBox = 0,
      medianRoster = 0;
    for (const a of actual) {
      const f = forecast.get(a.playerId);
      if (!f && a.played)
        throw Error(
          "Played outside dated roster: " + game.gameId + " " + a.playerId,
        );
      expectedBox +=
        Math.abs(a.minutes - (f ? minutes(f.p_play, f.minutes).mean : 0)) / 2;
    }
    for (const f of forecast.values()) {
      const a = box.get(f.playerId),
        dist = minutes(f.p_play, f.minutes);
      medianRoster += Math.abs((a?.minutes ?? 0) - dist.quantile(0.5)) / 2;
      if (a?.played) {
        conditionalMinutes.n++;
        conditionalMinutes.inside1090 += Number(
          f.minutes[1] <= a.minutes && a.minutes <= f.minutes[5],
        );
        conditionalMinutes.inside2575 += Number(
          f.minutes[2] <= a.minutes && a.minutes <= f.minutes[4],
        );
      }
      for (const q of quantities) {
        if (q !== "minutes" && !a?.played) continue;
        const y = a?.[q] ?? 0,
          r = f[q],
          c = coverage[q];
        const quant = (level: number, index: number) =>
          q === "minutes" ? dist.quantile(level) : r[index];
        c.n++;
        c.inside1090 += Number(quant(0.1, 1) <= y && y <= quant(0.9, 5));
        c.inside2575 += Number(quant(0.25, 2) <= y && y <= quant(0.75, 4));
      }
    }
    perGame.push({
      gameId: game.gameId,
      modelHash: record.modelHash,
      expectedBox,
      medianRoster,
    });
  }
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
        coverage,
        conditionalMinutes,
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
