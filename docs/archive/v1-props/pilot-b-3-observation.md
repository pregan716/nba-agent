# Pilot B-3: development games on the post-SPO-819/820 harness (Oct 26, 2026)

Pilot observation, not evidence. Configuration B (persistent, editable, voluntary) on the ten development games, effort `high`, code execution on, prompt caching on, cache reads at weight 0.1, generous ceilings (`pilot-generous-v1-not-approved`). Harness version `9d11b1d2…`, the first run after SPO-819 (evidence browse and ranked search), SPO-820 (working-aids memory instruction), SPO-821 to SPO-824. Compared throughout with [pilot-b-2](pilot-b-2-observation.md), the same configuration on the previous harness.

## Outcome

- 19 of 20 phases completed. Game 1 pregame ended `infrastructure_failure` after a transient upstream model error on its 15th call (recorded as a 502 by the proxy; the upstream status is not recorded). No retry exists at the proxy or runner level, so game 1 has no submission. Filed as SPO-827.
- 9 submissions, all valid on the first attempt, 191 questions. No budget limit reached.
- 2.2 h elapsed, $39.25 at the verified prices (pilot-b-2: $39.18 for 10 games).
- Because a development game is missing, this run is **not** a step-1 sample for the budget procedure. pilot-b-4 after SPO-827 is.

## Spend per session (charged tokens, cache reads at 0.1)

| Phase    | Sessions                   | min     | median  | p90     | max     | Total     |
| -------- | -------------------------- | ------- | ------- | ------- | ------- | --------- |
| Pregame  | 10 (one failed at 213,806) | 213,806 | 271,154 | 356,671 | 364,298 | 2,857,031 |
| Postgame | 10                         | 182,835 | 297,562 | 347,078 | 461,162 | 3,014,313 |

Per-game pregame charged tokens, pilot-b-2 then pilot-b-3: game 1 539k / 214k (failed), 2 308k / 364k, 3 320k / 271k, 4 348k / 353k, 5 410k / 288k, 6 288k / 357k, 7 444k / 256k, 8 352k / 234k, 9 353k / 288k, 10 359k / 232k. Pregame p90 fell from 444k to 357k; postgame p90 rose from 309k to 347k, with one postgame at 461k. Total tokens and dollars are the same as pilot-b-2: the agent moved spend from research into writing its workspace.

Model calls: pregame median 14, max 17 (pilot-b-2 max 22); postgame median 17, max 24. Uncached input per session stayed under 30 tokens; every call after the first was a cache hit.

## Sandbox

| Measure                  | Pregame | Postgame |
| ------------------------ | ------- | -------- |
| Programs                 | 62      | 44       |
| Compute per session, max | 28.0 s  | 28.8 s   |
| Per call, max            | 8.2 s   | 8.2 s    |
| Stdout per program, max  | 31 KB   | 25 KB    |
| Truncations              | 0       | 0        |

Total 106 programs (pilot-b-2: 111). Compute and output stayed inside the budget v1 proposal from pilot-b-2 (40 s / 20 s, 30 s per call, 64 KiB).

## Effect of SPO-820 (working aids in the workspace)

The game 1 postgame wrote `notes/schema.md`, `scripts/pregame_analysis.py`, roster, injury, strategy, lineup and tracker notes. Every later pregame began by listing and reading them. The final workspace is 20 files, 44 KB (pilot-b-2: 3 files, 21 KB). Workspace writes rose from 30 to 71 and lists from 19 to 58.

Schema rediscovery did not fall as hoped. Programs that list tables or print columns, by game, pilot-b-2 then pilot-b-3: 7/12, 2/7, 1/9, 5/4, 3/2, 1/2, 4/1, 2/0, 2/3, 2/0. Table-or-column errors: 5/6, 1/3, 1/5, 3/2, 1/1, 0/1, 3/1, 0/0, 0/1, 0/0. Games 1 to 3 spent more on discovery than before, building the sheet; games 7 to 10 spent almost nothing. The schema sheet is accurate. The persistent errors come from the sandbox having two SQL surfaces, the history shards behind `nba_data.query` and `nba_data.table`, and the session database behind `nba_data.session`, with different tables in each; the agent repeatedly queried session tables (`player_profiles`, `player_reference`, `player_season_stats`) through the history path. Its own sheet documents the split, and it still mixed them up in games 1, 2, 3 and 6. One surface, or a query helper that routes by table name, would remove this class of error; candidate environment follow-up, not filed.

## Effect of SPO-819 (evidence browse and ranked search)

| Measure                                | pilot-b-2 | pilot-b-3 |
| -------------------------------------- | --------- | --------- |
| `list_evidence` calls                  | n/a       | 2         |
| `search_evidence` calls                | 52        | 29        |
| Searches with at least one hit         | 14        | 27        |
| `fetch_evidence` calls                 | 5         | 8         |
| Fetched: lineups / posts / transcripts | 0 / 2 / 3 | 5 / 2 / 1 |

Ranked search works: 27 of 29 searches returned hits, and the first snippet was usually the record wanted (for example, the post that Brown was questionable but practised fully). The agent read fewer full records than its searches found because the snippets answered the question. Lineup records are now findable and were the records it chose to read. The browse tool was almost unused: two calls in nine games, both late, one with an explicit window and one for lineups only. The agent still does not skim what is new; it searches for what it already suspects. Coach transcripts were read once.

For SPO-825 (semantic search): no case for it yet. The misses that remain are not retrieval misses; the agent is not asking.

## Answers

| Measure                                | pilot-b-2 | pilot-b-3 |
| -------------------------------------- | --------- | --------- |
| Answers                                | 212       | 191       |
| Median distance from 0.50              | 0.06      | 0.07      |
| p90 distance from 0.50                 | 0.13      | 0.16      |
| Max distance from 0.50                 | 0.22      | 0.32      |
| Below 0.50 / above                     | 145 / 49  | 130 / 41  |
| Below market / above                   | 155 / 56  | 151 / 39  |
| Mean (agent minus market)              | −0.038    | −0.049    |
| Deviations of 0.10 or more from market | 15        | 36        |

The under lean persists and is a little stronger, and the agent is now more willing to deviate hard: 36 answers were 0.10 or more from the market, against 15 before, with a maximum gap of 0.38. Overs hit 39.8 % of the time on the nine games, as in pilot-b-2.

## Score (observation only)

Against `market-dev-2` on the 9 matched games, 191 questions: skill +0.0215 per question (pilot-b-2: +0.0137), bootstrap 90 % interval [−0.0007, +0.0379], without the five most influential games +0.0225. By stat: points +0.0273, assists +0.0239, rebounds +0.0134. Below-market answers scored +0.0298 on average; above-market −0.0105. Deviations of 0.10 or more were on the right side 24 of 36 times. Calibration by answer bin: answers under 0.35 had overs hit 41 % (good), 0.40 to 0.45 had overs hit 19 % (very good), 0.60 and above had overs hit 29 % (bad, 7 answers). The three worst questions are the same shape as in pilot-b-2: a low line (3.5 points, 3.5 rebounds, 0.5 assists) where the agent went to 0.30 to 0.40 and the player blew past it.

The harness differs from pilot-b-2's, so the two scores are two observations of the same ten games under different harnesses, not a replicate pair; the report flags the mismatch.

## Decisions this informs

1. pilot-b-4 is the step-1 budget run, after SPO-827, on the current harness. The pilot-b-2 budget v1 proposal still looks right: all pilot-b-3 sessions fit under it except one postgame (461k charged versus a 310k postgame cap). Postgame is the phase to watch in pilot-b-4; if its p90 moves, the proposal moves with it.
2. SPO-825 stays unfiled-for-work; browse usage, not retrieval quality, is the limit. If browse matters, it is a prompt question (SPO-820-style) rather than an environment one, and should wait until the stateless arm has run so both arms get the same wording.
3. Two-surface SQL in the sandbox is the remaining source of wasted programs.

## Housekeeping

- Checkpoints for this run take 1.5 GB (SPO-817).
- One reservation (28,020 tokens) from the failed call is charged and unconfirmed, as documented for transport errors; the report shows `spendComplete: false`.
