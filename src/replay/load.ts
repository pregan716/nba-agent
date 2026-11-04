import type { Corpus } from "../data/corpus.js";
import { injuryPlayerName, normalizeName } from "../data/identity.js";
import type { RecordEnvelope, Row } from "../data/contracts.js";
import type { ObjectRef } from "../data/store.js";
import { BOS, type Pregame, type ReplayInput } from "./types.js";
/** Caller supplies the frozen pregame evidence; no same-game box score roster inference. */
export async function loadReplayInputs(
  c: Corpus,
  pregames: Pregame[],
): Promise<ReplayInput[]> {
  const ids = new Set(pregames.map((p) => p.gameId)),
    release = c.pbp.release,
    coverage = await c.pbp.coverage(),
    games = await c.pbp.games();
  const index = JSON.parse(
    (
      await release.bytes(
        release.manifest.object_prefix + release.manifest.game_index,
      )
    ).toString(),
  );
  const tables: Record<string, Row[]> = {};
  for (const table of [
    "events",
    "event_participants",
    "v_player_stints",
    "data_quality_issues",
  ]) {
    tables[table] = [];
    for (const name of release.manifest.tables[table] ?? []) {
      const entries = index.tables[table]?.[name];
      if (!entries || !entries.some((r: any) => ids.has(r[0]))) continue;
      for (const row of await release.rows(
        release.manifest.object_prefix + name,
      ))
        if (ids.has(row.game_id)) tables[table].push(row);
    }
  }
  return pregames.map((pregame) => {
    const g = games.find((g) => g.id === pregame.gameId);
    if (!g) throw Error(`Unknown game ${pregame.gameId}`);
    const rows = (name: string) =>
      tables[name].filter((r) => r.game_id === g.id);
    return {
      game: {
        gameId: g.id,
        homeTeamId: g.data.home_team_id,
        awayTeamId: g.data.away_team_id,
        scheduledStart: g.data.scheduled_tipoff,
      },
      release: release.root,
      events: rows("events"),
      participants: rows("event_participants"),
      stints: rows("v_player_stints"),
      coverage: coverage.filter((r) => r.game_id === g.id),
      issues: rows("data_quality_issues"),
      pregame,
    };
  });
}
/** Restricted audit helper: opening roster is valid for the audited pre-trade sample,
 * not a season roster service. Production callers must provide game-specific rosters. */
export async function auditPregames(
  c: Corpus,
  gameIds: string[],
  identityMappings: Row[],
): Promise<Pregame[]> {
  const profiles = (await c.players.records()).filter(
      (r) => r.data.opening_team_id === BOS,
    ),
    games = (await c.pbp.games()).filter((g) => gameIds.includes(g.id));
  if (
    games.length !== new Set(gameIds).size ||
    games.some((g) => g.data.scheduled_tipoff >= "2026-02-01")
  )
    throw Error("Audit roster helper only supports pre-February games");
  const players = new Map<string, string[]>();
  for (const p of profiles) {
    const key = normalizeName(p.data.full_name);
    players.set(key, [...(players.get(key) ?? []), p.data.player_id]);
  }
  const resolveName = (name: string) => {
    const matches = players.get(
      normalizeName(name.includes(",") ? injuryPlayerName(name) : name),
    );
    if (matches?.length !== 1)
      throw Error(`Unresolved frozen roster identity: ${name}`);
    return matches[0];
  };
  const eligible = (r: RecordEnvelope) => {
    const game = games.find((g) => g.id === r.data.game_id);
    return (
      !!game &&
      r.data.team_id === BOS &&
      Date.parse(r.availableAt) < Date.parse(game.data.scheduled_tipoff)
    );
  };
  const latest = new Map<string, RecordEnvelope>();
  for await (const batch of c.injuries.partitions("teams"))
    for (const r of batch.filter(eligible)) {
      const prev = latest.get(r.data.game_id);
      if (
        !prev ||
        r.availableAt > prev.availableAt ||
        (r.availableAt === prev.availableAt && r.id > prev.id)
      )
        latest.set(r.data.game_id, r);
    }
  const reports = new Map<string, RecordEnvelope[]>();
  for await (const batch of c.injuries.partitions("players"))
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
  const announcements = await c.celticsLineups.records();
  return games.map((g) => {
    const snapshot = latest.get(g.id),
      rows = reports.get(g.id) ?? [];
    const lineup = announcements
      .filter(
        (r) =>
          identityMappings.some(
            (m) =>
              m.entity === "game" &&
              m.provider === "espn" &&
              m.providerId === r.data.gameId &&
              m.canonicalId === g.id,
          ) && Date.parse(r.availableAt) < Date.parse(g.data.scheduled_tipoff),
      )
      .sort((a, b) => a.availableAt.localeCompare(b.availableAt))
      .at(-1);
    const sources: ObjectRef[] = [
      c.players.release.root,
      c.injuries.release.root,
      ...profiles.map((p) => p.provenance.object),
      ...(snapshot ? [snapshot.provenance.object] : []),
      ...rows.map((p) => p.provenance.object),
      ...(lineup ? [lineup.provenance.object] : []),
    ];
    return {
      gameId: g.id,
      scheduledStart: g.data.scheduled_tipoff,
      roster: profiles.map((p) => ({
        playerId: p.data.player_id,
        availableAt: p.availableAt,
      })),
      injuryReport: {
        availableAt: snapshot?.availableAt ?? profiles[0].availableAt,
        state:
          snapshot?.data.observed_state === "players_listed"
            ? "listed"
            : "unknown",
        players: rows
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
