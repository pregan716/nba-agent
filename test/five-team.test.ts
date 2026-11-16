import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { Session } from "../src/env/session.js";
import { fixtureCorpus } from "./fixtures/session/corpus.js";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { writeView } from "../src/data/architect-view.js";
import { teamIds } from "../src/data/teams.js";
import type { RecordEnvelope, Row } from "../src/data/contracts.js";
import { releaseTime } from "../src/env/visibility.js";
import { GAME_HISTORY_TABLES } from "../src/env/contract.js";
const cutoff = "2026-03-23T00:00:00Z";
const tick = "2025-12-01T18:00:00Z";
const ref = {
  bucket: "sports-text" as const,
  key: "fixture",
  bytes: 0,
  sha256: "0".repeat(64),
};
function row(id: string, data: Row, at = tick): RecordEnvelope {
  return {
    id,
    data,
    source: "fixture",
    availableAt: at,
    eventTime: null,
    availabilityConvention: "post_version_publication",
    collectedAt: null,
    revisionTime: null,
    provenance: { object: ref, manifestSha256: ref.sha256 },
  };
}
function game(
  id: string,
  home: string,
  away: string,
  tip: string,
  season = "2025-26",
) {
  return row(id, {
    game_id: id,
    home_team_id: home,
    away_team_id: away,
    season,
    scheduled_tipoff: tip,
  });
}
for (const view of ["architect", "training"] as const)
  test(
    view + " SQLite mount excludes planted records at every input",
    async () => {
      const { BOS, DEN, MEM, OKC } = teamIds;
      const prior = game("prior", DEN, MEM, "2025-01-02T00:00:00Z", "2024-25");
      const other = game("test-only", DEN, MEM, tick);
      const overlap = game("overlap", OKC, MEM, "2025-12-02T18:00:00Z");
      const games = Array.from({ length: 82 }, (_, i) =>
        game(
          "b" + i,
          BOS,
          "other",
          new Date(
            i < 70
              ? Date.parse(tick) - 86400000 * (70 - i)
              : Date.parse(cutoff) + 86400000 * (i - 70),
          ).toISOString(),
        ),
      );
      games.push(prior, other, overlap);
      const expected =
        view === "architect"
          ? [prior.id, overlap.id, ...games.slice(0, 70).map((g) => g.id)]
          : [prior.id];
      const evidence = [
        row("ok", {
          team_id: OKC,
          game_id: overlap.id,
          text: "ok",
          player_name: "ok",
        }),
        ...[
          { team_id: OKC, game_id: other.id },
          { team_id: DEN, game_id: overlap.id },
          { team_id: OKC, game_id: "b70" },
        ].map((d) => row("bad", { ...d, text: "bad", player_name: "bad" })),
        row(
          "bad",
          {
            team_id: OKC,
            game_id: overlap.id,
            text: "bad",
            player_name: "bad",
          },
          cutoff,
        ),
      ];
      const src: Parameters<typeof writeView>[0] = {
        games,
        async gameLines(beforeTip) {
          assert.equal(view, "architect");
          assert.equal(beforeTip, cutoff);
          return (team, id, tip) => {
            assert.ok([BOS, OKC].some((t) => t === team));
            assert.ok(tip < cutoff && id !== other.id && id !== prior.id);
            return { spread: -4, total: 210, playerProp: "PROP_LINE_SENTINEL" };
          };
        },
        data: {
          async columns() {
            return [{ name: "text", description: "marker" }];
          },
          async *exportHistory(_table, eligible) {
            assert.deepEqual(
              eligible.map((g) => g.id).sort(),
              [...expected].sort(),
            );
            for (const g of eligible) {
              const good = { game_id: g.id, season: g.data.season, text: "ok" };
              yield {
                gameId: g.id,
                reason: null,
                records: [
                  row("ok", good, releaseTime(g.data.scheduled_tipoff)),
                  row("bad", { ...good, text: "bad" }, cutoff),
                  row("bad", { ...good, text: "bad", season: "outside" }, tick),
                  row("bad", { ...good, text: "bad", game_id: other.id }, tick),
                  ...(g === prior
                    ? [row("bad", { ...good, text: "bad" }, tick)]
                    : []),
                ],
              };
            }
          },
        },
        evidence: [
          {
            teamId: OKC,
            async evidence() {
              assert.equal(view, "architect");
              return evidence;
            },
          },
          {
            teamId: DEN,
            async evidence() {
              throw Error("test-team evidence accessed");
            },
          },
        ],
        corpus: {
          injuries: {
            async *partitions() {
              assert.equal(view, "architect");
              yield evidence.filter((r) => r.data.team_id === OKC);
            },
          },
        },
        rosters: new Map([
          [
            OKC,
            {
              at: () => [
                { playerId: "1", name: "ok", availableAt: tick },
                { playerId: "2", name: "bad", availableAt: cutoff },
              ],
            },
          ],
        ]),
      };
      const dir = await mkdtemp(join(tmpdir(), "five-team-view-"));
      try {
        const dest = join(dir, "mount");
        await writeView(src, view, dest, new AbortController().signal);
        const db = new DatabaseSync(join(dest, "session.sqlite"), {
          readOnly: true,
        });
        try {
          assert.deepEqual(
            db
              .prepare("select game_id from schedule")
              .all()
              .map((r) => r.game_id)
              .sort(),
            [...expected].sort(),
          );
          if (view === "architect") {
            const lines = db
              .prepare("SELECT * FROM game_lines ORDER BY game_id")
              .all();
            assert.deepEqual(
              lines.map((r) => [r.game_id, r.team_id]),
              [
                ...games.slice(0, 70).map((g) => [g.id, BOS]),
                [overlap.id, OKC],
              ].sort(([a], [b]) => a.localeCompare(b)),
            );
            assert.ok(lines.every((r) => r.spread === -4 && r.total === 210));
            assert.ok(!JSON.stringify(lines).includes("PROP_LINE_SENTINEL"));
          } else
            assert.equal(
              db
                .prepare(
                  "SELECT name FROM sqlite_master WHERE name='game_lines'",
                )
                .get(),
              undefined,
            );
          for (const t of GAME_HISTORY_TABLES.filter((t) => t !== "games")) {
            const rows = db.prepare("select text from " + t).all();
            assert.equal(rows.length, expected.length);
            assert.ok(rows.every((r) => r.text === "ok"));
          }
          for (const [t, col] of Object.entries({
            posts: "text",
            transcripts: "text",
            lineups: "text",
            injury_players: "player_name",
            injury_teams: "player_name",
            rosters: "name",
          })) {
            if (view === "architect")
              assert.deepEqual(
                db
                  .prepare("select " + col + " from " + t)
                  .all()
                  .map((r) => r[col]),
                ["ok"],
              );
            else
              assert.equal(
                db
                  .prepare("select name from sqlite_master where name=?")
                  .get(t),
                undefined,
              );
          }
        } finally {
          db.close();
        }
      } finally {
        await rm(dir, { force: true, recursive: true });
      }
    },
  );

test("architect and game exports agree on every shared SQL schema and pregame evidence rows", async (t) => {
  const f = fixtureCorpus();
  const { BOS } = teamIds;
  const post = f.records.posts[0];
  f.records.posts.push({
    ...post,
    id: "superseded",
    availableAt: "2025-11-02T20:00:00Z",
    data: { ...post.data, text: "old edition" },
  });
  const tip = f.game.scheduledStart;
  // Supply the architect's pinned Boston boundary without adding any new
  // released games to the sandbox fixture.
  const games = [
    ...f.schedule,
    ...Array.from({ length: 78 }, (_, i) =>
      game("extra" + i, BOS, "other", i < 66 ? "2026-01-01T00:00:00Z" : cutoff),
    ),
  ];
  const dir = await mkdtemp(join(tmpdir(), "shared-game-schema-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const signal = new AbortController().signal;
  const data = {
    ...f.source,
    async columns(table: Parameters<typeof f.source.columns>[0]) {
      return [
        ...(await f.source.columns(table)),
        { name: "retrieved_at", description: "internal" },
      ];
    },
    async *exportHistory(
      table: Parameters<typeof f.source.history>[0],
      selected: RecordEnvelope[],
    ) {
      for (const g of selected)
        yield { gameId: g.id, ...(await f.source.history(table, g)) };
    },
  };
  const viewDir = join(dir, "architect"),
    gameDir = join(dir, "game");
  await writeView(
    {
      games,
      data,
      gameLines: async () => () => ({ spread: null, total: null }),
      corpus: {
        injuries: {
          async *partitions(kind = "teams") {
            yield* data.injuries(kind);
          },
        },
      },
      evidence: [
        {
          teamId: BOS,
          evidence: (kind, cutoff) => data.evidence(kind, cutoff),
        },
      ],
      rosters: new Map([[BOS, { at: () => [] }]]),
    },
    "architect",
    viewDir,
    signal,
  );
  const session = new Session(
    f.config,
    f.game,
    "pregame",
    tip,
    data,
    undefined,
    undefined,
    undefined,
    true,
    BOS,
  );
  try {
    await session.exportTo(gameDir, signal);
  } finally {
    await session.close();
  }
  const open = (path: string) => {
    const db = new DatabaseSync(path, { readOnly: true });
    t.after(() => db.close());
    return db;
  };
  const view = open(join(viewDir, "session.sqlite")),
    sandbox = open(join(gameDir, "session.sqlite"));
  assert.deepEqual(
    sandbox
      .prepare("SELECT text FROM posts")
      .all()
      .map((r) => r.text),
    [post.data.text],
  );
  const shards = await readdir(join(gameDir, "games"));
  assert.equal(shards.length, 1);
  const path = join(dir, "prior.sqlite");
  await writeFile(
    path,
    gunzipSync(await readFile(join(gameDir, "games", shards[0]))),
  );
  const history = open(path);
  const names = (db: DatabaseSync) =>
    db
      .prepare("select name from sqlite_master where type='table'")
      .all()
      .map((r) => String(r.name));
  const schema = (db: DatabaseSync, name: string) =>
    db.prepare("select * from pragma_table_info(?) order by cid").all(name);
  const shared = [];
  const architectTables = names(view);
  for (const db of [sandbox, history])
    for (const name of names(db)) {
      if (architectTables.includes(name)) {
        assert.deepEqual(schema(view, name), schema(db, name), name);
        shared.push(name);
      }
    }
  assert.deepEqual(
    shared.sort(),
    [
      "schedule",
      "posts",
      "transcripts",
      "lineups",
      "injury_teams",
      "injury_players",
      ...GAME_HISTORY_TABLES.filter((t) => t !== "games"),
      "unavailable",
    ].sort(),
  );
  for (const [table, columns, expected] of [
    [
      "lineups",
      "startingLineup, scheduled_tipoff",
      [JSON.stringify(["Fixture Player"]), tip],
    ],
    [
      "injury_players",
      "player_name, status, reason",
      ["Player, Fixture", "Questionable", "Fixture reason"],
    ],
    ["injury_teams", "observed_state", ["players_listed"]],
  ] as const) {
    const sql =
      "select " +
      columns +
      " from " +
      table +
      " where game_id=? and team_id=? order by available_at";
    const rows = view.prepare(sql).all("current", BOS);
    assert.deepEqual(rows.map(Object.values), [expected]);
    assert.deepEqual(sandbox.prepare(sql).all("current", BOS), rows);
  }
});
