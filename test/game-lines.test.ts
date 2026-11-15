import { gzipSync } from "node:zlib";
import { OddsAdapter, envelope } from "../src/data/adapters.js";
import { Identities } from "../src/data/identity.js";
import { Release } from "../src/data/release.js";
import { VerifiedStore, sha256, type ObjectRef } from "../src/data/store.js";
import { fiveTeamGameLines } from "../src/data/five-team.js";
import { teamIds } from "../src/data/teams.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGameLines,
  gameLineVersion,
} from "../src/projection/game-lines.js";
import { cutoff, before } from "./fixtures/session/corpus.js";
function quotes(at = cutoff) {
  return ["book-a", "book-b"].flatMap((bookmaker) =>
    [
      ["spreads", "Boston Celtics", null, -4],
      ["spreads", "Opponent", null, 4],
      ["team_totals", "Over", "Boston Celtics", 112],
      ["team_totals", "Under", "Boston Celtics", 112],
      ["team_totals", "Over", "Opponent", 108],
      ["team_totals", "Under", "Opponent", 108],
    ].map(([market, selection, description, line]) => ({
      espn_event_id: "current",
      requested_at: at,
      snapshot_kind: at === cutoff ? "scheduled_start" : "pregame",
      market,
      selection,
      description,
      line,
      bookmaker,
      price: -110,
      odds_format: "american",
      price_is_indicative: false,
      snapshot_at: at,
      last_update: at,
    })),
  );
}
test("pinned game lines preserve spread sign, paired team totals and missing markets", () => {
  const rows = quotes();
  function values(data: typeof rows) {
    const [r] = buildGameLines(data);
    return [r.spread, r.game_total];
  }
  assert.deepEqual(values(rows), [-4, 220]);
  const [away] = buildGameLines(rows, "Opponent");
  assert.deepEqual([away.spread, away.game_total], [4, 220]);
  assert.deepEqual(values(rows.filter((r) => r.market === "team_totals")), [
    null,
    220,
  ]);
  assert.deepEqual(
    values(rows.map((r) => ({ ...r, bookmaker: "prizepicks" }))),
    [null, null],
  );
  const one = rows.filter((r) => r.bookmaker === "book-a");
  assert.deepEqual(values([...one, { ...one[0], price: 120 }]), [null, 220]);
  assert.deepEqual(
    values(
      rows.map((r) => ({
        ...r,
        last_update: r.selection === "Under" ? before : cutoff,
      })),
    ),
    [-4, null],
  );
  assert.deepEqual(
    values(
      rows.filter(
        (r) =>
          r.market === "spreads" ||
          (r.description === "Opponent") === (r.bookmaker === "book-a"),
      ),
    ),
    [-4, null],
  );
});

test("game-line source pins the SPO-829 methodology", () => {
  assert.equal(
    gameLineVersion.manifest_sha256,
    "a83d4537b93d028bb856b357bb10438d1b8624ea49d4a6feea442271e7d402ad",
  );
});

test("team-root archive joins by NBA game and exposes both perspectives only at scheduled tip", async () => {
  const objects = new Map<string, Buffer>();
  function put(key: string, bytes: Buffer): ObjectRef {
    objects.set(key, bytes);
    return {
      bucket: "pm-data-platform",
      key,
      bytes: bytes.length,
      sha256: sha256(bytes),
    };
  }
  const json = (key: string, value: unknown) =>
    put(key, Buffer.from(JSON.stringify(value)));
  const store = new VerifiedStore({
    get: async (_bucket, key) => objects.get(key)!,
  });
  const archive = json("bos/_MANIFEST.json", {
    objects: [put("bos/quotes.ndjson.gz", gzipSync(""))],
  });
  const consensus = json("bos/consensus/_MANIFEST.json", {
    sourceManifest: { manifest: archive.key, sha256: archive.sha256 },
  });
  const rows = [...quotes(), ...quotes(before)].map((r) => ({
    ...r,
    selection:
      r.selection === "Boston Celtics" ? "Denver Nuggets" : r.selection,
    description:
      r.description === "Boston Celtics" ? "Denver Nuggets" : r.description,
  }));
  // A prop-only event has no mapping in the game-line schedule.
  rows.push({
    ...rows[0],
    market: "player_points",
    espn_event_id: "unmapped-prop",
    line: 9999,
  });
  const games = json("den/games.json", [
    { espn_event_id: "current", nba_game_id: "nba", scheduled_start: cutoff },
  ]);
  const pin = json("den/_MANIFEST.json", {
    objects: [
      games,
      put(
        "den/quotes.ndjson.gz",
        gzipSync(rows.map((r) => JSON.stringify(r)).join("\n")),
      ),
    ],
  });
  const schedule = {
    season: "2025-26",
    home_team_id: teamIds.DEN,
    away_team_id: teamIds.MEM,
    scheduled_tipoff: cutoff,
  };
  const lines = await fiveTeamGameLines({
    games: [
      envelope(
        "schedule",
        "nba",
        schedule,
        pin,
        pin.sha256,
        cutoff,
        "schedule_static",
      ),
    ],
    ids: new Identities(),
    corpus: {
      verified: store,
      odds: new OddsAdapter(await Release.open(consensus, store)),
    },
    evidence: [{ team: "DEN", teamId: teamIds.DEN, gameLineManifest: pin }],
  });
  assert.deepEqual(lines(teamIds.DEN, "nba", cutoff), {
    spread: -4,
    total: 220,
  });
  assert.deepEqual(lines(teamIds.MEM, "nba", cutoff), {
    spread: 4,
    total: 220,
  });
  for (const [team, id, tip] of [
    [teamIds.OKC, "nba", cutoff],
    [teamIds.DEN, "nba", before],
    [teamIds.DEN, "current", cutoff],
  ])
    assert.deepEqual(lines(team, id, tip), { spread: null, total: null });
});
