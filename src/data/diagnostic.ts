import { gunzipSync } from "node:zlib";
import type { Corpus } from "./corpus.js";
import { Identities } from "./identity.js";
import { before, instant } from "./time.js";
import type { Row, RecordEnvelope } from "./contracts.js";
const BOS = "1610612738";
export const countBy = (rows: Row[], field: string): Record<string, number> => {
  const result: Record<string, number> = {};
  for (const row of rows)
    result[String(row[field])] = (result[String(row[field])] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(result).sort(([a], [b]) => a.localeCompare(b)),
  );
};
const utc = (v: unknown) => instant(v instanceof Date ? v.toISOString() : v);
export async function coverageDiagnostic(
  c: Corpus,
  progress: (message: string) => void = () => {},
) {
  progress(
    "Loading consensus, schedule, player identities, and labelled posts",
  );
  const odds = await c.odds.auditRows(),
    postRows = await c.posts.auditRows(),
    posts = await c.posts.records();
  const games = (await c.pbp.games()).filter(
    (g) => g.data.home_team_id === BOS || g.data.away_team_id === BOS,
  );
  const coverage = await c.pbp.coverage(),
    ids = new Identities();
  const players = await c.players.records();
  const playerEvidence = new Map(
    players.map((p) => [p.data.player_id, p.provenance.object]),
  );
  for (const p of players) {
    ids.addName("player", p.data.full_name, p.data.player_id);
    ids.add({
      entity: "player",
      provider: "nba",
      providerId: p.data.player_id,
      canonicalId: p.data.player_id,
      basis: "published_player_id",
      evidence: [p.provenance.object],
    });
  }
  for (const adapter of [c.priorPbp, c.pbp])
    for (const { row, ref } of await adapter.release.table("players")) {
      ids.addName("player", row.name, row.player_id);
      if (!playerEvidence.has(row.player_id))
        playerEvidence.set(row.player_id, ref);
      ids.add({
        entity: "player",
        provider: "nba",
        providerId: row.player_id,
        canonicalId: row.player_id,
        basis: "published_player_id",
        evidence: [ref],
      });
    }
  for (const { row, ref } of await c.pbp.release.table("teams")) {
    ids.addName("team", row.name, row.team_id);
    ids.add({
      entity: "team",
      provider: "nba",
      providerId: row.team_id,
      canonicalId: row.team_id,
      basis: "published_team_id",
      evidence: [ref],
    });
  }
  const scheduleKey = [...c.oddsArchive.objects.keys()].find((k) =>
    k.endsWith("/schedule-response.json.gz"),
  )!;
  const schedule = JSON.parse(
    JSON.parse(gunzipSync(await c.oddsArchive.bytes(scheduleKey)).toString())
      .rawBody,
  );
  const scheduleRef = c.oddsArchive.ref(scheduleKey);
  const espnGames = new Map<string, string>();
  for (const event of schedule.events) {
    const competition = event.competitions[0],
      teams: Record<string, string> = {};
    for (const team of competition.competitors) {
      const name = team.team.displayName;
      const nba = ids.byName("team", name);
      teams[team.homeAway] = nba;
      ids.add({
        entity: "team",
        provider: "espn",
        providerId: team.team.id,
        canonicalId: nba,
        basis: "unique_published_team_name",
        evidence: [scheduleRef],
      });
    }
    const matches = games.filter(
      (g) =>
        g.data.home_team_id === teams.home &&
        g.data.away_team_id === teams.away &&
        utc(g.data.scheduled_tipoff).slice(0, 10) ===
          utc(event.date).slice(0, 10),
    );
    if (matches.length !== 1)
      throw Error(`Ambiguous or missing schedule join: ${event.id}`);
    const game = matches[0];
    espnGames.set(event.id, game.id);
    ids.add({
      entity: "game",
      provider: "espn",
      providerId: event.id,
      canonicalId: game.id,
      basis: "unique_teams_and_UTC_game_date",
      evidence: [scheduleRef, game.provenance.object],
    });
    ids.add({
      entity: "game",
      provider: "nba",
      providerId: game.id,
      canonicalId: game.id,
      basis: "published_game_id",
      evidence: [game.provenance.object],
    });
  }
  const oddsRef = [...c.odds.release.objects.values()].find((r) =>
    r.key.endsWith("/consensus.ndjson.gz"),
  )!;
  for (const row of odds) {
    const playerId = ids.byName("player", row.player_name);
    ids.add({
      entity: "player",
      provider: "espn",
      providerId: row.espn_player_id,
      canonicalId: playerId,
      basis: "unique_normalized_published_player_name",
      evidence: [oddsRef, playerEvidence.get(playerId)!],
    });
    ids.add({
      entity: "game",
      provider: "odds-api",
      providerId: row.odds_api_event_id,
      canonicalId: ids.resolve("game", "espn", row.espn_event_id),
      basis: "published_odds_event_mapping",
      evidence: [oddsRef],
    });
  }
  for (const row of postRows)
    for (const [entity, id] of [
      ["account", row.post.accountId],
      ["post", row.post.postId],
    ] as const) {
      ids.add({
        entity,
        provider: "x",
        providerId: id,
        canonicalId: `x:${id}`,
        basis: "published_x_id",
        evidence: [
          c.posts.release.ref(c.posts.release.manifest.rows.objectKey),
        ],
      });
    }
  const own = await c.celticsLineups.records(),
    opponent = await c.opponentLineups.records();
  for (const lineup of [...own, ...opponent]) {
    ids.resolve("game", "espn", lineup.data.gameId);
    for (const name of lineup.data.startingLineup)
      ids.add({
        entity: "player",
        provider: "lineup-name",
        providerId: name,
        canonicalId: ids.byName("player", name),
        basis: "unique_normalized_published_player_name",
        evidence: [
          lineup.provenance.object,
          playerEvidence.get(ids.byName("player", name))!,
        ],
      });
    ids.add({
      entity: "post",
      provider: "x",
      providerId: lineup.data.postId,
      canonicalId: `x:${lineup.data.postId}`,
      basis: "published_x_id",
      evidence: [lineup.provenance.object],
    });
  }
  progress(
    "Reading all pinned injury team partitions and checking their hashes",
  );
  const injuries = new Map<string, RecordEnvelope[]>();
  for await (const partition of c.injuries.partitions())
    for (const row of partition) {
      const group = injuries.get(row.data.game_id) ?? [];
      group.push(row);
      injuries.set(row.data.game_id, group);
    }
  progress(
    "Verifying 134 transcript manifests, publication evidence, and transcript artifacts",
  );
  const transcripts = await c.transcripts.records();
  for (const row of transcripts)
    ids.add({
      entity: "media",
      provider: "sports-transcription",
      providerId: row.data.mediaId,
      canonicalId: row.data.mediaId,
      basis: "published_media_id",
      evidence: [row.provenance.object],
    });
  const perGame = games
    .map((game) => {
      const espnId = [...espnGames].find(([, nba]) => nba === game.id)?.[0];
      if (!espnId) throw Error(`Missing ESPN game: ${game.id}`);
      const gameOdds = odds.filter((r) => r.espn_event_id === espnId),
        starts = [...new Set(gameOdds.map((r) => utc(r.scheduled_start)))];
      if (starts.length !== 1) throw Error(`Ambiguous odds cutoff: ${espnId}`);
      const cutoff = starts[0],
        snapshots = (injuries.get(game.id) ?? []).filter((r) =>
          before(r.availableAt, cutoff),
        );
      const lineups = (records: RecordEnvelope[]) =>
        records.filter(
          (r) => r.data.gameId === espnId && before(r.availableAt, cutoff),
        ).length;
      return {
        gameId: game.id,
        espnEventId: espnId,
        cutoff,
        nbaScheduledTipoff: utc(game.data.scheduled_tipoff),
        scheduleAgrees: cutoff === utc(game.data.scheduled_tipoff),
        products: Object.fromEntries(
          coverage
            .filter((r) => r.game_id === game.id)
            .map((r) => [
              r.product,
              { status: r.quality_status, reason: r.missing_reason },
            ]),
        ),
        injuryTeamSnapshots: snapshots.length,
        celticsInjurySnapshots: snapshots.filter((r) => r.data.team_id === BOS)
          .length,
        distinctInjuryPdfs: new Set(snapshots.map((r) => r.data.pdf_sha256))
          .size,
        celticsLineups: lineups(own),
        opponentLineups: lineups(opponent),
        labelledPostsBeforeCutoff: posts.filter((r) =>
          before(r.availableAt, cutoff),
        ).length,
        transcriptsBeforeCutoff: transcripts.filter((r) =>
          before(r.availableAt, cutoff),
        ).length,
        consensusStatusCounts: countBy(gameOdds, "status"),
        cutoffStatusCounts: countBy(
          gameOdds.filter((r) => r.snapshot_kind === "scheduled_start"),
          "status",
        ),
      };
    })
    .sort((a, b) => a.cutoff.localeCompare(b.cutoff));
  const consensusStatusCounts = countBy(odds, "status"),
    relevanceCounts = {
      total: postRows.length,
      relevant: postRows.filter((r) => r.relevance.relevant === true).length,
      unrelated: postRows.filter((r) => r.relevance.relevant === false).length,
    };
  if (
    games.length !== 82 ||
    odds.length !== 7956 ||
    consensusStatusCounts.ok !== 6666 ||
    consensusStatusCounts.no_quotes !== 1178 ||
    consensusStatusCounts.dfs_only !== 112 ||
    relevanceCounts.total !== 1425 ||
    relevanceCounts.relevant !== 1303
  )
    throw Error("Pinned corpus does not reproduce the guide counts");
  return {
    schemaVersion: 1,
    season: "2025-26",
    versions: { ...c.versions, odds: c.odds.version() },
    totals: {
      games: games.length,
      consensusRows: odds.length,
      consensusStatusCounts,
      relevanceCounts,
      eligiblePostVersions: posts.length,
      transcripts: transcripts.length,
    },
    exclusions: [...c.posts.exclusions, ...c.transcripts.exclusions],
    perGame,
    identities: ids.rows(),
  };
}
