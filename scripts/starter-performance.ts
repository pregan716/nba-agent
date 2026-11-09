import { referenceStarterPredictions } from "./lib/starter-parity.js";
import { eligibleBacktestGames, scorePackage } from "../src/policy/backtest.js";
import { summarize } from "../src/replay/scoring.js";
import { StarterBacktestCache } from "../src/starter/backtest.js";
import { BACKTEST_EXECUTION } from "../src/policy/execution.js";
import { STARTER_RUNTIME, verifyStarter } from "../src/starter/model.js";
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
const probe = process.argv.includes("--probe");
if (codeRevision.endsWith("-dirty") && !probe)
  throw Error("Commit implementation before recording acceptance evidence");

const store = new DopplerStore();
const lifetime = new AbortController();
const gameId =
  process.argv.find((a) => a.startsWith("--game-id="))?.slice(10) ??
  "0022501206";
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
  const game = (await corpus.pbp.games()).find((g) => g.id === gameId)!;
  const cutoff = game.data.scheduled_tipoff;
  const artifact = process.argv
    .find((a) => a.startsWith("--artifact="))
    ?.slice(11);
  let fitted;
  if (artifact) {
    const mount = {
      ...JSON.parse(readFileSync(join(artifact, "identity.json"), "utf8")),
      path: artifact,
    };
    verifyStarter(mount);
    if (
      mount.gameId !== gameId ||
      Date.parse(mount.cutoff) !== Date.parse(cutoff)
    )
      throw Error("Wrong artifact cutoff");
    fitted = {
      mount,
      seconds: null,
      rows: JSON.parse(readFileSync(join(artifact, "model.json"), "utf8")).rows,
    };
  } else {
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
    fitted = await fitStarter({
      input,
      root: join(root, "artifact"),
      image,
      target: { gameId, scheduledStart: cutoff },
      cutoff,
      signal: lifetime.signal,
    });
  }
  assembler = assembler.withStarter(fitted.mount);
  const predictor = starterPredictor(assembler, root);
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
  const cacheStart = performance.now();
  const before = new Date(Date.parse(cutoff) - 1).toISOString();
  const history = await source(before, lifetime.signal);
  const starter = await new StarterBacktestCache().prepare(
    predictor,
    history,
    gameId,
    before,
    lifetime.signal,
  );
  const cacheSeconds = (performance.now() - cacheStart) / 1000;
  console.log(JSON.stringify({ cacheSeconds }));
  const results = [];
  for (const call of ["cached"]) {
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
  const windows = eligibleBacktestGames(history, gameId, before).flatMap((g) =>
    g.dataset.windows.filter(
      (w) => !w.exclusions.length && w.state && w.actual,
    ),
  );
  const reference = await referenceStarterPredictions(
    image,
    fitted.mount.path,
    windows.map((w) => w.state!),
    join(root, "parity"),
  );
  const referenceSummary = summarize(
    windows.map(
      (w, i) => scorePackage(w, reference.answers[i], contract).result,
    ),
  );
  const actual = results[0].summary;
  for (const [key, value] of Object.entries(referenceSummary)) {
    if (JSON.stringify(value) !== JSON.stringify((actual as any)[key]))
      throw Error(`Serial score mismatch: ${key}`);
  }
  const evidence = {
    codeRevision,
    parity: reference.parity,
    serialReferenceSummary: referenceSummary,
    execution: BACKTEST_EXECUTION,
    runtime: STARTER_RUNTIME,
    cacheSeconds,
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
    probe
      ? join(root, "probe.json")
      : `docs/evidence/policy/backtest-spo876-${gameId}.json`,
    JSON.stringify(evidence, null, 2) + "\n",
  );
  if (
    !results.every(
      (r) =>
        r.complete &&
        r.eligibleWindows === (gameId === "0022501206" ? 5397 : 8207) &&
        r.summary.scored === r.eligibleWindows &&
        r.starter?.summary?.n === r.summary.scored &&
        (r.starter?.errors?.length ?? 0) === 0 &&
        Object.keys(r.invalidByReason).length === 0,
    ) ||
    historyLoads !== 1
  )
    throw Error(`Starter full-history acceptance failed; output root ${root}`);
} finally {
  lifetime.abort();
  await store.close();
}
