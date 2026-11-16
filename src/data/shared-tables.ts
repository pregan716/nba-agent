import { postUrl } from "./posts.js";
import type { RecordEnvelope } from "./contracts.js";
import { lineupPlayerIds, type Identities } from "./identity.js";
import { pick } from "./adapters.js";

const evidenceKeys = ["id", "available_at", "team_id", "game_id", "text"];
const injuryKeys = [
  "game_id",
  "team_id",
  "player_name",
  "status",
  "reason",
  "observed_state",
  "available_at",
];
export const sharedColumns = {
  schedule: [
    "game_id",
    "season",
    "home_team_id",
    "away_team_id",
    "scheduled_tipoff",
  ],
  posts: [...evidenceKeys, "title", "url", "accountId"],
  transcripts: [...evidenceKeys, "title", "readable", "url"],
  lineups: [
    ...evidenceKeys,
    "scheduled_tipoff",
    "source",
    "startingLineup",
    "starterIds",
    "url",
  ],
  injury_teams: injuryKeys,
  injury_players: [...injuryKeys, "player_id"],
};

export function sharedBatch(
  table: keyof typeof sharedColumns,
  records: RecordEnvelope[],
  ids: Identities,
  games?: ReadonlyMap<string, RecordEnvelope>,
) {
  const columns = sharedColumns[table];
  return {
    table,
    columns,
    rows: records.map((r) => {
      const row = pick(r.data, columns);
      if (table === "schedule") return row;
      row.available_at = r.availableAt;
      if (table === "injury_players") {
        row.player_id = ids.playerId(
          "injury-name",
          r.data.player_name,
          r.data.team_id,
        );
      } else if (table !== "injury_teams") {
        row.id = r.id;
        if (table === "lineups") {
          row.starterIds = lineupPlayerIds(
            ids,
            r.data.startingLineup ?? [],
            r.data.team_id,
            r.data.starterIds,
          );
          row.scheduled_tipoff = games?.get(r.data.game_id)?.data
            .scheduled_tipoff;
        }
        if (table === "posts" && r.data.postId)
          row.url = postUrl(r.data.postId);
        if (table === "transcripts") row.text = r.data.readable ?? r.data.text;
      }
      return row;
    }),
  };
}
