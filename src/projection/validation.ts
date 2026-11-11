import { z } from "zod";
import { quantities, type Forecast } from "./forecast.js";
import type { ModelInput } from "./input.js";

export type Pregame = Pick<ModelInput, "gameId" | "tip" | "roster">;
const n = z.number();
const range = z.tuple([n, n, n, n, n, n, n]);
const probability = n.min(0).max(1);
const schema = z.strictObject({
  version: z.literal("forecast-v1"),
  gameId: z.string(),
  players: z.array(
    z.strictObject({
      playerId: z.string(),
      p_play: probability,
      p_start: probability,
      minutes: range,
      points: range,
      rebounds: range,
      assists: range,
      fantasy_points: range,
    }),
  ),
});

export function validateForecast(
  draft: unknown,
  pre: Pregame,
): { ok: true; forecast: Forecast } | { ok: false; reason: string } {
  const parsed = schema.safeParse(draft);
  if (!parsed.success) return { ok: false, reason: parsed.error.message };
  const f = parsed.data;
  if (f.gameId !== pre.gameId)
    return { ok: false, reason: "Wrong forecast game" };
  const remaining = new Set(pre.roster.map((r) => r.playerId));
  for (const player of f.players) {
    if (!remaining.delete(player.playerId))
      return {
        ok: false,
        reason: "Duplicate or unexpected player " + player.playerId,
      };
    for (const stat of quantities) {
      const r = player[stat];
      const label = stat + " for " + player.playerId;
      const floor = stat === "fantasy_points" ? -10 : 0;
      if (r.some((v) => v < floor))
        return { ok: false, reason: label + " must be at least " + floor };
      if (stat === "minutes" && r.some((v) => v > 58))
        return { ok: false, reason: label + " must be at most 58" };
      if (r.some((v, i) => i > 0 && v < r[i - 1]))
        return { ok: false, reason: label + " must be non-decreasing" };
    }
  }
  if (remaining.size)
    return {
      ok: false,
      reason: "Missing roster players: " + [...remaining].join(", "),
    };
  return { ok: true, forecast: f };
}
