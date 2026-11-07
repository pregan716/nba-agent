// Trusted launcher: provider credentials never enter the research process.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { memoryVariant, type MemoryPermissions } from "../src/env/memory.js";
import { DopplerStore } from "../src/data/store.js";
import { openCorpus } from "../src/data/corpus.js";
import { Identities } from "../src/data/identity.js";
import { corpusSource } from "../src/env/source.js";
import { manifest, type RunConfig } from "../src/runner/config.js";
import {
  MeteringProxy,
  anthropicProvider,
  systemOneProvider,
} from "../src/runner/proxy.js";
import { RecordStore } from "../src/runner/record.js";
import { piHarness } from "../src/harness/pi.js";
import { verifyLaunchImages } from "../src/launch/images.js";
import { localSandboxImage, presetConfig } from "../src/harness/presets.js";
import { PROMPT_SETS, type PromptSet } from "../src/harness/prompts.js";
import { probeForManifest } from "../src/harness/probe.js";
import { currentCodeRevision } from "../src/harness/version.js";
import { DockerAssembler } from "../src/policy/sandbox.js";
import { policyHarness } from "../src/policy/replay.js";
import {
  auditPregames,
  loadReplayInputs,
  loadPriorSeasonTraining,
  priorValidationSamples,
} from "../src/replay/load.js";
import { buildDataset } from "../src/replay/dataset.js";
import {
  chronologicalRunner,
  replayDescriptor,
  runBaselines,
  validateLaunch,
  diagnosticSelection,
  validationSampleDescriptors,
} from "../src/launch/run.js";
import {
  chronologicalFixture,
  scriptedAnalyst,
  scriptedJev,
} from "./fixtures/chronological.js";

const arg = (name: string, fallback?: string) =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.slice(name.length + 3) ?? fallback;
// Retain provider keys in trusted memory, not in inherited subprocess environments.
const providerKeys: Record<string, string | undefined> = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
};
delete process.env.ANTHROPIC_API_KEY;
delete process.env.TYPESAFE_API_KEY;
const scripted = process.argv.includes("--scripted");
const purpose = arg("purpose", "fixture") as RunConfig["purpose"];
const image = arg("assembler-image", "")!;
const promptSet = arg(
  "prompts",
  purpose === "fixture" ? "infrastructure" : "research-v3",
) as PromptSet;
if (!PROMPT_SETS.includes(promptSet)) throw Error("Unknown prompt set");
validateLaunch(
  purpose,
  image,
  promptSet === "research-v3" ? "pi-research-v3" : "pi-infrastructure-v3",
);
const gameLimit = Number(arg("games", "10"));
if (!image)
  throw Error(
    "Pass --assembler-image=<pinned digest> (npx tsx scripts/assembler-build.ts)",
  );
if (arg("revision") || arg("process"))
  throw Error("V2 memory switches are refused; use --memory=M0..M4");
if (arg("harness", "pi") !== "pi") throw Error("The v3 launcher runs Pi");
const mode = arg("mode", "analyst");
if (mode !== "analyst" && mode !== "baselines") throw Error("Unknown mode");
const memory = memoryVariant(
  arg("memory", "M0") as MemoryPermissions["variant"],
);
const assembler = new DockerAssembler(image, {
  wallSeconds: 15,
  memoryBytes: 128 * 1024 * 1024,
  outputBytes: 256000,
});
const codeExecution = !scripted && mode !== "baselines";
const sandboxImage = codeExecution ? localSandboxImage() : null;
if (codeExecution && !sandboxImage)
  throw Error(
    "Research sandbox image pin is missing; run npm run sandbox:build before launching",
  );
verifyLaunchImages({ assembler: image, sandbox: sandboxImage });
const root = resolve(arg("root", ".cache/runs")!);
const store = scripted ? null : new DopplerStore();
const secret = (name: string) =>
  providerKeys[name] ||
  (() => {
    throw Error(`${name} is required in the launcher process`);
  })();
try {
  const inputs = scripted
    ? (() => {
        const fixture = chronologicalFixture();
        const training = structuredClone(fixture.datasets[0]);
        training.gameId = "training-fixture";
        for (const w of training.windows) {
          w.gameId = training.gameId;
          if (w.state) w.state.gameId = training.gameId;
        }
        return {
          ...fixture,
          training: [training],
          priorTraining: [],
          validationSamples: [],
        };
      })()
    : await (async () => {
        const corpus = await openCorpus(
          store!,
          process.cwd(),
          ".cache/objects",
        );
        const mappings = JSON.parse(
          readFileSync("config/identities.json", "utf8"),
        );
        const ids = new Identities();
        for (const mapping of mappings) ids.add(mapping);
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
          .sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart));
        const selection = diagnosticSelection(schedule, mode, gameLimit);
        const loaded = (
          await loadReplayInputs(
            corpus,
            await auditPregames(
              corpus,
              [...selection.evaluation, ...selection.training].map(
                (g) => g.gameId,
              ),
              mappings,
            ),
          )
        ).map(buildDataset);
        return {
          source,
          schedule,
          priorTraining:
            mode === "baselines" ? await loadPriorSeasonTraining(corpus) : [],
          validationSamples:
            mode === "analyst" ? await priorValidationSamples(corpus) : [],
          datasets: loaded.filter((d) =>
            selection.evaluation.some((g) => g.gameId === d.gameId),
          ),
          training: loaded.filter((d) =>
            selection.training.some((g) => g.gameId === d.gameId),
          ),
        };
      })();
  const {
    source,
    schedule,
    datasets,
    training,
    priorTraining,
    validationSamples,
  } = inputs;
  const config = presetConfig({
    harness: "pi",
    promptSet,
    runId: arg(
      "run-id",
      `${scripted ? "scripted" : "fixture"}-${mode}${mode === "analyst" ? `-${memory.variant}` : ""}`,
    )!,
    replicateId: arg("replicate", "r1")!,
    purpose,
    memory,
    dataSources: source.versions,
    codeExecution,
    contaminationProbe: arg("probe")
      ? probeForManifest(JSON.parse(readFileSync(arg("probe")!, "utf8")))
      : null,
  });
  // Bind the run to the exact sandbox pin checked before loading data.
  if (sandboxImage) config.harness.sandboxImage = sandboxImage;
  config.codeRevision = config.harness.codeRevision = currentCodeRevision();
  config.budget.id = "development-limits-not-a-budget-profile";
  config.harness.policy = policyHarness(assembler);
  config.profile.modelRoles.jev = "jev-1.14.0";
  config.replay = replayDescriptor(
    datasets,
    arg("jev-probe")
      ? JSON.parse(readFileSync(arg("jev-probe")!, "utf8"))
      : undefined,
  );
  config.replay.validationSamples =
    validationSampleDescriptors(validationSamples);
  config.replay.mode = mode === "baselines" ? "baselines" : "variant";
  const proxy = new MeteringProxy(
    scripted
      ? scriptedAnalyst()
      : mode === "baselines"
        ? {
            count: async () => 0,
            create: async () => {
              throw Error("No analyst in baselines");
            },
          }
        : anthropicProvider(secret("ANTHROPIC_API_KEY")),
    scripted ? scriptedJev : systemOneProvider(secret("TYPESAFE_API_KEY")),
  );
  await proxy.listen();
  try {
    if (mode === "baselines") {
      const record = new RecordStore(
        resolve(root, config.runId, config.replicateId),
        manifest(config, schedule),
      );
      try {
        await runBaselines({
          config,
          schedule,
          datasets,
          training,
          priorTraining,
          record,
          assembler,
          proxy,
        });
        if (
          scripted &&
          (record.events("replay_window").length !==
            datasets.reduce((n, d) => n + d.windows.length, 0) * 3 ||
            record.events("replay_window").some((e) => e.data.result.failure))
        )
          throw Error("Scripted baseline acceptance failed");
        console.log(
          JSON.stringify({
            root: record.root,
            mode,
            windows: record.events("replay_window").length,
          }),
        );
      } finally {
        record.close();
      }
    } else {
      const runner = chronologicalRunner({
        validationSamples,
        root,
        config,
        source,
        schedule,
        datasets,
        assembler,
        proxy,
      });
      try {
        await runner.run(
          piHarness({ model: config.profile.modelRoles.analyst, promptSet }),
        );
        if (
          scripted &&
          (runner.record.events("game_end").length !== 2 ||
            runner.record.events("package_freeze").length !== 2 ||
            runner.record.events("replay_completed").length !== 2 ||
            runner.record
              .events("game_end")
              .some((e) => e.data.status !== "completed") ||
            runner.record
              .events("phase_end")
              .some((e) => e.data.status !== "completed") ||
            runner.record
              .events("replay_window")
              .some((e) => e.data.result.failure))
        )
          throw Error("Scripted chronological acceptance failed");
        console.log(
          JSON.stringify({
            root: runner.root,
            mode,
            phases: runner.record
              .events("phase_end")
              .map((e) => ({ scope: e.scope, status: e.data.status })),
            replays: runner.record.events("replay_completed").length,
            halted: !runner.record.events("run_end").length,
          }),
        );
      } finally {
        runner.close();
      }
    }
  } finally {
    await proxy.close();
  }
} finally {
  store?.close();
}
