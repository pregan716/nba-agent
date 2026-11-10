// Offline headroom check (SPO-878): export what analyze.py needs from the pinned
// releases. Read-only; no model calls. Run from the repository root:
//   npx tsx docs/evidence/projection-headroom/scripts/export.ts
// Output goes to the ignored .cache/projection-headroom/ directory.
//
// Holdout rule: nothing from a 2025-26 game that tips at or after the Celtics'
// 71st game leaves the release. That covers Celtics games 71-82, for both
// teams, and every other league game in that period. The schedule itself
// (ids, teams, scheduled tip) is exported for all games.
import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { DopplerStore } from "../../../../src/data/store.js";
import { openCorpus } from "../../../../src/data/corpus.js";

const out = ".cache/projection-headroom";
mkdirSync(out, { recursive: true });
const corpus = await openCorpus(
  new DopplerStore(),
  process.cwd(),
  ".cache/objects",
);
const BOS = "1610612738";
const FIRST_HOLDOUT_GAME = 71;
const GAME = [
  "game_id",
  "season",
  "home_team_id",
  "away_team_id",
  "scheduled_tipoff",
];
const BOX = [
  "game_id",
  "player_id",
  "team_id",
  "minutes_seconds",
  "points",
  "rebounds",
  "assists",
  "steals",
  "blocks",
  "turnovers",
  "three_pointers_made",
];
const SUMMARY = [
  "game_id",
  "player_id",
  "team_id",
  "starter",
  "participation_status",
];

const withheld = new Set<string>();
for (const [season, adapter] of [
  ["2024-25", corpus.priorPbp],
  ["2025-26", corpus.pbp],
] as const) {
  const games = await adapter.release.table("games", "regular_season");
  if (season === "2025-26") {
    const tips = games
      .map(({ row }) => row)
      .filter((g) => g.home_team_id === BOS || g.away_team_id === BOS)
      .map((g) => Date.parse(String(g.scheduled_tipoff)))
      .sort((a, b) => a - b);
    if (tips.length < FIRST_HOLDOUT_GAME) throw new Error("schedule too short");
    const cutoff = tips[FIRST_HOLDOUT_GAME - 1];
    for (const { row } of games)
      if (Date.parse(String(row.scheduled_tipoff)) >= cutoff)
        withheld.add(String(row.game_id));
    console.log("withheld 2025-26 games", withheld.size);
  }
  writeFileSync(
    `${out}/games-${season}.json`,
    JSON.stringify(
      games.map(({ row }) => Object.fromEntries(GAME.map((k) => [k, row[k]]))),
    ),
  );
  for (const [table, columns] of [
    ["player_box_scores", BOX],
    ["v_player_game_summary", SUMMARY],
  ] as const) {
    const stream = createWriteStream(`${out}/${table}-${season}.jsonl`);
    let rows = 0;
    for (const { row } of await adapter.release.table(
      table,
      "regular_season",
    )) {
      if (withheld.has(String(row.game_id))) continue;
      stream.write(JSON.stringify(columns.map((k) => row[k])) + "\n");
      rows++;
    }
    await new Promise((done) => stream.end(done));
    console.log(season, table, rows);
  }
}

// Celtics injury observations with the brief's availability time (printed report time).
const injuries: unknown[] = [];
for await (const part of corpus.injuries.partitions("players"))
  for (const record of part)
    if (
      record.data.team_id === BOS &&
      !withheld.has(String(record.data.game_id))
    )
      injuries.push({ availableAt: record.availableAt, ...record.data });
writeFileSync(`${out}/injuries-bos.json`, JSON.stringify(injuries));

const names = await corpus.players.release.table("player_reference");
writeFileSync(
  `${out}/names.json`,
  JSON.stringify(names.map(({ row }) => [row.player_id, row.full_name])),
);

// Prop consensus at the scheduled-start snapshot, joined to canonical ids. The
// evaluator reads this; the agent never does.
const identities: {
  entity: string;
  provider: string;
  providerId: string;
  canonicalId: string;
}[] = JSON.parse(readFileSync("config/identities.json", "utf8"));
const canonical = (entity: string) =>
  new Map(
    identities
      .filter((i) => i.entity === entity && i.provider === "espn")
      .map((i) => [i.providerId, i.canonicalId]),
  );
const gameIds = canonical("game"),
  playerIds = canonical("player");
const props = [];
let unmapped = 0;
for (const row of await corpus.odds.auditRows()) {
  if (row.snapshot_kind !== "scheduled_start" || row.status !== "ok") continue;
  const game = gameIds.get(String(row.espn_event_id)),
    player = playerIds.get(String(row.espn_player_id));
  if (game && withheld.has(game)) continue;
  if (!game || !player) {
    unmapped++;
    continue;
  }
  props.push([
    game,
    player,
    row.prop_type.replace("player_", ""),
    row.selected_line,
    row.p_over,
  ]);
}
writeFileSync(`${out}/props.json`, JSON.stringify(props));
console.log(
  "injuries",
  injuries.length,
  "props",
  props.length,
  "unmapped props",
  unmapped,
);
