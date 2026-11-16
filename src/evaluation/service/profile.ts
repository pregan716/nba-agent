import { developmentHoldout } from "../../data/development-evidence.js";
import { z } from "zod";
import { teamIds, developmentTeams } from "../../data/teams.js";
import {
  defaultProfile as replayProfile,
  type TeamGame,
} from "../../game-loop/replay.js";
import { before } from "../../data/time.js";

const window = z.strictObject({
  from: z.iso.date(),
  until: z.iso.date(),
  count: z.number().int().positive(),
});
export const profileSchema = z.strictObject({
  poolUsd: z.number().positive(),
  fullLimit: z.number().int().positive(),
  testLimit: z.number().int().min(1).max(5),
  replay: z.strictObject({
    usdPerTeamGame: z.number().nonnegative(),
    gameUsd: z.number().nonnegative(),
    gameMinutes: z.number().positive().max(35791),
  }),
  windows: z.strictObject({ middle: window, opening: window, late: window }),
});
export const evaluationProfile = {
  poolUsd: 1000,
  fullLimit: 12,
  testLimit: 5,
  replay: replayProfile,
  windows: {
    middle: { from: "2026-01-05", until: "2026-02-02", count: 43 },
    opening: { from: "2025-10-21", until: "2025-11-18", count: 41 },
    late: { from: "2026-02-23", until: "2026-03-23", count: 42 },
  },
};
export const developmentRequest = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("full"), package: z.unknown() }),
  z.strictObject({
    kind: z.literal("test"),
    package: z.unknown(),
    games: z
      .array(z.strictObject({ teamId: z.string(), gameId: z.string() }))
      .min(1)
      .max(5),
  }),
  z.strictObject({
    kind: z.literal("check"),
    runId: z.uuid(),
    window: z.enum(["opening", "late"]),
  }),
  z.strictObject({ kind: z.literal("repeat"), runId: z.uuid() }),
]);
export type Request = z.infer<typeof developmentRequest>;
export { developmentHoldout as holdout };
export function developmentGames(
  schedule: TeamGame[],
  request: Request,
  profile: typeof evaluationProfile,
  prior?: TeamGame[],
) {
  const allowed = schedule.filter(
    (g) =>
      developmentTeams.some((t) => teamIds[t] === g.teamId) &&
      before(g.tip, developmentHoldout),
  );
  if (request.kind === "test" || request.kind === "repeat") {
    const wanted = request.kind === "test" ? request.games : prior;
    if (
      !wanted?.length ||
      (request.kind === "test" && wanted.length > profile.testLimit)
    )
      throw Error("Invalid evaluation sample");
    const selected = allowed.filter((g) =>
      wanted.some((h) => h.teamId === g.teamId && h.gameId === g.gameId),
    );
    if (selected.length !== wanted.length)
      throw Error("Unknown or duplicate development team-game");
    return selected;
  }
  const w =
    profile.windows[request.kind === "full" ? "middle" : request.window];
  const games = allowed.filter(
    (g) =>
      !before(g.tip, w.from + "T00:00:00Z") &&
      before(g.tip, w.until + "T00:00:00Z"),
  );
  if (games.length !== w.count) throw Error("Incomplete evaluation window");
  return games;
}
export function finalGames(schedule: TeamGame[]) {
  const games = schedule.filter(
    (g) => g.teamId === teamIds.DEN || g.teamId === teamIds.MEM,
  );
  for (const team of [teamIds.DEN, teamIds.MEM])
    if (
      new Set(games.filter((g) => g.teamId === team).map((g) => g.gameId))
        .size !== 82
    )
      throw Error("Incomplete final schedule");
  if (games.length !== 164) throw Error("Duplicate final team-game");
  return games;
}
