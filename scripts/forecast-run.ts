import { recordConsensus } from "../src/evaluation/forecast/capture.js";
import { checkpoint } from "../src/runner/sync.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { verifyLaunchImages } from "../src/launch/images.js";
import { openCorpus } from "../src/data/corpus.js";
import { DopplerStore } from "../src/data/store.js";
import { Identities } from "../src/data/identity.js";
import { corpusSource } from "../src/env/source.js";
import { piHarness } from "../src/harness/pi.js";
import { manifest } from "../src/runner/config.js";
import { anthropicProvider, MeteringProxy } from "../src/runner/proxy.js";
import { Runner } from "../src/runner/runner.js";
import { forecastEnvironment } from "../src/projection/environment.js";
import { projectionSource } from "../src/projection/input.js";
import { projectionModel } from "../src/projection/reference.js";
import { forecastProfile } from "../src/projection/profile.js";
import { openingGameLines } from "../src/projection/game-lines.js";

const [
  arm,
  runId,
  replicateId,
  sandboxImage,
  projectionImage,
  base = ".cache/runs",
] = process.argv.slice(2);
if (
  (arm !== "no-memory" && arm !== "full-memory") ||
  !runId ||
  !replicateId ||
  !sandboxImage ||
  !projectionImage
)
  throw Error(
    "Usage: npm run forecast:run -- ARM RUN_ID REPLICATE PINNED_SANDBOX PINNED_PROJECTION [ROOT]",
  );
const key = process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
if (!key) throw Error("Analyst API key required");
verifyLaunchImages({ projection: projectionImage, sandbox: sandboxImage });
const store = new DopplerStore();
const proxy = new MeteringProxy(anthropicProvider(key));
try {
  const corpus = await openCorpus(store, process.cwd(), ".cache/objects");
  const ids = new Identities();
  for (const mapping of JSON.parse(
    readFileSync("config/identities.json", "utf8"),
  ))
    ids.add(mapping);
  const data = await corpusSource(corpus, ids);
  const source = await projectionSource(corpus);
  const config = forecastProfile({
    arm,
    runId,
    replicateId,
    purpose: "pilot",
    dataSources: data.versions,
    sandboxImage,
    projectionImage,
  });
  const schedule = source.schedule
    .filter((g) => g.boston && g.season === config.season)
    .map((g) => ({ gameId: g.gameId, scheduledStart: g.tip }));
  const environment = forecastEnvironment(
    config,
    data,
    source,
    projectionModel(projectionImage),
    await openingGameLines(corpus.odds, ids),
    resolve(".cache/reference-projection"),
  );
  const runner = new Runner(
    resolve(base),
    manifest(config, schedule),
    proxy,
    environment,
  );
  try {
    await proxy.listen();
    try {
      await runner.run(piHarness({ model: config.profile.modelRoles.analyst }));
      await recordConsensus(runner.record, corpus.odds, ids);
      await checkpoint(runner.record);
      if (
        runner.record
          .events("phase_end")
          .some((e) => e.data.status === "infrastructure_failure")
      )
        throw Error("Forecast run contains a failed phase; see run record");
      console.log(runner.root);
    } finally {
      await proxy.close();
    }
  } finally {
    runner.close();
  }
} finally {
  store.close();
}
