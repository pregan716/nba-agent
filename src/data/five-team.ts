import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Corpus } from "./corpus.js";
import { Identities, normalizeName, type Mapping } from "./identity.js";
import { PlayByPlayAdapter } from "./adapters.js";
import { teamIds, teams, teamCode, teamNames } from "./teams.js";
import { openTeamEvidence } from "./team-evidence.js";
import { corpusSource } from "../env/source.js";
import type { EvidenceSource } from "../env/contract.js";
import { loadSeasonRoster } from "../projection/roster.js";
import { projectionSource } from "../projection/input.js";
import { projectionModel, recordReference } from "../projection/reference.js";
import type { ReplaySource, TeamGame } from "../game-loop/replay.js";
import { Release } from "./release.js";
import type { Row } from "./contracts.js";
import {
  buildGameLines,
  openingGameLines,
  gameLineVersion,
} from "../projection/game-lines.js";
import { before, instant } from "./time.js";

// The v4 source retains its original pins and evidence surface. V5 starts from
// public schedule columns and uses the game index for every outcome partition.
export async function fiveTeamData(c: Corpus, root = process.cwd()) {
  const corpus = {
    ...c,
    pbp: new PlayByPlayAdapter(c.pbp.release, true),
    priorPbp: new PlayByPlayAdapter(c.priorPbp.release, true),
  };
  const ids = new Identities();
  const mappings: Mapping[] = JSON.parse(
    await readFile(resolve(root, "config/identities.json"), "utf8"),
  );
  for (const m of mappings) ids.add(m);
  const evidence = await Promise.all(
    teams.map((t) => openTeamEvidence(corpus, t, ids, root)),
  );
  const data = await corpusSource(corpus, ids);
  const games = await data.games();
  const schedule = new Map(games.map((g) => [g.id, g]));
  const rosters = new Map(
    await Promise.all(
      teams.map(
        async (t) =>
          [teamIds[t], await loadSeasonRoster(root, teamIds[t])] as const,
      ),
    ),
  );
  const versions = evidence.flatMap((e) => e.versions);
  for (const [team, roster] of rosters)
    for (const pin of roster.sources)
      versions.push({
        source: "roster-" + team + ":" + pin.path,
        release: pin.path,
        manifest_sha256: pin.sha256,
      });
  async function researchEvidence(kind: EvidenceSource, cutoff: string) {
    const grouped = await Promise.all(
      evidence.map(async (e) => {
        const rows = await e.evidence(kind, cutoff);
        if (kind !== "lineups" || e.team === "BOS") return rows;
        return rows.filter((r) => {
          const g = schedule.get(r.data.game_id);
          if (!g || !before(r.availableAt, g.data.scheduled_tipoff))
            return false;
          const roster = rosters.get(e.teamId)!.at(g.data.scheduled_tipoff);
          r.data.starterIds = r.data.startingLineup.map((name: string) => {
            const match = roster.filter(
              (p) => normalizeName(p.name) === normalizeName(name),
            );
            if (match.length !== 1)
              throw Error(
                "Unresolved lineup: " + e.team + " " + g.id + " " + name,
              );
            return match[0].playerId;
          });
          return true;
        });
      }),
    );
    // V4 carries the opposing lineup for Boston games too.
    if (kind === "lineups")
      grouped.push(
        (await corpus.opponentLineups.records()).filter((r) =>
          before(r.availableAt, cutoff),
        ),
      );
    return grouped.flat();
  }
  const source = {
    ...data,
    versions: [...data.versions, ...versions, gameLineVersion],
    async odds() {
      // Player props are excluded from v5 sessions, including Boston.
      return [];
    },
    async evidence(kind: EvidenceSource, cutoff?: string) {
      if (!cutoff) throw Error("V5 research evidence requires a cutoff");
      return researchEvidence(kind, cutoff);
    },
  };
  return { root, corpus, data: source, evidence, games, ids, rosters };
}
export type FiveTeamData = Awaited<ReturnType<typeof fiveTeamData>>;

/** Shared games use Boston's existing convention, otherwise the home team's
 * perspective, so a selection tie cannot produce different lines for each side. */
export async function fiveTeamGameLines(
  data: {
    games: FiveTeamData["games"];
    ids: Identities;
    corpus: Pick<Corpus, "verified" | "odds">;
    evidence: Pick<
      FiveTeamData["evidence"][number],
      "team" | "teamId" | "gameLineManifest"
    >[];
  },
  beforeTip?: string,
) {
  const schedule = new Map(
    data.games
      .filter((g) => g.data.season === "2025-26")
      .map((g) => [g.id, g.data]),
  );
  const values = new Map<
    string,
    { teamId: string; spread: number | null; total: number | null }
  >();
  const experimentTeams = new Set<string>(Object.values(teamIds));
  function primary(g: Row) {
    if ([g.home_team_id, g.away_team_id].includes(teamIds.BOS))
      return teamIds.BOS;
    return experimentTeams.has(g.home_team_id)
      ? g.home_team_id
      : g.away_team_id;
  }
  const boston = await openingGameLines(data.corpus.odds, data.ids, beforeTip);
  for (const [id, g] of schedule)
    if (primary(g) === teamIds.BOS) {
      const { celtics_spread, game_total } = boston(id, g.scheduled_tipoff);
      values.set(id, {
        teamId: teamIds.BOS,
        spread: celtics_spread,
        total: game_total,
      });
    }
  for (const e of data.evidence) {
    if (e.team === "BOS") continue;
    if (!e.gameLineManifest)
      throw Error("Missing game-line manifest for " + e.team);
    const release = await Release.open(
      e.gameLineManifest,
      data.corpus.verified,
    );
    const prefix = release.root.key.slice(
      0,
      release.root.key.lastIndexOf("/") + 1,
    );
    const games: Row[] = JSON.parse(
      (await release.bytes(prefix + "games.json")).toString(),
    );
    const eventIds = new Map<string, string>();
    for (const game of games) {
      const g = schedule.get(game.nba_game_id);
      if (
        !g ||
        ![g.home_team_id, g.away_team_id].includes(e.teamId) ||
        instant(g.scheduled_tipoff) !== instant(game.scheduled_start) ||
        eventIds.has(game.espn_event_id)
      )
        throw Error("Game-line schedule mismatch: " + game.nba_game_id);
      eventIds.set(game.espn_event_id, game.nba_game_id);
    }
    const quotes = (await release.rows(prefix + "quotes.ndjson.gz")).filter(
      (r) =>
        r.snapshot_kind === "scheduled_start" &&
        (!beforeTip || before(r.requested_at, beforeTip)) &&
        ["spreads", "team_totals"].includes(r.market),
    );
    for (const r of buildGameLines(quotes, teamNames[e.team])) {
      const id = eventIds.get(r.espn_event_id);
      if (!id) throw Error("Unknown game-line event: " + r.espn_event_id);
      const g = schedule.get(id)!;
      if (r.available_at !== instant(g.scheduled_tipoff))
        throw Error("Game-line snapshot differs from tip: " + id);
      if (primary(g) === e.teamId)
        values.set(id, {
          teamId: e.teamId,
          spread: r.spread,
          total: r.game_total,
        });
    }
  }
  return (teamId: string, id: string, tip: string) => {
    const g = schedule.get(id),
      line = values.get(id);
    if (
      !g ||
      !line ||
      instant(tip) !== instant(g.scheduled_tipoff) ||
      ![g.home_team_id, g.away_team_id].includes(teamId)
    )
      return { spread: null, total: null };
    return {
      spread:
        line.spread === null || line.teamId === teamId
          ? line.spread
          : -line.spread,
      total: line.total,
    };
  };
}

export async function fiveTeamReplay(
  data: FiveTeamData,
  image: string,
  receiptDirectory: string,
  beforeTip?: string,
): Promise<ReplaySource> {
  const source = await projectionSource(data.corpus, data.root);
  const model = projectionModel(image);
  let lines: ReturnType<typeof fiveTeamGameLines> | undefined;
  const games = new Map(source.schedule.map((g) => [g.gameId, g]));
  const schedule = source.teamGames.filter(
    (g) =>
      Object.values<string>(teamIds).includes(g.teamId) &&
      (!beforeTip || before(g.tip, beforeTip)),
  );
  function target(g: TeamGame) {
    teamCode(g.teamId);
    const target = games.get(g.gameId);
    if (
      !target ||
      target.tip !== g.tip ||
      !schedule.some((s) => s.gameId === g.gameId && s.teamId === g.teamId)
    )
      throw Error("Unknown replay team-game");
    return target;
  }
  return {
    data: data.data,
    schedule,
    async projection(g) {
      const game = target(g);
      const gameLines = await (lines ??= fiveTeamGameLines(data, beforeTip));
      const input = await source.input(game, g.teamId);
      const { forecast } = await recordReference(
        receiptDirectory,
        model,
        input,
      );
      return {
        reference: forecast,
        roster: input.roster,
        ...gameLines(g.teamId, g.gameId, g.tip),
      };
    },
    outcomes: (g, cutoff) => source.outcomes(target(g), cutoff),
  };
}
