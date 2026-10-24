// P3a session contract (SPO-786).
//
// This module fixes the typed in-process interface between the P4 runner, the
// P3 replay environment (P3b–P3f) and the P5 harness. It contains types, the
// error vocabulary, the phase-legality table and the visibility rules. It has
// no I/O and no behaviour beyond construction of errors.
//
// Two audiences read these types:
//   * The harness (and through it the model) sees only `ToolInput`/`ToolResult`
//     shapes. Every field in a result type is agent-visible by definition.
//   * The environment implementations fill the result types from P1 record
//     envelopes and P2 question records. Nothing from those internal records may
//     be spread into a result; each result is built field by field.
//
// Field naming: results never use a property called `type`. The P4 metering
// proxy rejects any nested object whose `type` is `url`, `file`, `image`,
// `document` or `container_upload`, and tool results are echoed back to the
// model inside `messages`. Discriminators are called `kind` or `source`.

import type { AgentQuestion, Stat } from "../questions/builder.js";
export type { AgentQuestion, Stat };

// ---------------------------------------------------------------------------
// Phases and tool names
// ---------------------------------------------------------------------------

/** Phases in which tools may be called. `initialize` and `checkpoint` are runner-only. */
export type Phase = "pregame" | "commit" | "postgame";

export const TOOL_NAMES = [
  "context",
  "search_evidence",
  "fetch_evidence",
  "query_game_history",
  "read_schedule_and_injuries",
  "query_odds_history",
  "list_questions",
  "execute_code",
  "workspace_list",
  "workspace_read",
  "workspace_write",
  "workspace_append",
  "workspace_delete",
  "begin_commit",
  "submit",
  "read_released_results",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Brief, "Environment tools": one capability → exactly one tool. */
export const CAPABILITY_TOOLS = {
  "Session context": "context",
  "Search and fetch evidence": "search_evidence",
  "Query game history": "query_game_history",
  "Read injuries and schedule": "read_schedule_and_injuries",
  "Query odds history": "query_odds_history",
  "List questions": "list_questions",
  "Execute code": "execute_code",
  Submit: "submit",
  "Read released results": "read_released_results",
} as const satisfies Record<string, ToolName>;

/**
 * Run-profile capability axis (brief, "Run profile"). A tool is callable only
 * when its capability is enabled for the run. Tools mapped to `null` are always
 * available: they are part of the task, not a capability.
 */
export const TOOL_CAPABILITY: Record<ToolName, string | null> = {
  context: null,
  list_questions: null,
  begin_commit: null,
  submit: null,
  read_released_results: null,
  search_evidence: "search_and_fetch",
  fetch_evidence: "search_and_fetch",
  query_game_history: "game_history",
  read_schedule_and_injuries: "game_history",
  query_odds_history: "odds_history",
  execute_code: "code_execution",
  workspace_list: "workspace",
  workspace_read: "workspace",
  workspace_write: "workspace",
  workspace_append: "workspace",
  workspace_delete: "workspace",
};

/**
 * Phase legality. A call outside the listed phases fails with `phase_refused`.
 * Workspace tools are additionally refused for stateless runs
 * (`memory_mode_refused`), and `workspace_write`/`workspace_delete` under
 * append-only revision rights.
 */
export const TOOL_PHASES: Record<ToolName, readonly Phase[]> = {
  context: ["pregame", "commit", "postgame"],
  search_evidence: ["pregame", "postgame"],
  fetch_evidence: ["pregame", "postgame"],
  query_game_history: ["pregame", "postgame"],
  read_schedule_and_injuries: ["pregame", "postgame"],
  query_odds_history: ["pregame", "postgame"],
  list_questions: ["pregame", "commit", "postgame"],
  execute_code: ["pregame", "postgame"],
  workspace_list: ["pregame", "postgame"],
  workspace_read: ["pregame", "postgame"],
  workspace_write: ["pregame", "postgame"],
  workspace_append: ["pregame", "postgame"],
  workspace_delete: ["pregame", "postgame"],
  begin_commit: ["pregame"],
  submit: ["commit"],
  read_released_results: ["pregame", "postgame"],
};

// ---------------------------------------------------------------------------
// Common scalars
// ---------------------------------------------------------------------------

/** ISO-8601 UTC instant, second precision, `Z` suffix (see `data/time.ts`). */
export type Instant = string;
/** Canonical NBA ids as strings (game `0022500083`, team `1610612738`, player `1628369`). */
export type GameId = string;
export type TeamId = string;
export type PlayerId = string;
/** Stable evidence id, opaque to the agent, resolvable by `fetch_evidence`. */
export type EvidenceId = string;

export interface TeamRef {
  team_id: TeamId;
  abbreviation: string;
  name: string;
}
export interface PlayerRef {
  id: PlayerId;
  name: string;
}
export interface Page {
  /** Count of eligible matches, after the cutoff filter. Never counts a future record. */
  total: number;
  /** Present when more eligible items exist. Opaque; pass back unchanged. */
  next_cursor: string | null;
}

// ---------------------------------------------------------------------------
// Tool inputs and results
// ---------------------------------------------------------------------------

export interface ContextInput {}
export interface BudgetRemaining {
  tokens: number;
  compute_seconds: number;
  tool_calls: number;
  /** Tokens held back for the final submission; unavailable until `begin_commit`. */
  submission_reserve: number;
  /** True once remaining research tokens are at or below the configured warning level. */
  warning: boolean;
}
export interface DatasetVersion {
  source: string;
  release: string;
  manifest_sha256: string;
}
export interface ContextResult {
  team: TeamRef;
  season: "2025-26";
  game: {
    game_id: GameId;
    /** 1-based position in the chronological season schedule. */
    game_index: number;
    opponent: TeamRef;
    home: boolean;
    scheduled_start: Instant;
    venue: string | null;
  };
  phase: Phase;
  /** Pregame and commit: the scheduled start. Postgame: the release time (9 a.m. ET next morning). */
  cutoff: Instant;
  budget: BudgetRemaining;
  memory: {
    horizon: "stateless" | "season";
    revision: "editable" | "append-only";
    process: "voluntary" | "mandated-reflection";
  };
  dataset_versions: DatasetVersion[];
}

export type EvidenceSource = "posts" | "transcripts" | "lineups";
export interface SearchEvidenceInput {
  /** Plain words. Lexical match over eligible text; no semantic search in v1. */
  query: string;
  sources?: EvidenceSource[];
  /** Inclusive lower bound on availability time. */
  from?: Instant;
  /** Exclusive upper bound on availability time; clamped to the session cutoff. */
  to?: Instant;
  limit?: number;
  cursor?: string;
}
export interface EvidenceHit {
  evidence_id: EvidenceId;
  source: EvidenceSource;
  available_at: Instant;
  /** Post author handle, transcript channel, or lineup account. */
  author: string | null;
  title: string | null;
  snippet: string;
}
export interface SearchEvidenceResult extends Page {
  items: EvidenceHit[];
}

export interface FetchEvidenceInput {
  evidence_id: EvidenceId;
}
export interface TranscriptSegment {
  /** Provider speaker-cluster label (e.g. `SPEAKER_01`), not an identity. */
  speaker_label: string;
  start_seconds: number;
  text: string;
}
export interface FetchEvidenceResult {
  evidence_id: EvidenceId;
  source: EvidenceSource;
  available_at: Instant;
  author: string | null;
  title: string | null;
  url: string | null;
  /** Full text as published (posts: post text; transcripts: readable transcript; lineups: announcement text). */
  text: string;
  /** Transcripts only. */
  segments: TranscriptSegment[] | null;
  /** Lineups only: announced starters, as announced, never corrected from box scores. */
  starters: PlayerRef[] | null;
  /** Other eligible evidence this record points to (reply parents, quoted posts). */
  references: EvidenceId[];
}

export const GAME_HISTORY_TABLES = [
  "games",
  "player_box_scores",
  "team_box_scores",
  "team_period_scores",
  "events",
  "lineup_stints",
  "player_stints",
  "matchup_stints",
  "player_game_summary",
  "team_game_summary",
  "possessions",
] as const;
export type GameHistoryTable = (typeof GAME_HISTORY_TABLES)[number];
export interface QueryGameHistoryInput {
  table: GameHistoryTable;
  /** At least one of game_id, team_id, player_id is required. */
  game_id?: GameId;
  team_id?: TeamId;
  player_id?: PlayerId;
  /** Season filter; both seasons are eligible, 2024-25 from the start of the replay. */
  season?: "2024-25" | "2025-26";
  /** Inclusive lower bound on the game's scheduled start. */
  from?: Instant;
  /** Exclusive upper bound on the game's scheduled start; clamped to the cutoff. */
  to?: Instant;
  limit?: number;
  cursor?: string;
}
export type Scalar = string | number | boolean | null;
export interface ColumnDefinition {
  name: string;
  description: string;
}
export interface QueryGameHistoryResult extends Page {
  table: GameHistoryTable;
  /** Explicit definitions for every column returned, from the release data dictionary. */
  columns: ColumnDefinition[];
  rows: Record<string, Scalar>[];
  /** Eligible games whose product is not `valid` in the release coverage; served as absent. */
  unavailable: { game_id: GameId; reason: string }[];
}

export interface ReadScheduleAndInjuriesInput {
  /** Defaults to the session team. */
  team_id?: TeamId;
  game_id?: GameId;
  from?: Instant;
  /** Exclusive; clamped to the cutoff. */
  to?: Instant;
}
export interface ScheduleEntry {
  game_id: GameId;
  scheduled_start: Instant;
  home: TeamRef;
  away: TeamRef;
  venue: string | null;
}
export interface InjuryReportEntry {
  /** Printed report time; the availability time. */
  report_time: Instant;
  game_id: GameId;
  team_id: TeamId;
  /** Canonical id when the printed name resolves; null for the refused joins. */
  player_id: PlayerId | null;
  player_name: string;
  status: string;
  reason: string | null;
}
export interface TeamStatusSnapshot {
  report_time: Instant;
  game_id: GameId;
  team_id: TeamId;
  /**
   * `listed`: the team appeared with player rows. `not_yet_submitted`: the PDF
   * printed the placeholder. `unknown`: the team was absent from the report
   * (served as unknown, never as a healthy roster; no earlier report is carried forward).
   */
  state: "listed" | "not_yet_submitted" | "unknown";
}
export interface ReadScheduleAndInjuriesResult {
  schedule: ScheduleEntry[];
  injury_reports: InjuryReportEntry[];
  team_snapshots: TeamStatusSnapshot[];
}

export interface QueryOddsHistoryInput {
  /** Defaults to the current game. */
  game_id?: GameId;
  player_id?: PlayerId;
  stat?: Stat;
}
export interface OddsObservation {
  game_id: GameId;
  /** `requested_at` of the observation; the availability time. */
  available_at: Instant;
  player: PlayerRef;
  stat: Stat;
  line: number;
  p_over: number;
}
export type Outcome = "over" | "under" | "push" | "did_not_play" | "unresolved";
export interface OddsSettlement {
  game_id: GameId;
  player: PlayerRef;
  stat: Stat;
  line: number;
  actual: number | null;
  outcome: Outcome;
}
export interface QueryOddsHistoryResult {
  /** Consensus observations with availability time at or before the cutoff. No per-book or dispersion fields. */
  observations: OddsObservation[];
  /** Only for games whose release time is at or before the cutoff. */
  settlements: OddsSettlement[];
}

export interface ListQuestionsInput {}
export interface ListQuestionsResult {
  game_id: GameId;
  cutoff: Instant;
  /** Exactly the P2 `agentQuestion` projection. Complete; no pagination. */
  questions: AgentQuestion[];
}

export interface ExecuteCodeInput {
  /** A Python 3 program. Runs in the session sandbox with pandas, numpy, scipy, scikit-learn. */
  program: string;
}
export interface ExecuteCodeResult {
  stdout: string;
  stderr: string;
  exit_status: number | null;
  compute_seconds: number;
  /** True if stdout or stderr was cut at the configured byte cap. */
  truncated: boolean;
  limit: "wall_clock" | "compute" | null;
}

export interface WorkspaceListInput {
  /** Directory relative to the workspace root; default root. */
  path?: string;
}
export interface WorkspaceEntry {
  path: string;
  kind: "file" | "directory";
  bytes: number | null;
}
export interface WorkspaceListResult {
  entries: WorkspaceEntry[];
}
export interface WorkspaceReadInput {
  path: string;
}
export interface WorkspaceReadResult {
  path: string;
  content: string;
  bytes: number;
}
export interface WorkspaceWriteInput {
  path: string;
  content: string;
}
export interface WorkspaceAppendInput {
  path: string;
  content: string;
}
export interface WorkspaceDeleteInput {
  path: string;
}
export interface WorkspaceMutationResult {
  path: string;
  bytes: number;
}

export interface BeginCommitInput {}
export interface BeginCommitResult {
  phase: "commit";
  budget: BudgetRemaining;
}

export interface Answer {
  question_id: string;
  /** In [0.01, 0.99]. Values outside are clipped and the clip is logged. */
  p_over: number;
  /** Required when |p_over − market| ≥ 0.05; may be empty otherwise. */
  rationale?: string;
  evidence_refs?: EvidenceId[];
}
export interface SubmitInput {
  answers: Answer[];
  /** Free text for the whole submission. Stored, never scored. */
  notes?: string;
}
export interface ClipEvent {
  question_id: string;
  submitted: number;
  clipped_to: number;
}
export interface SubmitResult {
  /** Stable; identical valid resubmission returns the same receipt. */
  receipt: string;
  attempt: number;
  clips: ClipEvent[];
}

export interface ReadReleasedResultsInput {
  /** Defaults to every released game of this run. */
  game_id?: GameId;
}
export interface ReleasedQuestion {
  question_id: string;
  player: PlayerRef;
  stat: Stat;
  line: number;
  market_p_over: number;
  /** Null when the session for that game failed. Never accompanied by the rationale. */
  agent_p_over: number | null;
  actual: number | null;
  outcome: Outcome;
  /** Log-loss skill versus the market; null when excluded or unresolved. */
  score: number | null;
}
export interface ReleasedGame {
  game_id: GameId;
  released_at: Instant;
  questions: ReleasedQuestion[];
}
export interface ReadReleasedResultsResult {
  games: ReleasedGame[];
}

// ---------------------------------------------------------------------------
// Typed tool map
// ---------------------------------------------------------------------------

export interface ToolContract {
  context: { input: ContextInput; result: ContextResult };
  search_evidence: { input: SearchEvidenceInput; result: SearchEvidenceResult };
  fetch_evidence: { input: FetchEvidenceInput; result: FetchEvidenceResult };
  query_game_history: {
    input: QueryGameHistoryInput;
    result: QueryGameHistoryResult;
  };
  read_schedule_and_injuries: {
    input: ReadScheduleAndInjuriesInput;
    result: ReadScheduleAndInjuriesResult;
  };
  query_odds_history: {
    input: QueryOddsHistoryInput;
    result: QueryOddsHistoryResult;
  };
  list_questions: { input: ListQuestionsInput; result: ListQuestionsResult };
  execute_code: { input: ExecuteCodeInput; result: ExecuteCodeResult };
  workspace_list: { input: WorkspaceListInput; result: WorkspaceListResult };
  workspace_read: { input: WorkspaceReadInput; result: WorkspaceReadResult };
  workspace_write: {
    input: WorkspaceWriteInput;
    result: WorkspaceMutationResult;
  };
  workspace_append: {
    input: WorkspaceAppendInput;
    result: WorkspaceMutationResult;
  };
  workspace_delete: {
    input: WorkspaceDeleteInput;
    result: WorkspaceMutationResult;
  };
  begin_commit: { input: BeginCommitInput; result: BeginCommitResult };
  submit: { input: SubmitInput; result: SubmitResult };
  read_released_results: {
    input: ReadReleasedResultsInput;
    result: ReadReleasedResultsResult;
  };
}
export type ToolInput<N extends ToolName> = ToolContract[N]["input"];
export type ToolResult<N extends ToolName> = ToolContract[N]["result"];

/**
 * What the harness holds: one typed call. The P4 runner implements this over
 * its `SessionEndpoint.call(name, args)` and routes `context`, `begin_commit`,
 * `submit` and `execute_code` itself; everything else reaches the environment.
 */
export interface SessionTools {
  call<N extends ToolName>(
    name: N,
    input: ToolInput<N>,
  ): Promise<ToolResult<N>>;
}

/**
 * What P3b–P3f implement: the typed tool methods, plus the runner-facing hooks
 * the P4 `Environment` adapter already expects (`transition`, `questions`,
 * `validateSubmission`, `execute`, `close`). The runner owns the budget ledger,
 * the record and the receipt; the environment owns visibility, phase legality,
 * memory-mode enforcement and submission validation.
 */
export type EnvironmentTools = {
  [N in Exclude<ToolName, "context" | "begin_commit" | "submit">]: (
    input: ToolInput<N>,
    signal: AbortSignal,
  ) => Promise<ToolResult<N>>;
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type SessionErrorCode =
  /** The request would reveal a record whose availability time is not before the cutoff (or, for odds, after it). */
  | "cutoff_refused"
  /** The tool is not legal in the current phase. */
  | "phase_refused"
  /** The run profile does not enable the tool's capability. */
  | "capability_disabled"
  /** Workspace tools in a stateless run, or write/delete under append-only rights. */
  | "memory_mode_refused"
  /** Malformed input (schema violation, unknown table, bad path). */
  | "invalid_input"
  /** An id that does not resolve to an eligible record. Never distinguishes "future" from "nonexistent". */
  | "not_found"
  /** Submission failed validation; `problems` names every problem. */
  | "validation_failed"
  /** The phase's token, compute, tool-call or wall-clock allowance is spent. */
  | "budget_exhausted";

export class SessionError extends Error {
  constructor(
    readonly code: SessionErrorCode,
    message: string,
    /** For `validation_failed`: one entry per problem, each naming the question id where applicable. */
    readonly problems: readonly string[] = [],
    /** For `validation_failed`: resubmissions left before the session fails. */
    readonly attemptsRemaining: number | null = null,
  ) {
    super(message);
    this.name = "SessionError";
  }
  /** The shape the harness and model see. Stable across in-process and MCP transports. */
  toJSON(): {
    error: SessionErrorCode;
    message: string;
    problems: string[];
    attempts_remaining: number | null;
  } {
    return {
      error: this.code,
      message: this.message,
      problems: [...this.problems],
      attempts_remaining: this.attemptsRemaining,
    };
  }
}

// ---------------------------------------------------------------------------
// Visibility rules (brief, datasets table and "Environment tools")
// ---------------------------------------------------------------------------

/**
 * Per-source rules every implementation must satisfy. Written as data so the
 * doc, the fixture tests and reviewers can point at one list.
 */
export const VISIBILITY = {
  odds: {
    exposes: [
      "available_at (requested_at)",
      "player",
      "stat",
      "line",
      "p_over",
    ],
    never: [
      "per-book quotes",
      "contributing books or count",
      "dispersion",
      "dfs reference lines",
      "snapshot_at",
      "p_under",
      "any observation with requested_at after the cutoff",
      "settlement before the game's release time",
    ],
    equality:
      "the observation whose requested_at equals the cutoff is eligible",
  },
  game_history: {
    exposes: [
      "published release tables with their data-dictionary definitions",
    ],
    never: [
      "any 2025-26 game whose release time is after the cutoff",
      "a product not valid in coverage.jsonl (served as absent with reason)",
    ],
    equality: "strictly before the cutoff",
  },
  injuries: {
    exposes: [
      "printed player rows",
      "team snapshots as listed/not_yet_submitted/unknown",
    ],
    never: [
      "evidence register",
      "empty_report_corroborated interpretations",
      "anything carrying an assessment time",
      "a healthy-roster reading of an absent team",
    ],
    equality: "strictly before the cutoff",
  },
  posts: {
    exposes: [
      "NBA-related posts, latest eligible version, text, author, publication time, references",
    ],
    never: [
      "unrelated posts",
      "a version whose edit time is unknown",
      "relevance scores",
    ],
    equality: "strictly before the cutoff",
  },
  lineups: {
    exposes: [
      "the preferred announcement per game with starters, source post, posting time",
    ],
    never: [
      "alternates",
      "box-score starters as a correction",
      "announcements at or after the cutoff for their own game",
    ],
    equality: "strictly before the cutoff",
  },
  transcripts: {
    exposes: [
      "readable text",
      "segments with speaker-cluster labels",
      "title",
      "url",
      "publication time",
    ],
    never: ["audio", "speaker identities", "title words as availability"],
    equality: "strictly before the cutoff (livestreams: stream end)",
  },
  questions: {
    exposes: ["question_id", "player", "stat", "line", "p_over"],
    never: ["p_under", "provenance", "exclusions", "the full question record"],
    equality: "n/a",
  },
  released_results: {
    exposes: [
      "outcome",
      "actual",
      "market and agent probabilities",
      "per-question score",
    ],
    never: [
      "rationales",
      "notes",
      "evidence_refs",
      "any game whose release time is after the cutoff",
    ],
    equality: "release time at or before the cutoff",
  },
} as const;
