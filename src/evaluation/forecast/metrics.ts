import { quantities } from "../../projection/forecast.js";
import { heldOutBlend } from "./blend.js";
import { scoreProps, type Snapshot, type Feedback } from "./market.js";

export const tiers = [
  "all",
  "deep bench",
  "fringe",
  "rotation",
  "core",
] as const;
export type Ratio = [sum: number, weight: number];
export type Metrics = Record<string, Ratio>;
export interface GameResult {
  id: string;
  index: number;
  flagged: boolean;
  costUsd: number;
  wallClockMs: number;
  feedback: Feedback;
  market: Snapshot;
}
const avg = (value: number | null): Ratio =>
  value === null ? [0, 0] : [value, 1];
export function gameMetrics(games: GameResult[], side: "agent" | "reference") {
  const rows = games.map((g) => scoreProps(g.feedback, g.market, side));
  const blends = heldOutBlend(rows.flat());
  return games.map((g, i) => {
    const result: Metrics = {};
    for (const tier of tiers) {
      const scores = g.feedback[side];
      const s = tier === "all" ? scores.overall : scores.byTier[tier];
      const m: Metrics = {};
      for (const q of quantities)
        for (const k of ["pinball", "coverage50", "coverage80"] as const)
          m[q + "." + k] = avg(s.ranges[q][k].mean);
      m.playBrier = avg(s.playBrier.mean);
      m.startBrier = avg(s.startBrier.mean);
      m.misplacedMinutes = avg(s.players ? s.misplacedMinutes : null);
      for (const k of ["coverage50", "coverage80"] as const)
        m["minutes.conditional." + k] = avg(
          s.conditionalMinutesCoverage[k].mean,
        );
      const c = s.ceiling;
      m["ceiling.brier"] = [(c.brier.mean ?? 0) * c.brier.count, c.brier.count];
      m["ceiling.hitRate"] =
        side === "agent"
          ? [c.hits, c.picks]
          : [c.referenceWeighted.numerator, c.referenceWeighted.denominator];
      m["ceiling.hitRateWithoutVoids"] =
        side === "reference" ? [0, 0] : [c.hits, c.picks - c.voids];
      m["ceiling.voidRate"] =
        side === "reference" ? [0, 0] : [c.voids, c.picks];
      m["ceiling.referenceWeighted"] = [
        c.referenceWeighted.numerator,
        c.referenceWeighted.denominator,
      ];
      const pool = rows[i].filter((r) => tier === "all" || r.tier === tier),
        picked = pool.filter((r) => r.picked);
      const hits = picked.reduce((a, p) => a + p.hit, 0),
        voids = picked.filter((r) => !r.played).length;
      m["big.hitRate"] = [hits, picked.length];
      m["big.hitRateWithoutVoids"] = [hits, picked.length - voids];
      m["big.voidRate"] = [voids, picked.length];
      m["big.baseRate"] = [pool.reduce((a, p) => a + p.hit, 0), pool.length];
      m["big.brier"] = [
        pool.reduce((a, p) => a + (p.probability - p.hit) ** 2, 0),
        pool.length,
      ];
      const played = pool.filter((r) => r.played),
        loss = played.flatMap((r) => blends.get(r) ?? []);
      m["market.brier"] = [
        played.reduce((a, r) => a + (r.over - r.y) ** 2, 0),
        played.length,
      ];
      m["market.consensusBrier"] = [
        played.reduce((a, r) => a + (r.market - r.y) ** 2, 0),
        played.length,
      ];
      m["market.brierMinusConsensus"] = [
        m["market.brier"][0] - m["market.consensusBrier"][0],
        played.length,
      ];
      m["market.marketOnlyLogLoss"] = [
        loss.reduce((a, r) => a + r.market, 0),
        loss.length,
      ];
      m["market.blendLogLoss"] = [
        loss.reduce((a, r) => a + r.blend, 0),
        loss.length,
      ];
      m["market.blendMinusMarketOnly"] = [
        m["market.blendLogLoss"][0] - m["market.marketOnlyLogLoss"][0],
        loss.length,
      ];
      m["market.dnpRate"] = [pool.length - played.length, pool.length];
      if (tier === "all")
        m["market.unavailableRate"] = [
          g.market.unavailable,
          pool.length + g.market.unavailable,
        ];
      for (const [name, value] of Object.entries(m))
        result[tier + "/" + name] = value;
    }
    return result;
  });
}
