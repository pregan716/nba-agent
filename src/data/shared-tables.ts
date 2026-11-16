import type { RecordEnvelope } from "./contracts.js";
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
const sharedColumns = {
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
    "url",
  ],
  injury_teams: injuryKeys,
  injury_players: injuryKeys,
};

export function sharedBatch(
  table: keyof typeof sharedColumns,
  records: RecordEnvelope[],
  games?: ReadonlyMap<string, RecordEnvelope>,
) {
  const columns = sharedColumns[table];
  return {
    table,
    columns,
    rows: records.map((r) =>
      pick(
        {
          ...r.data,
          text:
            table === "transcripts"
              ? (r.data.readable ?? r.data.text)
              : r.data.text,
          id: r.id,
          available_at: r.availableAt,
          ...(table === "lineups"
            ? {
                scheduled_tipoff: games?.get(r.data.game_id)?.data
                  .scheduled_tipoff,
              }
            : {}),
        },
        columns,
      ),
    ),
  };
}
