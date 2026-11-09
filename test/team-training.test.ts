import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { replayInput } from "../scripts/fixtures/chronological.js";
import { buildDataset } from "../src/replay/dataset.js";
import { loadAllTeamsTraining, loadBacktestData } from "../src/replay/load.js";
import { replay } from "../src/replay/run.js";
import { replayDescriptor } from "../src/launch/run.js";
import { BOS } from "../src/replay/types.js";
import { releaseTime } from "../src/env/visibility.js";

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

test("team parameter matches relabelling with real ids preserved, home and away", () => {
  const fixtures = [
    replayInput(),
    ...JSON.parse(
      readFileSync("test/fixtures/replay/jump-prefixes.json", "utf8"),
    ).map((x: any) => x.input),
  ];
  // Serialized dataset hashes from pre-change main (81ec247), including inputHash.
  const golden = [
    "fd1c8eae0d38a8a24b91ad043da2ea807d3cd61a4c52218ebc61789a33accaa5",
    "e1213e3b9f35b6a88d9e4bc5f3e3a9125085bb8f39bf061c215e04376938f7c2",
    "8cfcc98b7477f172615a8fae883ba7623985da1bcdecc758d9c60179c15a7512",
  ];
  assert.deepEqual(
    fixtures.map((input) =>
      createHash("sha256")
        .update(JSON.stringify(buildDataset(input)))
        .digest("hex"),
    ),
    golden,
  );
  for (const original of fixtures) {
    assert.deepEqual(buildDataset(original), buildDataset(original, BOS));
    for (const team of [original.game.homeTeamId, original.game.awayTeamId]) {
      const input = structuredClone(original);
      // The comparison tests both sides using a frozen roster containing that side.
      input.pregame.roster = [
        ...new Set<string>(
          input.events.flatMap((e: any) => {
            const side = team === input.game.homeTeamId ? "home" : "away";
            return [
              ...(e[`${side}_lineup_before`] ?? []),
              ...(e[`${side}_lineup_after`] ?? []),
            ];
          }),
        ),
      ].map((playerId) => ({
        playerId,
        availableAt: input.pregame.injuryReport.availableAt,
      }));
      input.pregame.injuryReport.players = [];
      input.pregame.announcedStarters = null;
      const actual = buildDataset(input, team);
      const expected = swap(buildDataset(swap(input, team, BOS)), team, BOS);
      for (const w of expected.windows)
        w.state?.history.substitutions.sort(
          (a: any, b: any) =>
            a.sequence - b.sequence || a.teamId.localeCompare(b.teamId),
        );
      assert.deepEqual(actual.windows, expected.windows);
      assert.deepEqual(actual.ledger, expected.ledger);
      assert.deepEqual(actual.diagnostics, expected.diagnostics);
      assert.equal(actual.celticsHome, expected.celticsHome);
      if (team !== BOS)
        assert.notEqual(
          actual.inputHash,
          buildDataset(swap(input, team, BOS)).inputHash,
        );
    }
  }
  assert.throws(() => buildDataset(fixtures[0], "not-in-game"), /Target team/);
});

function corpusFixture(season = "2024-25", team = "target") {
  const input = team === BOS ? replayInput() : swap(replayInput(), BOS, team);
  const tip =
    season === "2024-25" ? "2025-03-08T23:00:00Z" : "2025-11-01T23:00:00Z";
  const games = ["released", "future", "missing-roster", "missing-events"].map(
    (id, i) => ({
      id,
      data: {
        season,
        phase: "regular_season",
        home_team_id: input.game.homeTeamId,
        away_team_id: input.game.awayTeamId,
        scheduled_tipoff: i === 1 ? "2026-01-01T23:00:00Z" : tip,
      },
    }),
  );
  const reads: string[] = [];
  const tableNames = {
    events: "events",
    event_participants: "participants",
    v_player_stints: "stints",
    data_quality_issues: "issues",
  } as const;
  const tables: Record<string, any[]> = {};
  for (const g of games) {
    for (const [table, field] of Object.entries(tableNames))
      tables[`${g.id}/${table}`] =
        g.id === "missing-events"
          ? []
          : input[field].map((r: any) => ({ ...r, game_id: g.id }));
    tables[`${g.id}/player_box_scores`] =
      g.id === "missing-roster"
        ? []
        : [
            ...input.stints.map((s: any) => ({
              game_id: g.id,
              team_id: s.team_id,
              player_id: s.player_id,
            })),
            {
              game_id: g.id,
              team_id: input.game.homeTeamId,
              player_id: "dnp",
              minutes_seconds: 0,
            },
          ];
  }
  const names = [...Object.keys(tableNames), "player_box_scores"];
  const adapter = {
    games: async () => [
      ...games,
      { id: "playoff", data: { ...games[0].data, phase: "playoffs" } },
    ],
    coverage: async () =>
      games.flatMap((g) =>
        input.coverage.map((r: any) => ({ ...r, game_id: g.id })),
      ),
    release: {
      root: input.release,
      manifest: {
        object_prefix: "",
        game_index: "index",
        tables: Object.fromEntries(
          names.map((t) => [t, games.map((g) => `${g.id}/${t}`)]),
        ),
      },
      bytes: async () =>
        Buffer.from(
          JSON.stringify({
            tables: Object.fromEntries(
              names.map((t) => [
                t,
                Object.fromEntries(
                  games.map((g) => [`${g.id}/${t}`, [[g.id]]]),
                ),
              ]),
            ),
          }),
        ),
      rows: async (path: string) => {
        reads.push(path);
        if (path.startsWith("future/")) throw Error("Future partition read");
        return tables[path];
      },
    },
  };
  const corpus: any =
    season === "2024-25" ? { priorPbp: adapter } : { pbp: adapter };
  return { corpus, reads, tip };
}

test("all-teams training filters before indexed reads, retains DNPs, reports gaps and cannot be evaluated", async () => {
  for (const season of ["2024-25", "2025-26"] as const) {
    const { corpus, reads, tip } = corpusFixture(season);
    const at = releaseTime(tip);
    assert.equal(
      at,
      season === "2024-25" ? "2025-03-09T13:00:00Z" : "2025-11-02T14:00:00Z",
    );
    assert.deepEqual(
      await loadAllTeamsTraining(corpus, at, { seasons: [season] }),
      { datasets: [], skipped: [] },
    );
    assert.equal(reads.length, 0);
    const result = await loadAllTeamsTraining(
      corpus,
      new Date(Date.parse(at) + 1).toISOString(),
      { seasons: [season], batchSize: 1 },
    );
    const streamed: typeof result.datasets = [];
    const streamedResult = await loadAllTeamsTraining(
      corpus,
      new Date(Date.parse(at) + 1).toISOString(),
      {
        seasons: [season],
        collect: false,
        batchSize: 1,
        onDataset: async (dataset, scheduledStart) => {
          assert.equal(scheduledStart, tip);
          streamed.push(dataset);
        },
      },
    );
    assert.deepEqual(streamed, result.datasets);
    assert.deepEqual(streamedResult.datasets, []);
    assert.deepEqual(streamedResult.skipped, result.skipped);
    assert.equal(result.datasets.length, 2);
    assert.ok(
      result.datasets.every(
        (d) => d.gameId === "released" && d.trainingOnly?.season === season,
      ),
    );
    assert.deepEqual(
      new Set(result.datasets.map((d) => d.teamId)),
      new Set(["target", "other"]),
    );
    assert.notEqual(result.datasets[0].inputHash, result.datasets[1].inputHash);
    const d = result.datasets.find((d) => d.teamId === "target")!;
    assert.ok(d.windows[0].state!.eligibleBench.includes("dnp"));
    assert.ok(d.windows[0].state!.flags.includes("availability_unknown"));
    assert.equal(
      result.skipped.filter((g) => g.reason === "missing_box_score_roster")
        .length,
      2,
    );
    assert.equal(
      result.skipped.filter((g) => g.reason.startsWith("unbuildable:")).length,
      2,
    );
    assert.ok(!reads.some((p) => p.startsWith("future/")));
    assert.throws(() => replayDescriptor(result.datasets), /Training-only/);
    await assert.rejects(
      replay(d, "test", () => null, {} as any),
      /Training-only/,
    );
  }
});

test("Boston backtest loader filters future shards and retains retrospective membership", async () => {
  const { corpus, reads, tip } = corpusFixture("2024-25", BOS);
  corpus.pbp = { games: async () => [] };
  const at = releaseTime(tip),
    signal = new AbortController().signal;
  assert.deepEqual(await loadBacktestData(corpus, at, signal), {
    games: [],
    skipped: [],
  });
  assert.equal(reads.length, 0);
  const result = await loadBacktestData(
    corpus,
    new Date(Date.parse(at) + 1).toISOString(),
    signal,
  );
  assert.equal(result.games.length, 1);
  const { dataset, scheduledStart } = result.games[0];
  assert.equal(scheduledStart, tip);
  assert.equal(dataset.teamId, BOS);
  assert.equal(dataset.trainingOnly?.rosterPolicy, "same-game-box-score-v1");
  assert.ok(dataset.windows[0].state!.eligibleBench.includes("dnp"));
  assert.equal(result.skipped!.length, 2);
  assert.ok(result.skipped!.every((g) => g.scheduledStart === tip));
  assert.ok(!reads.some((path) => path.startsWith("future/")));
  assert.ok(!JSON.stringify(result).includes('"future"'));
});
