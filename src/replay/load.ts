import { releaseTime } from "../env/visibility.js";
import { digest } from "../runner/config.js";
import { buildDataset } from "./dataset.js";
import { WINDOW_VERSION } from "./types.js";
import type { Corpus } from "../data/corpus.js";
import { injuryPlayerName, normalizeName } from "../data/identity.js";
import type { RecordEnvelope, Row } from "../data/contracts.js";
import { loadSeasonRoster } from "./roster.js";
import {
  BOS,
  type Pregame,
  type ReplayInput,
  type DecisionDataset,
} from "./types.js";
/** Caller supplies the frozen pregame evidence; no same-game box score roster inference. */
export async function loadReplayInputs(
  c: Corpus,
  pregames: Pregame[],
): Promise<ReplayInput[]> {
  return loadInputs(c.pbp, pregames);
}
async function loadInputs(
  adapter: Corpus["pbp"],
  pregames: Pregame[],
): Promise<ReplayInput[]> {
  const ids = new Set(pregames.map((p) => p.gameId)),
    release = adapter.release,
    coverage = await adapter.coverage(),
    games = await adapter.games();
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
/** Season pregame evidence, using only dated curated membership and pre-tip reports. */
export async function auditPregames(
  c: Corpus,
  gameIds: string[],
  identityMappings: Row[],
  root = process.cwd(),
): Promise<Pregame[]> {
  const membership = await loadSeasonRoster(root);
  const games = (await c.pbp.games()).filter((g) => gameIds.includes(g.id));
  if (
    games.length !== new Set(gameIds).size ||
    games.some((g) => ![g.data.home_team_id, g.data.away_team_id].includes(BOS))
  )
    throw Error("Unknown or non-Celtics pregame request");
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

/** Proposed retrospective roster approximation, exclusively for baseline fitting.
 * Box-score membership includes DNP rows; it is NOT pregame availability evidence.
 * Synthetic pre-tip timestamps satisfy the state builder's shape only. The
 * trainingOnly marker and input hash bind this policy and forbid evaluation.
 */
export async function loadPriorSeasonTraining(
  c: Corpus,
): Promise<DecisionDataset[]> {
  const adapter = c.priorPbp;
  const games = (await adapter.games())
    .filter(
      (g) =>
        g.data.season === "2024-25" &&
        g.data.phase === "regular_season" &&
        [g.data.home_team_id, g.data.away_team_id].includes(BOS),
    )
    .sort((a, b) =>
      a.data.scheduled_tipoff.localeCompare(b.data.scheduled_tipoff),
    );
  if (games.length !== 82 || new Set(games.map((g) => g.id)).size !== 82)
    throw Error("Prior training requires all 82 Celtics regular-season games");
  const gaps = new Set(["0022400061", "0022400230"]);
  const ids = new Set(games.map((g) => g.id));
  const rosters = new Map<string, Set<string>>();
  for (const path of adapter.release.manifest.tables.player_box_scores ?? [])
    for (const row of await adapter.release.rows(
      adapter.release.manifest.object_prefix + path,
    ))
      if (ids.has(row.game_id) && row.team_id === BOS) {
        const roster = rosters.get(row.game_id) ?? new Set<string>();
        roster.add(row.player_id);
        rosters.set(row.game_id, roster);
      }
  const pregames: Pregame[] = games
    .filter((g) => !gaps.has(g.id))
    .map((g) => {
      const availableAt = new Date(
        Date.parse(g.data.scheduled_tipoff) - 1,
      ).toISOString();
      const roster = [...(rosters.get(g.id) ?? [])].sort();
      if (roster.length < 5)
        throw Error(`No training box-score roster: ${g.id}`);
      return {
        gameId: g.id,
        scheduledStart: g.data.scheduled_tipoff,
        roster: roster.map((playerId) => ({ playerId, availableAt })),
        injuryReport: { availableAt, state: "unknown", players: [] },
        announcedStarters: null,
        sources: [adapter.release.root],
      };
    });
  const trainingOnly = {
    season: "2024-25",
    rosterPolicy: "same-game-box-score-v1",
  } as const;
  const inputs = await loadInputs(adapter, pregames);
  const built = new Map(
    inputs.map((input) => {
      const d = buildDataset(input);
      return [
        d.gameId,
        { ...d, trainingOnly, inputHash: digest({ input, trainingOnly }) },
      ];
    }),
  );
  return games.map((g): DecisionDataset => {
    if (!gaps.has(g.id)) return built.get(g.id)!;
    // Known release gaps have no qualified reconstruction; never synthesize windows.
    const version = `${WINDOW_VERSION}:${adapter.release.root.sha256}`;
    return {
      gameId: g.id,
      celticsHome: g.data.home_team_id === BOS,
      version,
      windowVersion: WINDOW_VERSION,
      release: adapter.release.root,
      trainingOnly,
      inputHash: digest({
        game: g.data,
        release: adapter.release.root,
        trainingOnly,
        gap: true,
      }),
      windows: [],
      ledger: [
        {
          datasetVersion: version,
          gameId: g.id,
          releaseManifestSha256: adapter.release.root.sha256,
          span: [0, 0] as [number, number],
          reason: "prior_season_coverage_gap",
          mechanism: "No qualified windows in pinned release",
        },
      ],
      diagnostics: {
        candidates: 0,
        positiveCandidates: 0,
        celticsSubstitutionBuckets: 0,
        adjacencyBuckets: 0,
        unanchoredBuckets: 0,
      },
    };
  });
}

/** Fixed, diverse prior-season samples: Q1 early, Q2 late, Q4, in distinct games. */
export async function priorValidationSamples(
  c: Corpus,
  datasets?: DecisionDataset[],
) {
  const prior = datasets ?? (await loadPriorSeasonTraining(c));
  const games = new Map((await c.priorPbp.games()).map((g) => [g.id, g]));
  const ordered = [...prior].sort(
    (a, b) =>
      games
        .get(a.gameId)!
        .data.scheduled_tipoff.localeCompare(
          games.get(b.gameId)!.data.scheduled_tipoff,
        ) || a.gameId.localeCompare(b.gameId),
  );
  const used = new Set<string>();
  const samples = [];
  for (const period of [1, 2, 4]) {
    for (const d of ordered) {
      if (used.has(d.gameId)) continue;
      const w = d.windows.find(
        (w) =>
          w.state &&
          !w.exclusions.length &&
          w.state.period === period &&
          (period === 1
            ? w.state.clockMs >= 6 * 60_000
            : period === 2
              ? w.state.clockMs <= 6 * 60_000
              : true),
      );
      if (!w?.state) continue;
      const scheduledStart = games.get(d.gameId)!.data
        .scheduled_tipoff as string;
      samples.push({
        gameId: d.gameId,
        inputHash: d.inputHash,
        state: w.state,
        scheduledStart,
        release: releaseTime(scheduledStart),
      });
      used.add(d.gameId);
      break;
    }
  }
  return samples;
}
