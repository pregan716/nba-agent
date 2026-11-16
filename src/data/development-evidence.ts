import type { RecordEnvelope } from "./contracts.js";
import { developmentTeams, teamIds } from "./teams.js";
import { before } from "./time.js";

const testTeam = (id: unknown) =>
  String(id).trim() === teamIds.DEN || String(id).trim() === teamIds.MEM;
const developmentIds = new Set<string>(
  developmentTeams.map((team) => teamIds[team]),
);

export const developmentHoldout = "2026-03-23T00:00:00Z";

/** Session evidence only. Released history uses the original league schedule. */
export function developmentEvidence(games: RecordEnvelope[]) {
  const restricted = new Map(
    games
      .filter(
        ({ data: g }) => testTeam(g.home_team_id) || testTeam(g.away_team_id),
      )
      .map((g) => [g.id, g.data]),
  );
  return (record: RecordEnvelope, gameId = record.data.game_id) => {
    const row = record.data;
    const game = restricted.get(gameId);
    if (game) {
      const participants = [game.home_team_id, game.away_team_id];
      return (
        game.season === "2025-26" &&
        participants.some((t) => developmentIds.has(t)) &&
        (!row.team_id || participants.includes(row.team_id)) &&
        before(game.scheduled_tipoff, developmentHoldout) &&
        before(record.availableAt, game.scheduled_tipoff)
      );
    }
    return (
      !testTeam(row.team_id) &&
      !testTeam(row.opening_team_id) &&
      !String(row.source_team_ids ?? "")
        .split(",")
        .some(testTeam) &&
      !String(row.game_ids ?? "")
        .split(",")
        .some((id) => restricted.has(id.trim()))
    );
  };
}
