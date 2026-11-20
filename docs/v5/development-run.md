# v5 development run (SPO-908)

Run on Nov 18 and 20, 2026 (UTC) on the cloud host, in an empty pool, with `claude-opus-5-5` as the architect. Four development iterations ran, then a fifth that was allowed only to nominate. The architect nominated the configuration of its second iteration, run `fbfb2fbe-ba5e-44f7-8cf9-a241bd6a31fb`.

Everything below is a development result. None of it is evidence for the brief's questions; the final evaluation on Denver and Memphis is.

- **The nominee is code only.** It uses no LLM agents, no pretrained model and no artifacts. It adjusts the reference projection with the posted starting lineup and the inactive list, blends in a minutes model it fits inside the game loop on the previous season, and recalibrates the ranges from each team's earlier games.
- **Mid-season it is 2.8% better than the reference on minutes** (ratio 0.9722, 90% interval 0.9489 to 0.9957, 43 team-games).
- **In the opening weeks it is 11% better** (0.8855, 0.8541 to 0.9163, 41 team-games). The architect tuned on those games, so this is a tuning result.
- **The whole gain arrived in iteration 1.** Iterations 2 and 4 changed the mid-season ratio by less than 0.2 points.
- **Development was ended by the user, not the architect,** with eight of twelve full evaluations unused (brief, Decisions, Nov 18, 2026).
- **Total model spend was $17.04** in the pool, plus $0.21 for two operator checks outside it.

Records are in [`docs/evidence/v5-development-run/`](../evidence/v5-development-run/). The figures in this document are generated from the pool's records into [`run.json`](../evidence/v5-development-run/run.json) and [`operator-late-checks.json`](../evidence/v5-development-run/operator-late-checks.json).

## What ran

The host was at commit `295692f` throughout. Before the first iteration the acceptance script passed there and an operator check in a scratch pool confirmed the path. The pool is `.cache/spo908-opus55` on the host. An earlier pool on `claude-opus-4-6` was set aside when the architect model changed (brief, Decisions, Nov 17, 2026); it is not part of this run.

| Iteration | Restriction   | Model requests | Architect spend | Test runs | Ended with                             |
| --------- | ------------- | -------------- | --------------- | --------- | -------------------------------------- |
| 1         | none          | 47             | $2.74           | 8         | Full evaluation `9d3e391b`             |
| 2         | none          | 60             | $3.63           | 6         | Full evaluation `fbfb2fbe`             |
| 3         | none          | 41             | $2.30           | 2         | Opening check `21f83a3f` of `fbfb2fbe` |
| 4         | none          | 58             | $5.21           | 7         | Full evaluation `4abbd0ba`             |
| 5         | nominate only | 7              | $0.31           | 0         | Nomination of `fbfb2fbe`               |

- **Spend.** Architect $14.20, reviewer $2.84 across 28 reviews, evaluations $0. No evaluation made a model call, because no configuration used agents.
- **Evaluations.** Four of the twelve counted evaluations were used: three full and one check. There were 23 test runs.
- **Reviews.** All 28 were accepted by the automated scan and by the reviewer. There were 26 distinct configurations.
- **Watcher.** Every iteration ran under the watcher with a spend ceiling and a stop on the first missing forecast. It never stopped a run. No evaluation had a missing forecast or a fallback to the reference.
- **Rules added before this run.** Test runs accept only games before Feb 23, 2026, and a run on the late stretch returns its headline only. Every test used games before Feb 23 and no request was refused.

## Scores

Ratios of the system's loss to the reference's on the same team-games, with 90% paired bootstrap intervals over games. Below 1 is better than the reference.

| Run        | Iteration | Games                        | Minutes                   | Fantasy points            | Play Brier                | Flag |
| ---------- | --------- | ---------------------------- | ------------------------- | ------------------------- | ------------------------- | ---- |
| `9d3e391b` | 1         | Mid-season, 43 team-games    | 0.9739 (0.9516 to 0.9960) | 0.9946 (0.9865 to 1.0027) | 0.9810 (0.9683 to 0.9912) | no   |
| `fbfb2fbe` | 2         | Mid-season, 43 team-games    | 0.9722 (0.9489 to 0.9957) | 0.9914 (0.9822 to 1.0011) | 0.9810 (0.9683 to 0.9912) | no   |
| `21f83a3f` | 3         | Opening weeks, 41 team-games | 0.8855 (0.8541 to 0.9163) | 0.9593 (0.9449 to 0.9739) | 0.9400 (0.9121 to 0.9650) | no   |
| `4abbd0ba` | 4         | Mid-season, 43 team-games    | 0.9721 (0.9486 to 0.9960) | 0.9914 (0.9825 to 1.0004) | 0.9810 (0.9683 to 0.9912) | no   |

- **Nominee.** `fbfb2fbe`, the second row, with its opening check in the third. One opening team-game (Washington) is excluded from scoring for data quality.
- **Iteration 4 against iteration 2,** paired on the mid-season games: minutes 0.9999 (0.9941 to 1.0062). The two are indistinguishable.
- **The architect's expectations ran ahead of its results.** Before each full evaluation it predicted a ratio half a point to a point better than it got (for example 0.962 to 0.968 before `fbfb2fbe`). Its predictions came from a backtest inside the game sandbox over each team's earlier games, which include the opening weeks where the gain is largest.

### Why mid-season differs

Minutes pinball loss by window, from the same records. The opening row is `21f83a3f`; the mid-season row is `4abbd0ba`.

| Window     | Reference loss | System loss | Ratio | Boston | Oklahoma City | Washington | Team-games improved |
| ---------- | -------------- | ----------- | ----- | ------ | ------------- | ---------- | ------------------- |
| Opening    | 1.281          | 1.135       | 0.885 | 0.887  | 0.925         | 0.845      | 32 of 40            |
| Mid-season | 0.959          | 0.932       | 0.972 | 0.943  | 1.021         | 0.960      | 24 of 43            |

The reference's own loss is a quarter lower mid-season than in the opening weeks, so there is less to gain. This is what the brief expected when it chose the mid-season games. The mid-season gain is also thin: five team-games carry 86% of it, and Oklahoma City is slightly worse than the reference.

The cause has not been tested. The architect's own reading, in its notes, is that the reference is weakest early and that the posted lineup and the inactive list are worth most then.

## The hypothesis list as it developed

From the ledger, in the order the architect opened them.

| Hypothesis        | Iteration | What it tried                                                                                                                      | Outcome                                                                                                 |
| ----------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `lineup-starters` | 1         | Posted lineup, inactive flags, minutes shifted for role changes, freed minutes redistributed, quantile offsets learned per team    | Full evaluation `9d3e391b`. Kept; the base of every later configuration.                                |
| `gbm-minutes`     | 2         | A league-wide quantile gradient-boosting model fitted in the loop on the previous season, blended in with a weight chosen per team | Full evaluation `fbfb2fbe`. No visible gain over iteration 1 (paired 0.998, 0.986 to 1.011). Nominated. |
| `pred-lineup`     | 2         | Assume the previous game's starters when no lineup is posted                                                                       | Rejected after a test: clearly worse in its backtest.                                                   |
| `absence-return`  | 3         | Scale down the minutes of players returning from an absence, from a table fitted on the previous season                            | About 0.2% in its backtest. Included in `4abbd0ba`; no gain there.                                      |
| `spread-bench`    | 3         | More deep-bench minutes when a lopsided game is expected                                                                           | Rejected after a test: slightly worse on all three teams.                                               |
| `injury-listed`   | 4         | Lower minutes for starters listed on the injury report who play                                                                    | Neutral in its backtest; switched off.                                                                  |
| `team-total`      | 4         | Pull each team's expected minutes to the usual game total                                                                          | Full evaluation `4abbd0ba`. No measurable gain; not adopted for the nomination.                         |

The architect studied where the reference loses before it built anything, and it used test runs mainly to carry a backtest into the game sandbox, where the reference's earlier forecasts for each team are available. It did not try an LLM agent. Its notes list one as an idea (reading team posts for lineups the lineup table misses) and judge it "costly; value unclear".

## What the nominated system does

Configuration hash `72c7e39f9094b874ec686477b0dc686bd5238a89771692ce29dd73816a0b13c6`. Three Python files, about 950 lines, in [`nominee/`](../evidence/v5-development-run/nominee/). It declares no agents, no training scripts and no artifacts.

For each team-game it starts from the reference projection and:

1. **Removes inactive players.** A player on the official inactive list at forecast time gets no chance of playing.
2. **Applies the posted starting lineup.** When a lineup has been posted before the forecast, starters' chances of playing and starting go near 1 and the others' chance of starting near 0. A player whose role changes has their minutes shifted toward what they recently played in that role, and the minutes this frees or uses are spread across the rest of the rotation.
3. **Blends in a minutes model.** A league-wide quantile gradient-boosting model is fitted inside the game loop on the previous season's box scores. Its inputs are role, recent minutes, games since the player last played, minutes missing from inactive teammates and rest. The blend weight (0, 0.25 or 0.5) is chosen for each team from that team's own earlier games.
4. **Recalibrates the ranges.** Offsets for each quantile level are learned from the team's earlier games in the same replay.
5. **Scales the production ranges** with the change in minutes.

If any step fails it falls back to the reference projection for that game. No evaluation needed the fallback.

Because the nominee declares no artifacts and uses no agents, the final evaluation's agent ablation is skipped and its emptied-artifact run is expected to score the same as the nominated run. It is still run once, as the brief requires.

### Why the architect chose it

From its notes in iteration 5: `fbfb2fbe` has the same mid-season score as `4abbd0ba`, it is simpler, and it is the only configuration checked on the opening weeks, where the final evaluation starts. Its stated expectation for the unseen teams over the whole season is a minutes ratio of about 0.93 to 0.96, with no fallbacks and both guardrails at or better than the reference.

## The operator's late checks

The architect spent no late check. After iteration 4 the operator ran two, in a copy of the pool that the architect cannot read (`.cache/spo908-latecheck`), on 42 team-games from Feb 23 to Mar 22, 2026.

| Configuration            | Minutes                   | Fantasy points            | Play Brier                | Flag |
| ------------------------ | ------------------------- | ------------------------- | ------------------------- | ---- |
| Iteration 1 (`9d3e391b`) | 0.8982 (0.8661 to 0.9304) | 0.9685 (0.9525 to 0.9848) | 0.9030 (0.8647 to 0.9352) | no   |
| Iteration 4 (`4abbd0ba`) | 0.8945 (0.8607 to 0.9270) | 0.9617 (0.9475 to 0.9759) | 0.9030 (0.8647 to 0.9352) | no   |

- **No late check exists for the nominee itself.** It sits between these two configurations: it is iteration 1 plus the minutes model, and iteration 4 is the nominee plus two corrections.
- **Iteration 4 against iteration 1,** paired: minutes 0.9959 (0.9816 to 1.0109).
- **What these checks changed.** The user ended development after seeing them. The architect did not see them and no configuration changed afterwards. The decision to stop and test this design was nonetheless made knowing it held on the late stretch, which the brief now states under Limits on claims.

## Human sample of reviews

The brief requires a person to read a sample of accepted configurations before the final evaluation. The user read five on Nov 19, 2026 and accepted them: the three full evaluations and one test configuration each from iterations 1 and 4.

## Departures from the brief and the issue

| Brief or SPO-908                                            | What happened                                                                        | Decided by             |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------- |
| The architect runs until it nominates or reaches its limits | The fifth iteration was restricted to nominating, with eight full evaluations unused | The user, Nov 18, 2026 |
| The late check is the architect's independent reading       | The architect spent none; the operator ran two outside its pool                      | The user, Nov 18, 2026 |
| The architect passes the contamination probe                | `claude-opus-5-5` is exempt and would not pass                                       | The user, Nov 17, 2026 |

## Acceptance against SPO-908

- **Every iteration is in the record.** Five iterations, their 28 reviews and their 27 evaluations are in the pool; the summary is in `run.json`.
- **The nominee passed review and the guardrails.** It was reviewed three times, at its full evaluation, at the opening check and at nomination, and accepted each time. Neither guardrail is flagged.
- **Development results are reported as development results.** Nothing here is offered as evidence.
- **Nothing from the holdout date on was read, and no Denver or Memphis game beyond the 14.** Every evaluation ran on the three development teams before Mar 23, 2026, and the operator's analysis read only those records.

## What this run does not show

- **Whether the gain carries to unseen teams.** That is the final evaluation.
- **Whether agents add anything.** The architect never tried one, so the brief's question about what agents add will have no measured answer from this nominee.
- **Whether more development would have helped.** Three iterations after the first changed nothing measurable on the mid-season games, but the architect had eight evaluations left when the user ended development.
- **Whether a model that has not seen the season would build the same system.** The architect's training data includes 2025–26.

## Evidence files

- [`run.json`](../evidence/v5-development-run/run.json): iterations with their submissions and spend, the hypothesis list, every run with its headline scores, every review, and the paired comparisons of iterations 4 and 2 and of iterations 2 and 1.
- [`operator-late-checks.json`](../evidence/v5-development-run/operator-late-checks.json): the two late checks and their paired comparison.
- [`nominee/`](../evidence/v5-development-run/nominee/): the nominated configuration's files and package description.
- [`architect-documents/`](../evidence/v5-development-run/architect-documents/): the architect's notes and its working draft as they stood after the nomination.

Copies of the whole pool, as archives, are on the operator's machine under `.cache/spo908/`: `pool-opus55-after-nomination.tar.gz` and `pool-latecheck.tar.gz`.
