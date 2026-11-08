// Offline experiment only: decision windows for every team's 2024-25 regular-season games.
// The builder is Celtics-specific, so each team-game's input rows are relabelled
// (target team id <-> Celtics id) before buildDataset. Same box-score roster policy as
// loadPriorSeasonTraining (training only). Slim rows: only fields the model reads.
import { createWriteStream, readFileSync } from "node:fs";
import { DopplerStore } from "../../../../src/data/store.js";
import { openCorpus } from "../../../../src/data/corpus.js";
import { loadReplayInputs } from "../../../../src/replay/load.js";
import { buildDataset } from "../../../../src/replay/dataset.js";

const BOS = "1610612738";
const corpus = await openCorpus(new DopplerStore(), process.cwd(), ".cache/objects");
const adapter = corpus.priorPbp;
const games = (await adapter.games())
  .filter((g: any) => g.data.season === "2024-25" && g.data.phase === "regular_season")
  .sort((a: any, b: any) => a.data.scheduled_tipoff.localeCompare(b.data.scheduled_tipoff));
const ids = new Set(games.map((g: any) => g.id));
const rosters = new Map<string, Set<string>>();
for (const path of adapter.release.manifest.tables.player_box_scores ?? [])
  for (const row of await adapter.release.rows(adapter.release.manifest.object_prefix + path))
    if (ids.has(row.game_id)) {
      const key = `${row.game_id}:${row.team_id}`;
      (rosters.get(key) ?? rosters.set(key, new Set()).get(key)!).add(row.player_id);
    }
function swap<T>(v: T, a: string, b: string): T {
  if (v === a) return b as T;
  if (v === b) return a as T;
  if (Array.isArray(v)) return v.map((x) => swap(x, a, b)) as T;
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x, a, b)])) as T;
  return v;
}
const slim = (w: any) => ({
  id: w.id,
  exclusions: w.exclusions,
  actual: w.actual,
  state: w.state && {
    sequence: w.state.sequence,
    period: w.state.period,
    clockMs: w.state.clockMs,
    margin: w.state.margin,
    stoppage: w.state.stoppage,
    celtics: w.state.celtics,
    eligibleBench: w.state.eligibleBench,
    players: w.state.players.map(({ box, ...p }: any) => p),
    history: {
      substitutions: w.state.history.substitutions.filter((s: any) => s.teamId === BOS),
    },
  },
});
const out = createWriteStream(".cache/hazard/windows-league.jsonl");
let teamGames = 0, windows = 0, failed: string[] = [];
const batch = 60;
for (let i = 0; i < games.length; i += batch) {
  const chunk = games.slice(i, i + batch);
  const pregames = chunk.flatMap((g: any) =>
    [g.data.home_team_id, g.data.away_team_id]
      .filter((t: string) => t !== BOS)
      .map((team: string) => {
        const availableAt = new Date(Date.parse(g.data.scheduled_tipoff) - 1).toISOString();
        return {
          team,
          pregame: {
            gameId: g.id,
            scheduledStart: g.data.scheduled_tipoff,
            roster: [...(rosters.get(`${g.id}:${team}`) ?? [])]
              .sort()
              .map((playerId) => ({ playerId, availableAt })),
            injuryReport: { availableAt, state: "unknown", players: [] },
            announcedStarters: null,
            sources: [adapter.release.root],
          },
        };
      }),
  );
  const inputs = await loadReplayInputs({ pbp: adapter } as any, pregames.map((p: any) => p.pregame));
  inputs.forEach((input: any, j: number) => {
    const { team, pregame } = pregames[j];
    try {
      if (pregame.roster.length < 5) throw Error("no roster");
      const d = buildDataset(swap(input, team, BOS));
      teamGames++;
      for (const w of d.windows) {
        windows++;
        out.write(
          JSON.stringify({
            season: "2024-25",
            team,
            gameId: `${pregame.gameId}:${team}`,
            scheduledStart: pregame.scheduledStart,
            window: slim(w),
          }) + "\n",
        );
      }
    } catch (e) {
      failed.push(`${pregame.gameId}:${team} ${(e as Error).message.slice(0, 60)}`);
    }
  });
  process.stderr.write(`${Math.min(i + batch, games.length)}/${games.length}\r`);
}
out.end();
console.log(`\nteamGames=${teamGames} windows=${windows} failed=${failed.length}`);
console.log(failed.slice(0, 20).join("\n"));
