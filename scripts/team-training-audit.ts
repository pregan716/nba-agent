// Offline compatibility audit against the pre-SPO-870 cached experiment datasets.
// Usage: tsx scripts/team-training-audit.ts <datasets.json> [object-cache]
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DopplerStore, sha256 } from "../src/data/store.js";
import { openCorpus } from "../src/data/corpus.js";
import {
  auditPregames,
  loadReplayInputs,
  loadPriorSeasonTraining,
  loadAllTeamsTraining,
} from "../src/replay/load.js";
import { buildDataset } from "../src/replay/dataset.js";
import { BOS } from "../src/replay/types.js";
import { releaseTime } from "../src/env/visibility.js";

const bytes = readFileSync(process.argv[2]);
const baseline = JSON.parse(bytes.toString());
const store = new DopplerStore();
try {
  const corpus = await openCorpus(
    store,
    process.cwd(),
    process.argv[3] ?? ".cache/objects",
  );
  const prior = await loadPriorSeasonTraining(corpus);
  assert.deepEqual(prior, baseline.prior);
  console.error(`Prior Boston datasets identical: ${prior.length}`);
  const mappings = JSON.parse(readFileSync("config/identities.json", "utf8"));
  const currentBaseline = [...baseline.dev, ...baseline.warm];
  const pregames = await auditPregames(
    corpus,
    currentBaseline.map((d) => d.gameId),
    mappings,
  );
  const inputs = await loadReplayInputs(corpus, pregames);
  for (const input of inputs)
    assert.deepEqual(
      buildDataset(input),
      currentBaseline.find((d) => d.gameId === input.game.gameId),
    );
  console.error(`Current Boston datasets identical: ${inputs.length}`);
  // Exercise the complete prior-season loader, including coverage-gap reporting.
  const loaded = await loadAllTeamsTraining(corpus, "2025-10-01T00:00:00Z", {
    seasons: ["2024-25"],
  });
  console.error(
    `League training datasets: ${loaded.datasets.length}; gaps: ${loaded.skipped.length}`,
  );
  // Rebuild three non-Boston team-games with the experiment's id-relabeling method.
  const picks = loaded.datasets.filter((d) => d.teamId !== BOS).slice(0, 3);
  function swap(v: any, a: string, b: string): any {
    if (v === a) return b;
    if (v === b) return a;
    if (Array.isArray(v)) return v.map((x) => swap(x, a, b));
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, swap(x, a, b)]),
      );
    return v;
  }
  const games = await corpus.priorPbp.games();
  for (const d of picks) {
    const game = games.find((g) => g.id === d.gameId)!;
    const availableAt = new Date(
      Date.parse(game.data.scheduled_tipoff) - 1,
    ).toISOString();
    const roster = d.windows
      .find((w) => w.state)!
      .state!.players.map((p) => ({ playerId: p.playerId, availableAt }));
    const [input] = await loadReplayInputs(
      { ...corpus, pbp: corpus.priorPbp },
      [
        {
          gameId: d.gameId,
          scheduledStart: game.data.scheduled_tipoff,
          roster,
          injuryReport: { availableAt, state: "unknown", players: [] },
          announcedStarters: null,
          sources: [corpus.priorPbp.release.root],
        },
      ],
    );
    const expected = swap(
      buildDataset(swap(input, d.teamId!, BOS)),
      d.teamId!,
      BOS,
    );
    for (const w of expected.windows)
      w.state?.history.substitutions.sort(
        (a: any, b: any) =>
          a.sequence - b.sequence || a.teamId.localeCompare(b.teamId),
      );
    assert.deepEqual(d.windows, expected.windows);
    assert.deepEqual(d.ledger, expected.ledger);
    assert.deepEqual(d.diagnostics, expected.diagnostics);
  }
  // Current Boston training must retain the actual pregame roster, not box membership.
  const first = pregames
    .slice()
    .sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart))[0];
  const cutoff = new Date(
    Date.parse(releaseTime(first.scheduledStart)) + 1,
  ).toISOString();
  const current = await loadAllTeamsTraining(corpus, cutoff, {
    seasons: ["2025-26"],
  });
  const boston = current.datasets.find(
    (d) => d.gameId === first.gameId && d.teamId === BOS,
  )!;
  assert.equal(boston.trainingOnly?.rosterPolicy, "season-pregame-v1");
  assert.deepEqual(
    boston.windows,
    currentBaseline.find((d) => d.gameId === first.gameId).windows,
  );
  console.log(
    JSON.stringify(
      {
        referenceSha256: sha256(bytes),
        priorBostonIdentical: prior.length,
        currentBostonIdentical: inputs.length,
        priorTeamDatasets: loaded.datasets.length,
        priorWindows: loaded.datasets.reduce((n, d) => n + d.windows.length, 0),
        skipped: loaded.skipped,
        relabellingMatches: picks.map((d) => ({
          gameId: d.gameId,
          teamId: d.teamId,
        })),
        currentCutoff: cutoff,
        currentTeamDatasets: current.datasets.length,
        currentBostonPregameMatches: true,
      },
      null,
      2,
    ),
  );
} finally {
  store.close();
}
