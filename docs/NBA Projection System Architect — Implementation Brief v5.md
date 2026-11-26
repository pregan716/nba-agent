# NBA Projection System Architect — Implementation Brief v5

Nov 14, 2026 · @Patrick Regan · Draft for review (SPO-899)

## Purpose and research question

Find out whether an AI agent can design a projection system that adds value to DFS players and bettors. The system forecasts each player's minutes and production before every game of a replayed 2025–26 season, for one team at a time, and may build knowledge of that team as the season goes on.

The agent that does the designing is the **architect**. It does not forecast games itself. It writes the game loop: the code, the models and the specialist agents that produce each forecast. It submits a configuration, receives the scores of that configuration over about 40 games, studies where it did well and badly, and submits again.

Three questions, in order of difficulty:

1. **Can the architect build a system that beats a plain statistical projection on minutes, on teams it never saw?**
2. **Do the agents in the game loop add to that system?** The same system with its agents switched off is the control.
3. **Does knowledge accumulated from game to game help?** The same system with nothing kept between games is the control.

A good score alone does not establish any of these. Findings must connect score differences to what the system did, and a negative result is valuable when the comparison is sound.

## How to use this brief

Agreed items are requirements. Proposed items are recommended defaults for the first implementation: an implementer builds them as written and may raise a brief change against them before the development run begins. Open items must be resolved by the user and are never inferred.

| Status   | Meaning                                                           |
| -------- | ----------------------------------------------------------------- |
| Agreed   | Explicit user choice, or a decision carried from an earlier brief |
| Proposed | Concrete default offered for review                               |
| Open     | Unresolved choice that must not be inferred                       |

This brief supersedes [the v4 brief](NBA%20Team%20Expert%20Projection%20Agent%20%E2%80%94%20Implementation%20Brief%20v4.md) for the experiment design, the agent's role, memory and budgets. These v4 sections stay in force by reference, each with the status it has there:

- The forecast (format, validation, the interpolation rule)
- Reference projection (form and refit), now produced for all five teams
- Scoring: the primary scores and diagnostics, ceiling games, invalid and missing forecasts. The market test and big-over picks are not carried (see Decisions).
- The paired-bootstrap settings under Comparison between arms

The v3 sections that v4 carried by reference (data contracts and temporal access rules, isolation and reproducibility, the experiment record, contamination) stay in force in the same way.

### What changed from v4

The v4 pilot ran one analyst agent through Celtics games 1–20 in two arms, with and without memory ([games 1–10](v4/pilot.md); the write-up of games 11–20 is pending under SPO-883).

- In games 1–10 both arms placed minutes better than the reference: about 37 misplaced minutes a game against 47. The reference is at its weakest there, with no games yet from the new roster.
- In games 11–20 neither arm beat it: 33.7 (no memory) and 35.7 (full memory) against 34.8. No difference between the arms was distinguishable from zero on any primary score.
- The reference's own big-over picks hit more often than either arm's in both stretches (11 of 30 against 5 to 9 of 30).
- None of the 558 sandbox programs across both stretches fitted a model. Saved code was never reused. Memory was notes.

The agent's only signal was one game of feedback, and one game is mostly noise. It had no way to test a change to its method, redid the whole forecast by judgement every game, and nothing in the task told it that its routine was not working. On Nov 14, 2026 the user moved the agent up a level.

- The agent designs the system instead of being the forecaster.
- Feedback is the score over a large sample of games after each change, not one game.
- The experiment covers five teams, so that a design can be tested on teams the architect never saw.
- The two memory arms, the per-session research budgets and the fixed research prompt are dropped. Whether accumulated knowledge helps is now answered by an ablation of the final system.

## Scope

| Area                 | Value                                                                                                                                                                 | Status                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Goal                 | Test whether an architect agent can build a projection system that adds value to DFS players and bettors                                                              | Agreed (Nov 14, 2026)                           |
| Architect            | The only permanent and mandatory agent role. It decides how the game loop works.                                                                                      | Agreed (Nov 14, 2026)                           |
| Architect model      | `claude-opus-5-5`, exempt from the contamination probe (see Contamination). It replaced `claude-opus-4-6` after four iterations. Jev has no role in the architect.    | Agreed (Nov 17, 2026)                           |
| Game-loop models     | `claude-haiku-4-5-20251001`, `claude-sonnet-4-6`, `claude-opus-4-6` and Jev (`jev-1.14.0`, the version in use), at the architect's choice. Nothing outside this list. | Agreed (Nov 14, 2026)                           |
| Target metric        | Minutes pinball loss relative to the reference projection on the same games                                                                                           | Agreed (Nov 14, 2026)                           |
| Teams                | Boston, Denver, Memphis, Oklahoma City and Washington, 2025–26 regular season; 2024–25 games are historical evidence from the start                                   | Agreed (Nov 14, 2026)                           |
| Development and test | The architect develops on Boston, Oklahoma City and Washington. Denver and Memphis are never shown to it and are the test.                                            | Proposed                                        |
| Leakage review       | A separate model, `claude-opus-4-6` in its own session, reviews every submission for knowledge of the replayed season                                                 | Agreed (Nov 14, 2026); procedure Proposed       |
| Prop lines           | Not used in v5. Nothing sees player prop lines or a score computed from them, and none are collected for the four new teams. The game spread and total stay visible.  | Agreed (Nov 14, 2026)                           |
| Replay timing        | Pregame cutoff at scheduled tip; postgame release at 9 a.m. America/New_York the next morning                                                                         | Agreed, carried                                 |
| Holdout date         | Nothing from Mar 23, 2026 on (the date of the Celtics' 71st game) is read during development, for any team                                                            | Agreed, carried and extended to all teams       |
| Budgets              | Set for a full replay run, not per game                                                                                                                               | Agreed in form (Nov 14, 2026); numbers Proposed |

### Guard against unnecessary process

Carried. Specify the access rules, the output format, the scoring, the budgets and the leakage rule rigorously. Leave the architect free to choose how the game loop works: what is code and what is an agent, which models it fits, what its agents are told and what the system keeps.

## The architect

### What it must do

Status: Agreed (Nov 14, 2026).

- **Submit code that produces a valid forecast for every game in the replay.** The output is the v4 forecast (`forecast-v1`): one per team per game, frozen before the scheduled start.
- **Stay within the budget.** See Budgets.
- **Keep a running list of hypotheses** about what could improve performance, and update it with findings as it learns. Proposed addition: each submission names the hypothesis it tests and the effect it expects, recorded before the results are released.

### What it may do

Status: Agreed (Nov 14, 2026).

- **Use LLM agents in the game loop**, alongside deterministic code, or use code alone. Agents are permitted, not required; what they add is measured by the agent ablation in the final evaluation.
- **Create specialist agents** for tasks in the game loop, and write their prompts, tools and skills.
- **Declare artifacts that persist from game to game** during a replay run. An artifact is team-specific or team-agnostic. A team-specific artifact is visible only to the agents and code working on that team. A team-agnostic artifact is visible to all of them.
- **See the raw data the game loop will have**: play-by-play, box scores, transcripts, beat-reporter posts, injury reports and starting lineups. The limits on this view are under Leakage.
- **Do a test run** on a handful of games to check that its code works and to look at the outputs.
- **Read an archive of every past iteration**: code, prompts, the intermediate outputs of every agent in the loop, the final forecast for each game, and the scores, in aggregate and by game.
- **Train its own predictive models** and use them in the game loop. The limits are under Leakage.

### What it must not do

Status: Agreed (Nov 14, 2026).

- **Put team-specific tips or guidance in the prompts, tools or skills it writes.** They must be generic, so that the system could be used on any team. Team knowledge belongs in the artifacts the system builds for itself during a replay.
- **Use a model version outside the allowed list.**

### How the architect works

Status: Proposed.

- **Iterations.** One architect session per iteration. A session starts with no conversation history and has the archive, the hypothesis list and a notes workspace of its own. It ends by submitting a configuration for a full, repeat or check evaluation, or by nominating a final configuration. A test run does not end it: the result comes back in the same session, so the architect can fix its code and test again (Agreed Nov 16, 2026, after the pilot).
- **Configuration.** A package containing the game-loop entry point, any other code, the agent definitions (model, prompt, tools, skills and an optional thinking level), the artifact declarations, the training scripts for any pretrained model, and the hypothesis statement.
- **Team identity.** The environment tells the game loop which team and game it is working on at run time. Prompts and skills are therefore templates, and nothing in them needs to name a team.
- **One system.** A configuration is a single system for every team and every date. It is not designed for a particular team or stretch of the season.
- **Agent failure.** A configuration must still freeze a valid forecast when an agent call fails or is refused (Agreed Nov 14, 2026). This is also what makes the agent ablation possible.

## The game loop

Status: Proposed where new.

- **Unit.** One team's forecast for one game. A game between two of the experiment's teams is two forecasts.
- **One clock.** A replay run moves through its games in date order across all of its teams. Team-agnostic artifacts written for one game are visible only to later games.
- **Fresh start.** Every replay run begins with empty artifacts. Only the configuration carries from one iteration to the next.
- **Execution.** The architect's code is untrusted. It runs in the sandbox with no network, and reads data only through the interface that filters to the cutoff. Agent calls go through the environment, which enforces the allowed models and meters the spend.
- **Reference projection and feedback.** Tonight's reference forecast, its record on earlier games, and the system's own scores on released games are available in the loop on the v4 terms, with nothing market-relative. Whether and how the loop uses them is the architect's choice.
- **Missing forecast.** A team-game with no valid forecast frozen before the cutoff is scored on the reference projection and flagged (carried).

## Evaluation

### Target

Status: Agreed (Nov 14, 2026). The architect optimizes the v4 Minutes score: mean pinball loss on every roster player's minutes, with the chance of not playing included. It is reported as the ratio of the system's loss to the reference projection's loss on the same team-games, with a paired bootstrap interval over games.

Why minutes: the [headroom check](v4/headroom-check.md) found that the reference's own per-minute rates with actual minutes beat the market, and with projected minutes lose to it. Minutes are also a cleaner signal than fantasy points, which add per-minute noise.

Status: Proposed for the rest of this section.

- **Guardrails.** Fantasy-point pinball loss and the play Brier score are reported beside the target. A configuration that is reliably worse than the reference on either cannot be nominated as final.
- **What the architect sees.** Every v4 score that uses no prop line, in aggregate, by game, by team, by role tier and by player.
- **What it does not optimize.** Ceiling picks are reported but three picks a game cannot separate two configurations over 40 games. Optimizing minutes alone will not reward learning how production shifts when a star sits; the target can move to fantasy-point pinball by a brief change once the system reliably beats the reference on minutes.

### Evaluation games

Status: Proposed. The architect designs one system. The evaluation games are only the sample that system is scored on.

- **Full evaluation.** Every full evaluation replays the three development teams together through the same four weeks in mid-season: Jan 5 to Feb 1, 2026, 43 team-games (Boston 15, Oklahoma City 14, Washington 14; [counts](evidence/brief-v5-team-selection/results.txt)). Using the same games each time makes every comparison between two configurations paired, game by game.
- **Why mid-season.** By January the reference projection knows each roster, so a gain there is harder to earn and more representative than one in the opening weeks, where the reference is at its weakest.
- **Starting state.** The run starts with empty artifacts and with all game data and evidence released before its first game.
- **Check on other games.** The architect may spend a full evaluation scoring the same configuration, unchanged, on one of two other four-week stretches: the opening weeks (Oct 21 to Nov 17, 2025, 41 team-games) or the last weeks before the holdout date (Feb 23 to Mar 22, 2026, 42 team-games). Games played on Mar 22 are included in evaluations although their outcomes were released the next morning, after the holdout instant; the release-time rule governs what is read during development outside the evaluation service (Agreed Nov 15, 2026). This shows whether a gain holds elsewhere in the season. It is not an invitation to build a variant for those weeks.
- **The late stretch is reserved (Agreed Nov 17 and 18, 2026).** Test runs are free, and a test on a late game replays the reference's forecasts for every earlier game, so the architect can score any number of variants on the games a test can reach. The limit of twelve full evaluations does not limit that. Two rules keep the late stretch out of it. A test run accepts only games that tip before Feb 23, 2026. A run on the late stretch, a late check or a repeat of one, returns its headline only: overall scores for the system and the reference, the paired ratios and intervals, the guardrail flag and the number of fallbacks. Its forecasts, per-game scores, agent calls and sandbox output are not shown to the architect, and it cannot be put into a paired comparison. Results on the mid-season and opening games are therefore tuning results; the late check is the independent reading in development.
- **Test run.** At most five team-games, chosen by the architect from the development teams' games before Feb 23, 2026. Scores are returned.
- **Repeat run.** The architect may run a configuration again on the same games to see its run-to-run spread. It counts as a full evaluation.

### Final evaluation

Status: Proposed. The architect nominates one configuration. After that there is no further development.

- **Games.** Denver and Memphis together in one replay, without the development teams, over their whole seasons: 164 team-games. The architect has seen none of them apart from the 14 against development teams, so all of them count, including those after the holdout date.
- **Runs.** Each once (Agreed Nov 14, 2026): the nominated configuration; the same configuration with every agent call refused; and the same configuration with the artifact store emptied before every game. The agent ablation is skipped if the nominee uses no agents.
- **Comparisons.** Each run against the reference projection, and the nominated configuration against each ablation, on the target and the guardrails. Then the ceiling score, computed by the evaluator alone.
- **Celtics holdout.** Games 71–82 become an optional secondary check. Scoring them means replaying Boston's first 70 games to build its artifacts, so it is run only if the user asks. It stays unread until then.

## Second development round

Status: the round and the items marked Agreed were agreed on Nov 20, 2026. Test teams and budgets were agreed on Nov 21, 2026. The target and the restart were agreed on Nov 22, 2026. The rest is Proposed.

Round one nominated a system with no agents, so the final evaluation could not say whether agents add anything. The architect submitted no configuration with an agent in 28 submissions. Round two asks one question: can the architect, pushed to try agents and larger changes, build a system that beats the round-one nominee?

- **A separate run.** Round two has its own pool, its own nominee and its own final evaluation, and is reported apart from round one. Round one's result stands as it is. "No further development after nomination" holds within each round.
- **Starting state (Agreed: starts from the round-one nominee).** The architect is `claude-opus-5-5` again. Its draft is the round-one nominee. Proposed: it also receives round one's notes, hypothesis list and archive of development runs, so it does not repeat what was tried.
- **What it is not told.** Nothing from round one's final evaluation: no score, forecast or record from Denver or Memphis, and neither of the operator's late checks. The prompt may say that the round-one system has been tested and is the system to beat.
- **The bar (Agreed).** The bar is the round-one nominee, not a fixed ratio to the reference. In development, progress is a paired comparison against the round-one nominee's full evaluation on the same 43 team-games. Round two succeeds only if its nominee beats the round-one nominee in the paired comparison of the final evaluation, on minutes, with the 90% interval below 1.
- **The target (Agreed Nov 22, 2026).** The architect is told to aim for a minutes ratio of 0.75 against the round-one nominee, in the paired comparison on the 43 team-games. The target is a goal and not a pass mark: the nomination gate and the bar above are unchanged. If the architect cannot reach it, it keeps trying different kinds of systems while budget remains. When the budget is nearly spent it nominates the best full run that beats the round-one nominee, or the round-one nominee's own run if none does.
- **Why a target was added.** The round first ran without one, on the reasoning that a number chosen in advance may be out of reach and that a target which cannot be met rewards fitting 43 team-games by luck (their interval is about ±0.025). In three iterations the architect built one reading agent, varied its weight and confirmed it on the opening weeks. Against the round-one nominee it measured 0.9905 (0.9807–0.9999) on the 43 team-games, 1.0008 (0.983–1.018) for the variation and 0.9728 (0.9471–0.9998) on the opening window. Each time it had forecast a gain of 1% to 3%. It spent $24.71 of the $1,000 pool. Being asked in words for larger changes did not produce them, so the user set a number.
- **The target is far beyond anything measured.** Round one's whole gain over the reference was 11% on the test teams. No measurement says 0.75 against the round-one nominee can be reached. Its purpose is to make a gain of 1% plainly not enough. The risk named above stands: with a target out of reach, a low ratio on 43 team-games is more likely to be luck. The cap of twelve full evaluations limits that, and the final evaluation tests it.
- **Restart (Agreed Nov 22, 2026).** A pool opens only at the commit it was created on, and the prompt is part of that commit. Round two therefore restarts: a new pool is seeded from the round-one pool at the commit with the new prompt, with full budgets. The new architect receives the round-one handover and nothing from the first three round-two iterations. Those iterations stay in their own pool as a record and are reported in the round-two write-up. Their $24.71 is spent in addition to the new pool's budgets.
- **What the prompt asks for (Agreed).** Structurally different approaches, not refinements of the round-one system. The budget is there to be spent: round one used $14 of the architect's $350 and four of twelve evaluations.
- **Agents (Agreed).** At least one agent system must receive a full evaluation. The architect may still nominate a system without agents if the agent systems lose.
- **What counts as an agent system's evaluation (Proposed).** A completed full evaluation on the 43 mid-season team-games whose run record shows, for at least half of those team-games, an agent call that ended with a successful reply (an `agent_end` event with `reply.ok` true). Declaring an agent is not enough: a declared agent that the code never calls leaves no such event. A refused or failed call does not count, so a run whose calls were all refused or all failed does not qualify. Checks, repeats and test runs do not count. The service refuses a nomination until one qualifying run exists in the round-two pool. The record cannot show whether the code used the reply; the run with agent calls refused in the final evaluation measures that.
- **Everything else carries over** from round one: the target and guardrails, the evaluation games, the reserved late stretch, the leakage rule and the review.
- **Human sample (Proposed).** Round one's selection rule named its own iterations and does not apply. Before the round-two final evaluation a person reads up to five accepted configurations, in this order until five are reached: the nominee; the qualifying agent system with the lowest minutes ratio, if it is not the nominee; the other fully evaluated configurations from lowest minutes ratio upward. If the round produced fewer than five, all of them are read. For a configuration with agents the reading covers every prompt, skill and tool description as well as the code.
- **Final evaluation.** The same three runs. If the nominee uses agents, the run with agent calls refused answers the agent question directly. Added: the paired comparison of the round-two nominee against the round-one nominee on the same team-games. It runs on Denver and Memphis again, the same 164 team-games (Agreed Nov 21, 2026), so that comparison is paired with round one's final record. It is a second look at those games (see Limits).

## Architects on other models

Status: the decision is Agreed (Nov 25, 2026). Its terms are Open, listed under Decisions, except where marked Proposed.

Rounds one and two used one architect model, `claude-opus-5-5`, and a result describes that model only (see Limits). The user decided that the architect may also be run on models from other providers: OpenAI, Google Gemini and an open-source model.

- **What the decision covers.** The architect only. The game-loop model list and the reviewer are unchanged.
- **Rounds one and two are unchanged.** Their architect stays `claude-opus-5-5`, and their pools, nominees and results stand as they are.
- **A pool of its own (Proposed).** Each run on another model has its own pool and is reported apart from every other run. The model is part of the iteration record.
- **The same harness (Proposed).** Another model receives the same prompt, tools, data view and budgets in dollars as the round it runs under. Only the provider connection differs.
- **No run before the Open items are resolved.** The harness may be built first (SPO-939). No iteration runs on another model until the user has named the model version, decided its contamination treatment and set the terms of the run.

## Leakage

The architect studies the results of the development games. The rules below keep those results, and anything else from the replayed season, out of the system it builds.

### The rule

Status: Proposed, widening the Agreed ban on team-specific guidance. No part of a configuration may contain content drawn from the results of the 2025–26 season: players, teams, coaches, dates, opponents, or statements about what happened or tends to happen in that season. This covers prompts, tools, skills, code, constants, data files and model weights.

What stays allowed: general basketball knowledge; the structure of the loop; anything fitted on 2024–25; and design choices made because they scored well in development. The last is the optimization itself. The test on unseen teams is what limits it.

### Trained models

Status: Proposed. A model used for a game may be fitted only on data released before that game's cutoff.

- A model fitted inside the loop is fitted under the cutoff by construction.
- A pretrained model is built by the environment from the architect's training script, with only 2024–25 data mounted (Agreed Nov 14, 2026). A configuration cannot ship weights of its own.

### The architect's view

Status: Proposed.

- It sees the development teams' data before the holdout date, and league-wide data for 2024–25. That includes the spread and total the game loop is given (Agreed Nov 15, 2026).
- It does not see Denver's or Memphis's games, except the 14 they played against the development teams before the holdout date. Removing those would leave gaps in the development teams' seasons.
- It sees nothing from the holdout date on.
- The game loop itself keeps the full league-wide history before each cutoff, as in v4. Denver and Memphis rows can therefore appear in archived intermediate outputs. The reviewer does not police the archive; the risk is accepted and stated under Limits.

### Review

Status: review by a separate model is Agreed (Nov 14, 2026). The procedure is Proposed.

- Every configuration is reviewed before it runs, test runs included.
- First an automated scan for the names and ids of 2025–26 players, teams and coaches, for dates in the season, and for bundled binary files.
- Then the reviewer, `claude-opus-4-6`, reads the prompts, skills, tool descriptions and code against the rule. It runs in its own session with a fixed prompt and sees the configuration only, not the architect's reasoning.
- A rejection returns the reason. It costs nothing from the evaluation pool.
- Every review is recorded. A sample of accepted configurations is read by a person before the final evaluation.

### Contamination

Status: Proposed. Every model on the allowed list, the architect and the reviewer included, passes the carried contamination probe before use, with items added for the four new teams. A version that shows knowledge of the 2025–26 season is not allowed. `claude-opus-4-6` passed for the Celtics on Nov 12, 2026. `claude-haiku-4-5-20251001` and `claude-sonnet-4-6` have not been probed, and Jev's last probe predates this experiment. A version that fails comes off the list and the user is told.

**Exception for the architect (Agreed Nov 17, 2026).** The architect is `claude-opus-5-5`, whose training data runs past the 2025–26 season. It is not probed and would not pass. The user accepted this after a side-by-side run of four iterations each (SPO-908, SPO-925), in which it studied where the reference loses before building and made larger changes than `claude-opus-4-6` did. That run was exploratory. Its results are not evidence and its configurations are not candidates for nomination.

- The exception covers the architect only. The reviewer and every game-loop model must still pass the probe.
- The architect writes a system and never a forecast, so what it remembers can reach a forecast only through the configuration it submits. The leakage rule and the review are the guard: the automated scan for names, ids and dates of the season, and the reviewer's reading of every submission, which rejects content tied to particular players, teams or games.
- The review cannot catch a general fact about the season written as an ordinary setting, such as a league-wide trend expressed as one tuned number. The test teams do not catch it either, because they played in the same season. This is stated under Limits.

## Budgets

Status: budgets at the level of a full replay run are Agreed in form (Nov 14, 2026). The architect's $30 per iteration is Agreed (Nov 14, 2026); the other numbers are Proposed. Dollar figures use the v4 price schedule.

| Limit                                   | Proposed                                    | Basis                                                                               |
| --------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------- |
| Game-loop spend per full evaluation     | $2 per team-game (about $85)                | About what the no-memory arm cost in the v4 pilot                                   |
| Evaluation pool for the development run | $1,000, and at most 12 full evaluations     | Covers full evaluations, repeat runs and test runs; the architect decides the split |
| Test run                                | At most five team-games, from the same pool | Enough to check that the code runs                                                  |
| Architect's own model spend             | $30 per iteration (Agreed), $350 in total   | The total stops rejected submissions from running up spend without limit            |
| Final evaluation                        | $2 per team-game per run                    | About $330 a run; two paid runs and one that costs almost nothing, so about $660    |
| Safeguard per team-game                 | $10 and 45 minutes                          | One game cannot consume the run                                                     |

- **The cap on full evaluations matters as much as the dollars.** Each evaluation on the same games is another chance to fit them by luck.
- **When a run's budget is exhausted**, the remaining team-games are scored on the reference projection and flagged.
- **The architect pilot** runs two iterations before the development run, to check the whole path end to end and to report how the $30 cap behaves.
- **After the pilot** (Agreed Nov 16, 2026). The architect's requests use prompt caching, and the $30 and $350 caps count what is actually charged. The development run starts from an empty pool: no draft, notes, hypotheses or archive carry over from the pilot. The architect and the configuration reviewer use adaptive thinking at high effort; both pilot runs had thinking off, which nobody had chosen. Each agent in a configuration has a thinking level chosen by the architect.
- The total is about $2,000. Fewer full evaluations is the cheapest way to cut it: eight instead of twelve saves about $320.

## Teams

Status: the five teams are Agreed (Nov 14, 2026). The split is Proposed.

The four new teams were chosen from box scores before the holdout date, to differ from each other and from Boston ([script and output](evidence/brief-v5-team-selection/)). The yardstick is rough: each player forecast at his mean minutes over the team's previous five games. It is not the reference projection.

| Team          | Role        | Win rate | Naive misplaced minutes (rank of 30, 1 = most stable) | Starting lineups | Games missed by top five players | Players arriving / leaving mid-season |
| ------------- | ----------- | -------: | ----------------------------------------------------- | ---------------: | -------------------------------: | ------------------------------------- |
| Boston        | Development |     0.67 | 40.1 (3rd)                                            |               17 |                               19 | 2 / 2                                 |
| Oklahoma City | Development |     0.79 | 54.4 (20th)                                           |               29 |                               47 | 3 / 3                                 |
| Washington    | Development |     0.23 | 64.4 (30th)                                           |               42 |                               68 | 2 / 7                                 |
| Denver        | Test        |     0.61 | 46.3 (11th)                                           |               25 |                               44 | 0 / 1                                 |
| Memphis       | Test        |     0.34 | 53.0 (18th)                                           |               37 |                               73 | 9 / 9                                 |

Boston is among the easiest teams in the league to forecast by this measure, so the v4 pilot ran on favourable ground. The test pair is one moderate team with injuries and no roster moves, and one with heavy roster turnover.

## Run record

Carried in form. Added per iteration: the configuration and its hash, the review and its outcome, the hypothesis statement, the games evaluated, every agent call in the loop with its model and spend, the artifacts as they stood after each game, and the scores. The architect's archive is a view of this record. It includes the spread and total the loop was given. Player prop lines, and anything computed from them, are not in it.

## Limits on claims

- **The architect has seen the season.** `claude-opus-5-5` was trained on data that includes 2025–26. The review keeps out content tied to particular players, teams and games. It cannot keep out general knowledge of how the season went, and a design choice that rests on such knowledge would also help on Denver and Memphis. A gain on the test teams therefore does not show that the same architect would do as well on a season it has not seen.
- **One architect, one run.** A result describes one sequence of designs by one model, not architects in general.
- **Two test teams, same season.** Denver and Memphis are unseen, but they play in the season the architect studied, and 14 of their games against development teams are visible to it.
- **The late check is only partly independent.** Each late check returns a score, so a design chosen after several of them is partly chosen on the late stretch. The write-up reports how many late checks came before the nomination. The architect's data view also holds the outcomes of the late games, though not the reference's forecasts for them.
- **Development was stopped after looking at the late stretch.** The architect spent no late check. The operator ran two, on the configurations of iterations 1 and 4, in a copy of the pool, and the user ended development after seeing them. The architect did not see them and no configuration was changed afterwards, but the decision to stop and test this design was made knowing it held on the late stretch.
- **Design choices are fitted to development results.** The leakage rule cannot separate a general design choice from one that happens to suit three teams in 2025–26. Only the test teams can.
- **The archive can show test-team rows** that agents in the loop printed from league history.
- **The target and the teams were chosen after seeing results.** Minutes was chosen after the pilot. The teams were chosen by a person and an assistant from box-score summaries that included Denver and Memphis; the architect sees none of that.
- **Evidence coverage for the new teams is uneven.** Beat reporting and coach transcripts are thinner for some of them than for Boston.
- **No market comparison.** Player prop lines were not collected for the new teams, so v5 says nothing about whether the forecasts would have value against the betting market.
- **Round two is not a first look.** It was decided on after round one's final evaluation, which the user and the assistant have read. Round two is tested on Denver and Memphis again: the architect still has not seen them, but the people who designed the round have, and two systems will have been tested on the same games. Round two also starts from a design already known to work on those teams.
- **Round two pushes the architect.** It is told to try agents and larger changes, is given a target of 0.75 against the round-one nominee, and must evaluate at least one agent system. Its result says what an architect can do when pushed that way, not what it chooses unprompted. Round one is the reading of that.
- **Round two was restarted after looking at development results.** Its first three iterations ran without a target. The user and the assistant read their results, judged the changes too small, added the target to the prompt and restarted the round from the round-one pool. The prompt the nominee was designed under was therefore chosen after seeing how the architect behaved under the earlier one, on the same development games.
- The v4 limits on DFS salaries, the single forecast time and the holdout record carry over.
- Development games are never evidence.

## Decisions

### Agreed on Nov 14, 2026

| Decision                       | Resolution                                                                                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Design                         | An architect agent designs the game loop and receives results over a large sample of games after each change. It is the only permanent and mandatory agent role.                                  |
| Architect's terms              | The must, may and must-not lists under The architect                                                                                                                                              |
| Target metric                  | Minutes pinball loss relative to the reference projection                                                                                                                                         |
| Models                         | The architect is `claude-opus-4-6` to start, with no Jev. The game loop may use `claude-haiku-4-5-20251001`, `claude-sonnet-4-6`, `claude-opus-4-6` and Jev at the version in use (`jev-1.14.0`). |
| Teams                          | Denver, Memphis, Oklahoma City and Washington are added to Boston                                                                                                                                 |
| Leakage review                 | By a separate model: `claude-opus-4-6` in its own session                                                                                                                                         |
| Budget form                    | Calculated for a full replay run, not per game. The architect's own spend is capped at $30 per iteration.                                                                                         |
| Agents in the loop             | Permitted, not required                                                                                                                                                                           |
| Final evaluation runs          | Each configuration runs once                                                                                                                                                                      |
| Pretrained models              | Built by the environment from the architect's training script, on 2024–25 data only                                                                                                               |
| Agent failure                  | A configuration must still produce a valid forecast when its agents are switched off                                                                                                              |
| v4 scored run                  | Withdrawn (SPO-885)                                                                                                                                                                               |
| Market test and big-over picks | Dropped (SPO-912). Game lines are collected for all five teams; player props are not collected for the new teams. The ceiling-game score stays.                                                   |

### Agreed on Nov 17, 2026

| Decision        | Resolution                                                                                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architect model | `claude-opus-5-5` replaces `claude-opus-4-6`. It is exempt from the contamination probe; the leakage rule and the review are the guard. The reviewer stays `claude-opus-4-6`. |

### Agreed on Nov 17 and 18, 2026

| Decision              | Resolution                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reserved late stretch | Test runs accept only games that tip before Feb 23, 2026 (Nov 17). A run on the late stretch returns its headline only and cannot be put into a paired comparison (Nov 18). See Evaluation games. |

### Agreed on Nov 18, 2026

| Decision              | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| End of development    | Development ends after four iterations of the run on `claude-opus-5-5` (SPO-908), with eight of the twelve full evaluations unused. The next iteration may only nominate, and the architect chooses among its three full evaluations. The user decided this, not the architect, after the three later iterations added nothing measurable and after two late checks run by the operator in a copy of the pool. The architect has not seen those checks. See Limits on claims. |
| Human sample          | A person reads five accepted configurations before the final evaluation: the three full evaluations the architect can nominate and one test configuration each from iterations 1 and 4.                                                                                                                                                                                                                                                                                       |
| Celtics holdout check | Not run for now. Games 71–82 stay unread.                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### Agreed on Nov 20, 2026

| Decision            | Resolution                                                                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Second round        | A second development round runs after round one's final evaluation, in its own pool, with its own nominee and final evaluation, reported apart from round one (SPO-931).                                                                                     |
| Starting point      | The architect starts from the round-one nominee.                                                                                                                                                                                                             |
| The bar             | The round-one nominee, by paired comparison with the interval clear of 1. No fixed ratio to the reference is set as a pass mark.                                                                                                                             |
| Prompt              | Asks for structurally different approaches, not refinements, and says the budget is meant to be spent.                                                                                                                                                       |
| Agents in round two | At least one agent system must receive a full evaluation; what qualifies is Proposed under Second development round. The architect may still nominate a system without agents. Round one's "permitted, not required" is unchanged for what may be nominated. |

### Agreed on Nov 21, 2026

| Decision             | Resolution                                                                                                                                                                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Round-two test teams | Denver and Memphis again. No new teams are collected.                                                                                                                                                                                                                 |
| Round-two budgets    | The round-one limits in a new pool: $1,000 and at most twelve full evaluations; $30 per iteration and $350 in total for the architect; $2 per team-game per final run. With agents a full evaluation costs up to about $85 and the final evaluation up to about $660. |

### Agreed on Nov 22, 2026

| Decision          | Resolution                                                                                                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Round-two target  | The architect is told to aim for a minutes ratio of 0.75 against the round-one nominee. It is a goal, not a pass mark; the nomination gate and the bar of Nov 20 are unchanged (SPO-934).                      |
| Round-two restart | Round two restarts in a new pool seeded from the round-one pool, with full budgets and the prompt that states the target. The first three iterations, run without a target, are kept as a record and reported. |

### Open

All three follow from the decision of Nov 25, 2026 to run the architect on other models (see Architects on other models).

| Item           | What must be decided                                                                                                                                                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model versions | The exact model version for OpenAI, for Google Gemini and for the open-source model, and the host that serves the open-source model.                                                                                                                                        |
| Contamination  | Whether each new architect model is probed, or exempted as `claude-opus-5-5` was. The exception of Nov 17 names that model only. A model trained past the 2025–26 season would not pass the probe.                                                                          |
| Terms of a run | Which round's terms a run on another model follows (from nothing, as in round one, or from the round-one nominee, as in round two); its budgets; and whether it ends in a final evaluation on Denver and Memphis, which would be a further look at the same 164 team-games. |

### Proposed

| Item                                                                                                                                                                    | Where                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Boston, Oklahoma City and Washington for development; Denver and Memphis as the unseen test                                                                             | Scope, Teams             |
| Each submission states its hypothesis and expected effect before results                                                                                                | What it must do          |
| One architect session per iteration; the configuration package                                                                                                          | How the architect works  |
| One clock across teams; empty artifacts at the start of every run; sandboxed execution                                                                                  | The game loop            |
| Guardrails on fantasy-point pinball and play Brier                                                                                                                      | Target                   |
| One fixed set of evaluation games in mid-season, with two other stretches available as checks                                                                           | Evaluation games         |
| Final evaluation on the test teams' whole seasons, with two ablations                                                                                                   | Final evaluation         |
| The Celtics holdout as an optional secondary check                                                                                                                      | Final evaluation         |
| The widened leakage rule                                                                                                                                                | Leakage                  |
| The limits on the architect's view                                                                                                                                      | The architect's view     |
| Review procedure: automated scan, reviewer model, human sample                                                                                                          | Review                   |
| The contamination probe for every allowed model                                                                                                                         | Contamination            |
| Every budget number except the architect's $30 per iteration                                                                                                            | Budgets                  |
| Round two: what carries over besides the nominee; what the architect is not told; what counts as an agent system's evaluation and the nomination gate; the human sample | Second development round |

## Implementation projects

Each is one or more Linear issues in `nba-agent-v2`, filed after this brief is accepted. The data adapters, sandbox, reference projection, forecast validation, scoring and evaluators of earlier briefs are inputs, not rebuilt.

| Project               | Outputs                                                                                                                                                       | Acceptance                                                                                                                                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 Five-team data     | The four new teams' evidence under the existing contracts; the reference projection and roster evidence for all five; the architect's filtered data view      | The view contains no Denver or Memphis game beyond the 14 and nothing from the holdout date on (planted-record fixtures); the reference reproduces its Celtics figures                                                                                                                                                             |
| A2 Game-loop runtime  | The configuration package format; sandboxed execution of submitted code; agent calls with the model allowlist; the artifact store; the league clock; metering | Team-specific artifacts are unreadable from another team; a later game's artifact is never visible to an earlier one; a disallowed model is refused; a refused agent call still yields a forecast                                                                                                                                  |
| A3 Evaluation service | Full evaluations on the evaluation games, test runs and repeat runs; scores with intervals; the archive; the pool and run budgets; the two ablation switches  | No player prop line is reachable from the archive; an exhausted budget scores the rest on the reference and flags it; a pretrained model is built with only 2024–25 mounted                                                                                                                                                        |
| A4 Leakage review     | The automated scan and the reviewer's prompt and session                                                                                                      | Planted leaks of each kind are rejected; a clean configuration passes; every review is recorded                                                                                                                                                                                                                                    |
| A5 Architect harness  | The architect's tools, prompt, notes and hypothesis list; the contamination probe for every allowed model                                                     | The prompt names no result of the replayed season; a session cannot reach data outside its view                                                                                                                                                                                                                                    |
| A6 Architect pilot    | Two iterations end to end on the development teams                                                                                                            | Written up as a pilot, not evidence; the architect's spend is reported against the $30 cap                                                                                                                                                                                                                                         |
| A7 Development run    | The architect's iterations within the pool, ending in a nominated configuration                                                                               | Every iteration is in the record; the nominee passed review and the guardrails                                                                                                                                                                                                                                                     |
| A8 Final evaluation   | The test-team runs, the ablations and the write-up                                                                                                            | Report generated from the record alone; no development after nomination                                                                                                                                                                                                                                                            |
| A9 Round-two harness  | A new pool seeded from round one; the round-two prompt; the nomination rule for agents; the final comparison against the round-one nominee                    | The seeded pool holds nothing from round one's final evaluation or the operator's late checks; a nomination is refused until a qualifying agent evaluation exists, and is still refused after a full evaluation of a configuration whose declared agent is never called and after one whose agent calls were all refused or failed |
| A10 Round-two run     | The architect's iterations, ending in a nominated configuration                                                                                               | As A7                                                                                                                                                                                                                                                                                                                              |
| A11 Round-two final   | The test-team runs, the ablations, the comparison with the round-one nominee and the write-up                                                                 | As A8, reported apart from round one                                                                                                                                                                                                                                                                                               |

Build order: A1 and A2 first, in parallel. A3 against A2's interfaces. A4 and A5 after A2. A6 after A1 to A5. A7 after A6. A8 after A7. A9 after A8. A10 after A9. A11 after A10.

The v4 scored run (SPO-885) is withdrawn (Agreed Nov 14, 2026). The pilot extension is written up under SPO-883. Heavy runs belong on the cloud host (SPO-877), not the Mac mini.
