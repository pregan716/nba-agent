import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Corpus } from "./corpus.js";
import { Identities, normalizeName, type Mapping } from "./identity.js";
import { PlayByPlayAdapter } from "./adapters.js";
import { teamIds, teams, teamCode } from "./teams.js";
import { openTeamEvidence } from "./team-evidence.js";
import { corpusSource } from "../env/source.js";
import type { EvidenceSource } from "../env/contract.js";
import { loadSeasonRoster } from "../projection/roster.js";
import { projectionSource } from "../projection/input.js";
import { projectionModel, recordReference } from "../projection/reference.js";
import type { ReplaySource, TeamGame } from "../game-loop/replay.js";
import { openingGameLines, gameLineVersion } from "../projection/game-lines.js";
import { before } from "./time.js";

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
      return (
        await Promise.all(
          evidence.flatMap((e) => (e.odds ? [e.odds.records()] : [])),
        )
      ).flat();
    },
    async evidence(kind: EvidenceSource, cutoff?: string) {
      if (!cutoff) throw Error("V5 research evidence requires a cutoff");
      return researchEvidence(kind, cutoff);
    },
  };
  return { root, corpus, data: source, evidence, games, ids, rosters };
}
export type FiveTeamData = Awaited<ReturnType<typeof fiveTeamData>>;

export async function fiveTeamReplay(
  data: FiveTeamData,
  image: string,
  receiptDirectory: string,
): Promise<ReplaySource> {
  const source = await projectionSource(data.corpus, data.root);
  const model = projectionModel(image);
  const gameLines = await openingGameLines(data.corpus.odds, data.ids);
  const games = new Map(source.schedule.map((g) => [g.gameId, g]));
  const schedule = source.teamGames.filter((g) =>
    Object.values<string>(teamIds).includes(g.teamId),
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
      const input = await source.input(target(g), g.teamId);
      const { forecast } = await recordReference(
        receiptDirectory,
        model,
        input,
      );
      const { celtics_spread, game_total } = gameLines(g.gameId, g.tip);
      return {
        reference: forecast,
        roster: input.roster,
        spread:
          celtics_spread === null
            ? null
            : g.teamId === teamIds.BOS
              ? celtics_spread
              : -celtics_spread,
        total: game_total,
      };
    },
    outcomes: (g, cutoff) => source.outcomes(target(g), cutoff),
  };
}
