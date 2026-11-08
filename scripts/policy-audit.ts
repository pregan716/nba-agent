import { pinSwapContract } from "../src/replay/swap.js";
import { probeSwap } from "../src/policy/probe.js";
import {
  readFileSync,
  mkdirSync,
  mkdtempSync,
  cpSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { openCorpus } from "../src/data/corpus.js";
import { DopplerStore } from "../src/data/store.js";
import { auditPregames, loadReplayInputs } from "../src/replay/load.js";
import { buildDataset } from "../src/replay/dataset.js";
import { REPLAY_VERSIONS } from "../src/replay/types.js";
import { DockerAssembler } from "../src/policy/sandbox.js";
import { PackageStore } from "../src/policy/package.js";
import {
  replayPolicy,
  policyVersion,
  policyHarness,
} from "../src/policy/replay.js";
import { PolicyTools } from "../src/policy/tools.js";
import { probeJev, type ProbeFact } from "../src/policy/probe.js";
import { MeteringProxy, systemOneProvider } from "../src/runner/proxy.js";
import { RecordStore } from "../src/runner/record.js";
import { auditCodeRevision } from "./lib/audit-revision.js";
import { JEV_MODEL } from "../src/policy/request.js";
import { nextMorning } from "../src/data/time.js";
import { Temporal } from "@js-temporal/polyfill";
const image = process.argv.find((a) => a.startsWith("--image="))?.slice(8);
if (!image) throw Error("Pass --image=<pinned assembler image>");
const swap = process.argv.includes("--swap");
const live = process.argv.includes("--live"),
  codeRevision = auditCodeRevision();
const assembler = new DockerAssembler(image, {
  wallSeconds: 15,
  memoryBytes: 128 * 1024 * 1024,
  outputBytes: 256000,
});
const signal = new AbortController().signal;
const proxy = new MeteringProxy(
  {
    count: async () => 0,
    create: async () => {
      throw Error("No analyst in gate 2");
    },
  },
  live
    ? systemOneProvider(process.env.TYPESAFE_API_KEY ?? "")
    : {
        create: async (r) => ({
          model: JEV_MODEL,
          answers: Object.fromEntries(
            Object.entries(r.questions).map(([key, q]) => [
              key,
              q.type === "noul"
                ? { type: "noul", noul: 0.5 }
                : {
                    type: q.type,
                    probabilities: Object.fromEntries(
                      (Array.isArray(q.criteria)
                        ? q.criteria.map((_, i) => String(i))
                        : Object.keys(q.criteria)
                      ).map((k, _, a) => [k, 1 / a.length]),
                    ),
                  },
            ]),
          ),
          usage: { input_tokens: 0, output_tokens: 0 },
        }),
      },
);
const raw = new DopplerStore();
try {
  const c = await openCorpus(raw, process.cwd(), ".cache/objects");
  const id = "0022500083";
  const [input] = await loadReplayInputs(
    c,
    await auditPregames(
      c,
      [id],
      JSON.parse(readFileSync("config/identities.json", "utf8")),
    ),
  );
  const dataset = buildDataset(input);
  let swapContract;
  if (swap) {
    const games = await c.pbp.games();
    const schedule = [];
    for await (const g of games)
      if (
        [g.data.home_team_id, g.data.away_team_id].includes("1610612738") &&
        g.data.phase === "regular_season"
      )
        schedule.push(g);
    schedule.sort((a, b) =>
      String(a.data.scheduled_tipoff).localeCompare(
        String(b.data.scheduled_tipoff),
      ),
    );
    const warmup = schedule.slice(10, 20).map((g) => g.id);
    if (warmup.length !== 10) throw Error("Ten warm-up games required");
    swapContract = pinSwapContract(
      (
        await loadReplayInputs(
          c,
          await auditPregames(
            c,
            warmup,
            JSON.parse(readFileSync("config/identities.json", "utf8")),
          ),
        )
      ).map((input) => buildDataset(input)),
    );
  }
  mkdirSync(".cache/policy", { recursive: true });
  const root = mkdtempSync(".cache/policy/gate2-");
  const workspace = join(root, "workspace"),
    source = join(workspace, "packages", id);
  mkdirSync(source, { recursive: true });
  cpSync(swap ? "examples/policy-swap" : "examples/policy", source, {
    recursive: true,
  });
  const start = input.game.scheduledStart,
    clock = () => new Date(Date.parse(start) - 1).toISOString();
  const packages = new PackageStore(join(root, "frozen-packages"));
  const receipt = await packages.freeze(
    id,
    source,
    clock,
    start,
    assembler,
    signal,
  );
  const releaseAt = nextMorning(
    Temporal.Instant.from(start)
      .toZonedDateTimeISO("America/New_York")
      .toPlainDate()
      .toString(),
  );
  const versions = {
    handwritten: policyVersion(assembler, receipt, codeRevision, swapContract),
    generic: policyVersion(assembler, null, codeRevision, swapContract),
  };
  const facts: ProbeFact[] = [
    {
      id: "boston_won_opener",
      question:
        "Did the Boston Celtics win their NBA regular-season game against Philadelphia on October 22, 2025?",
      truth: false,
      source: dataset.release.sha256,
    },
    {
      id: "philadelphia_won_opener",
      question:
        "Did the Philadelphia 76ers win their NBA regular-season game against Boston on October 22, 2025?",
      truth: true,
      source: dataset.release.sha256,
    },
  ];
  const probeRecord = new RecordStore<any>(join(root, "probe"), {
    kind: "jev-probe",
    model: JEV_MODEL,
    codeRevision,
  });
  let probe;
  try {
    probe = swap
      ? await probeSwap(proxy, probeRecord, signal)
      : await probeJev(facts, proxy, probeRecord, signal);
  } finally {
    probeRecord.close();
  }
  const record = new RecordStore<any>(root, {
    schemaVersion: 1,
    kind: "replay-mvp",
    releaseManifestSha256: dataset.release.sha256,
    datasetVersion: dataset.version,
    datasets: [{ gameId: id, inputHash: dataset.inputHash }],
    harness: {
      ...REPLAY_VERSIONS,
      policy: policyHarness(assembler, swapContract),
    },
    predictors: Object.fromEntries(
      Object.entries(versions).map(([id, policy]) => [id, { id, policy }]),
    ),
    codeRevision,
    live,
    jevContaminationProbe: probe,
  });
  try {
    const reports = [];
    for (const [predictorId, frozen] of [
      ["generic", null],
      ["handwritten", receipt],
    ] as const) {
      if (swap && predictorId === "generic") continue;
      const trace = await replayPolicy({
        dataset,
        predictorId,
        record,
        proxy,
        assembler,
        receipt: frozen,
        packagePath: join(packages.path(id), "package"),
        signal,
        releaseAt,
        codeRevision,
        swapContract,
      });
      const service = new PolicyTools(
        join(root, predictorId),
        workspace,
        { gameId: id, scheduledStart: start, release: releaseAt },
        [{ gameId: id, scheduledStart: start, release: releaseAt }],
        assembler,
        [],
        () => releaseAt,
      );
      service.saveFeedback(trace);
      service.readFeedback("postgame");
      reports.push({
        predictorId,
        summary: trace.summary,
        usage: trace.usage,
        windows: trace.windows.length,
      });
      console.log(predictorId, trace.summary, trace.usage);
    }
    record.verify();
    if (swap) {
      const requests = record
        .events("policy_assembly")
        .map((e) => e.data.request);
      const bytes =
        requests.reduce(
          (n, r) => n + Buffer.byteLength(JSON.stringify(r)) + 4096,
          0,
        ) +
        Buffer.byteLength(JSON.stringify(probe.request)) +
        4096;
      console.log(
        JSON.stringify({
          swapAudit: {
            root,
            requests: requests.length + 1,
            conservativeUsdTwoAttempts: (2 * bytes * 0.042) / 1e6,
          },
        }),
      );
    }
    mkdirSync("docs/evidence/policy", { recursive: true });
    writeFileSync(
      `docs/evidence/policy/gate2-${swap ? "swap-" : ""}${live ? "live" : "fixture"}.json`,
      JSON.stringify(
        {
          codeRevision,
          swapContract,
          live,
          gameId: id,
          release: dataset.release,
          datasetVersion: dataset.version,
          inputHash: dataset.inputHash,
          versions,
          package: receipt,
          probe,
          reports,
        },
        null,
        2,
      ) + "\n",
    );
    console.log("Policy record", root);
  } finally {
    record.close();
  }
} finally {
  raw.close();
}
