// Offline real-history acceptance: data reads and Docker only, no model providers.
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import {
  fitStarter,
  exportStarterTraining,
  starterPredictor,
} from "../src/starter/model.js";
import { join } from "node:path";
import { openCorpus } from "../src/data/corpus.js";
import { DopplerStore } from "../src/data/store.js";
import { loadBacktestData } from "../src/replay/load.js";
import {
  backtestPackage,
  cachedBacktestSource,
} from "../src/policy/backtest.js";
import { DockerAssembler } from "../src/policy/sandbox.js";
import { auditCodeRevision } from "./lib/audit-revision.js";
const image = process.argv.find((a) => a.startsWith("--image="))?.slice(8);
if (!image) throw Error("Pass --image=<pinned assembler image>");
const codeRevision = auditCodeRevision();

const store = new DopplerStore();
const lifetime = new AbortController();
const cutoff = "2025-12-12T01:00:00Z",
  gameId = "0022501206";
let assembler = new DockerAssembler(image, {
  wallSeconds: 15,
  memoryBytes: 512 * 1024 * 1024,
  outputBytes: 256000,
});
mkdirSync(".cache/policy", { recursive: true });
const root = mkdtempSync(".cache/policy/backtest-"),
  workspace = join(root, "workspace");
mkdirSync(join(workspace, "packages"), { recursive: true });
cpSync("examples/policy-starter", join(workspace, "packages", gameId), {
  recursive: true,
});
// The same pinned warm-up size prior used by the merged v3 acceptance replay.
const contract = JSON.parse(
  readFileSync("docs/evidence/policy/gate2-code-fixture.json", "utf8"),
).swapContract;
try {
  const corpus = await openCorpus(store, process.cwd(), ".cache/objects");
  const current = join(root, "current.jsonl"),
    input = join(root, "training.jsonl");
  await exportStarterTraining(corpus, cutoff, current, lifetime.signal, [
    "2025-26",
  ]);
  await pipeline(
    createReadStream(".cache/starter-development/prior.jsonl"),
    createWriteStream(input),
  );
  await pipeline(
    createReadStream(current),
    createWriteStream(input, { flags: "a" }),
  );
  const fitted = await fitStarter({
    input,
    root: join(root, "artifact"),
    image,
    target: { gameId, scheduledStart: cutoff },
    cutoff,
    signal: lifetime.signal,
  });
  assembler = assembler.withStarter(fitted.mount);
  const starter = starterPredictor(assembler, root);
  console.log(
    JSON.stringify({ fitSeconds: fitted.seconds, model: fitted.mount.hash }),
  );
  let historyLoads = 0,
    loadingSeconds = 0;
  const source = cachedBacktestSource(async (at, signal) => {
    historyLoads++;
    const start = performance.now();
    const data = await loadBacktestData(corpus, at, signal);
    loadingSeconds += (performance.now() - start) / 1000;
    console.log(
      JSON.stringify({
        historyLoads,
        loadingSeconds,
        games: data.games.length,
      }),
    );
    return data;
  }, lifetime.signal);
  const results = [];
  for (const call of ["cold", "cached"]) {
    const result = await backtestPackage({
      root,
      workspace,
      gameId,
      cutoff,
      clock: () => new Date(Date.parse(cutoff) - 1).toISOString(),
      assembler,
      starter,
      contract,
      source,
      allowance: 120,
      signal: new AbortController().signal,
      input: {},
    });
    results.push({ call, ...result });
    console.log(
      JSON.stringify({
        call,
        complete: result.complete,
        error: result.error,
        eligible: result.eligibleWindows,
        scored: result.summary.scored,
        computeSeconds: result.computeSeconds,
      }),
    );
  }
  const evidence = {
    codeRevision,
    fitted: {
      ...fitted,
      mount: Object.fromEntries(
        Object.entries(fitted.mount).filter(([key]) => key !== "path"),
      ),
    },
    image,
    gameId,
    cutoff,
    allowanceSeconds: 120,
    historyLoads,
    loadingSeconds,
    contract,
    results,
  };
  writeFileSync(
    "docs/evidence/policy/backtest-spo873.json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
  if (
    !results.every(
      (r) =>
        (r.complete || r.error === "compute_limit") &&
        r.eligibleWindows === 5397 &&
        r.summary.scored > 0 &&
        r.starter?.summary?.n === r.summary.scored &&
        (r.starter?.errors?.length ?? 0) === 0 &&
        Object.keys(r.invalidByReason).length === 0,
    ) ||
    historyLoads !== 1
  )
    throw Error("Starter backtest measurement failed");
} finally {
  lifetime.abort();
  await store.close();
}
