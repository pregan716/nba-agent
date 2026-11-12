# V5 pilot: both arms on the development games (SPO-883)

This is a pilot, not evidence. Development games are never evidence. The pilot exists to check that the pipeline works end to end, to see how the analyst behaves, and to measure what a session spends so that the budget numbers can be proposed.

Run on Nov 12, 2026 (UTC) on the EC2 host (c8g.4xlarge, us-east-1) at commit `ebf8b52`. Both arms, one replicate each, Celtics games 1–10, analyst `claude-opus-4-6`, generous ceilings (3,000,000 charged tokens pregame, 1,500,000 postgame). Evidence is in [`docs/evidence/v5-pilot/`](../evidence/v5-pilot/). The full run records (240 MB) are not in the repository; they are on the host's retained volume under `.cache/runs/v5-pilot-*/r1` and on the workstation under `.cache/v5-pilot/`.

## What happened

|                          |  No memory |             Full memory |
| ------------------------ | ---------: | ----------------------: |
| Sessions                 | 10 pregame | 10 pregame, 10 postgame |
| Forecasts frozen         |   10 of 10 |                 9 of 10 |
| Model spend              |     $20.61 |                  $39.68 |
| Session time, total      |      2.0 h |                   3.5 h |
| Model calls              |        220 |                     568 |
| Sandbox programs         |        127 |                     194 |
| Sessions ending on a cap |          0 |                       0 |
| Infrastructure failures  |          0 |                       0 |

Dollar figures use the configured schedule ($5 input, $25 output, $0.50 cache read, $6.25 cache write per million tokens). It matches the published prices for the model, but the configuration still labels it a placeholder; it should get a real id with the budget profile.

No session came near a ceiling. The largest pregame session charged 415,865 tokens against 3,000,000.

## Defect found: one long response ends the session

The full-memory arm froze no forecast for game 7 (`0022500146`). It had finished its research and was composing the forecast when a single model response reached the 16,000-token output limit while still reasoning. The harness treated that stop as the end of the session. Nothing was validated or frozen, and the game was scored on the reference projection.

The same stop happened twice more in that arm (games 3 and 6, pregame). In those the session continued, because the harness had more to do. Three of 568 responses reached the limit; none of the no-memory arm's 220 did (its longest was 8,846 tokens).

This must be fixed before the scored run: a response cut off by the output limit should be continued, not treated as the analyst finishing. It is filed as SPO-888. Until it is fixed, a missing forecast in a scored game would be a harness artefact counted against the arm.

## Scores against the reference

Lower is better for pinball and Brier. Intervals are 90%, from resampling the ten games. With ten development games these describe the pilot and nothing more. [Full report](../evidence/v5-pilot/report.md).

| Score                                            | Reference | No memory | Full memory |
| ------------------------------------------------ | --------: | --------: | ----------: |
| Minutes pinball                                  |     1.556 |     1.271 |       1.209 |
| Misplaced minutes per game                       |      47.3 |      36.8 |        37.1 |
| Points pinball                                   |     1.393 |     1.312 |       1.265 |
| Rebounds pinball                                 |     0.578 |     0.562 |       0.587 |
| Assists pinball                                  |     0.326 |     0.293 |       0.309 |
| Fantasy-point pinball                            |     2.219 |     2.101 |       2.044 |
| Play Brier                                       |     0.130 |     0.139 |       0.136 |
| Prop Brier at the line (consensus 0.246)         |     0.267 |     0.243 |       0.252 |
| Big-over picks hit                               |  11 of 30 |   9 of 30 |     8 of 30 |
| Ceiling picks hit (reference weighted rate 9.0%) |         — |   5 of 30 |     3 of 30 |

- Both arms placed minutes better than the reference: about 37 misplaced minutes per game against 47. The reference is at its weakest here, since it starts the season with no games from the new roster. Its 70-game average is 33.
- Neither arm improved on the reference's probability of playing.
- Neither arm added to the market: the held-out blend change straddles zero for both (full memory −0.002 to +0.015, no memory −0.008 to +0.009).
- The reference's own big-over picks hit more often than either arm's.
- Full memory against no memory shows no clear difference on any primary score. The full-memory figures include game 7, where it is scored as the reference.

Game 7 was a back-to-back blowout loss in which the starters played 19 to 26 minutes. It accounts for a large share of the no-memory arm's minutes loss: its minutes pinball is 1.271 with that game and 1.090 without.

## How the analyst worked

Checked against the stage 8 findings.

- **No model was fitted, again.** None of the 321 sandbox programs across both arms fitted a model of any kind. The programs compute averages, per-minute rates and splits (back-to-backs, blowouts), and the forecast is assembled by judgement from those.
- **Saved code was not reused.** The full-memory arm wrote one file to `/workspace/code` after game 2 (`forecast_helpers.py`, 3,113 bytes: a table of player names, role lists and two games of minutes). It was never imported or updated afterwards, and later sessions rewrote their analysis each game. Its contents were stale by game 4.
- **Notes were used heavily.** The full-memory arm kept six note files (about 7,100 tokens of the 50,000 allowed): a rotation model with a minutes table by game, coaching notes, injury status, a forecast log, team context and upcoming games. It read them at the start of every session and rewrote them in every postgame (84 writes). [Final workspace](../evidence/v5-pilot/full-memory-workspace/).
- **Code use did not fall off.** Pregame programs per session ran 7 to 17 for no memory and 5 to 20 for full memory, with no downward trend. In stage 8 it fell from 15 to between 1 and 5.
- **Each forecast was validated once and frozen once.** Neither arm used validation to iterate.
- **The reference record was consulted little.** No memory called `reference_projection` 21 times in ten games; full memory 11 times.
- **One wasted call per session.** In 15 of the full-memory arm's 20 sessions, one `workspace_read` failed with "Workspace entry unavailable"; in four more it asked for a `memory/notes.md` that does not exist. Worth a look, but it costs little.

So memory in this pilot was notes, not tools. The arm that could keep code kept a lookup table.

## Spend per session

Charged tokens are what the caps count: input, output and cache writes in full, cache reads at one tenth. [Per-session table](../evidence/v5-pilot/sessions.json).

|                                            | Sessions |     Min |  Median |     Max |
| ------------------------------------------ | -------: | ------: | ------: | ------: |
| No memory, pregame tokens                  |       10 | 172,137 | 259,975 | 380,060 |
| Full memory, pregame tokens                |       10 | 151,764 | 291,533 | 415,865 |
| Full memory, postgame tokens               |       10 | 190,032 | 224,139 | 329,701 |
| Pregame time (s), both arms                |       20 |     471 |       — |   1,182 |
| Postgame time (s)                          |       10 |     370 |     505 |     603 |
| Sandbox compute per session (s), both arms |       30 |       0 |       — |      71 |
| Tool calls per session, both arms          |       30 |      18 |       — |      42 |

Median spend was $2.12 for a no-memory pregame session, $2.40 for a full-memory pregame session and $1.55 for a postgame session.

## Proposed budget profile

These numbers are Open in the brief and are the user's to decide. The proposal follows the brief's procedure.

| Limit              |                        Proposed | Basis                                                                                      |
| ------------------ | ------------------------------: | ------------------------------------------------------------------------------------------ |
| Pregame tokens     |                         260,000 | Median pregame spend of the no-memory arm (259,975)                                        |
| Postgame tokens    |                         225,000 | The same rule applied to the postgame sessions (median 224,139)                            |
| Low-budget warning |                50,000 remaining | Room for one validation and one freeze; the pilot value (400,000) exceeds the proposed cap |
| Sandbox compute    |               300 s per session | Largest observed 71 s                                                                      |
| Tool calls         |                  80 per session | Largest observed 42                                                                        |
| Wall clock         | 45 min pregame, 30 min postgame | Largest observed 20 min and 10 min                                                         |

How often the pilot's sessions would have ended on these caps:

- Pregame, no memory: 5 of 10.
- Pregame, full memory: 7 of 10.
- Postgame, full memory: 5 of 10.

The pregame cap binds, which is what the brief asks for. Two consequences to weigh:

1. **A session that reaches the cap without freezing has no forecast.** The pilot sessions did not know about this cap, so the counts above overstate how often that would happen; the analyst sees its remaining budget and is told to leave room. But how it behaves under a binding cap has not been observed. A short check at the proposed caps (both arms, three development games, about $15) would show it before the scored run.
2. **The postgame cap is a judgement.** The brief gives no rule for it. Using the median makes memory-keeping scarce too. A looser alternative is 330,000 (the largest observed), which would bind rarely.

## Checks run on the host before the pilot

- **Acceptance.** Type check, formatting, 210 tests, 15 sandbox tests and 12 forecast and reference tests passed at `ebf8b52`.
- **Reference audit (closes the outstanding part of SPO-886).** The 70-game audit reproduced the earlier figures: 33.14 misplaced minutes per game by expected minutes and 31.22 by the mixture median. The tail counts, never before computed on the real receipts, are in the table below. [Audit output](../evidence/v5-pilot/reference-audit.json).
- **Contamination probe.** The model reports a training cutoff of about April 2025 and marks every 2025-26 item unknown, including the added item on Celtics minutes and roles. [Probe record](../evidence/v5-pilot/contamination-probe.json).

Reference projection, players who played. Nominal rates are 10%, 10% and 15%.

| Quantity       | Games |   n | Below 10th | Above 90th | Above 85th |
| -------------- | ----- | --: | ---------: | ---------: | ---------: |
| Minutes        | 1–70  | 757 |      12.8% |       9.2% |      13.6% |
| Points         | 1–70  | 757 |      11.8% |       9.2% |      13.1% |
| Rebounds       | 1–70  | 757 |      15.1% |      12.5% |      15.5% |
| Assists        | 1–70  | 757 |       8.3% |       5.9% |       9.5% |
| Fantasy points | 1–70  | 757 |      11.8% |      10.0% |      14.7% |
| Fantasy points | 21–70 | 533 |      11.3% |       9.8% |      14.1% |

The fantasy-point 85th percentile, which defines a ceiling game, is exceeded 14.1% of the time in the scored games: close to its nominal 15%. Assists ranges are too wide and rebounds ranges too narrow at both ends.

## What the scored run would cost

At the pilot's spend per game ($2.06 no memory, $3.97 full memory), games 11–70 with two replicates of each arm come to about $725 in model spend, and somewhat less under the proposed caps. The holdout games 71–82 would add about $145. The host's hourly charge is small beside that; the pilot kept it running for about four hours.

## Before the scored run

1. Fix the output-limit defect (SPO-888).
2. The user decides the budget numbers.
3. Optionally, the three-game check at the chosen caps.
4. Give the price schedule a real id and record the budget profile.
