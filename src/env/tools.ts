// Agent-facing tool definitions (SPO-786). Data only: name, description and
// JSON Schema for the input. The P5 harness hands these to the model and hashes
// `serializeToolDefinitions()` into the harness version, so any wording change
// here is a new harness version by construction.
//
// Descriptions are written for the model: what the tool returns, what it never
// returns, and that the cutoff is enforced by the environment, not by the prompt.

import { createHash } from "node:crypto";
import {
  GAME_HISTORY_TABLES,
  PLAYER_REFERENCE_TABLES,
  TOOL_NAMES,
  type Phase,
  type ToolName,
} from "./contract.js";

export interface ToolDefinition {
  name: ToolName;
  description: string;
  /** JSON Schema (draft 2020-12 subset the Messages API accepts). Always an object schema. */
  input_schema: Record<string, unknown>;
  /** Mirrors `TOOL_PHASES`; repeated here so the serialized definitions carry it. */
  phases: readonly Phase[];
}

const instant = {
  type: "string",
  description: "ISO-8601 UTC instant, e.g. 2025-11-01T23:30:00Z",
};
const id = (what: string) => ({ type: "string", description: what });
const paging = {
  limit: {
    type: "integer",
    minimum: 1,
    maximum: 100,
    description: "Maximum items to return (default 20).",
  },
  cursor: {
    type: "string",
    description: "Opaque cursor from a previous result's next_cursor.",
  },
};
const object = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const AUTHORS =
  "Post authors are @handles from the pinned account mapping when known, otherwise account IDs; fetch provenance retains the original account ID and mapping hash.";

const CUTOFF =
  "The environment applies the session cutoff before searching, counting, paging or returning anything. Posts, transcripts, lineup announcements and injury reports published at or after the cutoff, and game data or odds observations released after it, do not exist from your point of view; no query, count or error reveals them.";

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "context",
    description:
      "Return game_lines at scheduled start: Celtics spread (negative when favoured), game total derived from paired team-total quotes, implied team totals, contributing-book counts and provenance; null values mean unavailable markets. Also return the session: your team, the game (opponent, home/away, scheduled start, position in the season), the current phase, the cutoff instant, your remaining budget (tokens, sandbox compute seconds, tool calls, the reserve held for the final submission, and a low-budget warning), the memory mode of this run, and the pinned dataset versions. Call it first in every session and again whenever you need the budget.",
    input_schema: object({}),
    phases: ["pregame", "commit", "postgame"],
  },
  {
    name: "list_evidence",
    description: `Browse eligible text evidence (beat reporters' posts, transcripts of the head coach's media sessions, and both teams' starting-lineup announcements) newest first, with snippets and paging. With no from, pregame starts at the previous Celtics game’s scheduled-start cutoff (all eligible history for the first game); postgame starts at this game’s scheduled start. The next pregame browse includes records from the previous postgame window because they were unavailable at the previous pregame cutoff. from is inclusive, to exclusive and clamped to the session cutoff. Use fetch_evidence to read a full record. ${AUTHORS} ${CUTOFF}`,
    input_schema: object(
      {
        sources: {
          type: "array",
          items: { type: "string", enum: ["posts", "transcripts", "lineups"] },
          description:
            "Restrict to these sources (default all): posts are beat reporters, transcripts are the head coach's media sessions, lineups are starting-five announcements.",
        },
        from: {
          ...instant,
          description: "Only evidence available at or after this instant.",
        },
        to: {
          ...instant,
          description:
            "Only evidence available before this instant (clamped to the cutoff).",
        },
        ...paging,
      },
      [],
    ),
    phases: ["pregame", "postgame"],
  },
  {
    name: "search_evidence",
    description: `Search eligible text evidence: posts from two pinned Celtics beat reporters, transcripts of the head coach's practice, pregame and postgame media sessions (about one per game day), and both teams' starting-lineup announcements. Ranked BM25 matching of any meaningful query words with English stemming and accent folding; common English function words are ignored. Player surnames boost matching players without filtering other matches; full names resolve through pinned identities and restrict results to those players. Use one or two terms (e.g. 'Pritchard injury'); player_id filters directly. Lineup starters are searchable. Ambiguous surnames match any resolved player. Returns matches with source, availability time, author, title and a snippet, plus the total eligible match count and a cursor for more. ${AUTHORS} ${CUTOFF} Use fetch_evidence to read a full record.`,
    input_schema: object(
      {
        query: { type: "string", minLength: 1, description: "Words to match." },
        player_id: id("Canonical player ID; restrict to this player."),
        sources: {
          type: "array",
          items: { type: "string", enum: ["posts", "transcripts", "lineups"] },
          description:
            "Restrict to these sources (default all): posts are beat reporters, transcripts are the head coach's media sessions, lineups are starting-five announcements.",
        },
        from: {
          ...instant,
          description: "Only evidence available at or after this instant.",
        },
        to: {
          ...instant,
          description:
            "Only evidence available before this instant (clamped to the cutoff).",
        },
        ...paging,
      },
      ["query"],
    ),
    phases: ["pregame", "postgame"],
  },
  {
    name: "fetch_evidence",
    description: `Read one evidence record by its evidence_id from list_evidence, search_evidence or from references on another record. Returns the full text as published, availability time, author, title, source URL, transcript segments with speaker-cluster labels (labels are not identities), announced starters for lineup posts, references to other eligible records, and provenance with the pinned manifest hash and supporting artifact object keys and hashes. Cite the stable evidence_id in evidence_refs. ${AUTHORS} ${CUTOFF} An id that does not resolve returns not_found; this does not tell you whether it exists.`,
    input_schema: object(
      { evidence_id: id("From search_evidence or a references list.") },
      ["evidence_id"],
    ),
    phases: ["pregame", "postgame"],
  },
  {
    name: "query_game_history",
    description: `Query published play-by-play release tables for completed games, or the static player reference. Game tables: schedule rows, official player and team box scores, period scores, events, lineup and player stints, matchup stints, per-game summaries and possessions; filter by game_id, team_id or player_id (at least one), season and a scheduled-start window. Both seasons are available: 2024-25 in full from the start, and 2025-26 games once released at 9 a.m. Eastern the morning after each game, including the game just played when you are in its postgame. Player-reference tables (player_profiles, player_reference, player_season_stats, player_2024_25_summary, player_career_summary, player_identity_exceptions) are the opening-night roster and career history through 2024-25, built before the season and available in every game; filter by player_id or team_id. Rows come with a column definition for every field. ${CUTOFF} A game whose product is not valid in the release coverage is listed under unavailable with the reason; it is not silently dropped. Prefer execute_code over the mounted export for season-wide aggregation.`,
    input_schema: object(
      {
        table: {
          type: "string",
          enum: [...GAME_HISTORY_TABLES, ...PLAYER_REFERENCE_TABLES],
        },
        game_id: id("NBA game id, e.g. 0022500083."),
        team_id: id("NBA team id, e.g. 1610612738."),
        player_id: id("NBA player id."),
        season: { type: "string", enum: ["2024-25", "2025-26"] },
        from: {
          ...instant,
          description: "Games scheduled at or after this instant.",
        },
        to: {
          ...instant,
          description:
            "Games scheduled before this instant (clamped to the cutoff).",
        },
        ...paging,
      },
      ["table"],
    ),
    phases: ["pregame", "postgame"],
  },
  {
    name: "read_schedule_and_injuries",
    description: `Return the schedule for a team or game and the official injury reports as printed, each with its printed report time: player rows with status and reason, and per-team snapshots marked listed, not_yet_submitted, or unknown. 'unknown' means the team was absent from that report; it is never a healthy roster, and no earlier report is carried forward. Player ids are present where the printed name resolves to one player; a few names are unresolved and carry only the name. ${CUTOFF}`,
    input_schema: object({
      team_id: id("Defaults to your team."),
      game_id: id("Restrict to one game."),
      from: {
        ...instant,
        description: "Reports printed at or after this instant.",
      },
      to: {
        ...instant,
        description:
          "Reports printed before this instant (clamped to the cutoff).",
      },
    }),
    phases: ["pregame", "postgame"],
  },
  {
    name: "query_odds_history",
    description: `Also returns game_lines observations for line movement, with the same cutoff and game selection. Return the consensus market history for this game or a prior one: for each observation, its availability time, player, stat, consensus line and market-implied P(over). Observations are taken at fixed times before tip and at the scheduled start; the scheduled-start observation defines the questions. For prior games whose results have been released, settled outcomes (over, under, push, did_not_play, unresolved) are included. Never includes per-book prices, contributing books or dispersion. ${CUTOFF} Do not interpolate between observations.`,
    input_schema: object({
      game_id: id("Defaults to the current game."),
      player_id: id("Restrict to one player."),
      stat: { type: "string", enum: ["points", "rebounds", "assists"] },
    }),
    phases: ["pregame", "postgame"],
  },
  {
    name: "list_questions",
    description:
      "Return the frozen question set for this game: for each question its question_id, player, stat, the consensus line and the market-implied P(over) at the scheduled start. Complete in one call. Submitting the market probability for a question means no view and scores exactly zero; deviate only where you have a reason.",
    input_schema: object({}),
    phases: ["pregame", "commit", "postgame"],
  },
  {
    name: "execute_code",
    description:
      "Run a Python 3 program in this session's sandbox and return stdout, stderr, exit status, compute seconds used, and whether output was truncated at the byte cap. Available: pandas, numpy, scipy, scikit-learn. Mounted read-only at /data: session.sqlite (questions, schedule, references, injuries, odds, evidence and released results), games/*.sqlite.gz (one compressed immutable history shard per eligible game), and source text files, all filtered before mounting. Use import nba_data; nba_data.table('player_box_scores') for a pandas DataFrame across games, nba_data.query(sql, params) for SQL run separately per game (aggregates are per game), and nba_data.session() for the session SQLite connection; /scratch is writable and discarded at the end of this session; /workspace is your workspace when the run has one (same rules as the workspace tools). No network and no package installs. New processes are blocked: scikit-learn/joblib n_jobs>1 requires the threading backend; process backends fail. Each call has a wall-clock limit and counts against the phase's compute cap; print only what you need.",
    input_schema: object({ program: { type: "string", minLength: 1 } }, [
      "program",
    ]),
    phases: ["pregame", "postgame"],
  },
  {
    name: "workspace_list",
    description:
      "List files and directories in your workspace under a path (default: the root). The workspace is the only thing that persists between games in a persistent run; in a stateless run it is empty at every game and these tools are refused.",
    input_schema: object({
      path: id("Directory relative to the workspace root."),
    }),
    phases: ["pregame", "postgame"],
  },
  {
    name: "workspace_read",
    description:
      "Read a UTF-8 text file from your workspace; use code execution for binary files. Text files are whatever you or your earlier sessions wrote: notes, scripts, fitted-model parameters, cached tables.",
    input_schema: object(
      { path: id("File path relative to the workspace root.") },
      ["path"],
    ),
    phases: ["pregame", "postgame"],
  },
  {
    name: "workspace_write",
    description:
      "Create or replace a workspace file with the given text. Refused during commit, in stateless runs, and for an existing file when the run is append-only (write a new file instead).",
    input_schema: object(
      {
        path: id("File path relative to the workspace root."),
        content: { type: "string" },
      },
      ["path", "content"],
    ),
    phases: ["pregame", "postgame"],
  },
  {
    name: "workspace_append",
    description:
      "Append text to a workspace file, creating it if needed. Allowed under both editable and append-only rights; refused during commit and in stateless runs.",
    input_schema: object(
      {
        path: id("File path relative to the workspace root."),
        content: { type: "string" },
      },
      ["path", "content"],
    ),
    phases: ["pregame", "postgame"],
  },
  {
    name: "workspace_delete",
    description:
      "Delete a workspace file. Refused during commit, in stateless runs, and always under append-only rights.",
    input_schema: object(
      { path: id("File path relative to the workspace root.") },
      ["path"],
    ),
    phases: ["pregame", "postgame"],
  },
  {
    name: "begin_commit",
    description:
      "End research and enter the commit phase for this game. After this call only context, list_questions and submit are available; evidence, history, odds, code and workspace tools are locked until postgame. The submission reserve becomes available. Call it when you are ready to submit, or when context reports the research budget is exhausted.",
    input_schema: object({}),
    phases: ["pregame"],
  },
  {
    name: "submit",
    description:
      "Submit your probabilities for every question in this game, as one atomic submission. Each answer needs the question_id and p_over in [0.01, 0.99] (values outside are clipped and the clip is recorded); a short rationale is required when p_over differs from the market P(over) by 0.05 or more and may be omitted otherwise; evidence_refs may list evidence_ids the rationale relies on. notes is optional free text for the whole submission, stored and never scored. A submission missing a question, naming an unknown question, or malformed is rejected with every problem named and may be corrected up to two more times; a third failure ends the session as failed. A valid submission is frozen and returns a receipt; sending the identical submission again returns the same receipt. Submitting the market probability is free and scores zero.",
    input_schema: object(
      {
        answers: {
          type: "array",
          minItems: 1,
          items: object(
            {
              question_id: { type: "string" },
              p_over: { type: "number" },
              rationale: { type: "string" },
              evidence_refs: { type: "array", items: { type: "string" } },
            },
            ["question_id", "p_over"],
          ),
        },
        notes: { type: "string" },
      },
      ["answers"],
    ),
    phases: ["commit"],
  },
  {
    name: "read_released_results",
    description:
      "Return released results for prior games of this run: for each question the player, stat, line, market P(over), the probability you submitted (null if that session failed), the actual stat, the outcome (over, under, push, did_not_play, unresolved) and your per-question score against the market (null when excluded). Results for a game are released at 9 a.m. Eastern the morning after it; a game not yet released is absent. Rationales and notes are never returned here; if you kept them, they are in your workspace.",
    input_schema: object({ game_id: id("Defaults to every released game.") }),
    phases: ["pregame", "postgame"],
  },
];

/** JSON with keys sorted at every level, so the hash does not depend on authoring order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as object)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
export function serializeToolDefinitions(
  definitions: readonly ToolDefinition[] = TOOL_DEFINITIONS,
): string {
  return canonicalJson(
    [...definitions].sort((a, b) => a.name.localeCompare(b.name)),
  );
}
export function toolDefinitionsSha256(
  definitions: readonly ToolDefinition[] = TOOL_DEFINITIONS,
): string {
  return createHash("sha256")
    .update(serializeToolDefinitions(definitions))
    .digest("hex");
}
/** The subset the Messages API `tools` parameter takes. */
export function messagesApiTools(names: readonly ToolName[] = TOOL_NAMES): {
  name: ToolName;
  description: string;
  input_schema: Record<string, unknown>;
}[] {
  return TOOL_DEFINITIONS.filter((d) => names.includes(d.name)).map(
    ({ name, description, input_schema }) => ({
      name,
      description,
      input_schema,
    }),
  );
}
