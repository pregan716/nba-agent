# Starter-model experiment (Nov 8, 2026)

An offline test of whether a fitted, player-level substitution model would make a
better first predictor than the research agent's hand-written assemblers. It is the
evidence for the Proposed brief amendment "Code-first prediction and the starter
model". Development games only (games 1–10 of 2025–26), so it is a pilot
observation, not evidence in the brief's sense. No model calls; games 21–82 were
never loaded.

## Why

The pilot (`docs/v3/pilot.md`) found that the agent's assemblers are hand-tuned
rule systems: stoppage-kind and stint-length thresholds, additive exit scores with
invented weights, and a replacement map taken from one or two games. No sandbox
program in about 1,450 across six runs fits a predictive model or scores the
package on prior windows. On `jev-contract-v2` the set score is worse than the
constant floor (5.32 and 5.75 against 5.02 on games 1–2) because the candidate list
misses most moves and Jev puts little mass on `other`.

## Method

Scripts are in [`docs/evidence/starter-model/scripts/`](../../evidence/starter-model/scripts),
run from the repository root with the Doppler-backed store; outputs go to the
ignored `.cache/hazard/`. Scoring uses the repository scorer (`scoreWindow` under
`jev-contract-v2` with the size prior pinned from warm-up games 11–20), on the same
584 scored windows the pilot used. The constant and statistical baselines refit by
`fitSwapBaselines` reproduce the pilot's figures exactly (timing 0.221 and 0.203,
mid-period 0.209 and 0.198), which checks the path.

**Data.** `export.ts`: Celtics windows for 2025–26 games 1–20 with the season
pregame loaders, and the 82 Celtics 2024–25 games under the retrospective
box-score roster policy (80 with windows). `export-league.ts`: every other team's
2024–25 regular-season games. The window builder is Celtics-specific, so each
team-game's input rows were relabelled (target team id swapped with the Celtics
id) before `buildDataset`; eligible benches come from the same box-score roster
policy. 2,374 team-games, 142,150 windows (four team-games in two games without box
scores failed). Sanity: about 60 windows per team-game (Celtics 59), 8 % excluded,
substitution rate 0.283, team rates 0.24–0.34.

**Model.** Four boosted-tree classifiers (scikit-learn
`HistGradientBoostingClassifier`, learning rate 0.05, 250 iterations, depth 4, leaf
40, L2 1.0; not tuned):

| Part | Unit | Target |
| --- | --- | --- |
| Exit | window × on-court player | player leaves |
| Timing | window | any substitution |
| Count | substitution window | size 1, 2, 3, 4+ |
| Entry | substitution window × bench player | player enters |

Features are the observable state plus as-of history from strictly earlier games:
current stint, minutes, fouls and a foul-trouble flag by period, rest, stoppage
kind, period, clock, margin, late-close and blowout flags, our timeout, Celtics
substitutions this period and time since the last one; per player an
exponentially weighted mean of minutes, completed stint length and start rate, the
stint ratio to that typical stint and minutes pace; in round 2 also the team's
as-of substitution rate overall and at this stoppage kind (shrunk toward the
2024–25 league rate) and a Celtics indicator. Window aggregates (longest stint,
largest stint ratio and pace, any foul trouble, starters on court) feed timing and
count.

**Set distribution.** P(out O, in I) = P(k) · CB(O) · CB(I), where CB is the
conditional-Bernoulli distribution over size-k subsets with weights h/(1 − h) from
the exit and entry models. Sizes 1–3 are enumerated, the eight most probable sets
are listed with their model probabilities, and `other` takes the remaining mass
(sizes 4–5 included). Empty-bench windows carry only `substitution`.

**Training regimes.** Rolling: before development game n, fit on 2024–25 and
2025–26 games 1 to n−1, which is what an agent could use. Baseline protocol: fit on
2024–25 and warm-up games 11–20, as the statistical baseline is (uses games after
the development games). 2024–25 only.

## Round 1: Celtics only

| Predictor | Timing | Mid-period | Set log loss | Hit rate | Exit / entry log loss |
| --- | --- | --- | --- | --- | --- |
| Constant | .221 | .209 | 5.17 | 0 | 1.61 / 2.20 |
| Statistical baseline | .203 | .198 | 5.08 | .18 | 1.62 / 2.16 |
| Stage 3 agent (M3, four-question contract) | .190 | .196 | — | — | — |
| `pilot-m0-10` (four-question contract) | .204 | .211 | — | — | — |
| Boosted, rolling | .178 | .186 | 4.49 | .45 | 1.39 / 1.82 |
| Boosted, baseline protocol | .172 | .179 | 4.44 | .46 | 1.38 / 1.85 |
| Boosted, 2024–25 only | .183 | .190 | 4.43 | .47 | 1.38 / 1.82 |
| Logistic, rolling | .194 | .199 | 4.91 | .31 | 1.53 / 2.05 |

Paired game bootstrap (10,000 resamples, seed 8542026), boosted rolling minus
statistical: timing −0.025 [−0.034, −0.015], set log loss −0.59 [−0.74, −0.44];
better on the set score in all ten games. On games 1–2, set log loss 4.01 with the
actual move listed at 56 % of substitutions, against the agent's 5.32 and 5.75
(hit rates 32 % and 20 %) and the floor's 5.02. Games 1–5 timing 0.179 against
0.170 for `pilot-m0-v2`, the best agent run.

One change was made after seeing results: `n_bench` and `hist_games` were dropped
because their meaning differs between seasons (2024–25 benches include
did-not-play players; history length trends over time). The 2024–25-only logistic
had a mean prediction of 0.057 against a 0.33 rate with them. Rolling boosted
timing moved from 0.175 to 0.178.

The rolling model under-predicted: mean probability 0.23 against 0.33. The
substitution rate at scored windows was 0.259 in 2024–25 and 0.32–0.33 in
2025–26.

## Round 2: calibration and league pooling

All five variants were fixed before any was scored. Boosted, rolling, player
history now decayed by date (half-life 21 days). Intervals are against A.

| Variant | Timing | Mid | Mean p (rate .329) | Set | Hit | Skill vs per-kind rate: foul / timeout / dead-ball turnover / between periods |
| --- | --- | --- | --- | --- | --- | --- |
| A Celtics only | .180 | .187 | .238 | 4.49 | .46 | .06 / −.06 / −.01 / .24 |
| B A with 2025–26 rows ×3 | .178 | .186 | .250 | 4.47 | .46 | .05 / .00 / .02 / .33 |
| C A plus team-rate features | .176 | .183 | .299 | 4.48 | .45 | .06 / .08 / −.04 / .15 |
| D league plus team rates | .165 | .172 | .312 | 4.36 | .47 | .12 / .12 / .06 / .35 |
| E D with Celtics rows ×5 | .164 | .170 | .304 | 4.29 | .51 | .13 / .11 / .05 / .35 |

E minus A: timing −0.016 [−0.022, −0.009]; set log loss −0.20 [−0.32, −0.08]. D
minus A: timing −0.015 [−0.023, −0.007]; set −0.12 [−0.25, 0.00]. B and C are within
noise of A.

- Recency weighting does not fix the level. Team-rate features fix it (mean 0.30)
  but do not improve the score on Celtics data alone. With league data both
  calibration and scores improve. A league variant without team-rate features was
  not run, so the split of D and E's gain between data and features is not
  measured; C suggests most of it is the data.
- E is the first predictor in the project with positive skill against the
  per-stoppage-kind rate at all four main kinds, including timeouts and dead-ball
  turnovers, where every agent run was below it (−0.10 to −0.35 and −0.45 to
  −0.98).
- Games 1–5: E timing 0.165 (mid 0.170) against 0.170 (0.178) for `pilot-m0-v2`.
  Within the agent's run-to-run noise.
- Games 1–2: E set log loss 3.78, hit rate 66 %, `other` mass 0.42.

## Limits

- Ten development games, one fit per regime. The selection gaps are large against
  that noise; the timing gap to the best agent run is not.
- Two rounds of choices were made on the same ten games (one feature change in
  round 1; five pre-registered variants in round 2). Hyperparameters were not
  tuned.
- League data is 2024–25 only. A rolling system would also add other teams'
  2025–26 games as they are released.
- League windows come from relabelling inputs, not a team-parameterised builder.
- 2024–25 eligible benches use the retrospective box-score roster policy (Agreed
  for training only, SPO-856).
- Agent rows in round 1 use the four-question contract and have no set score;
  their player log losses are not comparable and are omitted.

## Reproduce

```sh
npx tsx docs/evidence/starter-model/scripts/export.ts
NODE_OPTIONS=--max-old-space-size=12000 npx tsx docs/evidence/starter-model/scripts/export-league.ts
python -I docs/evidence/starter-model/scripts/model.py    # round 1 (numpy, pandas, scikit-learn 1.9)
npx tsx docs/evidence/starter-model/scripts/score.ts
python -I docs/evidence/starter-model/scripts/model2.py   # round 2
npx tsx docs/evidence/starter-model/scripts/score2.ts
npx tsx docs/evidence/starter-model/scripts/g12.ts        # games 1–2 set scores
```

Results: [`round1-scores.json`](../../evidence/starter-model/round1-scores.json),
[`round2-scores.json`](../../evidence/starter-model/round2-scores.json).
