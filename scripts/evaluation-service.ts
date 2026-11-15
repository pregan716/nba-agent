import { architectIteration } from "../src/architect/session.js";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { DopplerStore } from "../src/data/store.js";
import { openCorpus } from "../src/data/corpus.js";
import { fiveTeamData, fiveTeamReplay } from "../src/data/five-team.js";
import { holdoutBoundary } from "../src/data/architect-view.js";
import { specialists } from "../src/game-loop/agents.js";
import { presetConfig } from "../src/harness/presets.js";
import {
  developmentService,
  finalEvaluation,
} from "../src/evaluation/service/index.js";
import { developmentRequest } from "../src/evaluation/service/profile.js";
import { submissionKinds } from "../src/architect/tools.js";
import { z } from "zod";

import { seasonScanner } from "../src/evaluation/review/catalog.js";
import { reviewer } from "../src/evaluation/review/reviewer.js";

const [mode, dir, sandboxImage, projectionImage, ...args] =
  process.argv.slice(2);
if (
  ![
    "architect",
    "evaluate",
    "list",
    "archive",
    "compare",
    "refusals",
    "final",
  ].includes(mode) ||
  !dir ||
  ![sandboxImage, projectionImage].every(
    (s) => s && /@sha256:[a-f0-9]{64}$/.test(s),
  )
)
  throw Error(
    "Usage: npm run evaluation -- MODE POOL_DIRECTORY PINNED_SANDBOX PINNED_PROJECTION [REQUEST_FILE | RUN_ID ... | --only=KIND,...]",
  );
// `architect ... --only=test` restricts what that iteration may submit.
const only =
  mode === "architect" && args[0]?.startsWith("--only=")
    ? z.array(z.enum(submissionKinds)).min(1).parse(args[0].slice(7).split(","))
    : undefined;
if (mode === "architect" && args.length && !only)
  throw Error("Unknown architect option");
const request =
  mode === "evaluate"
    ? developmentRequest.parse(JSON.parse(readFileSync(args[0], "utf8")))
    : undefined;
const store = new DopplerStore();
try {
  const data = await fiveTeamData(
    await openCorpus(store, process.cwd(), ".cache/objects"),
  );
  const root = resolve(dir);
  const config = presetConfig({
    harness: "pi",
    runId: "evaluation-service",
    replicateId: "v5",
    purpose: "scored",
    memory: {
      version: "forecast-memory-v1",
      horizon: "stateless",
      revision: "editable",
      process: "voluntary",
    },
    dataSources: data.data.versions,
  });
  config.profile.capabilities.enabled.push("code_execution");
  config.harness.sandboxImage = sandboxImage;
  config.harness.projectionImage = projectionImage;
  const source = await fiveTeamReplay(
    data,
    projectionImage,
    join(root, "reference"),
    mode === "final" ? undefined : holdoutBoundary(data.games),
  );
  let scan: ReturnType<typeof seasonScanner> | undefined;
  const host = {
    review: {
      async scan(raw: unknown) {
        scan ??= seasonScanner(data);
        return (await scan)(raw);
      },
      reviewer: reviewer(),
    },
    root,
    config,
    source,
    training: data,
    runAgent: specialists({
      anthropic: process.env.ANTHROPIC_API_KEY,
      typesafe: process.env.TYPESAFE_API_KEY,
    }),
  };
  if (mode === "architect")
    console.log(JSON.stringify(await architectIteration(host, { only })));
  else if (mode === "final")
    console.log(JSON.stringify(await finalEvaluation(host, args[0])));
  else {
    const service = developmentService(host);
    try {
      const result =
        mode === "evaluate"
          ? await service.evaluate(request)
          : mode === "compare"
            ? service.compare(args[0], args[1])
            : mode === "archive"
              ? service.archive(args[0])
              : mode === "refusals"
                ? service.refusals()
                : service.list();
      console.log(JSON.stringify(result));
    } finally {
      service.close();
    }
  }
} finally {
  store.close();
}
