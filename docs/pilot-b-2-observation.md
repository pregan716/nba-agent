# Development-games pilot: pilot-b-2 observation

Status: pilot observation, not evidence (brief, Replicates and variance). Recorded Oct 26, 2026. Run root `.cache/runs/pilot-b-2/r1`, record hash chain verified by the report. This is step 1 of the budget procedure in the brief's Research budget section.

## Setup

| Item | Value |
| --- | --- |
| Configuration | B: persistent, editable, voluntary; code execution on |
| Games | The ten development games, Oct 22 to Nov 7, 2025, in schedule order |
| Model and effort | `claude-opus-4-6`, effort `high`, adaptive thinking, held fixed for A and B from here on |
| Harness version | `befc61b1…ecc6d5`: homemade-analyst-v1, prompt caching on (two 5-minute breakpoints per request, SPO-813), loop defaults |
| Budget profile | `pilot-generous-v1-not-approved`: pregame 3,000,000 and postgame 1,500,000 tokens, reserve 200,000, cache reads at weight 0.1 (SPO-814), compute 900 and 600 s, per-call 120 s, stdout 256 KiB |
| Contamination probe | Executed Oct 26, 2026 against the pinned model: every regular-season and 2025 offseason item reported unknown. Attached to the manifest. |
| Price schedule | `placeholder-verify-before-pilot`: $5 input, $25 output, $0.50 cache read, $6.25 cache write per million. Matches the prices the brief verified on Oct 20, 2026; the id is renamed when the profile is approved. |

A first attempt, `pilot-b-1`, was stopped after one game when cache reads counted at full weight consumed 2.3M of the 3M pregame cap in 22 turns. Its record is kept; it is not part of this observation.

## Outcome

All 20 phases completed. Ten submissions, each accepted on the first attempt, covering 212 questions (one `no_quotes` exclusion, Xavier Tillman assists in game two, is the P2 builder's, not the agent's). No budget, compute, tool-call or wall-clock limit ended any session. No `max_tokens` stops. Wall clock 2.09 hours for the run, of which 1.14 hours was pregame research, 0.21 hours commit, and 0.74 hours postgame.

## Spend

Per session, over ten sessions each. "Charged" is the amount counted against the cap (cache reads at 0.1). Cost is at the placeholder schedule above.

| Pregame | min | median | p90 | max | total |
| --- | --- | --- | --- | --- | --- |
| Model calls | 9 | 14 | 20 | 30 | 159 |
| Charged tokens | 287,564 | 351,898 | 444,220 | 539,498 | 3,721,202 |
| Output tokens | 13,970 | 17,876 | 24,076 | 29,106 | 201,652 |
| Cache-read tokens | 1,074,964 | 1,609,539 | 2,612,184 | 3,358,140 | 18,933,361 |
| Cache-write tokens | 142,265 | 162,848 | 174,544 | 180,734 | 1,626,033 |
| Uncached input tokens | 11 | 16 | 22 | 32 | 179 |
| Tool calls | 15 | 19 | 23 | 41 | 211 |
| Code executions | 2 | 7 | 10 | 19 | 76 |
| Sandbox compute, s | 3.4 | 20.3 | 34.0 | 36.0 | 207 |
| Elapsed, min | 6.1 | 7.8 | 9.5 | 11.3 | 80.6 |
| Cost, USD | 1.95 | 2.32 | 2.71 | 3.50 | 24.67 |

| Postgame | min | median | p90 | max | total |
| --- | --- | --- | --- | --- | --- |
| Model calls | 8 | 10 | 14 | 14 | 106 |
| Charged tokens | 141,649 | 186,983 | 308,539 | 394,787 | 2,160,653 |
| Output tokens | 6,976 | 11,565 | 14,738 | 14,824 | 112,688 |
| Cache-read tokens | 486,554 | 723,370 | 1,327,578 | 2,045,591 | 8,877,823 |
| Cache-write tokens | 86,008 | 100,166 | 163,849 | 183,096 | 1,160,053 |
| Tool calls | 11 | 12 | 16 | 17 | 137 |
| Code executions | 1 | 2 | 7 | 9 | 35 |
| Sandbox compute, s | 0.0 | 0.1 | 18.0 | 20.3 | 53 |
| Elapsed, min | 2.9 | 4.6 | 5.2 | 5.7 | 44.6 |
| Cost, USD | 0.96 | 1.29 | 1.99 | 2.35 | 14.51 |

Run total: $39.18, 314,340 output tokens, 27.8M cache-read tokens, 2.79M cache-write tokens, 305 uncached input tokens, 260 sandbox compute seconds. Caching made uncached input negligible; the first call of each session writes about 53k tokens of system prompt, tools, context and questions to cache.

Commit stage (begin_commit through submit) charged 18,009 to 21,554 tokens per session, median 20,000, p90 20,641. Submissions carried 18 to 24 answers.

Sandbox: per-call compute p90 4.1 s, max 15.7 s, against the 120 s ceiling. Per-call stdout p90 about 5 KB; one postgame call returned 278 KB and was truncated at the 256 KiB cap. Nine pregame and six postgame code calls exited non-zero (the agent's own script errors, retried by the agent). No call hit a limit.

Tool mix. Pregame: 76 `execute_code`, 52 `search_evidence`, 16 `list_questions`, 15 `workspace_read`, 14 `read_schedule_and_injuries`, 13 `query_odds_history`, 10 `workspace_list`, 9 `read_released_results`, 5 `fetch_evidence`, 1 `query_game_history`. Postgame: 35 `execute_code`, 30 `workspace_write`, 25 `workspace_read`, 21 `read_released_results`, 16 `query_game_history`, 9 `workspace_list`, 1 `workspace_append`.

Reasoning tokens are not in the record's normalized usage because the runner reads a field the SDK does not return (SPO-816); the raw SDK usage is stored on every response and can be re-read.

## Score, as a pilot observation

Paired with the market baseline on the same ten games and 212 questions (run `market-dev-2`, which scores exactly zero):

| Measure | Value |
| --- | --- |
| Log-loss skill over the market | +0.0137 per question |
| Game-level bootstrap 90% interval (10,000 draws, seed 782) | [+0.0020, +0.0248] |
| Skill without the five most influential games | +0.0160 |
| Brier improvement | +0.0068 |
| Deviations ≥ 0.05 from market | 99 of 212 (47%), 64% on the right side |
| Deviations ≥ 0.10 from market | 18 of 212 (8%), 72% on the right side |
| By stat | assists +0.0153 (65), points +0.0158 (74), rebounds +0.0101 (73) |

This is one replicate of B, on the games used to tune prompts, with no A run and no B replicate spread. The brief says to report it as a pilot observation and nothing more. The comparison tool warns that harness version differs from the baseline run, as it must (the baseline makes no model calls).

Workspace at the end: three files, 21 KB (`strategy_notes.md`, `game_log.md`, `score_tracker.md`), written only in postgame, holding per-player season lines, explicit deviation rules the agent set for itself, and a player-id table with one unresolved id. Learning diagnostics require evidence review per the brief; nothing here is claimed.

## Step 2: proposed budget profile v1 numbers

By the brief's rule (90th percentile of observed spend; reserve as a fixed multiple of observed submission cost; sandbox limits by the same rule), rounded up:

| Limit | Observed p90 | Proposed v1 |
| --- | --- | --- |
| Pregame token cap (cache reads at 0.1) | 444,220 | 450,000 |
| Postgame token cap | 308,539 | 310,000 |
| Submission reserve | 20,641 (3× = 61,923) | 65,000 |
| Warn remaining | | 100,000 |
| Pregame compute cap | 34.0 s | 40 s |
| Postgame compute cap | 18.0 s | 20 s |
| Per-call wall clock | 4.1 s (max 15.7) | 30 s |
| Stdout cap per call | ~5 KB (max 278 KB) | 64 KiB |
| Tool-call ceiling (safeguard) | 23 / 16 | 100 / 100 |
| Wall-clock ceiling (safeguard) | 9.5 / 5.2 min | 60 / 30 min |

Caveats before adopting: the p90 of ten sessions is the second-highest value, so these caps are close to the observed maxima (pregame max 539,498 would exceed a 450,000 cap). Step 3 of the procedure, re-running the development games at one smaller and one larger pregame cap, is what tests whether submission validity and deviation behaviour are stable near these numbers. That re-run spends roughly the same again per run.

## Housekeeping

- Local checkpoints for this run take 1.5 GB for a 24 KB workspace, almost all per-checkpoint record copies (SPO-817).
- The interrupted `pilot-b-1` run left one exited sandbox container, which the sweep does not touch because it belongs to a different run root; removed by hand.
