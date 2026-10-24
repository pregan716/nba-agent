import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { DopplerStore, sha256 } from "../src/data/store.js";
import { openCorpus } from "../src/data/corpus.js";
import { Identities } from "../src/data/identity.js";
import {
  agentQuestion,
  buildQuestionSet,
  loadQuestionLayer,
} from "../src/questions/builder.js";
import type { Row } from "../src/data/contracts.js";
const raw = new DopplerStore();
try {
  const c = await openCorpus(raw, process.cwd(), ".cache/objects"),
    ids = new Identities();
  const mappings = JSON.parse(await readFile("config/identities.json", "utf8"));
  for (const mapping of mappings) ids.add(mapping);
  const layer = await loadQuestionLayer(c.odds, ids);
  const coverage = JSON.parse(
    await readFile("docs/evidence/coverage-2025-26.json", "utf8"),
  );
  assert.equal(coverage.versions.sources.odds.sha256, layer.manifest.sha256);
  const games = (await c.pbp.games()).filter(
    (g) =>
      g.data.home_team_id === "1610612738" ||
      g.data.away_team_id === "1610612738",
  );
  const perGame: Row[] = [];
  await mkdir(".cache/questions", { recursive: true });
  for (const game of games) {
    const espn = mappings.filter(
      (m: Row) =>
        m.entity === "game" &&
        m.provider === "espn" &&
        m.canonicalId === game.id,
    );
    assert.equal(espn.length, 1);
    const set = buildQuestionSet(
      {
        game_id: game.id,
        espn_event_id: espn[0].providerId,
        scheduled_start: game.data.scheduled_tipoff,
      },
      layer,
    );
    const expected = coverage.perGame.find((g: Row) => g.gameId === game.id);
    assert.ok(expected);
    const statusCounts: Record<string, number> = {};
    if (set.questions.length) statusCounts.ok = set.questions.length;
    for (const excluded of set.exclusions)
      statusCounts[excluded.status] = (statusCounts[excluded.status] ?? 0) + 1;
    assert.deepEqual(statusCounts, expected.cutoffStatusCounts);
    const encoded = JSON.stringify(set);
    perGame.push({
      gameId: game.id,
      espnEventId: set.game.espn_event_id,
      cutoff: set.game.scheduled_start,
      questions: set.questions.length,
      exclusions: set.exclusions.length,
      statusCounts,
      questionSetSha256: sha256(Buffer.from(encoded)),
    });
    await writeFile(
      `.cache/questions/${game.id}.json`,
      JSON.stringify(set, null, 2) + "\n",
    );
    await writeFile(
      `.cache/questions/${game.id}.agent.json`,
      JSON.stringify(set.questions.map(agentQuestion), null, 2) + "\n",
    );
  }
  perGame.sort(
    (a, b) =>
      a.cutoff.localeCompare(b.cutoff) || a.gameId.localeCompare(b.gameId),
  );
  const questions = perGame.reduce((n, g) => n + g.questions, 0),
    exclusions = perGame.reduce((n, g) => n + g.exclusions, 0);
  assert.equal(games.length, layer.summary.games);
  assert.equal(questions, layer.summary.usableBySnapshotKind.scheduled_start);
  assert.equal(
    perGame.find((g) => g.espnEventId === "401811041")?.questions,
    1,
  );
  const report = {
    schemaVersion: 1,
    layerManifest: layer.manifest,
    methodology: layer.methodology,
    summary: layer.summaryRef,
    comparison:
      "Published summary has aggregate counts only; per-game status counts match the pinned P1 coverage diagnostic.",
    games: games.length,
    questions,
    exclusions,
    perGame,
  };
  await writeFile(
    "docs/evidence/question-sets-2025-26.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify(
      {
        games: games.length,
        questions,
        exclusions,
        thinGame: perGame.find((g) => g.questions === 1),
      },
      null,
      2,
    ),
  );
} finally {
  raw.close();
}
