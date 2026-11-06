# Memory permissions and chronological learning (SPO-851 / R4)

The v3 run profile uses `version: memory-permissions-v1`, a named `variant`, and
three gates: `coachProfile`, `bestPractices`, `skills`. Each stores separate
`read`, `create`, and `revise` booleans. First-stage manifests require exactly the
rights below; a partly enabled gate cannot silently redefine a named variant.

| Variant | Coach profile | Best practices | Skills |
| --- | --- | --- | --- |
| M0 | off | off | off |
| M1 | all rights | off | off |
| M2 | off | all rights | off |
| M3 | all rights | all rights | off |
| M4 | all rights | all rights | all rights |

`memoryVariant()` constructs these profiles. The schema also recognizes versioned
representation values (`episodic-store-v1`, `synthesised-profile-v1`,
`free-form-profile-v1`, `hypothesis-ledger-v1`, `coach-profile-v1`,
`coach-and-player-profiles-v1`) and management values (`append-only-v1`,
`revision-v1`, `periodic-consolidation-v1`, `always-in-context-v1`, `retrieval-v1`).
Manifest construction refuses every second-stage selection. No representation or
management algorithm is implemented here.

## Directory enforcement

Workspace tools and the research sandbox's FUSE mount delegate to the same
`Workspace` service. The context tool reports the actual v3 permissions; v2
switches cannot be mixed into the v3 schema.

| Surface | Access and persistence |
| --- | --- |
| `memory/coach_profile.md`, `memory/coach/` | Coach-profile gate; retained across games |
| `memory/best_practices.md`, `memory/practices/` | Best-practices gate; retained across games |
| `skills/` | Skills gate; retained across games, uncapped |
| `scratch/` | Always available during research/reflection; removed at session end and reset before the next session |
| `packages/<game_id>/` | Current game only; atomically frozen by R3; older directories disappear from the agent workspace |
| `feedback/<game_id>/trace.json` | Read-only virtual view authorized by the existing `PolicyTools.readFeedback` gate: previous game in pregame, current game in postgame, nothing older |

All other paths are refused. Gated-off paths are filtered before filesystem
inspection, so planted host files do not affect listing, reads, or write refusals.
Refusals use the same `not_found` response whether the hidden path exists or not.
The workspace mount is mediated for M0 too: its writable surfaces are packages
and scratch. The sandbox's separate `/scratch` remains ephemeral as before.

Memory mutations are serialized across tools and filesystem calls. The proposed
candidate is counted before any bytes or mutation-journal entry are committed;
phase and package locks are checked again after counting. Binary/non-UTF-8 memory
is rejected. Skill files may be binary and are measured separately in bytes and
file count. Freeze locks the research workspace, including memory, and postgame
opens the permitted memory again. The R3 frozen-package root assertion and
per-package freeze lock remain in force.

## Accepted implementation decisions

The user accepted these three choices on November 6, 2026 (SPO-851 / PR #48).
They are Agreed and recorded in the v3 implementation brief.

1. **Token counting: `analyst-count-snapshot-v1`.** The trusted metering proxy
   calls the analyst provider's existing `count` operation, which uses
   Anthropic `messages.countTokens` with `claude-opus-4-6`. No credential or count
   endpoint is given to the harness. The request is one user message containing
   a path-sorted JSON array of `{path, content}` for all retained UTF-8 memory
   files. Its returned input count is compared with 50,000. This includes file
   names, JSON escaping and message framing, so it is deliberately more
   conservative than counting raw document text alone; empty memory is zero.
   This is the accepted measurement convention, not a claim that API framing is
   part of the brief's definition of retained text.

   Anthropic documents that the endpoint uses the selected model's tokenizer,
   does not generate a response, and is free with separate request rate limits.
   Its count can differ from inference usage. See the [token-counting guide](https://platform.claude.com/docs/en/build-with-claude/token-counting)
   and [API reference](https://platform.claude.com/docs/en/api/messages/count_tokens).
   Counting charges no research tokens or compute; elapsed time still consumes
   the session wall budget. Requests have a bounded timeout and failure refuses
   the mutation; no character/byte approximation is used in production.

   `budget.memory` pins `tokenCap: 50000` and the protocol. Each distinct request
   is stored as an immutable blob with its hash, model, returned count and
   `researchBudgetCharged: false` in `memory_token_count`. The first result for
   identical input bytes is reused, including on resume. A refusal is therefore
   reproducible from the record even if a provider later changes its tokenizer.
   The error states current size, proposed size and cap. Sandbox cap refusals are
   also included in captured stderr, because FUSE itself returns only an errno.
   Tests use an explicitly synthetic character-count provider; no test count is
   presented as an actual analyst-tokenizer result.

2. **Staff dictionary.** Accepted source: the official NBA-hosted
   [2025–26 Denver Nuggets media guide](https://cdn.nba.com/teams/uploads/sites/1610612743/2025/10/2025-26-Denver-Nuggets-Media-Guide.pdf),
   PDF page 376, Boston Celtics coaching-staff listing. The curated names, source
   URL, page and full-PDF SHA-256 are pinned in
   `config/celtics-staff-2025-26.json`. `D.J. MacLeay` is an additional punctuation
   alias for the source's `DJ MacLeay`. This covers the head coach and eight
   assistants; it does **not** claim exhaustive coverage of front-office,
   medical, scouting or other non-coaching staff. Expanding that scope needs a
   further pinned source. These inputs are audit-only and never agent evidence.

3. **V2 retirement.** Keep `memory-v1` as a distinct historical fixture shape,
   with its original behavior and manifest hashing. The runner rejects it for
   pilot/scored execution. There is no mapping from horizon/revision/process to
   a v3 gate. The infrastructure launcher now takes `--memory=M0` through `M4`
   and rejects `--revision`/`--process`; it does not reinterpret old flags. Old
   manifests can still be read and derived for audit. This preserves earlier
   fixture evidence while preventing accidental use as a v3 experimental arm.

## Reflection, recovery and experiment record

Every v3 game has a postgame session, including M0. It starts at the existing
9 a.m. America/New_York release boundary and uses the postgame budget. No write,
reflection artifact or particular workflow is required. M0 may read the released
trace and write session scratch but retains no memory. M3's permitted memory
survives into the next pregame. Current and prior feedback access continues to
use R3's release rules; `feedback.ts` is unchanged.

`session_start` and `session_end` carry workspace snapshots and memory size;
`session_end` also records the diff. Each published runner checkpoint has a
`memory_checkpoint` event with tokens, cap, memory bytes/files, separate skill
bytes/files and the most recent game. Counts reuse the same recorded protocol.
Scratch is removed before the closing snapshot. Package snapshots remain outside
the agent's writable surfaces after commit.

Successful freeze records a `package_freeze` snapshot and locks the session.
A receipt published immediately before a crash is itself the durable commit;
resume never reruns pregame research or rolls back committed memory. Trusted
replay happens between pregame and postgame. An atomically published feedback
trace can be recognized after a crash before the `replay_completed` event,
without invoking replay again. Frozen package contents and feedback are also
backed by record blobs and can be restored when a checkpoint moves to a new root.

After each postgame attempt, including infrastructure failures, `boundary_audit`
scans the generic memory document, practices tree and skills tree. It records exact matched text,
file, character offset, current game and a `human-review` queue label. Both file
contents and relative paths are checked. Name matching also checks paths with
hyphens, underscores and dots replaced by spaces. Path flags record the entire
relative path as matched text, `source: path` and offset zero; content flags use
`source: content` and the matched substring offset. If the environment is
unavailable or the audit fails, `boundary_audit_skipped` records the game,
attempt, session status and reason so the gap remains visible. A successful audit
also records source hashes, the dictionary and scanned-file hashes. It never changes
or blocks a file. Player names combine the curated season roster and matching
player-reference names; game IDs come from the pinned schedule. Matching is
case-insensitive full-name/ID matching with Unicode word boundaries. It is a
lightweight flagger, not semantic detection of disguised facts, encoded labels,
misspellings or surname-only references. Surname-only references such as “Tatum”
or “Brown” remain undetected, so the end-of-run human sample is especially
important for those likely leaks.

## Integration and validation

The trusted `sessionEnvironment` factory receives the recorded memory counter
from the runner. Direct fixture sessions must supply their own explicit counter;
a v3 memory mutation without one fails closed.

For policy-enabled chronological runs, supply the existing R3 `policy` factory
and the runner's trusted `replayGame` callback. The callback runs `replayPolicy`
with its durable R3 record and publishes through `PolicyTools.saveFeedback`.
R3 already resumes received Jev answers without calling the provider again.
The runner requires the callback's released trace to match the game and release
before starting reflection. If a crash occurs *during* replay before publication,
the callback must resume its R3 record; the runner does not promise that an
arbitrary non-idempotent callback executes exactly once. The forced-crash fixture
covers the requested boundary between freeze and replay, and verifies one freeze
receipt and one replay. Missing/invalid packages remain the replay callback's R3
invalid-package path, not a new scoring rule.

R5b still owns prompts, memory-permission instruction wording and the skills
loading API. No prompt text was authored here. `harnessConfig` requires explicit
instruction text for v3; fixture configurations and the infrastructure-only
launcher reuse an existing infrastructure placeholder. Proposed skills loading:
use the permitted `/workspace/skills` tree through `execute_code`; a richer
loading API requires a later contract. No score or earlier replay gate evidence
was regenerated or changed.

`test/memory-permissions.test.ts` covers schemas, tool gates M0–M4, atomic cap
refusals, count caching, boundary flags, the old analyst loop with v3 permissions,
two chronological games for M0/M3/M4, SIGKILL recovery, and artifact restoration.
`test/sandbox.test.ts` checks M0–M3 through real Docker, including planted hidden
files and an over-cap append through FUSE. Run `npm run check`,
`npm run format:check`, `npm test`, `npm run sandbox:build`, and
`npm run test:sandbox`.
