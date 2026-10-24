// Trusted launcher: the only place that holds the Anthropic key, opens the
// corpus, and constructs the runner. The harness receives three handles.
//
//   doppler run --project nba-agent --config prd -- npx tsx scripts/run.ts \
//     --mode analyst --memory season --purpose pilot --run-id pilot-b-1
//   npx tsx scripts/run.ts --mode market --purpose fixture --run-id market-1
//
// Modes: analyst | market | naive-stats | random-deviation. Baselines make no
// model calls and need no API key. --purpose pilot runs the ten development
// games; fixture runs the whole schedule. --code enables the sandbox and needs
// `npm run sandbox:build` to have produced .cache/sandbox-image.json.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DopplerStore } from "../src/data/store.js";
import { openCorpus } from "../src/data/corpus.js";
import { Identities } from "../src/data/identity.js";
import { loadQuestionLayer } from "../src/questions/builder.js";
import { corpusSource } from "../src/env/source.js";
import { sessionEnvironment } from "../src/env/session.js";
import { manifest, type RunConfig } from "../src/runner/config.js";
import {
  MeteringProxy,
  anthropicProvider,
  type ModelProvider,
} from "../src/runner/proxy.js";
import { Runner, type Harness } from "../src/runner/runner.js";
import { analystHarness } from "../src/harness/loop.js";
import {
  marketBaseline,
  naiveStatsBaseline,
  randomDeviationBaseline,
} from "../src/harness/baselines.js";
import { presetConfig } from "../src/harness/presets.js";
import type { BaselineName } from "../src/harness/version.js";
import { probeForManifest } from "../src/harness/probe.js";

const arg = (name: string, fallback?: string) =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.slice(name.length + 3) ?? fallback;
const flag = (name: string) => process.argv.includes(`--${name}`);

const mode = arg("mode", "market")!;
const memory: RunConfig["profile"]["memory"] = {
  version: "memory-v1",
  horizon: arg("memory", "stateless") as "stateless" | "season",
  revision: arg("revision", "editable") as "editable" | "append-only",
  process: arg("process", "voluntary") as "voluntary" | "mandated-reflection",
};
const purpose = arg("purpose", "fixture") as "fixture" | "pilot";
const runId = arg("run-id", `${mode}-${memory.horizon}`)!;
const replicateId = arg("replicate", "r1")!;
const seed = Number(arg("seed", "1"));
const root = resolve(arg("root", ".cache/runs")!);
const probeFile = arg("probe");

const store = new DopplerStore();
try {
  const corpus = await openCorpus(store, process.cwd(), ".cache/objects");
  const ids = new Identities();
  for (const m of JSON.parse(await readFile("config/identities.json", "utf8")))
    ids.add(m);
  const source = await corpusSource(
    corpus,
    await loadQuestionLayer(corpus.odds, ids),
    ids,
  );
  const games = (await source.games()).filter(
    (g) =>
      g.data.season === "2025-26" &&
      [g.data.home_team_id, g.data.away_team_id].includes("1610612738"),
  );
  const baseline = (
    ["market", "naive-stats", "random-deviation"] as BaselineName[]
  ).find((b) => b === mode);
  if (!baseline && mode !== "analyst") throw Error(`Unknown mode: ${mode}`);
  const config = presetConfig({
    runId,
    replicateId,
    purpose,
    memory,
    dataSources: source.versions,
    devig: {
      layer: "consensus/proportional/v1",
      manifestSha256: source.layer.manifest.sha256,
      methodologySha256: source.layer.methodology.sha256,
    },
    effort: arg("effort", "high") as RunConfig["harness"]["loop"]["effort"],
    baseline,
    seed: baseline === "random-deviation" ? seed : undefined,
    codeExecution: flag("code"),
    contaminationProbe: probeFile
      ? probeForManifest(JSON.parse(await readFile(probeFile, "utf8")))
      : null,
  });
  const m = manifest(
    config,
    games.map((g) => ({
      gameId: g.id,
      scheduledStart: g.data.scheduled_tipoff,
    })),
  );
  const provider: ModelProvider = baseline
    ? {
        count: async () => {
          throw Error("Baselines make no model calls");
        },
        create: async () => {
          throw Error("Baselines make no model calls");
        },
      }
    : anthropicProvider(
        process.env.ANTHROPIC_API_KEY ??
          (() => {
            throw Error("ANTHROPIC_API_KEY is not set; run under doppler run");
          })(),
      );
  const harness: Harness =
    baseline === "market"
      ? marketBaseline
      : baseline === "naive-stats"
        ? naiveStatsBaseline()
        : baseline === "random-deviation"
          ? randomDeviationBaseline(seed)
          : analystHarness({
              model: config.profile.modelRoles.analyst,
              process: memory.process,
              onTurn: (e) =>
                console.error(
                  JSON.stringify({
                    phase: e.phase,
                    turn: e.turn,
                    stop: e.stopReason,
                    tools: e.toolCalls,
                  }),
                ),
            });
  const proxy = new MeteringProxy(provider);
  await proxy.listen();
  const runner = new Runner(root, m, proxy, sessionEnvironment(config, source));
  try {
    console.error(
      JSON.stringify({
        run: runId,
        replicate: replicateId,
        harnessVersion: m.harnessVersion,
        games: m.games.length,
        purpose,
      }),
    );
    await runner.run(harness);
    const ends = runner.record.events("phase_end");
    const statuses: Record<string, number> = {};
    for (const e of ends)
      statuses[e.data.status] = (statuses[e.data.status] ?? 0) + 1;
    console.log(
      JSON.stringify({
        root: runner.root,
        submissions: runner.record.events("submission").length,
        phases: ends.length,
        statuses,
      }),
    );
  } finally {
    runner.close();
    await proxy.close();
  }
} finally {
  store.close();
}
