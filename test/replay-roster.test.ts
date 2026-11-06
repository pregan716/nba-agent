import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFile,
  mkdtemp,
  mkdir,
  copyFile,
  appendFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSeasonRoster } from "../src/replay/roster.js";
import { auditPregames } from "../src/replay/load.js";
import type { Corpus } from "../src/data/corpus.js";
import { BOS } from "../src/replay/types.js";
const crosscheck = JSON.parse(
  await readFile("docs/evidence/roster/crosscheck.json", "utf8"),
);

test("all 82 rosters match independent cross-check with strictly pre-tip membership times", async () => {
  const roster = await loadSeasonRoster();
  for (const g of crosscheck.per_game) {
    const players = roster.at(g.scheduled_tip);
    assert.deepEqual(
      players.map((p) => p.playerId),
      g.roster,
    );
    assert(
      players.every(
        (p) => Date.parse(p.availableAt) < Date.parse(g.scheduled_tip),
      ),
    );
  }
});

test("trade, same-day signings, expiries and strict timestamp boundaries", async () => {
  const roster = await loadSeasonRoster();
  const game = (n: number) =>
    roster.at(crosscheck.per_game[n - 1].scheduled_tip);
  const ids = (n: number) => game(n).map((p) => p.playerId);
  for (const id of ["1629014", "1628449", "1631169", "1630214"]) {
    assert(ids(51).includes(id));
    assert(!ids(52).includes(id));
  }
  for (const id of ["202696", "1642910"]) assert(ids(52).includes(id));
  for (const [n, id, time] of [
    [55, "1630625", "2026-02-19T22:52:00Z"],
    [60, "1642910", "2026-03-01T17:12:00Z"],
    [72, "1629646", "2026-03-25T19:00:00Z"],
  ] as const) {
    assert.equal(game(n).find((p) => p.playerId === id)?.availableAt, time);
    assert(!roster.at(time).some((p) => p.playerId === id));
    assert(
      roster
        .at(new Date(Date.parse(time) + 1).toISOString())
        .some((p) => p.playerId === id),
    );
  }
  assert(!ids(60).includes("1630625"));
  assert(!ids(78).includes("1629646"));
  assert(ids(82).includes("1630625"));
  assert.throws(() => roster.at(roster.openingAvailableFrom), /not before tip/);
});

test("season pregame names use current roster and ignore planted same-game participants and box membership", async () => {
  const g = crosscheck.per_game[54];
  const ref = {
    bucket: "sports-nba-data",
    key: "fixture",
    sha256: "a".repeat(64),
  };
  const report = (data: object) => ({
    id: "r",
    availableAt: "2026-02-20T02:00:00Z",
    data: { game_id: g.game_id, team_id: BOS, ...data },
    provenance: { object: ref },
  });
  const c = {
    pbp: {
      games: async () => [
        {
          id: g.game_id,
          data: {
            scheduled_tipoff: g.scheduled_tip,
            home_team_id: BOS,
            away_team_id: "opponent",
          },
        },
      ],
      events: [{ player_id: "planted" }],
      player_box_scores: [{ player_id: "planted" }],
    },
    players: {
      records: () => {
        throw Error("Opening player reference must not determine membership");
      },
    },
    injuries: {
      release: { root: ref },
      async *partitions(table: string) {
        yield table === "teams"
          ? [report({ observed_state: "players_listed" })]
          : [report({ player_name: "Banton, Dalano", status: "Out" })];
      },
    },
    celticsLineups: {
      records: async () => [
        {
          availableAt: "2026-02-20T02:00:00Z",
          data: {
            gameId: "espn",
            startingLineup: [
              "Nikola Vucevic",
              "Jaylen Brown",
              "Derrick White",
              "Sam Hauser",
              "Payton Pritchard",
            ],
          },
          provenance: { object: ref },
        },
      ],
    },
  } as unknown as Corpus;
  const [p] = await auditPregames(
    c,
    [g.game_id],
    [
      {
        entity: "game",
        provider: "espn",
        providerId: "espn",
        canonicalId: g.game_id,
      },
    ],
  );
  assert.deepEqual(
    p.roster.map((p) => p.playerId),
    g.roster,
  );
  assert.equal(p.injuryReport.players[0].playerId, "1630625");
  assert(p.announcedStarters?.players.includes("202696"));
  assert(!p.roster.some((p) => p.playerId === "planted"));
  assert.equal(p.sources.filter((s) => "path" in s).length, 2);
});

test("silent edits to either roster evidence file fail integrity verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "roster-pins-"));
  try {
    const paths = [
      "config/roster-evidence.json",
      "config/celtics-transactions-2025-26.json",
      "docs/evidence/roster/nba-player-movement-celtics-2025-26.json",
    ];
    await mkdir(join(root, "config"), { recursive: true });
    await mkdir(join(root, "docs/evidence/roster"), { recursive: true });
    for (const path of paths) await copyFile(path, join(root, path));
    for (const path of paths.slice(1)) {
      await appendFile(join(root, path), " ");
      await assert.rejects(loadSeasonRoster(root), /hash mismatch/);
      await copyFile(path, join(root, path));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
