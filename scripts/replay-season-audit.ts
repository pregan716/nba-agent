import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { openCorpus } from "../src/data/corpus.js";
import { DopplerStore } from "../src/data/store.js";
import { auditPregames, loadReplayInputs } from "../src/replay/load.js";
import { buildDataset } from "../src/replay/dataset.js";
import { auditCodeRevision } from "./lib/audit-revision.js";
import { BOS } from "../src/replay/types.js";
const codeRevision = auditCodeRevision();
const raw = new DopplerStore();
try {
  const c = await openCorpus(raw, process.cwd(), ".cache/objects");
  const games = (await c.pbp.games()).filter((g) =>
    [g.data.home_team_id, g.data.away_team_id].includes(BOS),
  );
  const pregames = await auditPregames(
    c,
    games.map((g) => g.id),
    JSON.parse(await readFile("config/identities.json", "utf8")),
  );
  const crosscheck = JSON.parse(
    await readFile("docs/evidence/roster/crosscheck.json", "utf8"),
  );
  assert.equal(pregames.length, 82);
  for (const p of pregames) {
    assert.deepEqual(
      p.roster.map((r) => r.playerId).sort(),
      crosscheck.per_game.find((g: any) => g.game_id === p.gameId).roster,
    );
    assert(
      p.roster.every(
        (r) => Date.parse(r.availableAt) < Date.parse(p.scheduledStart),
      ),
    );
  }
  console.log("All 82 pregame rosters match the curated cross-check.");
  const datasets = (await loadReplayInputs(c, pregames)).map((input) =>
    buildDataset(input),
  );
  const perGame = datasets.map((d) => ({
    gameId: d.gameId,
    inputHash: d.inputHash,
    ...d.diagnostics,
    boundaries: d.windows.filter((w) => w.kind === "between_periods").length,
    outsideRoster: d.windows
      .filter((w) => w.exclusions.includes("lineup_outside_frozen_roster"))
      .map((w) => ({ id: w.id, exclusions: w.exclusions })),
  }));
  const totals = {
    candidates: 0,
    positiveCandidates: 0,
    unanchoredBuckets: 0,
    boundaries: 0,
    outsideRoster: 0,
  };
  for (const g of perGame) {
    totals.candidates += g.candidates;
    totals.positiveCandidates += g.positiveCandidates;
    totals.unanchoredBuckets += g.unanchoredBuckets;
    totals.boundaries += g.boundaries;
    totals.outsideRoster += g.outsideRoster.length;
  }
  assert.deepEqual(totals, {
    candidates: 4576,
    positiveCandidates: 1299,
    unanchoredBuckets: 159,
    boundaries: 248,
    outsideRoster: 0,
  });
  await writeFile(
    "docs/evidence/replay-mvp/season-rosters.json",
    JSON.stringify(
      {
        codeRevision,
        release: c.pbp.release.root,
        datasetVersion: datasets[0].version,
        games: pregames.length,
        rosterMismatches: 0,
        sources: pregames[0].sources.filter((s) => "path" in s),
        totals,
        perGame,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(totals);
} finally {
  raw.close();
}
