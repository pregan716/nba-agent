import { readFile, mkdir, writeFile, mkdtemp } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { openCorpus } from "../src/data/corpus.js";
import { DopplerStore } from "../src/data/store.js";
import { auditPregames, loadReplayInputs } from "../src/replay/load.js";
import { buildDataset } from "../src/replay/dataset.js";
import { fitBaselines } from "../src/replay/baselines.js";
import { replay, type ReplayManifest } from "../src/replay/run.js";
import { RecordStore } from "../src/runner/record.js";
import { summarize } from "../src/replay/scoring.js";
import { BOS, REPLAY_VERSIONS } from "../src/replay/types.js";
const raw = new DopplerStore();
try {
  const c = await openCorpus(raw, process.cwd(), ".cache/objects");
  const schedule = (await c.pbp.games())
    .filter((g) => [g.data.home_team_id, g.data.away_team_id].includes(BOS))
    .sort((a, b) =>
      a.data.scheduled_tipoff.localeCompare(b.data.scheduled_tipoff),
    );
  const trainingIds = schedule.slice(10, 20).map((g) => g.id),
    auditIds = ["0022500083", "0022500338", "0022500637"];
  const pregames = await auditPregames(
    c,
    [...new Set([...trainingIds, ...auditIds])],
    JSON.parse(await readFile("config/identities.json", "utf8")),
  );
  console.log("Pregame snapshots", pregames.length);
  const inputs = await loadReplayInputs(c, pregames);
  await writeFile(".cache/replay-inputs.json", JSON.stringify(inputs));
  const datasets = inputs.map(buildDataset),
    training = datasets.filter((d) => trainingIds.includes(d.gameId)),
    audited = auditIds.map((id) => datasets.find((d) => d.gameId === id)!);
  const baselines = fitBaselines(training),
    parameters = Object.fromEntries(
      Object.entries(baselines).map(([k, b]) => [
        k,
        { id: b.id, training: b.training, parameters: b.parameters },
      ]),
    );
  const manifest: ReplayManifest = {
    schemaVersion: 1,
    kind: "replay-mvp",
    releaseManifestSha256: c.pbp.release.root.sha256,
    datasets: datasets.map((d) => ({
      gameId: d.gameId,
      inputHash: d.inputHash,
    })),
    harness: REPLAY_VERSIONS,
    predictors: parameters,
    codeRevision: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
  };
  await mkdir(".cache/replay", { recursive: true });
  const root = await mkdtemp(".cache/replay/audit-"),
    record = new RecordStore(root, manifest);
  try {
    const games = [];
    for (const d of audited) {
      const scores: Record<string, unknown> = {};
      for (const [name, b] of Object.entries(baselines))
        scores[name] = summarize(await replay(d, b.id, b.predict, record));
      games.push({
        gameId: d.gameId,
        inputHash: d.inputHash,
        evaluation:
          d.gameId === "0022500083"
            ? "development diagnostic; training occurs later"
            : "post-warmup diagnostic",
        diagnostics: d.diagnostics,
        boundaries: d.windows.filter((w) => w.kind === "between_periods")
          .length,
        ledger: d.ledger,
        scores,
      });
      console.log(d.gameId, d.diagnostics, scores);
    }
    await mkdir("docs/evidence/replay-mvp", { recursive: true });
    await writeFile(
      "docs/evidence/replay-mvp/audit.json",
      JSON.stringify(
        {
          manifest,
          training: training.map((d) => ({
            gameId: d.gameId,
            windows: d.windows.length,
            qualified: d.windows.filter((w) => !w.exclusions.length).length,
            excluded: Object.fromEntries(
              [...new Set(d.windows.flatMap((w) => w.exclusions))]
                .sort()
                .map((reason) => [
                  reason,
                  d.windows.filter((w) => w.exclusions.includes(reason)).length,
                ]),
            ),
          })),
          games,
        },
        null,
        2,
      ) + "\n",
    );
    // Local reproducible input for investigation; never passed to a predictor.
    await writeFile(root + "/inputs.json", JSON.stringify(inputs));
    console.log("Verified replay record", root);
  } finally {
    record.close();
  }
} finally {
  raw.close();
}
