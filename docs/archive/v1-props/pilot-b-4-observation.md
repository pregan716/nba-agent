# Pilot B-4: development games, step 1 of the budget procedure (Oct 26, 2026)

Pilot observation, not evidence. Configuration B (persistent, editable, voluntary) on the ten development games, effort `high`, code execution on, prompt caching on, cache reads at weight 0.1, generous ceilings (`pilot-generous-v1-not-approved`), recovery defaults (3 model retries in a 60 s window, 2 session attempts). Harness version `45c0d5da…`, the first run after SPO-827 (transient-error recovery), SPO-829 (game spread, total and implied team totals in the opening `context`) and SPO-830 (factual descriptions of the text evidence sources). Same contamination probe as pilot-b-3. Compared throughout with [pilot-b-3](pilot-b-3-observation.md) and, for the budget, with the [pilot-b-2](pilot-b-2-observation.md) proposal.

## Outcome

- All 20 phases completed. 10 submissions, 212 questions, all scored. No budget, compute, tool-call or wall-clock limit ended any session.
- This run **is** a valid step-1 sample for the budget procedure.
- 2.4 h elapsed (research 80 min, commit 14 min, postgame 48 min), $40.99 at the verified prices (pilot-b-3: $39.25 for nine games).
- One upstream failure, recovered by the session re-attempt, not by the proxy retry (below).
- One submission (game 6) failed validation on its first submit for missing rationales on two answers 0.05 or more from the market, and was accepted on the second. All others were accepted first time.

## Recovery (SPO-827) in practice

Game 6 pregame (0022500021), attempt 1, call 8: the provider returned 529 `overloaded_error` (request `req_011CgRgXfFwsxxkjnoA3Sf3M`) after 89.5 s. The proxy recorded it as terminal on its first attempt without retrying, because the call had already used the whole 60 s retry window. The window counts time inside calls by design, so that a healthy long generation is never aborted. The harness got a 502, and the runner ended attempt 1 as `infrastructure_failure`. It then restored the workspace to the attempt's `before` snapshot, reset the attempt budgets and started attempt 2, which completed and submitted after 10 minutes.

Cost of the failure: attempt 1 charged 217,654 tokens ($0.76 settled), including the failed call's 93,555-token reservation, which stays charged and unconfirmed (`spendComplete: false`). The phase as a whole charged 567,465 tokens across both attempts.

The recovery worked, but it worked through the more expensive layer. A 529 that arrives slowly is never retried in the proxy, so it costs a session restart instead of a few seconds of backoff. Starting the retry window at the first failure, rather than at the first call, would let the proxy absorb it. Candidate follow-up, not filed.

## Spend per session (charged tokens, cache reads at 0.1)

Completed sessions, ten per phase. Game 6 pregame uses attempt 2; the failed attempt 1 is reported above.

| Pregame            | min     | median  | p90     | max     | Total     |
| ------------------ | ------- | ------- | ------- | ------- | --------- |
| Charged tokens     | 291,541 | 363,833 | 416,150 | 464,344 | 3,677,362 |
| Model calls        | 10      | 14.5    | 20      | 20      | 148       |
| Output tokens      | 10,810  | 23,700  | 30,579  | 32,052  | 222,458   |
| Cache-read tokens  | 1.01M   | 1.88M   | 2.28M   | 2.65M   | 18.0M     |
| Tool calls         | 13      | 20.5    | 23      | 26      | 197       |
| Code executions    | 2       | 7       | 12      | 13      | 70        |
| Sandbox compute, s | 6.2     | 21.7    | 40.1    | 43.8    | 219       |
| Elapsed, min       | 4.8     | 9.0     | 12.7    | 13.3    | 91.7      |
| Cost, USD          | 1.90    | 2.47    | 2.89    | 3.07    | 24.90     |

| Postgame           | min     | median  | p90     | max     | Total     |
| ------------------ | ------- | ------- | ------- | ------- | --------- |
| Charged tokens     | 169,444 | 205,434 | 303,458 | 407,947 | 2,347,442 |
| Model calls        | 11      | 13      | 16      | 25      | 143       |
| Output tokens      | 8,012   | 10,884  | 13,264  | 17,458  | 113,593   |
| Tool calls         | 13      | 15      | 20      | 26      | 166       |
| Code executions    | 1       | 4       | 8       | 11      | 48        |
| Sandbox compute, s | 0.0     | 6.4     | 26.9    | 29.7    | 92        |
| Elapsed, min       | 3.8     | 4.6     | 5.3     | 7.4     | 48.0      |
| Cost, USD          | 1.14    | 1.34    | 1.95    | 2.57    | 15.33     |

Per-game charged tokens, pregame then postgame, in thousands: game 1 416 / 213, 2 299 / 184, 3 411 / 198, 4 346 / 234, 5 380 / 248, 6 350 (+218 failed) / 169, 7 292 / 303, 8 464 / 194, 9 378 / 408, 10 343 / 197.

Against pilot-b-3's nine completed pregames (median 287,508, p90 364,298), pregame spend rose by about a quarter: more output (222k against 193k), more cache reads (18.0M against 12.0M), more programs (70 against 50) and more compute (219 s against 142 s). Postgame fell: median 205k against 298k, p90 303k against 347k. Total spend is again about the same as the two earlier pilots. This time the agent moved work from postgame back into pregame research. The run does not show why; workspace writes fell (below) and pregame reads rose.

Commit stage (begin_commit through submit): median 21,273, p90 23,982, max 40,503 (game 6, two submits). One `max_tokens` stop (game 10 pregame), recovered by the harness's larger retry allowance. Uncached input per session stayed under 30 tokens.

## Budget profile v1: the pilot-b-2 proposal against this run

| Limit                          | Proposed v1 | pilot-b-4 p90        | pilot-b-4 max | Holds?                               |
| ------------------------------ | ----------- | -------------------- | ------------- | ------------------------------------ |
| Pregame token cap              | 450,000     | 416,150              | 464,344       | Yes at p90; one session over         |
| Postgame token cap             | 310,000     | 303,458              | 407,947       | Yes at p90, barely; one session over |
| Submission reserve             | 65,000      | 23,982 (3× = 71,946) | 40,503        | No: 3× p90 is above it               |
| Pregame compute cap            | 40 s        | 40.1 s               | 43.8 s        | No                                   |
| Postgame compute cap           | 20 s        | 26.9 s               | 29.7 s        | No                                   |
| Per-call wall clock            | 30 s        | 19.4 s               | 22.4 s        | Yes                                  |
| Stdout cap per call            | 64 KiB      | 45 KB                | 47 KB         | Yes                                  |
| Tool-call ceiling (safeguard)  | 100 / 100   | 23 / 20              | 26 / 26       | Yes                                  |
| Wall-clock ceiling (safeguard) | 60 / 30 min | 12.7 / 5.3           | 13.3 / 7.4    | Yes                                  |

By the brief's rule (90th percentile of observed spend, reserve as a fixed multiple of observed submission cost), rounded up, this sample moves three numbers: submission reserve 75,000, pregame compute 45 s, postgame compute 30 s. The token caps hold at p90. As in pilot-b-2, the p90 of ten sessions is the second-highest value, and in all three pilots one session per run has exceeded a cap (pilot-b-2 pregame 539k, pilot-b-3 postgame 461k, pilot-b-4 pregame 464k and postgame 408k). Step 3, re-running the development games at a smaller and a larger pregame cap, is what tests whether submission validity and deviation behaviour hold near these numbers.

## Game lines (SPO-829)

The opening `context` carried the spread and derived total in all 20 sessions. The implied team totals were null for game 10, one of the six release snapshots whose spread and total contributors do not overlap. Use:

- **Submission notes:** the notes cite the spread or total in 8 of 10 games, every game except 1 and 4 ("BOS +4, total 231", "BOS -10.5 favorites", "BOS -12.5 (big favorite, blowout potential)", "Celtics +3.5 underdogs. Competitive game expected - no blowout adjustments").
- **Workspace:** it added a `Spread` column to its own `team_game_log.md`, and wrote blowout rules into `strategy_notes.md` (starters' minutes cut in a blowout win, bench minutes up, "against weaker teams more likely blowout").
- **Reasoning:** spread, total or blowout language appears in the model's reasoning in all 20 sessions.
- **Not used:** no sandbox program read the `game_lines` table. `query_odds_history` was called once in ten pregames (pilot-b-3: 7), returning four game-line snapshots.

Whether the numbers improved answers can't be read from one run: the two heavy-favourite games (8 and 9, Celtics −10.5 and −12.5) scored +0.054 and +0.016, against +0.045 and +0.029 in pilot-b-3.

## Sandbox

| Measure                  | Pregame | Postgame |
| ------------------------ | ------- | -------- |
| Programs                 | 73      | 48       |
| Compute per session, max | 43.8 s  | 29.7 s   |
| Per call, max            | 22.4 s  | 5.8 s    |
| Stdout per program, max  | 47 KB   | 31 KB    |
| Non-zero exits           | 6       | 3        |
| Truncations              | 0       | 0        |

Pregame programs include 3 from the failed game 6 attempt. Total 121 programs (pilot-b-3: 106).

Schema work, counted the same way for both runs (programs that list tables or print columns; programs that failed on a missing table or column): discovery 38 programs (pilot-b-3: 40), table-or-column errors 8 (pilot-b-3: 18). The errors were spread over games 1, 2, 4, 7, 8 and 9, and still include history-path queries for session tables, for example `player_2024_25_summary` through `nba_data.table` in game 1. The two-surface SQL issue from pilot-b-3 is smaller here but not gone.

## Workspace and evidence

Final workspace: 19 files, about 80 KB (pilot-b-3: 20 files, 44 KB): per-game postgame notes, `schema_and_ids.md`, `strategy_notes.md`, `results_tracker.md`, `team_game_log.md`, `player_season_actuals.md`, two box-score CSVs. Writes 55 (pilot-b-3: 71), reads 39 (41), lists 22 (58). Fewer, larger files; the per-game postgame note replaced repeated rewrites of shared files.

| Measure                                | pilot-b-3 | pilot-b-4 |
| -------------------------------------- | --------- | --------- |
| `list_evidence` calls                  | 2         | 6         |
| `search_evidence` calls                | 29        | 26        |
| Searches with at least one hit         | 27        | 26        |
| `fetch_evidence` calls                 | 8         | 10        |
| Fetched: lineups / posts / transcripts | 5 / 2 / 1 | 2 / 5 / 3 |

Browse use tripled from a low base. The agent read more posts and transcripts and fewer lineup records. Coach transcripts were read three times in ten games, against once in nine in pilot-b-3, the first run since SPO-830 described them. That is too few reads to attribute to the change.

## Answers

| Measure                                | pilot-b-3 | pilot-b-4 |
| -------------------------------------- | --------- | --------- |
| Answers                                | 191       | 212       |
| Median distance from 0.50              | 0.07      | 0.06      |
| p90 distance from 0.50                 | 0.16      | 0.15      |
| Max distance from 0.50                 | 0.32      | 0.30      |
| Below 0.50 / above                     | 130 / 41  | 148 / 56  |
| Below market / above                   | 151 / 39  | 157 / 55  |
| Mean (agent minus market)              | −0.049    | −0.044    |
| Deviations of 0.10 or more from market | 36        | 41        |

The under lean is unchanged. Overs hit 39.2 % across the ten games.

## Score (observation only)

Against `market-dev-2` on all ten games, 212 questions: skill +0.0235 per question, bootstrap 90 % interval [+0.0114, +0.0355], without the five most influential games +0.0248. This is the first pilot whose interval excludes zero, which is still not evidence: development games, one replicate, a harness that has changed after every pilot. By stat: points +0.0278, assists +0.0275, rebounds +0.0156. Below-market answers scored +0.0291 on average, above-market +0.0076. Deviations of 0.10 or more were on the right side 27 of 41 times.

Against pilot-b-3 on the nine games both completed (191 questions): +0.0002, interval [−0.0105, +0.0133]. On those nine games pilot-b-4 scored +0.0216 and pilot-b-3 +0.0215. The higher headline is game 1 (+0.041), which pilot-b-3 lost, not better play. The report flags the harness-version mismatch.

Calibration by answer bin: under 0.35, overs hit 27 % (15 answers, good); 0.35 to 0.40, 47 % (38, bad); 0.40 to 0.45, 17 % (42, very good); 0.45 to 0.50, 38 % (53); 0.55 to 0.60, 55 % (33); 0.60 and above, 67 % (6). The three worst questions are a new shape: confident unders on starters at ordinary lines that the player cleared narrowly. Derrick White assists 5.5 and rebounds 4.5 in game 8 (0.28 each, actual 6 and 5), Jaylen Brown assists 4.5 in game 6 (0.30, actual 6). The game 8 notes explain both White answers with "White under on all stats - consistent pattern", a rule carried from earlier games in its own notes. Those three are the losing tail of a rule that paid on balance. White's 30 answers totalled +1.70 skill, the most of any player: points went under in 9 of 10 games while the line fell from 20.5 to 16.5, and rebounds went under in 8 of 10. Assists went under in six of the first seven games, then over in games 8 to 10 (6, 8, 10). The rule is overconfident extrapolation from seven games that this sample happened to reward: by game 8 it put White at 0.28 against a market of 0.49 on two stats at once.

## How the agent estimates probabilities

The agent's method changed within the run, from a model to hit rates.

- **Game 1.** The pregame wrote a projection model in the sandbox: per player and stat, a projected mean and spread converted to P(over) with a negative binomial (Poisson where not over-dispersed). These are the only 3 of 121 programs in the run that use a distribution. The script was never saved; the final workspace contains no scripts.
- **Rationales.** 120 of the 158 written rationales rest on a hit rate, "N% over the line" or "X of the last Y", usually over a small conditional sample ("only 38% over 5.5 in those games", "35.3% over 1.5 assists in his 17 games with 20+ minutes"). 33 mention minutes, 25 per-minute rates or usage, 4 a distribution. The share grows with game index: 10 of 12 in game 1 (printed beside the model), 9 of 28 in games 2 and 3, 43 of 57 in games 4 to 6, 58 of 61 in games 7 to 10.
- **Workspace.** What persisted is a tout sheet rather than a model: `player_season_actuals.md` lists season average against the typical line with "OVER PLAY" or "UNDER"; `strategy_notes.md` holds hand-set probability ranges ("on 16.5 line, go 0.35-0.40"); `results_tracker.md` keeps a win-loss record per game. Every pregame starts by reading these files.
- **Memory errors.** The tracker names the wrong opponent for games 1 to 6 ("G1 vs TOR" for PHI, "G2 @ WAS" for NYK); games 7 to 10 are right. The agent never noticed.

Asked in a plain chat how it would judge a points prop, the same model describes minutes, usage, pace and an over-dispersed distribution compared with the market, and calls small-sample history mostly noise. So the drift is not a gap in what it knows. Candidate causes in this setup, none yet isolated:

1. What persistent memory kept: rules and records, not the model.
2. Scale: about 21 props in about 14 model calls under a visible budget, where `(pts > line).mean()` over a roster is the cheapest program.
3. The rationale format, a sentence or two per deviation, for which a hit rate is the natural justification.
4. Feedback framed as over, under or push per question (`read_released_results`, odds-history settlements), which the agent turned into win-loss records.

`pilot-a-1`, the stateless arm on the same games, separates the first cause from the others. If stateless sessions keep a game-1 style method throughout while B drifts, memory is the driver. If they also lean on hit rates, the cause is the task and its framing.

## Decisions this informs

1. Step 1 of the budget procedure is complete with pilot-b-4. Proposed budget profile v1, updated: pregame 450,000 and postgame 310,000 tokens (unchanged), submission reserve 75,000 (was 65,000), pregame compute 45 s (was 40), postgame compute 30 s (was 20), other limits unchanged. Step 3 (smaller and larger pregame cap) is next.
2. Proxy retry window: start it at the first failure so that a slow 529 is retried in the proxy rather than by a session restart. Small runner change, no harness-version change.
3. Game lines are used as context in every game, as intended. No change needed.
4. Two-surface SQL in the sandbox remains a minor source of wasted programs (8 errors in 121 programs).
5. The positive score is not evidence of sound reasoning. The method drifted from a model to hit rates; `pilot-a-1` (stateless, same games) tests whether memory caused it, before any change to method guidance, the sandbox or the rationale format.

## Housekeeping

- One reservation (93,555 tokens) from the failed call is charged and unconfirmed; the report shows `spendComplete: false`.
- Checkpoints for this run sit alongside pilot-b-1 to b-3 in `.cache/runs` (SPO-817); the host disk is 93 % full.
