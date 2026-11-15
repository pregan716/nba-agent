import { writeFile } from "node:fs/promises";
import { fiveTeamData, fiveTeamGameLines } from "../src/data/five-team.js";
import { teamIds } from "../src/data/teams.js";
import { holdoutBoundary, viewGames } from "../src/data/architect-view.js";
import { openCorpus } from "../src/data/corpus.js";
import { DopplerStore } from "../src/data/store.js";
import { before } from "../src/data/time.js";
import { Temporal } from "@js-temporal/polyfill";
const store = new DopplerStore();
try {
  const a = await fiveTeamData(
    await openCorpus(store, process.cwd(), ".cache/objects"),
  );
  const cutoff = holdoutBoundary(a.games);
  const games = a.games.filter(
    (g) =>
      g.data.season === "2025-26" && before(g.data.scheduled_tipoff, cutoff),
  );
  const tips = new Map(games.map((g) => [g.id, g.data.scheduled_tipoff]));
  const injuries = new Set<string>();
  for await (const rows of a.corpus.injuries.partitions("teams", "2026-03-22"))
    for (const r of rows) {
      const tip = tips.get(r.data.game_id);
      if (
        tip &&
        before(r.availableAt, tip) &&
        r.data.observed_state !== "not_yet_submitted"
      )
        injuries.add(r.data.team_id + ":" + r.data.game_id);
    }
  const gameLines = await fiveTeamGameLines(a);
  const teams = [];
  for (const e of a.evidence) {
    const schedule = games
      .filter((g) =>
        [g.data.home_team_id, g.data.away_team_id].includes(e.teamId),
      )
      .sort((a, b) =>
        a.data.scheduled_tipoff.localeCompare(b.data.scheduled_tipoff),
      );
    const posts = (await e.evidence("posts", cutoff)).map((r) => r.availableAt);
    const transcripts = e.transcriptTimes().filter((t) => before(t, cutoff));
    const lineups = new Set(
      (await e.evidence("lineups", cutoff))
        .filter(
          (r) =>
            tips.has(r.data.game_id) &&
            before(r.availableAt, tips.get(r.data.game_id)),
        )
        .map((r) => r.data.game_id),
    );
    const props = new Set(
      e.odds
        ? (await e.odds.records()).flatMap((r) => {
            const id = a.ids.resolve("game", "espn", r.data.espn_event_id);
            const tip = tips.get(id);
            return tip && !before(tip, r.availableAt) ? [id] : [];
          })
        : [],
    );
    const windows = (times: string[]) =>
      schedule.filter((g, i) => {
        const tip = g.data.scheduled_tipoff;
        const from = i
          ? schedule[i - 1].data.scheduled_tipoff
          : Temporal.Instant.from(tip).subtract({ hours: 72 }).toString();
        return times.some((t) => !before(t, from) && before(t, tip));
      }).length;
    const lines = schedule.map((g) =>
      gameLines(e.teamId, g.id, g.data.scheduled_tipoff),
    );
    teams.push({
      team: e.team,
      games: schedule.length,
      withPosts: windows(posts),
      withTranscripts: windows(transcripts),
      withPregameInjuryReport: schedule.filter((g) =>
        injuries.has(e.teamId + ":" + g.id),
      ).length,
      withAnnouncedLineup: schedule.filter((g) => lineups.has(g.id)).length,
      withSpread: lines.filter((l) => l.spread !== null).length,
      withGameTotal: lines.filter((l) => l.total !== null).length,
      withProps: e.odds ? schedule.filter((g) => props.has(g.id)).length : null,
    });
  }
  const testTeams = new Set<string>([teamIds.DEN, teamIds.MEM]);
  const overlap = viewGames(games, "architect", cutoff).filter((g) =>
    [g.data.home_team_id, g.data.away_team_id].some((t) => testTeams.has(t)),
  ).length;
  if (overlap !== 14) throw Error("Unexpected development/test overlap");
  const report = {
    developmentVsTestGames: overlap,
    cutoff,
    method:
      "Regular-season team-games before the Celtics game 71 tip (March 23 UTC). Posts and publication-eligible transcript index entries count from the previous team tip to strictly before this tip (72 hours for the opener). Injury counts require a published team snapshot; props count pinned game consensus availability. Spread and game total use the scheduled-start snapshot. Player props were collected only for Boston.",
    teams,
  };
  await writeFile(
    process.argv[2] ?? "docs/evidence/five-team/coverage.json",
    JSON.stringify(report, null, 2) + "\n",
  );
} finally {
  store.close();
}
