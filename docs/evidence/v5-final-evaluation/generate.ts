// Builds final.json from the final-evaluation records alone (SPO-909).
//   npx tsx docs/evidence/v5-final-evaluation/generate.ts FINAL_DIR OUT
// FINAL_DIR is POOL/final/NOMINEE, holding nominated/ and clear-artifacts/.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { archiveRun } from "../../../src/evaluation/service/archive.js";
import {
  pairedComparison,
  summarize,
} from "../../../src/evaluation/service/scores.js";

const [dir, out] = process.argv.slice(2);
const names = ["minutes.pinball", "fantasy_points.pinball", "playBrier"];
const teams: Record<string, string> = {
  "1610612743": "DEN",
  "1610612763": "MEM",
};
const holdout = "2026-03-23T00:00:00.000Z";
const period = (tip: string) =>
  tip < "2026-01-01" ? "Oct-Dec" : tip < holdout ? "Jan-Mar 22" : "Mar 23 on";

function against(scores: any[]) {
  const c = pairedComparison(scores, scores, "reference");
  const sys = summarize(scores, "agent"),
    ref = summarize(scores, "reference");
  const refGame = new Map(
    ref.byGame.map((g: any) => [g.teamId + g.gameId, g.metrics]),
  );
  return {
    games: c.games,
    teamGames: c.teamGames,
    guardrailFlag: c.guardrailFlag,
    metrics: Object.fromEntries(
      names.map((k) => [
        k,
        {
          system: (sys.overall as any)[k],
          reference: (ref.overall as any)[k],
          ratio: (c.metrics as any)[k].ratio,
          ratio90: (c.metrics as any)[k].ratio90,
          teamGamesImproved: sys.byGame.filter(
            (g: any) =>
              g.metrics[k] < (refGame.get(g.teamId + g.gameId) as any)[k],
          ).length,
        },
      ]),
    ),
  };
}

function report(mode: string) {
  const a = archiveRun(join(dir, mode));
  const scores: any[] = a.scores;
  const sys = summarize(scores, "agent"),
    ref = summarize(scores, "reference");
  const group = (key: (s: any) => string) =>
    Object.fromEntries(
      [...new Set(scores.map(key))]
        .sort()
        .map((k) => [k, against(scores.filter((s) => key(s) === k))]),
    );
  // Players who played: absolute error of the median minutes forecast.
  const miss: Record<string, { n: number; system: number; reference: number }> =
    {};
  let sameAsReference = 0;
  for (const s of scores) {
    const refs = new Map(
      s.score.reference.players.map((p: any) => [p.playerId, p]),
    );
    if (
      s.score.agent.players.every(
        (p: any) =>
          JSON.stringify(p.forecast.minutes) ===
          JSON.stringify((refs.get(p.playerId) as any).forecast.minutes),
      )
    )
      sameAsReference++;
    for (const p of s.score.agent.players) {
      if (!p.actual.played) continue;
      const m = (miss[p.actual.starter ? "starters" : "bench"] ??= {
        n: 0,
        system: 0,
        reference: 0,
      });
      const r = refs.get(p.playerId) as any;
      m.n++;
      m.system += Math.abs(p.forecast.minutes[3] - p.actual.minutes);
      m.reference += Math.abs(r.forecast.minutes[3] - p.actual.minutes);
    }
  }
  for (const m of Object.values(miss)) {
    m.system /= m.n;
    m.reference /= m.n;
  }
  const tiers = Object.fromEntries(
    Object.keys(sys.byTier).map((t) => [
      t,
      (sys.byTier as any)[t]["minutes.pinball"] /
        (ref.byTier as any)[t]["minutes.pinball"],
    ]),
  );
  return {
    hash: a.hash,
    agentsInConfiguration: Object.keys((a.configuration as any).agents).length,
    artifactsInConfiguration: Object.keys((a.configuration as any).artifacts)
      .length,
    excluded: scores.filter((s) => s.score.status === "excluded").length,
    harnessFallbacks: a.forecasts.filter((f: any) => f.fallback).length,
    // The nominee returns the reference itself when its own code fails, which
    // the harness records as an ordinary forecast. Two independent readings.
    stepsLoggingErrorOrFallback: a.sandboxSteps.filter((s: any) =>
      /fallback|traceback|error|exception/i.test(s.stderr ?? ""),
    ).length,
    teamGamesWithReferenceMinutes: sameAsReference,
    sandboxSteps: a.sandboxSteps.length,
    agentCalls: a.calls.length,
    usd: scores.reduce((n, s) => n + s.costUsd + s.unresolvedUsd, 0),
    overall: against(scores),
    byTeam: group((s) => teams[s.teamId]),
    byPeriod: group((s) => period(s.tip)),
    beforeHoldout: against(scores.filter((s) => s.tip < holdout)),
    minutesRatioByTier: tiers,
    medianMinutesMissForPlayersWhoPlayed: miss,
    other: Object.fromEntries(
      Object.keys(sys.overall)
        .filter((k) => !names.includes(k))
        .map((k) => [
          k,
          {
            system: (sys.overall as any)[k],
            reference: (ref.overall as any)[k],
          },
        ]),
    ),
    scores,
  };
}

const nominated = report("nominated"),
  cleared = report("clear-artifacts");
const pair = pairedComparison(nominated.scores, cleared.scores);
const strip = ({ scores: _, ...rest }: any) => rest;
writeFileSync(
  out,
  JSON.stringify(
    {
      nominated: strip(nominated),
      clearArtifacts: strip(cleared),
      nominatedAgainstClearArtifacts: Object.fromEntries(
        names.map((k) => [
          k,
          {
            ratio: (pair.metrics as any)[k].ratio,
            ratio90: (pair.metrics as any)[k].ratio90,
          },
        ]),
      ),
      forecastsIdentical:
        JSON.stringify(
          archiveRun(join(dir, "nominated")).forecasts.map(
            (f: any) => f.forecast,
          ),
        ) ===
        JSON.stringify(
          archiveRun(join(dir, "clear-artifacts")).forecasts.map(
            (f: any) => f.forecast,
          ),
        ),
      agentsOff: "not run: the nominee has no agents",
    },
    null,
    2,
  ) + "\n",
);
