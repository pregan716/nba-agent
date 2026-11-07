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
//     envelopes. Nothing from those internal records may
//     be spread into a result; each result is built field by field.
//
// Field naming: results never use a property called `type`. The P4 metering
// proxy rejects any nested object whose `type` is `url`, `file`, `image`,
// `document` or `container_upload`, and tool results are echoed back to the
// model inside `messages`. Discriminators are called `kind` or `source`.

// ---------------------------------------------------------------------------
// Phases and tool names
// ---------------------------------------------------------------------------

/** Phases in which tools may be called. `initialize` and `checkpoint` are runner-only. */
export type Phase = "pregame" | "commit" | "postgame";

export const TOOL_NAMES = [
  "context",
  "freeze_package",
  "validate_package",
  "read_feedback",
  "search_evidence",
  "list_evidence",
  "fetch_evidence",
  "query_game_history",
  "read_schedule_and_injuries",
  "execute_code",
  "workspace_list",
  "workspace_read",
  "workspace_write",
  "workspace_append",
  "workspace_delete",
  "workspace_edit",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Brief, "Environment tools": one capability → exactly one tool. */
export const CAPABILITY_TOOLS = {
  "Session context": "context",
  "Search and fetch evidence": "search_evidence",
  "Query game history": "query_game_history",
  "Read injuries and schedule": "read_schedule_and_injuries",
  "Execute code": "execute_code",
} as const satisfies Record<string, ToolName>;

/**
 * Run-profile capability axis (brief, "Run profile"). A tool is callable only
 * when its capability is enabled for the run. Tools mapped to `null` are always
 * available: they are part of the task, not a capability.
 */
export const TOOL_CAPABILITY: Record<ToolName, string | null> = {
  context: null,
  freeze_package: null,
  validate_package: "code_execution",
  read_feedback: null,
  search_evidence: "search_and_fetch",
  list_evidence: "search_and_fetch",
  fetch_evidence: "search_and_fetch",
  query_game_history: "game_history",
  read_schedule_and_injuries: "game_history",
  execute_code: "code_execution",
  workspace_list: "workspace",
  workspace_read: "workspace",
  workspace_write: "workspace",
  workspace_append: "workspace",
  workspace_delete: "workspace",
  workspace_edit: "workspace",
};

/**
 * Phase legality. A call outside the listed phases fails with `phase_refused`.
 * Workspace tools are additionally refused for stateless runs
 * (`memory_mode_refused`), and replacement `workspace_write`/any `workspace_delete` under
 * append-only revision rights.
 */
export const TOOL_PHASES: Record<ToolName, readonly Phase[]> = {
  context: ["pregame", "commit", "postgame"],
  freeze_package: ["pregame"],
  validate_package: ["pregame"],
  read_feedback: ["pregame", "postgame"],
  search_evidence: ["pregame", "postgame"],
  list_evidence: ["pregame", "postgame"],
  fetch_evidence: ["pregame", "postgame"],
  query_game_history: ["pregame", "postgame"],
  read_schedule_and_injuries: ["pregame", "postgame"],
  execute_code: ["pregame", "postgame"],
  workspace_list: ["pregame", "postgame"],
  workspace_read: ["pregame", "postgame"],
  workspace_write: ["pregame", "postgame"],
  workspace_append: ["pregame", "postgame"],
  workspace_delete: ["pregame", "postgame"],
  workspace_edit: ["pregame", "postgame"],
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
  /** True once remaining research tokens are at or below the configured warning level. */
  warning: boolean;
}
export interface DatasetVersion {
  source: string;
  release: string;
  manifest_sha256: string;
}
export interface MemoryUsage {
  retainedTokens: number;
  cap: number;
}
export interface ContextResult {
  memoryUsage?: MemoryUsage;
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
  /** Capability groups enabled for this run (see TOOL_CAPABILITY). Tools whose group is absent are refused. */
  capabilities: string[];
  memory:
    | (import("./memory.js").MemoryPermissions & { window_games?: never })
    | {
        version?: never;
        variant?: never;
        horizon: "stateless" | "season" | "window";
        window_games?: number;
        revision: "editable" | "append-only";
        process: "voluntary" | "mandated-reflection";
      };
}

export type EvidenceSource = "posts" | "transcripts" | "lineups";
export interface ListEvidenceInput {
  sources?: EvidenceSource[];
  /** Inclusive lower bound on availability time. */
  from?: Instant;
  /** Exclusive upper bound on availability time; clamped to the session cutoff. */
  to?: Instant;
  limit?: number;
  cursor?: string;
}
export interface SearchEvidenceInput extends ListEvidenceInput {
  /** Ranked, stemmed OR search; player names resolve through pinned identities. */
  query: string;
  player_id?: string;
}
export interface EvidenceHit {
  evidence_id: EvidenceId;
  source: EvidenceSource;
  available_at: Instant;
  /** Post @handle when mapped, otherwise account ID; transcript channel or lineup account. */
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
export interface EvidenceProvenance {
  /** Posts: stable numeric account identity, even when author is a handle. */
  account_id?: string;
  /** Hash of the checked-in account-to-handle mapping used for posts. */
  author_mapping_sha256?: string;
  manifest_sha256: string;
  objects: { bucket: string; key: string; sha256: string }[];
}
export interface FetchEvidenceResult {
  /** Immutable published artifacts supporting the text; not storage credentials. */
  provenance: EvidenceProvenance;
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
/**
 * The always-on, static player reference (brief, datasets table): opening
 * roster profiles, season and career totals through 2024-25, identity
 * exceptions. The six published tables P1's PlayerReferenceAdapter allows.
 * Built to 2025-10-21T23:29:59Z, so eligible for every game; age is computed
 * for the replay date by the implementation.
 */
export const PLAYER_REFERENCE_TABLES = [
  "player_profiles",
  "player_reference",
  "player_season_stats",
  "player_2024_25_summary",
  "player_career_summary",
  "player_identity_exceptions",
] as const;
export type PlayerReferenceTable = (typeof PLAYER_REFERENCE_TABLES)[number];
export type HistoryTable = GameHistoryTable | PlayerReferenceTable;
export interface QueryGameHistoryInput {
  include_metadata?: boolean;
  table: HistoryTable;
  /**
   * For game-history tables at least one of game_id, team_id, player_id is
   * required. Player-reference tables accept player_id and team_id only; the
   * game and season filters are rejected with `invalid_input`.
   */
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
  table: HistoryTable;
  /** Explicit definitions for every column returned, from the release data dictionary. */
  columns: { name: string; description?: string }[];
  rows: Record<string, Scalar>[];
  /** Eligible games whose product is not `valid` in the release coverage; served as absent. Empty for player-reference tables. */
  unavailable: { game_id: GameId; reason: string }[];
}

export interface ReadScheduleAndInjuriesInput {
  cursor?: string;
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
  next_cursor?: string | null;
  schedule: ScheduleEntry[];
  injury_reports: InjuryReportEntry[];
  team_snapshots: TeamStatusSnapshot[];
}

export interface ExecuteCodeInput {
  /** A Python 3 program. Runs in the session sandbox with pandas, numpy, scipy, scikit-learn. */
  program: string;
}
export interface ExecuteCodeResult {
  truncation_notice?: string;
  stdout: string;
  stderr: string;
  exit_status: number | null;
  compute_seconds: number;
  /** True if stdout or stderr was cut at the configured byte cap. */
  truncated: boolean;
  limit: "wall_clock" | "compute" | "memory" | null;
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
export interface WorkspaceEditInput {
  path: string;
  old_text: string;
  new_text: string;
}
export interface WorkspaceMutationResult {
  memoryUsage?: MemoryUsage;
  path: string;
  bytes: number;
}

// ---------------------------------------------------------------------------
// Typed tool map
// ---------------------------------------------------------------------------

export interface ToolContract {
  workspace_edit: {
    input: WorkspaceEditInput;
    result: WorkspaceMutationResult;
  };
  freeze_package: {
    input: {};
    result:
      | import("../policy/package.js").PackageReceipt
      | { status: "invalid_package"; reason: string };
  };
  validate_package: {
    input: import("../policy/validation.js").ValidationInput;
    result: import("../policy/validation.js").ValidationResult;
  };
  read_feedback: {
    input: {
      game_id?: string;
      cursor?: number;
      window_id?: string;
      offset?: number;
    };
    result: import("../policy/feedback.js").FeedbackPage;
  };
  context: { input: ContextInput; result: ContextResult };
  search_evidence: { input: SearchEvidenceInput; result: SearchEvidenceResult };
  list_evidence: { input: ListEvidenceInput; result: SearchEvidenceResult };
  fetch_evidence: { input: FetchEvidenceInput; result: FetchEvidenceResult };
  query_game_history: {
    input: QueryGameHistoryInput;
    result: QueryGameHistoryResult;
  };
  read_schedule_and_injuries: {
    input: ReadScheduleAndInjuriesInput;
    result: ReadScheduleAndInjuriesResult;
  };
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
}
export type ToolInput<N extends ToolName> = ToolContract[N]["input"];
export type ToolResult<N extends ToolName> = ToolContract[N]["result"];

/**
 * What the harness holds: one typed call. The P4 runner implements this over
 * its `SessionEndpoint.call(name, args)` and routes `context` and `execute_code` itself; everything else reaches the environment.
 */
export interface SessionTools {
  call<N extends ToolName>(
    name: N,
    input: ToolInput<N>,
  ): Promise<ToolResult<N>>;
}

/**
 * What P3b–P3f implement: the typed tool methods, plus the runner-facing hooks
 * the P4 `Environment` adapter already expects (`transition`, `execute`, `close`). The runner owns the budget ledger,
 * the record; the environment owns visibility, phase legality,
 * memory-mode enforcement.
 */
export type EnvironmentTools = {
  [N in Exclude<ToolName, "context">]: (
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
  /** Workspace tools in a stateless run, or replacement/delete under append-only rights. */
  | "memory_mode_refused"
  /** Malformed input (schema violation, unknown table, bad path). */
  | "invalid_input"
  /** An id that does not resolve to an eligible record. Never distinguishes "future" from "nonexistent". */
  | "not_found"
  /** The phase's token, compute, tool-call or wall-clock allowance is spent. */
  | "budget_exhausted";

export class SessionError extends Error {
  constructor(
    readonly code: SessionErrorCode,
    message: string,
    readonly problems: readonly string[] = [],
  ) {
    super(message);
    this.name = "SessionError";
  }
  /** The shape the harness and model see. Stable across in-process and MCP transports. */
  toJSON(): {
    error: SessionErrorCode;
    message: string;
    problems: string[];
  } {
    return {
      error: this.code,
      message: this.message,
      problems: [...this.problems],
    };
  }
}

// ---------------------------------------------------------------------------
// Visibility rules (brief, datasets table and "Environment tools")
// ---------------------------------------------------------------------------

/**
 * How a source's availability time compares with the session cutoff.
 *
 * `at_or_before`: the environment itself defines the availability instant as a
 * scheduled boundary (an odds observation's `requested_at`; a game's 9 a.m. ET
 * release, which is also the postgame cutoff), so a record whose availability
 * equals the cutoff is eligible. This is what lets the scheduled-start
 * observation remain visible and lets postgame reflection read the
 * just-released box score.
 *
 * `strictly_before`: the availability time is a publication time outside the
 * environment's control (posts, transcripts, lineup announcements, printed
 * injury reports), so equality is not enough.
 *
 * `static`: eligible for every game.
 */
export type CutoffRule = "at_or_before" | "strictly_before" | "static";
export interface VisibilityRule {
  exposes: readonly string[];
  never: readonly string[];
  cutoff: CutoffRule;
  equality: string;
}

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
    cutoff: "at_or_before",
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
    cutoff: "at_or_before",
    equality:
      "a game released at exactly the cutoff is eligible; the postgame cutoff is that game's release instant",
  },
  player_reference: {
    exposes: [
      "the six published tables: profiles, reference, season stats, 2024-25 summary, career summary, identity exceptions",
    ],
    never: ["archive/ contents", "anything built after 2025-10-21T23:29:59Z"],
    cutoff: "static",
    equality: "static; eligible for every game",
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
    cutoff: "strictly_before",
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
    cutoff: "strictly_before",
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
    cutoff: "strictly_before",
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
    cutoff: "strictly_before",
    equality: "strictly before the cutoff (livestreams: stream end)",
  },
} as const satisfies Record<string, VisibilityRule>;
