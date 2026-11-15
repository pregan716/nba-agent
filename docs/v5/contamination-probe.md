# v5 contamination probe (SPO-906)

Run on Nov 15, 2026 (UTC) from the workstation. Every model on the v5 allowed list was probed for knowledge of the 2025–26 season, for all five teams. No model showed any, so the allowed list is unchanged.

Records are in [`docs/evidence/v5-probe/`](../evidence/v5-probe/). Model spend was about $0.29.

The Jev probe was run twice. The first run broke the holdout rule in two ways and its record is replaced; see [The first Jev run](#the-first-jev-run).

## Claude models

Each model was asked the carried nine-item audit once per team, with no tools: its training cutoff, the team's 2025–26 record, game results, in-season events, player statistics, league-wide facts, the 2025 offseason, the rotation, and player minutes and roles. The prompt is `teamProbePrompt` in `src/harness/probe.ts`. It names no player.

| Model                       | Stated cutoff               | 2025–26 items (2–6, 8, 9), five teams | 2025 offseason (item 7)              |
| --------------------------- | --------------------------- | ------------------------------------- | ------------------------------------ |
| `claude-haiku-4-5-20251001` | April 2024                  | All unknown                           | Unknown                              |
| `claude-sonnet-4-6`         | Early 2025, stated unsurely | All unknown                           | Unknown; 2024–25 roster context only |
| `claude-opus-4-6`           | Early April 2025            | All unknown                           | Unknown; 2024–25 roster context only |

Every item the models marked known is from the 2024–25 season or earlier: rosters, head coaches and front offices as they stood in early 2025. None of the 15 answers contains a 2025–26 result, statistic, transaction or rotation detail, and none names a 2025 draft pick or signing.

The models' stated cutoffs are their own accounts and were not checked against anything. What the probe establishes is that, asked directly, they produce nothing from the replayed season.

## Jev

Jev returns probabilities, not text, so its probe is different. It was given 1,114 true-or-false statements with an empty state and asked for the probability that each is true. Whether a statement asserts the positive or the negative outcome is fixed by a hash of its id, so true and false statements are balanced.

- **Results.** "The team won (or lost) its game against the opponent on the date", for every game of the five teams in 2024–25, and every 2025–26 game whose outcome was released before the holdout.
- **Appearances.** "The player played (or did not play) in that game", one per eligible 2025–26 game, for a roster player who played in between 20% and 80% of his team's games.

An outcome is eligible when it was released before the holdout (00:00 UTC on Mar 23, 2026). Release is 9 a.m. Eastern on the morning after the game, so the last eligible games are those of Mar 21. Eligibility is decided from schedule columns alone. The box-score files are then opened only where they hold an eligible game, and only those games' row ranges are decoded (`src/harness/jev-probe-source.ts`).

| Group                | Statements | Accuracy | Brier | Discrimination | Brier of an outcome-blind guess |
| -------------------- | ---------: | -------: | ----: | -------------: | ------------------------------: |
| Results, 2024–25     |        410 |    67.8% | 0.227 |         +0.054 |                           0.240 |
| Results, 2025–26     |        352 |    54.5% | 0.242 |         +0.019 |                           0.249 |
| Appearances, 2025–26 |        352 |    41.8% | 0.333 |         −0.064 |                           0.243 |

Chance is 50% accuracy, a Brier score of 0.25 and zero discrimination. Discrimination is the mean probability given to true statements minus that given to false ones. The outcome-blind guess knows only how often the positive outcome happened across the group and answers that rate every time.

- On 2025–26 results Jev is close to chance, and weaker than on 2024–25. Its small edge over the pooled guess is what knowing which teams were strong a year earlier would give: a guess that knows each team's own win rate scores 0.206, well ahead of Jev's 0.242.
- On who played in a given 2025–26 game it is worse than chance.

This is the same picture as the Nov 6 probe on the Celtics alone. It is descriptive: positive discrimination can come from recall or from ordinary priors about teams, and a probe of this size cannot prove that nothing was memorised. It gives no sign that Jev knows the season.

## The first Jev run

The first run, earlier the same day, sent 1,118 statements. A review of the PR found two breaches of the holdout rule in it, and the write-up's claim that the schedule was cut before any box-score row was read was wrong.

1. **It decoded every outcome row.** The script loaded both box-score tables whole and filtered afterwards, so rows from the holdout date on were decoded in memory, in the dry run as well. None of those rows was printed, stored or sent, apart from the four statements below.
2. **It gated on scheduled tip, not on release.** Four statements concerned two games played on Mar 22 (`0022501032`, Denver, and `0022501034`, Washington). They tipped before the holdout instant, but their outcomes were released at 9 a.m. Eastern on Mar 23, after it. Their results and one appearance each were sent to Jev and written to the record, and they were counted in the statistics first reported.

The script now uses the release gate the architect's view uses and reads only eligible row ranges. The probe was run again from scratch, and the table above is from that run. The first run's record is no longer in the tree. It remains in the branch history at commit `7af0cb4`.

## What was not done

- The architect and the reviewer are both `claude-opus-4-6`, so they are covered by that model's probe and were not probed separately.
- Each Claude probe was run once per team. Answers were not sampled repeatedly.
