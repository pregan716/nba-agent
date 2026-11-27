import { RecordStore } from "../../runner/record.js";
import type { TeamGame } from "../../game-loop/replay.js";
import type { ScoredGame } from "./scores.js";

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
    if (
      ended.length !== 1 ||
      receipts.size !== games.length ||
      [...receipts.keys()].some((scope) => !gameScopes.has(scope))
    )
      throw Error("Incomplete evaluation record");
    // Listed in the manifest's tip order, not the order they were recorded
    // in: lanes record scores in an order that varies from run to run.
    const order = new Map([...gameScopes.keys()].map((k, i) => [k, i]));
    const scored = record
      .events("game_score")
      .sort((a, b) => (order.get(a.scope) ?? 0) - (order.get(b.scope) ?? 0));
    const scores: ScoredGame[] = scored.map((e) => {
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
    // Records made before SPO-941 hold the artifacts in the receipt.
    const stores = new Map(
      record.events("game_artifacts").map((e) => [e.scope, e.data.artifacts]),
    );
    const forecasts = [...receipts]
      .sort(([a], [b]) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
      .map(([scope, r]) => ({
        game: gameScopes.get(scope),
        spread: r.spread ?? null,
        total: r.total ?? null,
        forecast: r.frozen ?? r.reference,
        fallback: r.frozen === null,
        reason: r.reason,
        artifacts: stores.get(scope) ?? r.artifacts,
      }));
    const events = record.events();
    const calls = events
      .filter((e) =>
        ["agent_start", "agent_transcript", "agent_end"].includes(e.kind),
      )
      .map((e) => ({
        seq: e.seq,
        kind: e.kind,
        game: gameScopes.get(e.scope),
        data: e.data,
      }));
    const sandboxSteps = events
      .filter((e) => e.kind === "sandbox_step")
      .map(({ seq, scope, data }) => ({
        seq,
        game: gameScopes.get(scope),
        file: data.file,
        action: data.action,
        exitStatus: data.exitStatus,
        limit: data.limit,
        stderr: data.stderr,
        stdoutTruncated: data.stdoutTruncated,
      }));
    return {
      sandboxSteps,
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
