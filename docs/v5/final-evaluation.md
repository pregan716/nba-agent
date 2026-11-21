# v5 final evaluation, round one (SPO-909)

Run on Nov 20, 2026 (UTC) on the cloud host. The nominated configuration, run `fbfb2fbe-ba5e-44f7-8cf9-a241bd6a31fb` (hash `72c7e39f…13c6`), was replayed once over the whole 2025–26 seasons of Denver and Memphis: 164 team-games in 160 games. The architect had seen none of these games apart from the 14 against development teams. This was the first and only read of them.

- **The system beat the reference projection on minutes by 11%** (ratio 0.8886, 90% interval 0.8680 to 0.9096). It had the lower minutes loss in 133 of 164 team-games.
- **Both guardrails improved too.** Fantasy points by 1.6% (0.9838, 0.9732 to 0.9941) and the will-play Brier score by 10% (0.9010, 0.8752 to 0.9244).
- **The gain is modest in practical terms.** For players who played, the typical miss of the median minutes forecast fell from 4.5 to 4.2 minutes for starters and from 4.8 to 4.3 for bench players.
- **The agent question is untested.** The nominee has no agents, so the run with agents switched off did not apply.
- **The accumulated-knowledge control does not apply to this system either.** The nominee keeps no artifacts, so emptying them changed nothing: every forecast was identical.
- **No model spend.** The system makes no model calls.

The figures are generated from the two run records by [`generate.ts`](../evidence/v5-final-evaluation/generate.ts) into [`final.json`](../evidence/v5-final-evaluation/final.json).

## What ran

Two of the brief's three runs: the nominated configuration, and the same configuration with the artifact store emptied before every game. The run with every agent call refused is skipped when the nominee has no agents (brief, Final evaluation).

| Run             | Team-games | Forecasts frozen | Excluded | Agent calls | Spend | Wall clock |
| --------------- | ---------- | ---------------- | -------- | ----------- | ----- | ---------- |
| Nominated       | 164        | 164              | 0        | 0           | $0    | 4 h 0 min  |
| Clear artifacts | 164        | 164              | 0        | 0           | $0    | 3 h 6 min  |

- **No fallbacks of either kind.** The harness scored no team-game on the reference. The nominee also returns the reference itself when its own code fails, which the harness records as an ordinary forecast, so that was checked separately: none of the 164 sandbox logs has an error or fallback line, and in no team-game do the system's minutes equal the reference's.
- **No guardrail flag.**

## Against the reference

Ratio of the system's loss to the reference's on the same team-games. Below 1 is better. Intervals are 90%, from the paired bootstrap over games.

| Score          | Reference | System | Ratio  | 90% interval     | Team-games improved |
| -------------- | --------- | ------ | ------ | ---------------- | ------------------- |
| Minutes        | 0.9988    | 0.8875 | 0.8886 | 0.8680 to 0.9096 | 133 of 164          |
| Fantasy points | 2.2008    | 2.1650 | 0.9838 | 0.9732 to 0.9941 | 104 of 164          |
| Will-play      | 0.0793    | 0.0714 | 0.9010 | 0.8752 to 0.9244 | 164 of 164          |

Minutes by team and by part of the season:

| Slice                      | Team-games | Minutes ratio | 90% interval     | Improved |
| -------------------------- | ---------- | ------------- | ---------------- | -------- |
| Denver                     | 82         | 0.9155        | 0.8876 to 0.9432 | 62       |
| Memphis                    | 82         | 0.8528        | 0.8215 to 0.8856 | 71       |
| October to December        | 65         | 0.9424        | 0.9152 to 0.9664 | 52       |
| January to March 22        | 77         | 0.8522        | 0.8243 to 0.8800 | 67       |
| March 23 on (post-holdout) | 22         | 0.8716        | 0.8133 to 0.9526 | 14       |

- **The gain holds on both teams and in every part of the season.** It is larger for Memphis, the team with heavy roster turnover.
- **Fantasy points are not separately clear in every slice.** The interval reaches 1 for Denver alone (0.9743 to 1.0024), for October to December (0.9799 to 1.0022) and for the 22 games after the holdout date (0.9327 to 1.0211).
- **By role tier**, the minutes ratio is 0.84 for fringe players, 0.86 for rotation players, 0.91 for core players and 0.92 for the deep bench. These have no intervals.

### What the gain looks like

- **Median miss for players who played.** Starters: 4.52 minutes for the reference, 4.17 for the system (820 player-games). Bench: 4.80 and 4.33 (877).
- **Misplaced minutes.** Of the 240 minutes in a game, the median forecasts gave 29.2 to the wrong players under the reference and 26.3 under the system.
- **Who starts.** The start Brier score fell from 0.0555 to 0.0007. The system reads the posted starting lineup; the reference does not.
- **Ranges.** For players who played, 82% of results fell inside the system's 80% minutes range and 54% inside its 50% range (reference: 80% and 52%).

### Ceiling score

The evaluator's ceiling picks hit on 15.9% of 492 picks (16.0% without the 1.2% that were void), against 11.0% for the reference by the evaluator's weighting. The ceiling Brier score was 0.0901 against 0.0923. No interval is computed for these, and the brief notes that three picks a game separate little.

## Against the artifact ablation

The clear-artifacts run produced the same 164 forecasts as the nominated run, value for value. Every paired ratio is 1 with an interval of 1 to 1.

This also shows the system gives the same forecasts from one run to the next, which had not been checked before.

## Against the architect's expectation

Before the test, the architect's notes expected a minutes ratio of about 0.93 to 0.96 on unseen teams. The result, 0.8886, is better than that range. In development the same configuration scored 0.9722 on the mid-season games and 0.8855 on the opening weeks ([development run](development-run.md)); those are four-week stretches of other teams, so they are not like-for-like with a whole season.

## The brief's three questions

1. **Can the architect build a system that beats a plain statistical projection on minutes, on teams it never saw?** Yes, for this architect, these two teams and this season. The interval on the target excludes 1 by a wide margin, the gain appears on both teams and in each part of the season, and neither guardrail was traded away. What the system did to earn it is ordinary: it reads the announced lineup and the injury report, moves minutes when roles change, blends in a league-wide model fitted on the previous season, and recalibrates its ranges from each team's earlier games.
2. **Do the agents in the game loop add to that system?** Not tested. The architect submitted no configuration with an agent, in 28 submissions, and noted one agent idea as costly with unclear value. Round two (brief, Second development round) is set up to test it.
3. **Does knowledge accumulated from game to game help?** Not tested by the control. The control empties the artifact store, and this system stores nothing there. It does learn within a season, but from the history the environment hands it before each game: the reference's record on the team's earlier games and the league's box scores. The control leaves those in place. The larger gain after December is consistent with that learning helping, but the reference changes over the season too, so this does not show it.

## Departures and notes

- **The evaluation ran at commit `295692f`, the watcher at `df26f16`.** A pool opens only at the commit it was created on, because the stored environment includes the code revision. The first launch, from the newer commit with the guarded launcher of SPO-930, stopped with "Different evaluation profile or environment in this pool" before any game ran. The evaluation was then started from a checkout of `295692f`, with the SPO-930 watcher running from a second checkout. The watcher's rules were unchanged: stop on the first team-game without a frozen forecast, on agent errors, or above a $25 ceiling. It did not stop the run.
- **The nominee's acceptance was restored, not repeated.** The final evaluation reuses the review recorded at nomination.
- **Records.** The two run records are 19 MB each and are not in the repository. They are in `.cache/spo909/final.tgz` on the Mac mini (sha256 `8bef8a2b915e9c716ebe970dfd53b7c8b4ca9b3a3838464538c31a167a86084a`) and in the pool on the host.
- **The Celtics holdout check was not run** (brief, Decisions, Nov 18, 2026). Games 71 to 82 stay unread.

## What this does not show

The brief's Limits on claims apply in full. The ones that bear most on this result:

- **The architect has seen the season.** `claude-opus-5-5` was trained on data that includes 2025–26. The review keeps out content tied to players, teams and games, not general knowledge of how the season went.
- **One architect, one run, two test teams, one season.**
- **Development was stopped by the user after looking at the late stretch**, on configurations other than the nominee.
- **The comparison is with our own reference projection only.** There is no market comparison, so the result says nothing about value against betting lines or other projections. A 1.6% gain in fantasy-point loss over this reference may or may not be an edge over those.
- **Twenty-two of the 164 team-games were played after the holdout date.** They count because the architect never saw them, and the result does not depend on them: the 142 team-games before that date give a minutes ratio of 0.8919 (0.8711 to 0.9116).
