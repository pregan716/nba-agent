# v5 architect pilot (SPO-907)

Run on Nov 16, 2026 (UTC) on the cloud host. Three architect iterations ran end to end on the development teams: two ended in test runs and one in a full evaluation. Nothing in the harness failed. Total model spend was $14.70.

This is a pilot, not evidence. Its one full evaluation scored slightly worse than the reference, because most of the configuration's logic did nothing in the game sandbox. The causes were defects in the environment and the prompt, and they are fixed (see [Defects](#defects)).

A second run later the same day, with the fixes merged, ran one iteration through six test runs to a full evaluation for $3.68. Its configuration read its data correctly and scored level with the reference (see [Second run, with the fixes](#second-run-with-the-fixes)).

Records are in [`docs/evidence/v5-architect-pilot/`](../evidence/v5-architect-pilot/). The pilot used its own pool directory, so none of its evaluations count against the development run's pool.

## What ran

The host was at commit `3d230c8`. Before the pilot, the full suite passed there with the images (266 tests, 251 passed, 15 skipped), and a two-game paid check confirmed the path with live agents (one Haiku call and one Jev call per game, under one cent).

| Iteration | Restriction | Model requests | Architect spend | Submission          | Review   | Result                     |
| --------- | ----------- | -------------- | --------------- | ------------------- | -------- | -------------------------- |
| 1         | test only   | 18             | $1.71           | Test, 2 team-games  | Accepted | Both forecasts frozen      |
| 2         | none        | 23             | $4.67           | Test, 3 team-games  | Accepted | All three forecasts frozen |
| 3         | full only   | 34             | $8.17           | Full, 43 team-games | Accepted | All 43 forecasts frozen    |

- **Spend.** The architect spent $14.55, the reviewer $0.15 across three reviews, and the evaluations nothing: the configuration is code only, with no agents.
- **Time.** Iterations 1 and 2 took about 17 minutes each, including the test replays. Iteration 3 took 16 minutes of architect work and 41 minutes of evaluation.
- **Game clock.** The configuration used at most 0.3 seconds of its 45 minutes per team-game. Host preparation, now recorded separately (SPO-917), was 47 to 69 seconds per team-game in the full evaluation.
- **Watcher.** Each iteration ran under `scripts/pilot-watch.ts` with a spend ceiling. It never stopped a run.

## Scope against SPO-907

The issue asks for a five-game test run first, then two iterations each ending in a full evaluation. The pilot differs in three ways:

| SPO-907                       | What ran                                                                                              | Decided by                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Two iterations                | Three: a third was added so the first could be limited to a test run                                  | The user, before launch                                                   |
| First test on five team-games | First test on two team-games                                                                          | The architect, which chooses the games; the operator did not require five |
| Two full evaluations          | One. Iteration 2, unrestricted, ended in a second test run, and the approval covered three iterations | Not decided: outstanding                                                  |

The second full evaluation is outstanding, not waived. The user has not accepted one full evaluation as the revised scope. Running it on the pilot's configuration as it stands would repeat a design that could not read its data, so it is better spent as a further pilot iteration with the fixes in place; the user has since approved that (see [Decisions after the pilot](#decisions-after-the-pilot)).

The watcher as it ran also fell short of the issue's "any infrastructure failure": it would have missed an evaluation that failed between two polls, and the launcher did not stop the run if the watcher itself failed. Neither happened in the pilot. Both were fixed in review of this PR, with the launcher's exit status.

## The $30 cap

No iteration came near the cap: the largest used $8.17. Under the rule then in force, a test run ended the iteration, so iterations 1 and 2 stopped after $1.71 and $4.67. That rule has since changed (SPO-919), and iterations in the development run will last longer.

The architect runs without prompt caching, so every request pays for the whole conversation again. In iteration 3, 34 requests read 1.5 million input tokens and wrote 26,000 output tokens; input was about $7.50 of the $8.17. At that rate $30 is roughly 100 to 120 requests. Caching has since been turned on (see [Decisions after the pilot](#decisions-after-the-pilot)).

## What the architect built

A code-only configuration, `main.py` (about 900 lines), with one hypothesis, `baseline_error_correction`. It starts from the reference forecast and is meant to:

- read the starting-lineup announcement and set who starts;
- read the injury report to adjust the chance of playing;
- correct each player's minutes from the reference's past errors on him;
- widen or narrow ranges from the reference's past coverage;
- fall back to the reference on any error.

The architect found that lineup announcements exist before tip for 37 of the 43 evaluation games, and built around them. It wrote no notes in iterations 1 and 2, and one useful note at the end of iteration 3.

## Scores

Full evaluation, 43 team-games, ratio of the system's loss to the reference's with 90% intervals:

| Metric                            | Ratio  | 90% interval     |
| --------------------------------- | ------ | ---------------- |
| Minutes pinball (target)          | 1.0065 | 1.0010 to 1.0131 |
| Fantasy-point pinball (guardrail) | 1.0000 | 1.0000 to 1.0000 |
| Play Brier (guardrail)            | 1.0687 | 1.0097 to 1.1469 |

The configuration was slightly worse than the reference on minutes and reliably worse on the play guardrail, so it is flagged and could not be nominated. Points, rebounds and assists losses matched the reference to four decimal places.

The score says nothing about the design, because the design did not run:

- **Lineups were never read.** In the game sandbox the lineups table had different columns from the architect's view. The configuration found no starters in any game.
- **History was never read.** The configuration looked for keys in `ctx["referenceHistory"]` that do not exist, and reported "0 players" in every game.
- **Injuries were read**, once the third version tried several table names and found the sandbox's. This is the only part of the design that ran, and the chance of playing got worse.

## Defects

| Defect                                                                          | Effect in the pilot                                                                          | Status                       |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------- |
| The architect's view and the game sandbox used different table and column names | The configuration's lineup and injury queries failed in the sandbox                          | Fixed: SPO-918, SPO-921      |
| The prompt did not give the layout of `referenceHistory`                        | The architect guessed keys that do not exist                                                 | Fixed in the prompt: SPO-922 |
| A test run ended the iteration                                                  | Two iterations ended after a fraction of their budget; each next one re-read everything      | Changed: SPO-919             |
| Host preparation counted against the 45-minute game clock                       | Found in the paid check before the pilot; up to 11 minutes lost on a team's first game       | Fixed: SPO-917               |
| One transient provider error ended an iteration or was recorded as a rejection  | Found by reading the path before the pilot                                                   | Fixed: SPO-916               |
| Development replays could read Denver and Memphis evidence                      | Found in review after the pilot; whether the pilot's configuration read any was not examined | Fixed: SPO-920               |

Two things that were choices, not defects:

- **The full-only restriction on iteration 3 was the operator's.** The architect wanted another test run to learn the sandbox's column names, noted that it could not, and guessed. With SPO-918 and SPO-919 in place it would not need to.
- **Notes came late.** The prompt asks for notes before each submission. The architect skipped them twice. Under SPO-919 fewer iterations start cold, which reduces the cost, but it is worth watching in the development run.

## What the pilot does not show

- No configuration with agents ran in a full evaluation, so agent spend, the per-game dollar limit and agent failures were exercised only by the two-game check.
- No repeat, check or nomination was submitted, and no submission was rejected by the reviewer.
- The watcher never had to stop a run, so its stop path was exercised only by tests.
- The fixes above were made after this run. They were exercised in the [second run](#second-run-with-the-fixes).

## Decisions after the pilot

Decided by the user on Nov 16, 2026:

- **The development run starts empty.** Nothing from the pilot's pool carries over: no draft, notes, hypotheses or archive.
- **Prompt caching for the architect is on**, with five-minute retention. The caps count what is actually charged.
- **The second full evaluation is funded**: one more pilot iteration with the fixes in place, ending in a full evaluation. See [Second run, with the fixes](#second-run-with-the-fixes).

## Second run, with the fixes

Run on Nov 16, 2026 (UTC) on the cloud host at commit `aafff7d`, after every fix above was merged, on a fresh pool. The full suite passed on the host first (275 tests, 260 passed, 15 skipped, plus the sandbox and forecast tests with images). This run supplies the second full evaluation SPO-907 asks for. It is still a pilot, not evidence.

One unrestricted iteration ran under the watcher. Records are in [`second-run/`](../evidence/v5-architect-pilot/second-run/).

| Step   | Team-games | Minutes ratio             | Play Brier ratio          | Fantasy ratio | What the architect changed                                                                  |
| ------ | ---------- | ------------------------- | ------------------------- | ------------- | ------------------------------------------------------------------------------------------- |
| Test 1 | 3          | 0.973                     | 0.866                     | 1.046         | First draft: correct minutes from the reference's past errors, rescale the other statistics |
| Test 2 | 5          | 0.983                     | 0.940                     | 1.002         | Scale fantasy points in proportion                                                          |
| Test 3 | 5          | 0.988                     | 0.953                     | 1.000         | Leave everything but minutes and the two probabilities alone; add lineup and injury reading |
| Test 4 | 2          | 0.980                     | 0.982                     | 1.000         | Same, with logging                                                                          |
| Test 5 | 5          | 1.018                     | 1.749                     | 1.000         | Corrections by role tier                                                                    |
| Test 6 | 5          | 0.990                     | 0.943                     | 1.000         | Back to the simple correction; lineup and injury reading removed                            |
| Full   | 43         | 0.9994 (0.9898 to 1.0085) | 0.9971 (0.9741 to 1.0192) | 1.0000        | Same configuration as test 6                                                                |

Ratios on a handful of games are noise; they are listed to show the loop the architect ran, not as results. On the full evaluation the configuration is indistinguishable from the reference and is not flagged on either guardrail.

- **Every submission was accepted** by the scan and the reviewer, and all 68 forecasts froze. The watcher never stopped the run, and the launcher exited 0.
- **The fixes worked together.** The iteration continued through six test runs and ended on the full evaluation (SPO-919). The configuration read the reference history, the lineup announcements and the injury reports in the game sandbox with the names the architect had seen in its own view (SPO-918, SPO-921, SPO-922). Its stderr shows per-player corrections in every game.
- **What it built.** A code-only configuration of about 250 lines that shifts each player's minutes, chance of playing and chance of starting by a fraction of the reference's recent error on him, and recalibrates the width of the minutes range. The architect tried lineup and injury reading, saw the play Brier on five test games rise to 1.75 times the reference's, and removed both. It wrote its notes before the full submission.
- **Spend.** $3.68 in total: $3.47 for the architect, $0.21 for seven reviews, nothing for the evaluations.
- **Caching.** The architect made 55 requests. They read 3.43 million input tokens from the cache, wrote 148,000 to it and sent 57 uncached, with 33,000 output tokens. The same requests without caching would have cost about $18.7. The $30 cap now allows several hundred requests instead of about a hundred.
- **Time.** The iteration took 95 minutes: about 50 of architect work and test replays, and 45 for the full evaluation. The first test run took 18 minutes, because a fresh pool prepares each team's history once; later test runs took 1.5 to 4 minutes. The configuration itself used at most 0.3 seconds per team-game.

Still not exercised by either run: agents in a full evaluation, a rejected submission, repeat and check evaluations, a nomination, the budget warning and the watcher's stop path.

## Evidence files

The first run's files are listed here; `second-run/` holds the same files for the second run.

- `pilot.json`: per iteration, the spend, request and token counts, tool calls and submissions; the three reviews; per run, each team-game's status, times and the configuration's stderr.
- `full-evaluation-summary.json`: the full evaluation's scores for the system and the reference, and the paired comparison.
- `configuration/`: the package as evaluated in the full run.
- `iteration_3_notes.md`: the architect's notes.
- `logs/`: the watcher's log, the exit status and the commit for each iteration.

The pool's databases, which hold the full transcripts, are on the workstation under `.cache/spo907/final/` and are not committed.
