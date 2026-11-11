import { Temporal } from "@js-temporal/polyfill";
import type { Corpus } from "../data/corpus.js";
import type { RecordEnvelope } from "../data/contracts.js";
import { before } from "../data/time.js";
import { releaseTime } from "../env/visibility.js";
import { auditPregames } from "./pregame.js";
import { BOS } from "./roster-types.js";
import type { Quantity } from "./forecast.js";

export class ExcludedOutcome extends Error {
  constructor(
    readonly gameId: string,
    readonly reason: string,
  ) {
    super("Excluded outcomes: " + gameId + " " + reason);
  }
}

export interface Game {
  gameId: string;
  tip: string;
  release: string;
  season: string;
  boston: boolean;
}
export type Outcome = Record<Quantity, number> & {
  playerId: string;
  teamId: string;
  played: boolean;
  starter: boolean | null;
  inactive: boolean;
};
export interface ReleasedGame extends Game {
  players: Outcome[];
}
export interface ModelInput {
  gameId: string;
  tip: string;
  roster: { playerId: string; inactive: boolean }[];
  history: ReleasedGame[];
  exclusions?: { gameId: string; reason: string }[];
}

export function eligibleHistory(schedule: Game[], target: Game) {
  return schedule
    .filter((g) => g.gameId !== target.gameId && before(g.release, target.tip))
    .sort(
      (a, b) => a.tip.localeCompare(b.tip) || a.gameId.localeCompare(b.gameId),
    );
}

export function outcome(box: RecordEnvelope, summary: RecordEnvelope): Outcome {
  const b = box.data,
    s = summary.data;
  if (
    b.player_id !== s.player_id ||
    b.team_id !== s.team_id ||
    b.game_id !== s.game_id
  )
    throw Error("Projection box/summary mismatch");
  const stat = (name: string) => {
    const value = b[name];
    if (value == null && ["dnp", "inactive"].includes(s.participation_status))
      return 0;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
      throw Error("Invalid box statistic: " + name);
    return value;
  };
  const minutes = stat("minutes_seconds") / 60,
    points = stat("points"),
    rebounds = stat("rebounds"),
    assists = stat("assists"),
    steals = stat("steals"),
    blocks = stat("blocks");
  const doubles = [points, rebounds, assists, steals, blocks].filter(
    (n) => n >= 10,
  ).length;
  return {
    playerId: b.player_id,
    teamId: b.team_id,
    played: minutes > 0 || s.participation_status === "played",
    starter: typeof s.starter === "boolean" ? s.starter : null,
    inactive: s.participation_status === "inactive" && minutes === 0,
    minutes,
    points,
    rebounds,
    assists,
    fantasy_points:
      points +
      0.5 * stat("three_pointers_made") +
      1.25 * rebounds +
      1.5 * assists +
      2 * (steals + blocks) -
      0.5 * stat("turnovers") +
      (doubles >= 2 ? 1.5 : 0) +
      (doubles >= 3 ? 3 : 0),
  };
}

// Select game IDs before opening their history, then guard individual envelopes
// before joining. Cache only complete games. The session never sees raw inputs.
export async function projectionSource(c: Corpus) {
  const seasons = [c.priorPbp, c.pbp];
  const records = (await Promise.all(seasons.map((a) => a.games()))).flat();
  const schedule: Game[] = records.map((g) => ({
    gameId: g.id,
    tip: new Date(g.data.scheduled_tipoff).toISOString(),
    release: new Date(releaseTime(g.data.scheduled_tipoff)).toISOString(),
    season: g.data.season,
    boston: [g.data.home_team_id, g.data.away_team_id].includes(BOS),
  }));
  const envelopes = new Map(records.map((g) => [g.id, g]));
  const cache = new Map<string, ReleasedGame>();
  const exclusions = new Map<string, string>();
  const rosters = new Map<string, ModelInput["roster"]>();
  async function loadReleased(allowed: Game[], cutoff: string) {
    for (const [i, season] of ["2024-25", "2025-26"].entries()) {
      const missing = allowed.filter(
        (g) =>
          g.season === season &&
          !cache.has(g.gameId) &&
          !exclusions.has(g.gameId),
      );
      if (!missing.length) continue;
      const releaseById = new Map(
        missing.map((g) => [g.gameId, Date.parse(g.release)]),
      );
      const games = missing.map((g) => envelopes.get(g.gameId)!);
      const load = async (table: string) => {
        const grouped = new Map<string, RecordEnvelope[]>();
        for await (const batch of seasons[i].exportRecords(table, games)) {
          if (batch.reason) {
            exclusions.set(batch.gameId, batch.reason);
            continue;
          }
          grouped.set(
            batch.gameId,
            batch.records.filter((r) => {
              if (!before(r.availableAt, cutoff)) return false;
              if (
                r.data.game_id !== batch.gameId ||
                Date.parse(r.availableAt) !== releaseById.get(batch.gameId)
              )
                throw Error(
                  "Unexpected released envelope: " + table + " " + batch.gameId,
                );
              return true;
            }),
          );
        }
        return grouped;
      };
      const summaries = await load("game_players"),
        boxes = await load("player_box_scores");
      for (const game of missing) {
        if (exclusions.has(game.gameId)) continue;
        const key = (r: RecordEnvelope) =>
          r.data.team_id + ":" + r.data.player_id;
        const rows = summaries.get(game.gameId) ?? [];
        const sm = new Map(rows.map((r) => [key(r), r]));
        if (sm.size !== rows.length)
          throw Error("Duplicate player summary in " + game.gameId);
        const players = (boxes.get(game.gameId) ?? [])
          .map((b) => {
            const s = sm.get(key(b));
            if (!s) throw Error("Missing player summary in " + game.gameId);
            sm.delete(key(b));
            return outcome(b, s);
          })
          .sort(
            (a, b) =>
              a.teamId.localeCompare(b.teamId) ||
              a.playerId.localeCompare(b.playerId),
          );
        if (sm.size)
          throw Error("Player summary without box in " + game.gameId);
        if (new Set(players.map((p) => p.teamId)).size !== 2)
          throw Error("Incomplete projection history: " + game.gameId);
        cache.set(game.gameId, { ...game, players });
      }
    }
  }
  return {
    schedule,
    async outcomes(game: Game, cutoff: string) {
      if (!before(game.release, cutoff))
        throw Error("Game outcomes unavailable before release");
      await loadReleased([game], cutoff);
      const result = cache.get(game.gameId);
      if (!result) {
        const reason = exclusions.get(game.gameId);
        if (reason) throw new ExcludedOutcome(game.gameId, reason);
        throw Error("Missing outcomes: " + game.gameId);
      }
      return result;
    },
    async input(target: Game): Promise<ModelInput> {
      const allowed = eligibleHistory(schedule, target);
      await loadReleased(allowed, target.tip);
      const pending = [
        ...allowed.filter((g) => g.season === target.season && g.boston),
        target,
      ].filter((g) => !rosters.has(g.gameId));
      if (pending.length) {
        const pregames = await auditPregames(
          c,
          pending.map((g) => g.gameId),
          [],
          process.cwd(),
          undefined,
          {
            throughReportDay: Temporal.Instant.from(target.tip)
              .toZonedDateTimeISO("America/New_York")
              .toPlainDate()
              .toString(),
            omitLineups: true,
          },
        );
        for (const pre of pregames) {
          const out = new Set(
            pre.injuryReport.players
              .filter((r) =>
                ["out", "doubtful"].includes(r.status.toLowerCase()),
              )
              .map((r) => r.playerId),
          );
          rosters.set(
            pre.gameId,
            pre.roster.map((r) => ({
              playerId: r.playerId,
              inactive: out.has(r.playerId),
            })),
          );
        }
      }
      return {
        gameId: target.gameId,
        tip: target.tip,
        roster: rosters.get(target.gameId)!,
        history: allowed
          .filter((g) => cache.has(g.gameId))
          .map((g) => cache.get(g.gameId)!),
        exclusions: allowed
          .filter((g) => exclusions.has(g.gameId))
          .map((g) => ({
            gameId: g.gameId,
            reason: exclusions.get(g.gameId)!,
          })),
      };
    },
  };
}
