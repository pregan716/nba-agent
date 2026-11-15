import { RecordStore } from "../../runner/record.js";
import type { TeamGame } from "../../game-loop/replay.js";
import type { ScoredGame } from "./scores.js";

/** Free-form provider output, diagnostics and artifacts can quote game lines
 * even when all keys referring to markets have been stripped. Keep the full
 * audit record private and project the public events from trusted fields. */
export function archiveRun(root: string) {
  const record = new RecordStore(root);
  try {
    const manifest = record.events("manifest")[0].data;
    const games: TeamGame[] = manifest.games;
    const gameScopes = new Map(
      games.map((g) => [JSON.stringify([g.teamId, g.gameId]), g]),
    );
    const receipts = new Map(
      record.events("team_game").map((e) => [e.scope, e.data]),
    );
    const ended = record.events("replay_end");
    if (ended.length !== 1 || receipts.size !== games.length)
      throw Error("Incomplete evaluation record");
    const scores: ScoredGame[] = record.events("game_score").map((e) => {
      const game = gameScopes.get(e.scope);
      if (!game) throw Error("Unknown scored team-game");
      // scoreGame is the typed, non-market scoring boundary used by the loop.
      const receipt = receipts.get(e.scope);
      if (!receipt) throw Error("Missing team-game receipt");
      return {
        ...game,
        score: e.data,
        costUsd: receipt.costUsd,
        unresolvedUsd: receipt.unresolvedUsd,
        wallClockMs: receipt.wallClockMs,
      };
    });
    if (
      new Set(scores.map((g) => JSON.stringify([g.teamId, g.gameId]))).size !==
        games.length ||
      scores.length !== games.length
    )
      throw Error("Incomplete evaluation scores");
    const forecasts = [...receipts].map(([scope, r]) => {
      const withheld = r.marketExposed !== false;
      return {
        game: gameScopes.get(scope),
        forecast: r.frozen ?? r.reference,
        fallback: r.frozen === null,
        reason:
          !withheld ||
          r.reason === null ||
          r.reason === "run_budget_exhausted" ||
          r.reason === "wall_clock"
            ? r.reason
            : "forecast_failed",
        artifacts: withheld
          ? r.artifacts.map((a: { name: string; team: string | null }) => ({
              name: a.name,
              team: a.team,
              withheld: true,
            }))
          : r.artifacts,
      };
    });
    const calls = record.events().flatMap((e) => {
      if (!["agent_start", "agent_transcript", "agent_end"].includes(e.kind))
        return [];
      const withheld = receipts.get(e.scope)?.marketExposed !== false;
      let data = e.data;
      if (withheld) {
        if (e.kind === "agent_start")
          data = {
            name: Object.hasOwn(manifest.package.agents, e.data.name)
              ? e.data.name
              : null,
            model: e.data.model,
            system: e.data.system,
          };
        else if (e.kind === "agent_end")
          data = {
            call: e.data.call,
            model: e.data.model,
            ok: e.data.reply.ok,
            usd: e.data.usd,
            unresolvedUsd: e.data.unresolvedUsd,
          };
        else data = { call: e.data.call };
      }
      return [
        {
          seq: e.seq,
          kind: e.kind,
          game: gameScopes.get(e.scope),
          withheld,
          data,
        },
      ];
    });
    return {
      configuration: manifest.package,
      hash: manifest.packageHash,
      forecasts,
      calls,
      scores,
    };
  } finally {
    record.close();
  }
}
