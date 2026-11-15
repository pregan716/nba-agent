import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
