import type { DecisionDataset } from "../replay/types.js";
import type { RecordEnvelope, Row } from "../data/contracts.js";
import { opener } from "../replay/dataset.js";
import { actionFor } from "../replay/state.js";
import { digest } from "../runner/config.js";
import { releasedGame } from "./visibility.js";
import type { SessionSource } from "./source.js";

export const DECISION_EXPOSURE = "decision-history-v1";
export const DECISION_TABLES = [
  "decision_windows",
  "unanchored_substitutions",
] as const;
export type DecisionTable = (typeof DECISION_TABLES)[number];
export const decisionTable = (table: string): table is DecisionTable =>
  (DECISION_TABLES as readonly string[]).includes(table);
export const DECISION_DESCRIPTION =
  "windows-v2: full timeouts, personal/offensive fouls, dead-ball turnovers, violations and held-ball jump balls open windows. State is frozen after the opener and before subsequent events; retrospective jump-ball markers use the pre-substitution snapshot. Duplicate rows of one whistle form one window; ambiguous same-clock runs are excluded. The outcome is the same-clock Celtics substitution block, or the immediately adjacent block allowed by the pinned rule. One window per quarter/period break carries the net lineup change. unanchored_substitutions holds the ledger of substitutions no opener anchors and excluded-window qualifications. Facts only, no predictions or scoring losses.";
const windowDescriptions = {
  game_id: "Canonical game id.",
  window_id: "Pinned decision-window id.",
  window_version: "Window-definition version (windows-v2).",
  period: "Period of the decision; upcoming period for a boundary.",
  clock_remaining_ms:
    "Game clock remaining in milliseconds; full upcoming clock at boundaries.",
  canonical_sequence:
    "Canonical sequence of the opener, not the state cutoff; null at boundaries.",
  stoppage_kind: "Independent opener kind, or between_periods.",
  timeout_team: "Team that called the timeout; null otherwise or unknown.",
  free_throws_pending: "1 if free throws remain, 0 if none, null if unknown.",
  celtics_home: "1 if Boston is home, 0 if away.",
  celtics_score:
    "Boston points in the observable state; null when state is unavailable.",
  opponent_score:
    "Opponent points in the observable state; null when state is unavailable.",
  celtics_lineup:
    "JSON array of Boston's five before the decision; null if state is unavailable.",
  opponent_lineup:
    "JSON array of the opposing five before the decision; null if state is unavailable.",
  eligible_bench:
    "JSON array of eligible Celtics bench ids; null if state is unavailable.",
  players_out:
    "JSON array of actual exits; empty for no substitution, null when outcome cannot be reconstructed.",
  players_in:
    "JSON array of actual entries; empty for no substitution, null when outcome cannot be reconstructed.",
  substituted:
    "1 when players_out is nonempty, 0 when empty, null for an unknown outcome.",
  excluded: "1 if the window is excluded, 0 otherwise.",
  exclusion_reason:
    "All window exclusion reasons joined by semicolons, or null.",
  adjacency:
    "1 if an outcome bucket was attached under the adjacency rule, 0 otherwise.",
  state:
    "Exact state-v1 JSON supplied to the assembler; null for an unavailable state. Prior-season membership uses same-game-box-score-v1, with unknown injury status and synthetic pregame timestamps, never for evaluation.",
};
const ledgerDescriptions = {
  game_id: "Canonical game id.",
  period:
    "Period at the ledger span's start, or null for a coverage-gap entry.",
  clock_remaining_ms:
    "Clock at the ledger span's start, or null when unavailable.",
  mechanism:
    "Mechanism recorded in the decision dataset ledger, including excluded-window qualification entries.",
  sequence_start: "Inclusive start of the ledger span.",
  sequence_end: "Inclusive end of the ledger span.",
  players_out:
    "JSON array of Celtics exits in substitution rows in the span; null for a coverage gap.",
  players_in:
    "JSON array of Celtics entries in substitution rows in the span; null for a coverage gap.",
};
export const decisionColumns = (table: DecisionTable) =>
  Object.entries(
    table === "decision_windows" ? windowDescriptions : ledgerDescriptions,
  ).map(([name, description]) => ({ name, description }));
export interface DecisionHistory {
  dataset: DecisionDataset;
  events: Row[];
  participants: Row[];
}
export function decisionRows(
  table: DecisionTable,
  { dataset: d, events: raw, participants }: DecisionHistory,
) {
  const events = raw
    .filter((e) => e.validity === "effective" && e.game_id === d.gameId)
    .sort((a, b) => a.canonical_sequence - b.canonical_sequence);
  if (table === "unanchored_substitutions")
    return d.ledger.map((l) => {
      const span = events.filter(
        (e) =>
          e.canonical_sequence >= l.span[0] &&
          e.canonical_sequence <= l.span[1],
      );
      const missing = l.reason === "prior_season_coverage_gap";
      const actual = missing
        ? null
        : actionFor(
            span.filter((e) => e.type === "substitution"),
            participants,
          );
      return {
        game_id: d.gameId,
        period: missing ? null : (span[0]?.period ?? null),
        clock_remaining_ms: missing
          ? null
          : (span[0]?.clock_remaining_ms ?? null),
        mechanism: l.mechanism,
        sequence_start: l.span[0],
        sequence_end: l.span[1],
        players_out: actual?.players_out ?? null,
        players_in: actual?.players_in ?? null,
      };
    });
  return d.windows.map((w) => {
    const s = w.state;
    const first = events.find((e) => e.canonical_sequence === w.span[0]);
    const markers = first
      ? events.filter(
          (e) =>
            e.period === first.period &&
            e.clock_remaining_ms === first.clock_remaining_ms &&
            e.canonical_sequence >= w.span[0] &&
            e.canonical_sequence <= w.span[1] &&
            opener(e),
        )
      : [];
    const marker = markers.find((e) => e.type === "jump_ball") ?? markers[0];
    const boundary = w.kind === "between_periods";
    const start = boundary
      ? events.find((e) => e.canonical_sequence === w.sequence)
      : marker;
    return {
      game_id: d.gameId,
      window_id: w.id,
      window_version: d.windowVersion,
      period: s?.period ?? start?.period ?? null,
      clock_remaining_ms:
        s?.clockMs ??
        (boundary && start
          ? start.period <= 4
            ? 720000
            : 300000
          : (start?.clock_remaining_ms ?? null)),
      canonical_sequence: boundary
        ? null
        : (marker?.canonical_sequence ?? null),
      stoppage_kind: boundary
        ? "between_periods"
        : (s?.stoppage.kind ?? (marker ? opener(marker) : null)),
      timeout_team: s?.stoppage.timeoutTeam ?? null,
      free_throws_pending:
        s?.stoppage.freeThrowsPending == null
          ? null
          : Number(s.stoppage.freeThrowsPending),
      celtics_home: d.celticsHome == null ? null : Number(d.celticsHome),
      celtics_score: s ? (d.celticsHome ? s.homeScore : s.awayScore) : null,
      opponent_score: s ? (d.celticsHome ? s.awayScore : s.homeScore) : null,
      celtics_lineup: s?.celtics ?? null,
      opponent_lineup: s?.opponent ?? null,
      eligible_bench: s?.eligibleBench ?? null,
      players_out: w.actual?.players_out ?? null,
      players_in: w.actual?.players_in ?? null,
      substituted: w.actual ? Number(w.actual.players_out.length > 0) : null,
      excluded: Number(w.exclusions.length > 0),
      exclusion_reason: w.exclusions.length ? w.exclusions.join(";") : null,
      adjacency: Number(w.adjacentSubstitutionBuckets > 0),
      state: s,
    };
  });
}
/** Adds facts from pinned datasets, never reads a run record. Session enforces visibility. */
export function withDecisionHistory(
  base: SessionSource,
  load: (game: RecordEnvelope) => Promise<DecisionHistory | null>,
): SessionSource {
  const pending = new Map<string, Promise<DecisionHistory | null>>();
  const get = (game: RecordEnvelope) => {
    if (!pending.has(game.id)) pending.set(game.id, load(game));
    return pending.get(game.id)!;
  };
  const history = async (table: DecisionTable, game: RecordEnvelope) => {
    const data = await get(game);
    return {
      reason: null,
      records: data
        ? decisionRows(table, data).map((row, i) => ({
            ...releasedGame(game),
            id: `${game.id}:${table}:${i}`,
            source: table,
            data: row,
          }))
        : [],
    };
  };
  return {
    ...base,
    versions: [
      ...base.versions,
      {
        source: "decisionHistoryExposure",
        release: DECISION_EXPOSURE,
        manifest_sha256: digest([
          DECISION_EXPOSURE,
          DECISION_DESCRIPTION,
          decisionColumns("decision_windows"),
          decisionColumns("unanchored_substitutions"),
        ]),
      },
    ],
    historyIdentity: async (game) => [
      await base.historyIdentity?.(game),
      DECISION_EXPOSURE,
      (await get(game))?.dataset.inputHash ?? null,
    ],
    tableDescription: (table) =>
      decisionTable(table)
        ? DECISION_DESCRIPTION
        : base.tableDescription?.(table),
    columns: async (table, season) =>
      decisionTable(table)
        ? decisionColumns(table)
        : base.columns(table, season),
    history: async (table, game, player) =>
      decisionTable(table)
        ? history(table, game)
        : base.history(table, game, player),
    async *exportHistory(table, games) {
      if (decisionTable(table)) {
        for (const game of games)
          yield { gameId: game.id, ...(await history(table, game)) };
      } else if (base.exportHistory) yield* base.exportHistory(table, games);
      else
        for (const game of games)
          yield { gameId: game.id, ...(await base.history(table, game)) };
    },
  };
}
