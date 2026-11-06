import { memoryVariant, type MemoryPermissions } from "../src/env/memory.js";
// Trusted launcher: the only place that holds the Anthropic key, opens the
// corpus, and constructs the runner. The harness receives three handles.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DopplerStore } from "../src/data/store.js";
import { openCorpus } from "../src/data/corpus.js";
import { Identities } from "../src/data/identity.js";
import { corpusSource } from "../src/env/source.js";
import { sessionEnvironment } from "../src/env/session.js";
import { manifest, type RunConfig } from "../src/runner/config.js";
import {
  MeteringProxy,
  anthropicProvider,
  type ModelProvider,
} from "../src/runner/proxy.js";
import { Runner, type Harness } from "../src/runner/runner.js";
import { piHarness } from "../src/harness/pi.js";
import { analystHarness } from "../src/harness/loop.js";
import { presetConfig } from "../src/harness/presets.js";
import { probeForManifest } from "../src/harness/probe.js";

const arg = (name: string, fallback?: string) =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.slice(name.length + 3) ?? fallback;
const flag = (name: string) => process.argv.includes(`--${name}`);

const mode = arg("mode", "analyst")!;
if (arg("revision") || arg("process"))
  throw Error("V2 memory switches are not accepted; select --memory=M0..M4");
const memory = memoryVariant(
  arg("memory", "M0") as MemoryPermissions["variant"],
);
const purpose = arg("purpose", "fixture") as "fixture" | "pilot";
const runId = arg("run-id", `${mode}-${memory.variant}`)!;
const replicateId = arg("replicate", "r1")!;
const root = resolve(arg("root", ".cache/runs")!);
const probeFile = arg("probe");

if (!flag("infrastructure-only"))
  throw Error(
    "The v2 task is not implemented. Use --infrastructure-only explicitly for unscored infrastructure diagnostics.",
  );

const store = new DopplerStore();
try {
  const corpus = await openCorpus(store, process.cwd(), ".cache/objects");
  const ids = new Identities();
  for (const m of JSON.parse(await readFile("config/identities.json", "utf8")))
    ids.add(m);
  const source = await corpusSource(corpus, ids);
  const games = (await source.games()).filter(
    (g) =>
      g.data.season === "2025-26" &&
      [g.data.home_team_id, g.data.away_team_id].includes("1610612738"),
  );
  if (mode !== "analyst") throw Error(`Unknown mode: ${mode}`);
  const implementation = arg("harness", "pi");
  if (implementation !== "pi" && implementation !== "homemade")
    throw Error("Unknown harness");
  const config = presetConfig({
    harness: implementation,
    runId,
    replicateId,
    purpose,
    memory,
    dataSources: source.versions,
    effort: arg("effort", "high") as RunConfig["harness"]["loop"]["effort"],
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
  const provider: ModelProvider = anthropicProvider(
    process.env.ANTHROPIC_API_KEY ??
      (() => {
        throw Error("ANTHROPIC_API_KEY is not set; run under doppler run");
      })(),
  );
  const harness: Harness = (config.harness.pi ? piHarness : analystHarness)({
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
