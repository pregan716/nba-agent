# Policy packages, assembler and Jev — SPO-841

R3 connects a frozen Python package to the existing `windows-v2` replay, per-question validator and scorer. `src/policy/` owns package validation, isolated assembly, fixed requests, replay traces, feedback access and the typed contamination probe. `MeteringProxy.jev` is the trusted replay role; the analyst's scoped HTTP endpoint still accepts only Anthropic Messages.

## Package and freeze

The agent writes `packages/<game_id>/` through the workspace tools or mediated research filesystem. The package contains `assemble.py`, optional components, and `manifest.json`:

Agreed (Nov 6, 2026, SPO-857): the agent may omit `components`; the harness computes the hashes itself.

```json
{
  "stateVersion": "state-v1",
  "notes": "Free-form notes (optional)"
}
```

If `components` is supplied, every file except the manifest must appear in it, including `assemble.py`, with its exact SHA-256; wrong hashes, missing entries and extra entries are refused. Without it, all ordinary package files are included automatically. Paths are relative; symlinks, hard links, devices, more than 256 files or more than 8 MiB are refused. The manifest and all file hashes form the package identity, and the frozen receipt records every hash including `manifest.json`. See the runnable [hand-written package](https://github.com/pregan716/nba-agent/blob/f0a69d3e2d3194aa34259483b0a6acd1a234b5c5/examples/policy/assemble.py), which remains compatible with its explicit hashes.

`freeze_package` takes no agent-supplied game id or path. It validates hashes and schema, copies the bytes into a staging directory, loads the entry point inside the assembler container, checks the trusted logical clock again, and atomically renames the snapshot into the run's `frozen-packages/<game_id>/`. Both clock checks require strictly before scheduled tip. Identical pre-cutoff retries return the same receipt; changing a frozen package is refused. A failed freeze returns `status: invalid_package` and a reason, publishes no snapshot, and permits fixing the draft before cutoff. The replay caller passes a final failed freeze through `replayPolicy.invalidPackage` to mark the game unscored.

Snapshots are outside the agent workspace, with read-only files/directories. The workspace service checks the durable receipt on write, append, edit, delete, mkdir and filesystem authorization; this also covers the mediated research mount. Old packages cannot be listed or read in a new game's session. With the policy tools installed, the current package is writable even for stateless/append-only memory configurations; ordinary memory permissions are unchanged. The host administrator can modify files, but the replay verifies the snapshot's hashes before assembly and before cache use. Immutability is an agent/tool boundary, not a claim against a privileged host administrator.

## Assembler API and containment

`assemble(state)` returns exactly:

- `jev_state`: string;
- `instructions`: strings for `substitution`, `count`, `exit`, `entry`;
- `criteria`: `substitution.true`/`false` strings; `count` descriptions under `none`, `one`, `two`, `three_or_more`; `exit` and `entry` descriptions keyed by exactly the observable state's respective player sets;
- `diagnostics`: JSON object.

The assembler never receives a window, actual decision or future rows. A fresh container/interpreter receives only the state on stdin, the read-only package at `/package`, and a writable tmpfs at `/scratch`. There is no workspace or data mount, host PID namespace, provider credential or network. The root filesystem is read-only, all capabilities dropped, privilege escalation disabled, process count capped at 16, and memory/swap capped equally. Container cleanup follows success, failure, timeout and cancellation. Package validation also executes inside this boundary, never on the host.

The gate uses 15 seconds per window (including both verification executions), 128 MiB memory and a 256,000-byte combined output cap. These are explicit development assembler limits, not the unresolved research budget profile. The immutable image digest, limits, API version, context guard, model settings and determinism rule are in `harness.policy`; package hashes and code revision also identify the predictor. Research harness configs accept the same policy descriptor.

Each new package/state/image combination executes twice, with fresh scratch, fixed Python hash seed and seeded standard-library RNG. Canonical outputs must match. The validated request and diagnostics are then stored in an integrity-checked content cache; repeated execution uses those exact bytes. This catches observed nondeterminism rather than claiming arbitrary Python cannot inspect clocks or OS entropy. The cache makes the accepted request stable through retry/resume. A first-window package load/assembly exception is `invalid_package` and leaves the entire game unscored; a later exception is `assembler_error` and scores the existing fallback. Context-limit failures and unsupported environment option sets (including an empty eligible bench) are window-only `assembler_error`, including the first window. External cancellation stops replay without saving a prediction failure, window score, summary or trace for unfinished work. Docker creation/launch/inspection failures propagate as harness errors; resumption retries the unfinished window. Only worker failures, schema/criteria errors, nondeterminism and execution limits can invalidate a package. Cleanup errors attach to the original exception rather than replacing it.

Build and test the real boundary:

```sh
npx tsx scripts/assembler-build.ts
# Use the printed immutable pin:
ASSEMBLER_IMAGE=local@sha256:<digest> npx tsx --test test/policy-sandbox.test.ts
```

The real Docker test plants a host future record and a runner credential, tests network and package writes, verifies fresh scratch, enforces wall-clock and memory failure, and checks request identity/cache reuse. It is explicitly skipped when `ASSEMBLER_IMAGE` is absent; the ordinary unit suite does not claim container isolation coverage.

## Jev request, provider and scoring

The environment constructs four questions. Names, types and eligible option keys cannot be chosen by the package. `count` criteria are sent as the ordered array `none`, `one`, `two`, `three_or_more`. TypeSafe returns score probabilities under `"0"` through `"3"`; the adapter translates those four keys to the contract's semantic names. Missing or extra keys remain invalid. Raw responses, including the original numeric keys, are retained.

The runner calls `POST https://api.typesafe.ai/v1/systemone` with `model: jev-1.14.0`, `state` and `questions`. Only the trusted provider constructor receives `TYPESAFE_API_KEY`. It sends neither long-context nor image headers. Every attempt, raw response, error, versioned response model, latency and usage is written to the hash-chained record. A mismatched response model or invalid usage is recorded and rejected. There is one retry for 429 or transport failure, honoring numeric/date `Retry-After` and cancellation. Retry-After values above 60 seconds cause a recorded provider failure without an early retry. Other HTTP errors are not retried. Spend is input tokens × $0.042 / 1,000,000, output free; even a rejected model response retains reported usage and cost.

The existing validator and derived-action rule are reused without relaxing them. Invalid answers fall back only for that question. Model probabilities are not summed, normalized, filled or repaired. A malformed `entry` map with valid timing/count/exit therefore retains those other answers. Provider failures remain unscored, with the existing >5% game flag. TypeSafe `max_tokens_exceeded` responses are recorded as assembler errors.

The [System One API](https://docs.typesafe.ai/api/system-one), [Score response](https://docs.typesafe.ai/primitives/score) and [request errors](https://docs.typesafe.ai/api/errors) were checked during implementation. The numeric count mapping is an API adaptation, not a scoring change.

## Agreed context guard

The API documentation does not expose a tokenizer/count endpoint. The implementation therefore refuses a request when UTF-8 bytes of serialized state plus one question, plus 1,024 bytes of framing allowance, exceed 32,000; it also guards the serialized full request plus 4,096 against 64,000. This is a conservative capacity guard, **not an exact token count**, and can reject requests below the token limit. The user explicitly accepted this narrower guard on Nov 6, 2026; the brief marks it Agreed. An exact tokenizer would change the harness version. No research budget numbers or other Open decision are inferred here.

## Trace, feedback and local validation

`replayPolicy` plugs into the existing frozen-state `Predictor` interface. It records assembly diagnostics and measured wall time, request, raw responses, usage, validation, derived action, actual decision and per-window scores. The trace contains all candidates, including exclusions and failures, plus package/harness identity, aggregate scores, invalid-answer reasons, latency and spend. Saved predictions and received valid responses are reused after a crash; uncertain in-flight calls remain visible as attempts rather than invented usage. A committed full trace is published atomically outside the workspace. `read_feedback` returns compact pages of two window summaries, with bounded previews of diagnostics/questions/answers/validation. `cursor` advances through windows. `window_id` requests the complete forensic window JSON in chunks of 4,096 characters; `offset`/`nextOffset` support reconstruction. Full request state and raw responses remain available on demand without putting a whole game's trace into one model message.

### Compact state-summary fields (SPO-850)

The user accepted this field selection on Nov 6, 2026. Each
window summary retains `period`, `clockMs`, `celtics` and `eligibleBench`, and adds:

- `celticsHome`, `homeScore`, `awayScore` and `margin` (Celtics points minus
  opponent points). `celticsHome` comes from the pinned game's home-team ID,
  carried as static dataset/trace metadata. It is `true` for Boston at home and
  `false` away, including tied scores. Older datasets/traces without that metadata
  return `null`; the side is never inferred from score or margin.
- `players`: one entry per unique on-court or eligible bench player, in that
  order, containing `playerId`, `personalFouls`, `minutes` (total minutes played
  so far) and `currentStintMinutes`. These are copied without rounding from the
  window's observable state. Unavailable players and opponents are excluded;
  missing player measurements are `null`, never invented zeroes.

Timeouts remaining is omitted until the observable state supplies that data;
`state-v1` contains historical timeout events but no remaining-timeout balance.

Scores and player measurements project `window.state`; home/away identity is
static pregame metadata. Neither uses assembled Jev state, actual outcomes or
final box scores. The same projection is used for previous-game and
postgame feedback. Pages still contain at most two windows; full forensic detail
remains available in the existing 4,096-character chunks. Tests cover the enriched
page with five on-court and fifteen eligible bench players under 24,000 bytes,
null states, unchanged detail reconstruction and invariance when later game
scores/fouls change. The observable-state schema, scores and release rules are
unchanged. New traces include the static side metadata; existing frozen traces
are not rewritten.

`PolicyTools` takes the trusted chronological schedule, current game, logical clock, and prior sample states. `read_feedback` returns exactly the immediate previous game in pregame or current game in postgame, only at/after its next-morning 9 a.m. Eastern release. Explicitly asking for an older/current/future game outside that rule returns the same unavailable error. The schedule's release times are validated. The agent cannot set the clock, supply a trace path, or nominate its own validation states.

`validate_package` snapshots the draft separately and assembles at most three sample states from games released by the logical clock and strictly before current tip. It returns requests and diagnostics, never invokes Jev, and is charged against research compute through the runner's reservation/settlement path. The meter conservatively charges elapsed assembly/setup wall time; limits abort validation and preserve the error in the result. When no earlier game of the run has been released, validation falls back to up to three qualified states from distinct games in the fixed chronological 2024–25 datasets from SPO-856: first quarter with at least six minutes left, second quarter with at most six minutes left, and fourth quarter. For each target, choose the first qualifying window in the earliest unused game; skip a target if none qualifies. Each fallback must have a canonical next-morning release strictly before the session cutoff, a prior-season scheduled start, and a matching state game ID; current and future games are refused. The run manifest pins each fallback’s game, release, dataset input hash and state hash. Once an earlier run game is released, only eligible run-game samples are used. Tests plant current and future samples and confirm they are ignored. Temporary validation snapshots are unlocked and removed in `finally`. Session creation asserts that the policy package store shares the workspace freeze-lock root.

Integration: supply `sessionEnvironment`'s `policy` factory with a `PolicyTools` instance and put `policyHarness(assembler)` in the research harness config. The factory receives only trusted session/run context. Pregame uses a logical instant strictly before scheduled tip; postgame uses the game's release. Call `replayPolicy` during trusted replay, then publish via `PolicyTools.saveFeedback`. The analyst's model handle cannot call the `jev` role. Pi and the chronological learning runner are the subsequent R4/R5 work, not replaced here.

## Generic baseline, probe and gate 2

`genericAssembly` uses a fixed observable-state template and fixed instructions, with no package components or retained memory. The hand-written package goes through freeze and Docker assembly; both use the same request builder, provider, validator and scorer.

`probeJev` sends only typed factual questions with an empty state. Truth and source provenance stay outside the request. It records invalid answers, accuracy against 0.5 chance, Brier against 0.25 chance, and the difference between mean probabilities on true and false statements. The gate runs a small paired opener-result probe and embeds its result in the replay manifest; its own request/response record is retained. Two questions about one game cannot establish absence of contamination. The larger pilot probe and model repeatability evaluation remain R5.

```sh
# Fixture responses, real Docker and pinned audited data:
npx tsx scripts/policy-audit.ts --image=local@sha256:<digest>
# Real Jev, with the credential only in the runner:
doppler run --project nba-agent --config prd -- npx tsx scripts/policy-audit.ts --live --image=local@sha256:<digest>
```

The script uses the opener `0022500083`, verifies the pinned corpus, builds its frozen pregame and windows, runs both predictors, verifies the hash chain, and publishes/reads the postgame traces. Full local records live under `.cache/policy/gate2-*`; the compact [live gate evidence](../../evidence/policy/gate2-live.json) records the implementation revision, image, package, dataset, probe, scores and usage. Both predictors scored all 66 eligible windows from 75 candidates, with zero invalid answers or provider failures in the initial gate. This is a development integration check, not evidence of learning or a scored comparison. The decision dataset contains independently marked stoppages, which over-represent fouls/timeouts; it is not all coaching decisions.

## Review follow-ups

CI now builds the assembler image and runs the real Docker test. Local image IDs remain host-local: registry publication and a pullable digest are required before scored runs. The user accepted the context guard on Nov 6, 2026; that explicit decision is recorded in the brief. The original live gate below remains evidence for its recorded implementation revision; review fixes are covered by cancellation/resume, infrastructure, paging, cleanup and Docker tests.

## Research tool output — SPO-857

Research code output is capped at 16,384 bytes across stdout and stderr in the pilot preset. Up to 4 KiB is reserved for the tail of stderr when present; stdout uses the remaining bytes. The supervisor retains rolling stderr so the final exception survives earlier output. Truncated results carry `truncated: true` and `truncation_notice`; files saved in the permitted workspace are unaffected.

`query_game_history` defaults to column names without descriptions and rows without provenance columns. `include_metadata: true` restores both. Python `nba_data.table(..., include_metadata=True)` and `nba_data.query(..., include_metadata=True)` restore provenance columns; their default frames omit them. `quality_status` remains in the default view so partial or failed rows are identifiable; `issue_ids` remains opt-in. The shared provenance list is `sandbox/provenance-columns.json`. SQL still executes over the complete stored tables; filtering occurs on result columns. Empty and all-null shards retain their rows and null values without pandas concatenation warnings.

Agreed (Nov 6, 2026, SPO-857): `workspace_edit(path, old_text, new_text)` replaces exactly one literal occurrence in an existing UTF-8 file. Empty, absent or repeated matches are refused. It uses write permissions and the same phase checks, freeze lock and atomic memory-cap enforcement. Successful writes, appends, deletes and edits under `memory/` return `memoryUsage: {retainedTokens, cap}` using the existing analyst count protocol; v3 `context` returns the same usage. Skills and per-game artifacts are not included in retained memory usage.

Feedback includes the game summary only on `cursor: 0`; later pages retain window details and pagination. The full forensic trace remains unchanged.

Integration for SPO-855: prompts should describe the optional `components` map, the fallback validation states, `workspace_edit`, `include_metadata`, and `memoryUsage`. Prompt wording is outside SPO-857’s scope. The user accepted the simplified manifest, edit tool and prior-season practice states on Nov 6, 2026; all three are Agreed.

Agreed (Nov 6, 2026, SPO-857): using the retrospective 2024–25 box-score roster datasets for unscored analyst validation extends the Nov 6 agreement, which covered statistical-baseline training only. These samples retain the same unknown injury status and synthetic timestamp caveats. They never supply rosters or states for evaluated games.

## Pilot data checks and bounded reads — SPO-860

With neither `game_id` nor `team_id`, `read_schedule_and_injuries` returns the current game and next scheduled Celtics game, plus injury reports/snapshots only for those games. Pass `next_cursor` back as `cursor` to read two later games at a time. Cursors are bound to the session, phase, cutoff and report-time filters. Explicit `game_id` or `team_id` retains the existing full filtered result; neither can be combined with a cursor. The research export retains its complete cutoff-filtered schedule.

The prior-season release `spo-839-full-v1-2024-25` (manifest SHA-256 `449f99a1910ed1114815376acecfb7bc0c5ab834888d8f7d9bbdc577bac50a75`) reproduces the pilot's Celtics substitution histogram exactly: 859 same-game/period/clock groups with 2 event rows, 290 with 4, 137 with 6, 29 with 8, and 6 with 10. Across 1,321 groups, the 3,992 event rows have exactly one substitution participant each: 1,996 `sub_in` and 1,996 `sub_out`; all groups have equal entry and exit counts. These are separate entering/leaving-player records, not duplicate observations of the same player. A k-for-k change therefore has 2k rows. The participant roles above were checked internally against the release; `event_participants` is not an agent-queryable table and is not exported to the research sandbox. For agent research, recover who moved by comparing the team lineup before and after the substitution batch using the exposed `home_lineup_before`/`home_lineup_after` or `away_lineup_before`/`away_lineup_after` arrays in `events`. Use the feedback trace for scored decisions; raw equal-clock batches are not necessarily decision windows. SPO-861 chooses this wording-only correction rather than expanding the public table surface. Clock grouping here describes the observed histogram, not a replacement for the scoring contract's adjacency and window rules.

The [pinned data dictionary](../../../config/dictionaries/pbp-0.1.0.md) defines `player_box_scores.minutes_seconds` as seconds and `player_stints.cumulative_minutes_entry`/`exit` as reconstructed decimal minutes. Verified sample: game `0022400001`, player `1626204`, official `PT27M26.00S` maps to 1,646 seconds; a period-3 stint has `duration_ms = 403000` and cumulative minutes 11.9 → 18.616666666666667 (difference × 60,000 = 403,000 milliseconds). The public `player_stints` table maps to the release's `v_player_stints`. These findings are for the pinned release, not a promise about future feed schemas.

The boundary audit additionally matches player and staff surnames case-sensitively, stripping generational suffixes and recognizing hyphen/apostrophe surname components. Matching folds diacritics on both names and scanned text/paths, so ASCII spellings such as `Vucevic` and `Gonzalez` are detected. Flags retain the original spelling and UTF-16 offset, including decomposed combining accents. Full names remain case-insensitive. Thus `Brown`, `White`, `Harper` (from `Ron Harper Jr.`) and `Mazzulla` enter the same human-review queue in best practices and skills, while `white background` alone does not. It remains flag-only and never rewrites or suppresses memory.
