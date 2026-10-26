# P3a session contract (SPO-786)

`src/env/contract.ts` and `src/env/tools.ts` fix the interface between the P4 runner, the P3 replay environment (P3b–P3f) and the P5 harness. This issue ships types, tool definitions as data, the error vocabulary, the phase-legality table and the visibility rules. It ships no behaviour. The brief's "Environment tools", "Harness contract", "Agent output contract" and "Temporal access rules" sections are the spec.

## Three parties, one contract

```text
  harness (P5)  ── SessionTools.call(name, input) ──▶  runner (P4)  ──▶  environment (P3b–f)
                                                        │ owns: budget ledger, record,       │ owns: visibility (cutoff),
                                                        │ receipt, phase transitions,        │ phase legality, memory-mode
                                                        │ attempt counting, stdout cap       │ enforcement, submission
                                                        │ routes: context, begin_commit,     │ validation, sandbox lifecycle
                                                        │         submit, execute_code       │ implements: EnvironmentTools
```

- **The harness** holds `SessionTools`: one typed `call<N>(name, input)`. It never sees paths, credentials or internal records. Results are the `ToolResult<N>` types and nothing else; every field in a result type is agent-visible by definition.
- **The runner** keeps the P4 `Environment` adapter it already has. It routes `context`, `begin_commit`, `submit` and `execute_code` itself (budget, phase ledger, receipt, compute metering) and forwards every other tool name to the environment. One follow-up for P4: `execute_code` input is `{ program }`, not a bare string, because the Messages API requires object input schemas.
- **The environment** implements `EnvironmentTools`: a typed method per forwarded tool, plus the runner-facing hooks P4 already expects (`transition`, `questions`, `validateSubmission`, `execute`, `close`).

Where both sides check the same rule (commit locking, stateless workspace denial, three submission attempts), the environment's check is the semantic owner and the runner's is a second belt that must agree. P3b's fixture tests exercise the environment's check directly, without the runner, so the guarantee does not depend on P4 being in front.

## Tools

One tool per capability in the brief's table, plus the workspace tools and `begin_commit`, which the brief describes in prose. Names match what the P4 runner already routes on.

| Brief capability | Tool | Phases | Capability axis |
| --- | --- | --- | --- |
| Session context | `context` | pregame, commit, postgame | always |
| Search and fetch evidence | `search_evidence`, `fetch_evidence` | pregame, postgame | `search_and_fetch` |
| Query game history | `query_game_history` (play-by-play release tables and the static player-reference tables) | pregame, postgame | `game_history` |
| Read injuries and schedule | `read_schedule_and_injuries` | pregame, postgame | `game_history` |
| Query odds history | `query_odds_history` | pregame, postgame | `odds_history` |
| List questions | `list_questions` | pregame, commit, postgame | always |
| Execute code | `execute_code` | pregame, postgame | `code_execution` |
| Workspace (prose) | `workspace_list`, `workspace_read`, `workspace_write`, `workspace_append`, `workspace_delete` | pregame, postgame | `workspace` |
| Commit step (prose) | `begin_commit` | pregame | always |
| Submit | `submit` | commit | always |
| Read released results | `read_released_results` | pregame, postgame | always |

`search_evidence` and `fetch_evidence` are two tools for one capability because search returns ids and snippets and fetch returns one full record; a single tool would force the model to choose between paging and reading. `CAPABILITY_TOOLS` maps the capability to `search_evidence`; the test asserts the nine capabilities map to nine distinct tools.

### Phase machine

```text
 initialize ──▶ pregame ──begin_commit──▶ commit ──valid submit──▶ postgame ──▶ checkpoint
   (runner)      research                 only context,            release at 9 a.m. ET;
                 + workspace              list_questions,          research + workspace
                                          submit                   tools again; no submit
```

The runner requests transitions; the environment validates them; the agent cannot advance time. A tool called outside its phases fails with `phase_refused`. The pregame and commit cutoff is the scheduled start; the postgame cutoff is the release instant. A stateless run skips postgame entirely (P4 records it as `skipped`).

### Inputs and results

Every input schema is an object with `additionalProperties: false`. Results are plain JSON: strings, numbers, booleans, null, arrays and objects. Two conventions hold everywhere:

- **No property named `type`.** The P4 metering proxy rejects any nested object whose `type` is `url`, `file`, `image`, `document` or `container_upload`, and tool results are echoed to the model inside `messages`. Discriminators are `kind` or `source`. The test walks the definitions and the visibility rules to enforce this; P3b's tests should walk real results.
- **Paging never leaks.** `total` counts eligible matches only; `next_cursor` is opaque. A future record contributes to no count, no page and no error.

Result types in `contract.ts`, briefly:

| Tool | Result carries | Result never carries |
| --- | --- | --- |
| `context` | scheduled-start `game_lines` (spread, derived total, implied team totals, counts, provenance), team, game (opponent, home, scheduled start, index), phase, cutoff, budget remaining, enabled capability groups, memory mode, dataset versions | run id, paths, anything about other replicates |
| `search_evidence` | hits with `evidence_id`, source, availability time, author, title, snippet; `total`, `next_cursor` | relevance scores, record provenance |
| `fetch_evidence` | full text as published, segments with speaker-cluster labels, announced starters, references, explicit artifact provenance (SPO-788) | audio, speaker identities, alternates, box-score corrections |
| `query_game_history` | published rows plus a `ColumnDefinition` per column, and `unavailable` games with reason; the six player-reference tables (`PLAYER_REFERENCE_TABLES`) by `player_id` or `team_id` | any 2025–26 game before its release; invalid-coverage products as data; the player-reference `archive/` |
| `read_schedule_and_injuries` | schedule entries; injury rows with printed time, status, reason, resolved `player_id` or null; team snapshots as `listed` / `not_yet_submitted` / `unknown` | evidence register, corroborations, assessment times, a healthy reading of an absent team |
| `query_odds_history` | `game_lines` observations for the selected game, observations (`available_at`, player, stat, line, `p_over`) and settlements for released games | per-book quotes, contributing books, dispersion, DFS lines, `snapshot_at`, `p_under` |
| `list_questions` | exactly the P2 `agentQuestion` projection | `p_under`, provenance, exclusions |
| `execute_code` | stdout, stderr, exit status, compute seconds, truncation flag, limit | host paths, container ids |
| `workspace_*` | entries, content, byte counts | anything outside the workspace |
| `begin_commit` | `phase: "commit"`, budget | — |
| `submit` | receipt, attempt number, clip events | — |
| `read_released_results` | per question: player, stat, line, market and agent probabilities, actual, outcome, score | rationales, notes, evidence_refs, unreleased games |

### Errors

`SessionError` carries a `code` and serializes to `{ error, message, problems, attempts_remaining }` on every transport:

| Code | Meaning |
| --- | --- |
| `cutoff_refused` | The request would reveal a record not eligible at the cutoff. |
| `phase_refused` | Tool not legal in the current phase. |
| `capability_disabled` | The run profile does not enable the tool's capability. |
| `memory_mode_refused` | Workspace tools in a stateless run; write or delete under append-only rights. |
| `invalid_input` | Schema violation, unknown table, bad path. |
| `not_found` | An id that does not resolve to an eligible record. Never distinguishes future from nonexistent. |
| `validation_failed` | Submission rejected; `problems` names every problem; `attempts_remaining` says how many resubmissions remain. |
| `budget_exhausted` | The phase's allowance is spent (the limit is recorded by P4). |

## Visibility rules

`VISIBILITY` in `contract.ts` lists, per source, what is exposed, what is never exposed, and a `cutoff` rule (`CutoffRule`). It restates the brief's datasets table and the P1a dispositions: the absent-team snapshot is served as `unknown`; lineup announcements at or after the scheduled start are unavailable for their own game; transcript title words carry no availability meaning; released results never carry rationales; the player reference is static and eligible for every game. P3b's adversarial fixture tests should be written against this list.

### Equality at the cutoff

| Rule | Sources | Why |
| --- | --- | --- |
| `at_or_before` | odds observations, game-history tables, questions, released results | The environment defines the availability instant as a scheduled boundary: an observation's `requested_at`, or a game's 9 a.m. ET release. The scheduled-start observation is requested at the cutoff and defines the questions. The postgame cutoff *is* the just-played game's release instant, so postgame reflection can read that game's box score and events, which the lifecycle promises. |
| `strictly_before` | injury reports, posts, lineup announcements, transcripts | Publication times outside the environment's control; equality is not evidence of availability. This is the brief's "strictly before" rule and the P1a T1 disposition on the two lineups posted at exactly the scheduled start. |
| `static` | player reference | Built before the opener; eligible everywhere. |

The shared sentence in every research tool's description says the same: posts, transcripts, lineups and injury reports published at or after the cutoff, and game data or odds observations released after it, do not exist from the agent's point of view. The brief's P3 acceptance sentence for odds history was aligned with this in the same PR (it previously said "at or after").

## Harness version

`serializeToolDefinitions()` emits the definitions as canonical JSON (keys sorted at every level, tools sorted by name) and `toolDefinitionsSha256()` hashes it. P5 puts the serialized definitions in the run config's `harness.toolDefinitions`, so any change to a name, description or schema changes the harness version. `messagesApiTools(names)` returns the `{ name, description, input_schema }` subset for the Messages API `tools` parameter, filtered to the tools the run profile enables.

## MCP later

The contract is one `call(name, input)` with object inputs, JSON results and a fixed error shape, which is the MCP tool model. Wrapping it is a transport change: each `ToolDefinition` becomes an MCP tool, `SessionError.toJSON()` becomes the error payload, and the harness swaps `SessionTools` for an MCP client with the same types. Nothing in this file assumes in-process calls.

## P4 translation (tracked in SPO-787)

The P4 runner routes `context`, `begin_commit`, `submit` and `execute_code` itself. SPO-787 implements the following translations, verified at the runner-backed `SessionTools` boundary:

| Previous runner shape | Contract | Implemented translation |
| --- | --- | --- |
| `execute_code` args is a bare string | `{ program }` | read `args.program` |
| `context` returns `{ game, phase, cutoff, budget }` with the manifest `Game` and camelCase budget (`tokens, compute, tools, reserve, warning`) | `ContextResult`: team, game with opponent/home/index/venue, phase, cutoff, `BudgetRemaining` in snake_case, memory, dataset versions | build `ContextResult`; map `compute → compute_seconds`, `tools → tool_calls`, `reserve → submission_reserve` |
| `submit` returns `{ receipt }` | `{ receipt, attempt, clips }` | add attempt and clips (P3 `Validation.clips`) |
| `submit` validation failure returns the `Validation` object | throws `SessionError("validation_failed", …, problems, attemptsRemaining)` | wrap |
| code result `exitStatus`, `computeSeconds` | `exit_status`, `compute_seconds` | rename at the boundary |
| capability check `enabled.includes(toolName)` | `TOOL_CAPABILITY[toolName]` grouped names (`search_and_fetch`, `game_history`, `odds_history`, `code_execution`, `workspace`) | look up the group; `null` means always on |
| errors are plain `Error` | `SessionError` codes | map phase lock → `phase_refused`, stateless workspace → `memory_mode_refused`, disabled → `capability_disabled`, limits → `budget_exhausted` |

## What P3b–P3f take from here

- P3b implements `EnvironmentTools` for `query_game_history` (both table families), `read_schedule_and_injuries`, `query_odds_history`, `list_questions`, the visibility function behind `VISIBILITY` with its three cutoff rules, the adversarial fixture, and the P4 translation above.
- P3c implements `search_evidence` and `fetch_evidence`.
- P3d implements the phase machine behind `TOOL_PHASES`, `validateSubmission` producing `validation_failed` with every problem named, and `read_released_results`.
- P3e implements the five `workspace_*` tools and `memory_mode_refused`.
- P3f implements `execute_code` and the `/data`, `/scratch`, `/workspace` mounts the tool description promises.

SPO-788 adds `FetchEvidenceResult.provenance`: `manifest_sha256` and an `objects` list containing only `bucket`, `key` and `sha256`. This supplies the issue's citation provenance without exposing raw envelopes, retrieval metadata, relevance judgments or credentials. Transcript provenance includes both the normalized segments artifact and the readable-text artifact. Future and nonexistent IDs both use P3a's `not_found` error; this supersedes SPO-788's earlier `cutoff_refused` wording to avoid an existence oracle.

### Game-line context (SPO-829)

Every opening context includes `game_lines` for the current game's scheduled-start
snapshot, in both pregame and postgame and all memory modes. Fields are
`celtics_spread` (negative means favoured), `p_celtics_cover`, `spread_book_count`,
`game_total`, `total_book_count`, `celtics_implied_total`,
`opponent_implied_total`, and `implied_total_book_count`, plus `game_id`,
`available_at`, `snapshot_kind`, and provenance. Missing or insufficient markets
produce null values and zero counts, never zeros masquerading as market lines.
The total is derived from two team-total quotes, not a directly quoted total.

`query_odds_history.game_lines` includes the selected game's eligible snapshots;
player/stat filters apply only to player props. The sandbox `game_lines` table
mirrors those projections across current and prior games when odds history is
enabled; without that capability it includes only the opening-context row.
Observations use `requested_at <= cutoff`; future observations and
future games are excluded. These context markets never create scored questions.
Provenance contains the parent layer manifest, chained source manifest, quotes
object, pinned proportional methodology, and game-line adaptation hash. The
`gameLines` data-source version pins that adaptation. The updated tool descriptions
change the harness version, so existing manifests must not be reused.
