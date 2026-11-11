import { referenceStarterPredictions } from "./lib/starter-parity.js";
// Offline official-data acceptance; no provider calls.
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  createReadStream,
  createWriteStream,
} from "node:fs";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { openCorpus } from "../src/data/corpus.js";
import { DopplerStore } from "../src/data/store.js";
import {
  exportStarterTraining,
  fitStarter,
  starterPredictor,
  STARTER_SPEC,
} from "../src/starter/model.js";
import { auditPregames, loadReplayInputs } from "../src/replay/load.js";
import { buildDataset } from "../src/replay/dataset.js";
import { DockerAssembler } from "../src/policy/sandbox.js";
import { scoreWindow, summarize } from "../src/replay/scoring.js";
import { auditCodeRevision } from "./lib/audit-revision.js";
const codeRevision = auditCodeRevision();
if (codeRevision.endsWith("-dirty"))
  throw Error("Commit implementation before recording acceptance evidence");
const image = process.argv.find((a) => a.startsWith("--image="))?.slice(8);
if (!image) throw Error("Pass --image");
const macReference = process.argv.includes("--verify-spo873")
  ? JSON.parse(
      readFileSync("docs/evidence/starter-model/spo873-scores.json", "utf8"),
    )
  : undefined;
const root = ".cache/starter-development";
mkdirSync(root, { recursive: true });
const signal = new AbortController().signal;
const store = new DopplerStore();
try {
  const corpus = await openCorpus(store, process.cwd(), ".cache/objects");
  const games = (await corpus.pbp.games())
    .filter(
      (g) =>
        g.data.season === "2025-26" &&
        [g.data.home_team_id, g.data.away_team_id].includes("1610612738"),
    )
    .sort((a, b) =>
      a.data.scheduled_tipoff.localeCompare(b.data.scheduled_tipoff),
    )
    .slice(0, 10);
  const prior = join(root, "prior.jsonl");
  const out = createWriteStream(prior);
  for await (const line of createInterface({
    input: createReadStream(".cache/starter-audit/training.jsonl"),
  })) {
    if (JSON.parse(line).season === "2024-25") out.write(line + "\n");
  }
  out.end();
  await new Promise<void>((resolve) => out.on("finish", resolve));
  const datasets = (
    await loadReplayInputs(
      corpus,
      await auditPregames(
        corpus,
        games.map((g) => g.id),
        JSON.parse(readFileSync("config/identities.json", "utf8")),
      ),
    )
  ).map((input) => buildDataset(input));
  const contract = JSON.parse(
    readFileSync("docs/evidence/policy/gate2-code-fixture.json", "utf8"),
  ).swapContract;
  const results = [];
  const fits = [];
  for (const g of games) {
    const game = { gameId: g.id, scheduledStart: g.data.scheduled_tipoff };
    const dir = join(root, g.id);
    mkdirSync(dir, { recursive: true });
    const current = join(dir, "current.jsonl");
    await exportStarterTraining(corpus, game.scheduledStart, current, signal, [
      "2025-26",
    ]);
    const input = join(dir, "training.jsonl");
    await pipeline(createReadStream(prior), createWriteStream(input));
    await pipeline(
      createReadStream(current),
      createWriteStream(input, { flags: "a" }),
    );
    const fit = await fitStarter({
      input,
      root: mkdtempSync(join(dir, "artifact-")),
      image,
      target: game,
      cutoff: game.scheduledStart,
      signal,
    }).finally(() => {
      rmSync(input, { force: true });
      rmSync(current, { force: true });
    });
    if (macReference) {
      const expected = macReference.fits.find(
        (f: { gameId: string }) => f.gameId === game.gameId,
      )?.hash;
      if (fit.mount.hash !== expected)
        throw Error(
          `Game ${game.gameId}: expected ${expected}, got ${fit.mount.hash}`,
        );
    }
    const assembler = new DockerAssembler(
      image,
      { wallSeconds: 15, memoryBytes: 512 * 1024 * 1024, outputBytes: 256000 },
      fit.mount,
    );
    const predictor = starterPredictor(assembler, root);
    const dataset = datasets.find((d) => d.gameId === g.id)!;
    const windows = dataset.windows.filter(
      (w) => !w.exclusions.length && w.state && w.actual,
    );
    const answers = await predictor.predictBatch!(
      windows.map((w) => w.state!),
      signal,
    );
    const reference = await referenceStarterPredictions(
      image,
      fit.mount.path,
      windows.map((w) => w.state!),
      join(dir, "parity"),
    );
    if (JSON.stringify(answers) !== JSON.stringify(reference.answers)) {
      // JSON key order differs between emitters; compare canonical structures.
      const { canonicalJson } = await import("../src/env/tools.js");
      if (canonicalJson(answers) !== canonicalJson(reference.answers))
        throw Error("Starter baseline differs from reference");
    }
    const scored = windows.map((w, i) =>
      scoreWindow(
        w,
        {
          ...(answers[i].prediction as object),
          candidates: answers[i].candidates,
        },
        null,
        contract,
      ),
    );
    results.push(...scored);
    fits.push({
      ...game,
      hash: fit.mount.hash,
      seconds: fit.seconds,
      rows: fit.rows,
      parity: reference.parity,
      summary: summarize(scored),
    });
    console.log(JSON.stringify(fits.at(-1)));
    writeFileSync(
      join(root, "results.json"),
      JSON.stringify(
        {
          codeRevision,
          image,
          spec: STARTER_SPEC,
          fits,
          summary: summarize(results),
        },
        null,
        2,
      ) + "\n",
    );
  }
  const summary = summarize(results);
  if (fits.length !== 10 || summary.n !== 584)
    throw Error("Incomplete starter development acceptance");
  if (
    macReference &&
    (summary.timingBrier !== macReference.summary.timingBrier ||
      summary.setLogLoss !== macReference.summary.setLogLoss)
  )
    throw Error(
      `Starter score mismatch: Brier ${summary.timingBrier}, set log loss ${summary.setLogLoss}`,
    );
  writeFileSync(
    process.argv.find((a) => a.startsWith("--output="))?.slice(9) ??
      "docs/evidence/starter-model/spo876-scores.json",
    readFileSync(join(root, "results.json")),
  );
} finally {
  store.close();
}
