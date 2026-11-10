# NBA Team Expert Projection Agent — Implementation Brief v4

Nov 10, 2026 · @Patrick Regan · Draft for review (SPO-878)

## Purpose and research question

Find out whether an AI agent that builds expertise in a single NBA team adds value to DFS players and bettors. The agent follows the Boston Celtics through a replay of the 2025–26 season. Before every game it projects each player's minutes and production from time-restricted sources. After the game it sees how its projections did and may update what it keeps.

Three questions, in order of difficulty:

1. **Does the agent beat a plain statistical projection?** That is the value to someone who would otherwise use a projection system.
2. **Does accumulated team knowledge help?** The same agent with nothing kept between games is the control.
3. **Does the agent know anything the betting market does not?** The prop market at scheduled tip is the reference.

A good score alone does not establish that the agent learned. Findings must connect score differences to what the agent kept, and a negative result is valuable when the comparison is sound.

## How to use this brief

Agreed items are requirements. Proposed items are recommended defaults for the first implementation: an implementer builds them as written and may raise a brief change against them before scored runs begin. Open items must be resolved by the user before a scored run and are never inferred.

| Status   | Meaning                                                           |
| -------- | ----------------------------------------------------------------- |
| Agreed   | Explicit user choice, or a decision carried from an earlier brief |
| Proposed | Concrete default offered for review                               |
| Open     | Unresolved choice that must not be inferred                       |

This brief supersedes [the v3 brief](NBA%20Coaching%20Policy%20Agent%20%E2%80%94%20Implementation%20Brief%20v3.md) for the task, the scoring, the memory design and the experiment. Until they are restated here, these v3 sections stay in force by reference, read without their decision-window, policy-package, assembler and Jev provisions:

- Data contracts and temporal access rules, including shared contract requirements and game data scope
- Isolation and reproducibility
- Harness contract and Pi as the harness
- Research budget structure
- Experiment record, learning diagnostics and contamination
- The paired-bootstrap settings under Comparison between variants

### What changed from v3

The v3 task asked the agent to write a substitution policy scored stoppage by stoppage. Its last pilot stage ([stage 8](v3/pilot.md), SPO-875) found the agent adding almost nothing to the environment's fitted model, and an inspection of that run showed why: per-stoppage decisions are driven by in-game state a model reads directly, the agent's only yardstick was biased toward the model, and its code could not persist. On Nov 10, 2026 the user returned to the original goal.

- The deliverable changes from a substitution policy to a pregame forecast of every player's minutes and production.
- The substitution windows, the policy package, the assembler sandbox, the starter model, the backtest tool and game simulation are dropped.
- The prop market returns as a reference, with the agent blind to it. The v1 task let the agent see the lines and pick its spots; this one does neither.
- The memory comparison starts with the strongest contrast, nothing kept against everything kept, before splitting memory into kinds.

## Scope

| Area                 | Value                                                                                                                                     | Status                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Goal                 | Test whether a single-team expert agent adds value to DFS players and bettors by projecting minutes and production                        | Agreed (Nov 10, 2026)                      |
| Team and season      | Boston Celtics, 2025–26 regular season; 2024–25 games are historical evidence from the start                                              | Agreed, carried                            |
| Agent task           | Before each game, forecast every Celtics player's chance of playing, minutes and stat lines; after it, review and update permitted memory | Proposed                                   |
| Prop lines           | The agent never sees player prop lines or any score computed from them. The game spread and total stay visible.                           | Agreed (Nov 10, 2026)                      |
| Big-over score       | A secondary score for identifying players likely to greatly exceed their prop lines, because it matters to DFS players                    | Agreed (Nov 10, 2026); definition Proposed |
| Replay timing        | Pregame cutoff at scheduled tip; postgame release at 9 a.m. America/New_York the next morning                                             | Agreed, carried                            |
| Research-agent model | `claude-opus-4-6`, re-verified at pin time                                                                                                | Agreed, carried                            |
| Harness              | Pi through its SDK under the carried harness contract                                                                                     | Agreed, carried                            |
| Jev                  | No role. The decision-model role is retired with the substitution task.                                                                   | Proposed                                   |
| Game split           | Development 1–10, warm-up 11–20, scored 21–70, holdout 71–82                                                                              | Agreed, carried                            |

### Guard against unnecessary process

Carried. Specify the access rules, the forecast format, the scoring and the difference between arms rigorously. Leave the agent free to choose how it researches, what it computes, what models it fits and how it organises what it keeps.

## The task

### The forecast

Status: Proposed. Before the cutoff the agent writes one forecast for the game and freezes it through the environment. For every player on the Celtics roster for that game (the season roster evidence the repository already builds per game), it states:

- `p_play`: the probability he plays at all.
- `p_start`: the probability he starts.
- Ranges, each as the 5th, 10th, 25th, 50th, 75th, 90th and 95th percentiles, **given that he plays**: minutes, points, rebounds, assists and fantasy points.

Fantasy points use DraftKings classic NBA scoring: point 1, made three 0.5, rebound 1.25, assist 1.5, steal 2, block 2, turnover −0.5, double-double 1.5, triple-double 3. Verify against DraftKings' published rules when the scorer is built.

Validation: every roster player present, probabilities in [0, 1], percentiles non-decreasing, minutes at most 58. Percentiles for minutes, points, rebounds and assists are non-negative. Fantasy-point percentiles may be negative, because turnovers score −0.5 (3 of 757 Celtics player-games in games 1–70 finished below zero); they must be at least −10. A failed freeze returns the reason and may be retried before the cutoff. Nothing is repaired.

The environment turns each range into a full distribution by straight-line interpolation between the stated percentiles. Above, it is closed at the 95th percentile plus the gap between the 90th and 95th. Below, minutes, points, rebounds and assists are closed at zero; fantasy points are closed at the 5th percentile minus the gap between the 5th and 10th, the mirror of the upper rule. Every probability the scorer needs comes from that one distribution.

### Reference projection

Status: Proposed. An environment-owned statistical projection in the same format as the agent's forecast, identical for every arm.

- **Form.** At minimum the model of the [headroom check](v4/headroom-check.md): a play model, a minutes model and recent per-minute rates, with ranges from the historical spread of its own errors. The implementation issue may improve it (opponent, pace, rate changes when a teammate is out) before any scored run and documents the result. Its form is part of the harness version.
- **Refit.** Before every pregame, deterministically, from data released before the cutoff. Its forecast for each game is therefore out of sample.
- **Role.** It is the first reference in every report and the yardstick in the agent's feedback.
- **Visibility.** The agent can read tonight's reference forecast and, for every released game, the reference's forecast made before that game and its errors. This lets the agent test an idea against an honest out-of-sample record in seconds. The risk is the one stage 8 showed: an agent handed a strong model may pass it through. The alternative is to hide it and let each arm build its own; then most of the memory effect would be "kept a baseline model", which is not the question.

### Feedback

Status: Proposed. At the next-morning release the agent can read the game's data, its own forecast scored player by player, and the reference projection's scores on the same players. It never receives prop lines, market-relative scores or big-over results against lines, in any phase. The fantasy-points ceiling score, which uses no line, is included.

Every arm reads the previous game's feedback in its next pregame. Older feedback is not readable unless the arm's memory permission let the agent copy from it.

## Scoring

One deterministic implementation in the evaluation layer. Agent feedback uses the same code.

### Primary scores

Status: Proposed. Lower is better for all three. They are reported separately, never combined.

| Score      | Definition                                                                                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Minutes    | Mean pinball loss over the seven percentile levels on each roster player's minutes, where the distribution is zero with probability 1 − `p_play` and the stated range otherwise. Averaged over players, then games. |
| Production | Mean pinball loss on points, rebounds, assists and fantasy points, given that the player played. Reported per stat.                                                                                                 |
| Playing    | Brier score of `p_play` over roster players not listed Out or Doubtful on the last pregame injury report.                                                                                                           |

Pinball loss at level τ for a stated percentile q and result y is τ(y − q) when y ≥ q and (1 − τ)(q − y) otherwise.

Reported beside them: misplaced minutes per game (half the summed absolute error of the median minutes forecast over the roster, the headroom check's measure); the Brier score of `p_start`; coverage of the 10th–90th and 25th–75th ranges; every score by player tier (deep bench, fringe, rotation, core, by the reference projection's expected minutes); cost and wall-clock per game.

### Market test

Status: Proposed. Computed by the evaluator from the frozen forecast and the pinned prop consensus at the scheduled-start snapshot, on props where the player played.

- **Over probability.** The agent's probability of clearing each line, from its distribution, clipped to [0.02, 0.98]. Brier score against the market's and the reference projection's on the same props.
- **Blend.** A logistic regression of the result on the market's and the agent's log-odds, fitted leaving one game out. The reported quantity is the change in log loss from adding the agent to the market alone, with the game bootstrap interval.
- **Averages and intervals.** Every market-test figure is a mean over props. Its interval resamples games and divides the summed loss of the drawn games by their summed prop count, so the interval describes the same quantity as the estimate. A reliably negative change means the agent knows something the market does not.

The market test is a stretch result, not the headline. The headroom check found a plain projection has no edge on the market at all.

### Big overs and ceiling games

Status: included by the user (Agreed Nov 10, 2026). The ceiling-game threshold, the reference projection's own 85th percentile, and its benchmark are Agreed (Nov 10, 2026). The other definitions are Proposed.

Both are pregame events: the player plays and reaches the mark. A player who does not play is a miss, never a removal. The agent's probability of either event is `p_play` times the chance of reaching the mark from its distribution given that he plays.

- **Big over.** A result at least one standard deviation above the prop line, where the standard deviation is the square root of the line times a per-stat constant fixed from 2024–25 (points 2.33, rebounds 1.09, assists 1.08). The candidate pool is every prop with a usable consensus at the scheduled-start snapshot, whether or not the player then plays. On games 1–70 that is 1,562 props, 19.7 % of them big overs.
- **Ceiling game.** A fantasy-points result above the reference projection's 85th percentile (given that he plays) for that player. The candidate pool is every roster player not listed Out or Doubtful on the last pregame injury report. It needs no line, covers players with no props, and may be shown to the agent.
- **Picks.** The three candidates per game with the highest event probability, fixed from the frozen forecast before any result is read. Ties go to the lower player id, then the stat name. A pick on a player who does not play is a void: it is not replaced, it counts as a miss, and the denominator is the picks made. Void counts and the hit rate without voids are reported beside it. A game with fewer than three candidates contributes the candidates it has.
- **Scores.** For each event, the hit rate of the agent's picks and the Brier score of its event probability over the whole pool.
- **Benchmarks, big overs.** The pool's base rate, and the reference projection's picks made the same way.
- **Benchmarks, ceiling games.** The reference gives every candidate the same 15 % chance of passing its own 85th percentile if he plays, so its event probability is 0.15 times its `p_play` and it has no meaningful three likeliest. Its benchmark is defined instead as the expected hit rate of a pick drawn in proportion to those probabilities: the sum over candidates of the reference's `p_play` times the outcome, divided by the sum of its `p_play`, pooled over games. The no-memory arm's picks are the other comparison.
- **Limit.** Three picks over 50 scored games resolve a hit rate to about ±5 points. The headroom check puts a plain projection at 24 % on big overs and perfect minutes foresight at 37 %.

### Invalid and missing forecasts

Status: Proposed.

| Case                                 | Handling                                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| No forecast frozen before the cutoff | Session status `no_forecast`; the game is scored on the reference projection's forecast and flagged |
| Game postponed or cancelled          | Session voided; replayed on the rescheduled date's data                                             |
| Prop with no usable consensus        | Excluded from the market test and the big-over pool, and counted                                    |
| Prop offered, player did not play    | Excluded from the market test and counted; stays in the big-over pool as a miss                     |

Flagged games stay visible in every report and are shown with and without in each comparison.

### Comparison between arms

Carried, Agreed: matched games, the game as the unit of uncertainty, a paired bootstrap over games with the v3 settings (10,000 resamples, seed 8542026, 90 % interval), sensitivity to the five most influential games, replicate spread, and cost and time beside every difference. Learning curves show each primary score by game index against the no-memory arm on the same games.

## Memory

### Arms

Status: Proposed. This replaces v3's three gated categories for the first stage.

| Arm         | What persists between games                                               | Question                                         |
| ----------- | ------------------------------------------------------------------------- | ------------------------------------------------ |
| No memory   | Nothing. Each pregame starts empty, with the previous game's feedback.    | How well can the agent prepare afresh each game? |
| Full memory | `memory/` (notes, free-form) and `code/` (scripts, fitted models, tables) | Does accumulated team knowledge help?            |

- Two replicates of each arm from the start. The pilot's run-to-run noise was as large as the effects it was looking for.
- If full memory beats no memory, split it in a second stage: notes only, code only, and the v3 representation and management variants. If it does not, stop and report that.
- The v3 rule that some memory must stay coach-agnostic, and its boundary audit, do not apply to these two arms. Team-specific knowledge is the point.
- `memory/` keeps the 50,000-token cap and counting method (Agreed, carried). `code/` is capped at 8 MB and its size is reported.
- A gated-off directory does not exist from the agent's point of view, as in v3. Arms share nothing.

### Research budget

Structure Agreed, carried: separate pregame and postgame caps, no rollover, cache reads at their price ratio, sandbox compute budgeted separately, tool-call and wall-clock ceilings as safeguards. Numbers are Open.

The budget must bind. An agent with no memory can re-derive anything from the data if it has unlimited room, so memory can only show an effect when research per game is scarce. No session in the v3 pilot reached a cap. Proposed procedure: run both arms on the development games with generous ceilings; set the pregame cap at the median pregame spend of the no-memory arm; report how often each arm's sessions end on the cap.

## Lifecycle and tools

Status: Proposed where new. One game runs through five phases; the runner requests transitions and the agent cannot advance time.

1. **Initialize.** Validate configuration and data coverage; refit the reference projection; create the session.
2. **Pregame.** Cutoff at scheduled tip. The agent reads feedback and permitted memory, researches, writes the forecast.
3. **Freeze.** `freeze_forecast` validates and locks it. A later write is refused.
4. **Postgame.** Clock to 9 a.m. the next morning. Scores and the game's data are released; the agent may update permitted memory. Nothing is required of it.
5. **Checkpoint.** Record the workspace, the forecast, costs and statuses; advance.

| Capability                                                     | Status                                                                  |
| -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Session context, with game spread and total                    | Carried                                                                 |
| Evidence search and fetch; game history; schedule and injuries | Carried                                                                 |
| Code execution in the research sandbox                         | Carried                                                                 |
| Workspace list, read, write, append, edit, delete              | Carried; permissions follow the arm                                     |
| Reference projection tables                                    | New: tonight's forecast, and prior forecasts with their errors          |
| Validate forecast                                              | New: checks the draft without freezing                                  |
| Freeze forecast                                                | New                                                                     |
| Read feedback                                                  | New content: scores against results and the reference, never the market |

The v3 tools for packages, backtests and Jev validation, and the decision-window tables, are not exposed.

## Run profile and record

Carried in form. The memory axis takes the two arms above; the model-roles axis has the analyst only; data sources are as in v3, with the prop consensus read by the evaluator alone. The record adds the frozen forecast, its validation result and the reference projection's forecast and model hash per game, and drops the package, window and Jev records.

The contamination probe for the analyst model is carried, with one added item on Celtics 2025–26 minutes and roles.

## What the headroom check established

Run before this brief, with no agent ([report](v4/headroom-check.md)).

- A plain projection gives about 35 of the 240 minutes per game to the wrong players. Knowing who starts and plays removes about 8 of them.
- The misses sit with fringe and mid-rotation players, not in games where the lineup changed.
- The plain projection has no edge on the market. The same per-minute rates with the minutes actually played beat it clearly, so minutes are the lever.

## Limits on claims

- One team, one season. A result is about this agent on the Celtics, not about agents and teams in general.
- The market reference covers points, rebounds and assists for the players who have lines, about 22 props a game.
- The pinned sources hold no DFS salaries or ownership, so the DFS test is projection accuracy and ceiling games, not lineup profit.
- There is one forecast time, scheduled tip. Bettors often act earlier; an earlier cutoff is a later extension.
- Main-line bets pay the same for a narrow over as a big one. Whether the book-level quotes hold enough alternate lines to price a big over has not been checked.
- The headroom check read results for games 1–70. It involved no agent, but the big-over definition and the tier split were chosen after seeing them.
- The holdout is not perfectly clean. The first version of the headroom check computed one league-wide minutes-error figure that included holdout-period games and noted that game 79 has no pregame injury report ([record](v4/headroom-check.md#holdout-access-in-the-first-version)). No Celtics player result from games 71–82 was reported or used, and the scripts now drop the period before computing anything.
- Development games are never evidence (carried).

## Decisions

### Agreed on Nov 10, 2026

| Decision       | Resolution                                                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Goal           | Single-team expert agent adding value to DFS players and bettors through minutes and production projections. The substitution-policy task and game simulation are dropped.                              |
| Prop lines     | The agent is blind to player prop lines. Game spread and total stay visible.                                                                                                                            |
| Headroom check | Run before any build. Done.                                                                                                                                                                             |
| Big-over score | Included.                                                                                                                                                                                               |
| Ceiling game   | The threshold is the reference projection's 85th percentile for the player, so the score measures upside the reference misses. The reference's benchmark is a pick drawn in proportion to its `p_play`. |

### Open

| Item           | Resolution path                                                                     |
| -------------- | ----------------------------------------------------------------------------------- |
| Budget numbers | Set by the pilot procedure under Research budget, then recorded as a budget profile |

### Proposed

| Item                                                                                             | Where                         |
| ------------------------------------------------------------------------------------------------ | ----------------------------- |
| Forecast format: `p_play`, `p_start`, seven percentiles for five quantities, given that he plays | The forecast                  |
| DraftKings scoring for fantasy points                                                            | The forecast                  |
| Interpolation rule that turns percentiles into a distribution                                    | The forecast                  |
| Reference projection: form, refit before every game, visible to the agent                        | Reference projection          |
| Feedback contents, and withholding everything market-relative                                    | Feedback                      |
| Primary scores and the reported diagnostics                                                      | Scoring                       |
| Market test: Brier at the line and the leave-one-game-out blend                                  | Market test                   |
| Big-over and ceiling-game definitions, candidate pools, the three-picks rule and void handling   | Big overs and ceiling games   |
| Fantasy-point percentiles may be negative, with a mirrored lower tail                            | The forecast                  |
| `no_forecast` scored on the reference projection                                                 | Invalid and missing forecasts |
| Two arms, two replicates each; second stage only if the first shows an effect                    | Arms                          |
| No coach-agnostic boundary or audit for these arms; `code/` capped at 8 MB                       | Arms                          |
| Budget procedure: pregame cap at the no-memory arm's median spend                                | Research budget               |
| Jev and the substitution machinery retired from the experiment                                   | Scope                         |

## Implementation projects

Each is one or more Linear issues in `nba-agent-v2`. The data adapters, environment, runner, harness, memory permissions and evaluators of earlier briefs are inputs, not rebuilt.

| Project                  | Outputs                                                                                                                                      | Acceptance                                                                                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| V1 Reference projection  | The environment-owned model in forecast format, refit before each game, with its tables for the agent                                        | Reads nothing released at or after the cutoff (planted-future-record fixture); refits to the same hash; reproduces the headroom check's baseline figures or documents why it differs |
| V2 Forecast and scoring  | Forecast validation and freeze; the interpolation rule; primary scores and diagnostics; feedback release                                     | A frozen forecast cannot change; hand-computed pinball and Brier fixtures match; feedback contains nothing market-relative                                                           |
| V3 Arms and tool surface | The two memory arms with `memory/` and `code/`; the new tools; v3 tools removed from the agent's surface                                     | A gated-off directory is unlistable, unreadable, unwritable and unmounted; the no-memory arm retains nothing but the last feedback                                                   |
| V4 Evaluators            | Market test, big-over and ceiling scores, tier splits, bootstrap comparisons, report                                                         | The blend is fitted leaving one game out; the report refuses mismatched comparisons; no market quantity is reachable from an agent session                                           |
| V5 Prompts and pilot     | Research prompts for the new task; the added probe item; both arms on the development games; budget profile proposed                         | The pilot is written up as a pilot, not evidence; the budget numbers are put to the user                                                                                             |
| V6 Scored run            | Both arms, two replicates, on the warm-up and scored games with the reference projection and the market test; the write-up; then the holdout | Report generated from the record alone; the holdout untouched until the write-up is accepted                                                                                         |
| V7 Cleanup               | Remove or archive the window, package, starter-model and Jev code and documents                                                              | Nothing the scored run depends on is removed                                                                                                                                         |

Build order: V1 and V2 first, in parallel. V3 and V4 against V2's interfaces. V5 after V1 to V3. V6 after V5 and the Open decision. V7 any time after V3.

Heavy runs belong on the cloud host (SPO-877), not the Mac mini.
