import type { Corpus } from "../data/corpus.js";
import { openTeamEvidence } from "../data/team-evidence.js";
import { teamCode } from "../data/teams.js";
import {
  Identities,
  injuryPlayerName,
  normalizeName,
} from "../data/identity.js";
import type { RecordEnvelope, Row } from "../data/contracts.js";
import { loadSeasonRoster } from "./roster.js";
import { BOS, type Pregame } from "./roster-types.js";
export async function auditPregames(
  c: Corpus,
  gameIds: string[],
  identityMappings: Row[],
  root = process.cwd(),
  signal?: AbortSignal,
  options?: {
    throughReportDay?: string;
    omitLineups?: boolean;
    teamId?: string;
    lineups?: RecordEnvelope[];
  },
): Promise<Pregame[]> {
  signal?.throwIfAborted();
  const teamId = options?.teamId ?? BOS;
  const membership = await loadSeasonRoster(root, teamId);
  const games = (await c.pbp.games()).filter((g) => gameIds.includes(g.id));
  if (
    games.length !== new Set(gameIds).size ||
    games.some(
      (g) => ![g.data.home_team_id, g.data.away_team_id].includes(teamId),
    )
  )
    throw Error("Unknown pregame request for team " + teamId);
  const eligible = (r: RecordEnvelope) => {
    const game = games.find((g) => g.id === r.data.game_id);
    return (
      !!game &&
      r.data.team_id === teamId &&
      Date.parse(r.availableAt) < Date.parse(game.data.scheduled_tipoff)
    );
  };
  const latest = new Map<string, RecordEnvelope>();
  for await (const batch of c.injuries.partitions(
    "teams",
    options?.throughReportDay,
  )) {
    signal?.throwIfAborted();
    for (const r of batch.filter(eligible)) {
      const prev = latest.get(r.data.game_id);
      if (
        !prev ||
        r.availableAt > prev.availableAt ||
        (r.availableAt === prev.availableAt && r.id > prev.id)
      )
        latest.set(r.data.game_id, r);
    }
  }
  const reports = new Map<string, RecordEnvelope[]>();
  for await (const batch of c.injuries.partitions(
    "players",
    options?.throughReportDay,
  )) {
    signal?.throwIfAborted();
    for (const r of batch.filter(eligible)) {
      const team = latest.get(r.data.game_id);
      if (
        team?.data.observed_state === "players_listed" &&
        Date.parse(team.availableAt) === Date.parse(r.availableAt)
      )
        reports.set(r.data.game_id, [
          ...(reports.get(r.data.game_id) ?? []),
          r,
        ]);
    }
  }
  signal?.throwIfAborted();
  const latestTip = games
    .map((g) => String(g.data.scheduled_tipoff))
    .sort()
    .at(-1);
  const announcements =
    options?.omitLineups || !latestTip
      ? []
      : (options?.lineups ??
        (teamId === BOS
          ? await c.celticsLineups.records()
          : await (
              await openTeamEvidence(
                c,
                teamCode(teamId),
                new Identities(),
                root,
              )
            ).evidence("lineups", latestTip)));
  return games.map((g) => {
    const roster = membership.at(g.data.scheduled_tipoff);
    const resolveName = (name: string) => {
      const key = normalizeName(
        name.includes(",") ? injuryPlayerName(name) : name,
      );
      const matches = roster.filter((p) => normalizeName(p.name) === key);
      if (matches.length !== 1)
        throw Error(`Unresolved frozen roster identity: ${g.id}: ${name}`);
      return matches[0].playerId;
    };
    const snapshot = latest.get(g.id),
      rows = reports.get(g.id) ?? [];
    const lineup = announcements
      .filter(
        (r) =>
          (r.data.game_id === g.id ||
            identityMappings.some(
              (m) =>
                m.entity === "game" &&
                m.provider === "espn" &&
                m.providerId === r.data.gameId &&
                m.canonicalId === g.id,
            )) &&
          Date.parse(r.availableAt) < Date.parse(g.data.scheduled_tipoff),
      )
      .sort((a, b) => a.availableAt.localeCompare(b.availableAt))
      .at(-1);
    const sources: Pregame["sources"] = [
      ...membership.sources,
      c.injuries.release.root,
      ...(snapshot ? [snapshot.provenance.object] : []),
      ...rows.map((p) => p.provenance.object),
      ...(lineup ? [lineup.provenance.object] : []),
    ];
    return {
      gameId: g.id,
      scheduledStart: g.data.scheduled_tipoff,
      roster: roster.map(({ playerId, availableAt }) => ({
        playerId,
        availableAt,
      })),
      injuryReport: {
        availableAt: snapshot?.availableAt ?? membership.openingAvailableFrom,
        state:
          snapshot?.data.observed_state === "players_listed"
            ? "listed"
            : "unknown",
        players: rows
          .filter((r) => {
            // A report can still list an officially waived player as "Not With Team".
            if (r.data.reason !== "Not With Team") return true;
            const key = normalizeName(injuryPlayerName(r.data.player_name));
            return !membership.departed(key, g.data.scheduled_tipoff);
          })
          .map((r) => ({
            playerId: resolveName(r.data.player_name),
            status: r.data.status,
          }))
          .sort((a, b) => a.playerId.localeCompare(b.playerId)),
      },
      announcedStarters: lineup
        ? {
            availableAt: lineup.availableAt,
            players: lineup.data.startingLineup.map(resolveName),
          }
        : null,
      sources: [...new Map(sources.map((s) => [s.sha256, s])).values()].sort(
        (a, b) => a.sha256.localeCompare(b.sha256),
      ),
    };
  });
}
