import { historyExportCacheDirectory } from "../src/env/cache.js";
import { DopplerStore } from "../src/data/store.js";
import { openCorpus } from "../src/data/corpus.js";
import { Identities } from "../src/data/identity.js";
import { loadQuestionLayer } from "../src/questions/builder.js";
import { corpusSource } from "../src/env/source.js";
import { Session } from "../src/env/session.js";
import { fixtureConfig } from "../test/fixtures/runner/support.js";
import { manifest } from "../src/runner/config.js";
import { readFile, mkdir, mkdtemp, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
async function bytes(dir: string): Promise<number> {
  let size = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    size += entry.isDirectory() ? await bytes(path) : (await stat(path)).size;
  }
  return size;
}
await mkdir(".cache", { recursive: true });
const root = await mkdtemp(".cache/export-benchmark-");
console.log(
  JSON.stringify({ root, objectCache: "existing verified on-disk cache" }),
);
const store = new DopplerStore();
try {
  const c = await openCorpus(store, process.cwd(), ".cache/objects");
  const ids = new Identities();
  for (const m of JSON.parse(await readFile("config/identities.json", "utf8")))
    ids.add(m);
  const requestedCache =
    process.argv[2] ?? process.env.NBA_HISTORY_EXPORT_CACHE;
  const shardCache = historyExportCacheDirectory(
    process.argv[2] ??
      (process.env.NBA_HISTORY_EXPORT_CACHE === undefined
        ? join(root, "shards")
        : undefined),
  );
  const source = await corpusSource(
    c,
    await loadQuestionLayer(c.odds, ids),
    ids,
    { exportCacheDirectory: shardCache },
  );
  console.log(JSON.stringify({ shardCache }));
  const config = fixtureConfig("live-smoke");
  config.profile.capabilities.enabled = [
    "code_execution",
    "game_history",
    "odds_history",
    "search_and_fetch",
  ];
  config.profile.dataSources = source.versions.map((v) => ({
    type: v.source,
    release: v.release,
    manifestSha256: v.manifest_sha256,
  }));
  config.devig.manifestSha256 = source.layer.manifest.sha256;
  config.devig.methodologySha256 = source.layer.methodology.sha256;
  const gs = (await source.games()).filter(
    (g) =>
      g.data.season === "2025-26" &&
      [g.data.home_team_id, g.data.away_team_id].includes("1610612738"),
  );
  const m = manifest(
    config,
    gs.map((g) => ({ gameId: g.id, scheduledStart: g.data.scheduled_tipoff })),
  );
  // Run before other reads so the first measurement has a cold parsed-row cache
  // (the verified on-disk object cache may already be populated).
  const gameNumber = Number(process.argv[3] ?? 41);
  if (
    !Number.isInteger(gameNumber) ||
    gameNumber < 1 ||
    gameNumber > m.games.length
  )
    throw Error("Game number must be in the season schedule");
  const benchmarkGame = m.games[gameNumber - 1];
  for (const pass of [
    requestedCache !== undefined
      ? "configured shard cache"
      : "cold shard cache",
    "warm shard cache",
  ]) {
    const benchmarkSession = new Session(
      config,
      benchmarkGame,
      "postgame",
      benchmarkGame.release,
      source,
    );
    const dir = join(root, pass === "warm shard cache" ? "warm" : "first");
    const started = performance.now();
    await benchmarkSession.exportTo(dir, new AbortController().signal);
    console.log(
      JSON.stringify({
        pass,
        gameNumber,
        cutoff: benchmarkGame.release,
        seconds: (performance.now() - started) / 1000,
        bytes: await bytes(dir),
        sessionBytes: (await stat(join(dir, "session.sqlite"))).size,
        gameShards: (await readdir(join(dir, "games"))).length,
      }),
    );
  }
} finally {
  await store.close();
}
