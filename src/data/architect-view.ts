import { Temporal } from "@js-temporal/polyfill";
import { mkdtemp, mkdir, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { FiveTeamData } from "./five-team.js";
import { teamIds, developmentTeams } from "./teams.js";
import type { RecordEnvelope } from "./contracts.js";
import { before, instant } from "./time.js";
import { GAME_HISTORY_TABLES } from "../env/contract.js";
import {
  PROVENANCE_COLUMNS,
  projectHistory,
  writeSessionExport,
  type ExportBatch,
} from "../env/export.js";
import { releaseTime } from "../env/visibility.js";
import { pick } from "./adapters.js";

type ViewSource = {
  games: RecordEnvelope[];
  data: Pick<FiveTeamData["data"], "columns" | "exportHistory">;
  corpus: { injuries: Pick<FiveTeamData["corpus"]["injuries"], "partitions"> };
  evidence: Pick<FiveTeamData["evidence"][number], "teamId" | "evidence">[];
  rosters: ReadonlyMap<
    string,
    {
      at(
        tip: string,
      ): { playerId: string; name: string; availableAt: string }[];
    }
  >;
};

export function holdoutBoundary(games: RecordEnvelope[]) {
  const boston = games
    .filter(
      (g) =>
        g.data.season === "2025-26" &&
        [g.data.home_team_id, g.data.away_team_id].includes(teamIds.BOS),
    )
    .sort((a, b) =>
      Temporal.Instant.compare(
        a.data.scheduled_tipoff,
        b.data.scheduled_tipoff,
      ),
    );
  if (boston.length !== 82) throw Error("Incomplete Boston schedule");
  const tip = instant(boston[70].data.scheduled_tipoff);
  if (tip !== "2026-03-23T00:00:00Z")
    throw Error("Unexpected Boston holdout tip");
  return tip;
}
export type View = "architect" | "training";
const developmentIds = new Set<string>(developmentTeams.map((t) => teamIds[t]));
export function viewGames(games: RecordEnvelope[], view: View, cutoff: string) {
  return games.filter(
    (g) =>
      before(g.data.scheduled_tipoff, cutoff) &&
      ((g.data.season === "2024-25" &&
        before(g.data.scheduled_tipoff, "2025-07-01T00:00:00Z")) ||
        (view === "architect" &&
          g.data.season === "2025-26" &&
          [g.data.home_team_id, g.data.away_team_id].some((t) =>
            developmentIds.has(t),
          ))),
  );
}
export async function* viewBatches(
  data: ViewSource,
  view: View,
  signal: AbortSignal,
): AsyncGenerator<ExportBatch> {
  const cutoff = holdoutBoundary(data.games);
  const selected = viewGames(data.games, view, cutoff);
  const currentGames = new Map(
    selected.filter((g) => g.data.season === "2025-26").map((g) => [g.id, g]),
  );
  const games = new Map(selected.map((g) => [g.id, g]));
  yield {
    table: "schedule",
    rows: selected.map((g) =>
      pick(g.data, [
        "game_id",
        "season",
        "home_team_id",
        "away_team_id",
        "scheduled_tipoff",
      ]),
    ),
  };
  const released = selected.filter((g) =>
    before(releaseTime(g.data.scheduled_tipoff), cutoff),
  );
  for (const table of GAME_HISTORY_TABLES) {
    if (table === "games") continue;
    const defs = (await data.data.columns(table)).filter(
      (c) => !PROVENANCE_COLUMNS.includes(c.name),
    );
    for await (const batch of data.data.exportHistory!(table, released)) {
      signal.throwIfAborted();
      const game = games.get(batch.gameId);
      if (!game || !before(releaseTime(game.data.scheduled_tipoff), cutoff))
        throw Error("Unexpected game in view export");
      if (batch.reason) {
        yield {
          table: "unavailable",
          rows: [{ game_id: game.id, table, reason: batch.reason }],
        };
        continue;
      }
      const rowCutoff =
        game.data.season === "2024-25" ? "2025-07-01T00:00:00Z" : cutoff;
      yield {
        table,
        rows: batch.records
          .filter(
            (r) =>
              r.data.game_id === game.id &&
              (!r.data.season || r.data.season === game.data.season) &&
              before(r.availableAt, rowCutoff) &&
              (!r.eventTime || before(r.eventTime, rowCutoff)),
          )
          .map((r) => projectHistory(r, defs)),
      };
    }
  }
  if (view === "training") return;
  const day = Temporal.Instant.from(cutoff)
    .subtract({ nanoseconds: 1 })
    .toZonedDateTimeISO("America/New_York")
    .toPlainDate()
    .toString();
  for (const kind of ["teams", "players"] as const) {
    for await (const batch of data.corpus.injuries.partitions(kind, day)) {
      signal.throwIfAborted();
      yield {
        table: "injury_" + kind,
        rows: batch
          .filter((r) => {
            const g = currentGames.get(r.data.game_id);
            return (
              g &&
              [g.data.home_team_id, g.data.away_team_id].includes(
                r.data.team_id,
              ) &&
              (!r.eventTime || before(r.eventTime, cutoff)) &&
              before(r.availableAt, g.data.scheduled_tipoff)
            );
          })
          .map((r) => ({
            ...pick(r.data, [
              "game_id",
              "team_id",
              "player_name",
              "status",
              "reason",
              "observed_state",
            ]),
            available_at: r.availableAt,
          })),
      };
    }
  }
  for (const team of data.evidence.filter((e) =>
    developmentIds.has(e.teamId),
  )) {
    const roster = data.rosters.get(team.teamId)!;
    for (const g of currentGames.values())
      if ([g.data.home_team_id, g.data.away_team_id].includes(team.teamId))
        yield {
          table: "rosters",
          rows: roster
            .at(g.data.scheduled_tipoff)
            .filter((p) => before(p.availableAt, g.data.scheduled_tipoff))
            .map((p) => ({ game_id: g.id, team_id: team.teamId, ...p })),
        };
    for (const kind of ["posts", "transcripts", "lineups"] as const) {
      const rows = await team.evidence(kind, cutoff);
      yield {
        table: kind,
        rows: rows
          .filter((r) => {
            if (
              r.data.team_id !== team.teamId ||
              !before(r.availableAt, cutoff) ||
              (r.eventTime && !before(r.eventTime, cutoff))
            )
              return false;
            const id = r.data.game_id;
            if (id === undefined) return kind !== "lineups";
            const game = currentGames.get(id);
            return (
              game &&
              [game.data.home_team_id, game.data.away_team_id].includes(
                team.teamId,
              ) &&
              (kind !== "lineups" ||
                before(r.availableAt, game.data.scheduled_tipoff))
            );
          })
          .map((r) => ({
            id: r.id,
            available_at: r.availableAt,
            ...pick(r.data, [
              "team_id",
              "game_id",
              "text",
              "title",
              "readable",
              "source",
              "startingLineup",
              "url",
              "accountId",
            ]),
          })),
      };
    }
  }
}
/** Publish a fresh, complete directory. The caller mounts it read-only. */
export async function writeView(
  data: ViewSource,
  view: View,
  path: string,
  signal: AbortSignal,
) {
  const dest = resolve(path);
  await mkdir(dirname(dest), { recursive: true });
  const staging = await mkdtemp(dest + ".stage-");
  try {
    await writeSessionExport(staging, viewBatches(data, view, signal), signal);
    signal.throwIfAborted();
    await rename(staging, dest);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
