# Pregame reference projection (SPO-879)

Run the trusted V4 pregame producer from the repository root with the numerical
Python image built by `npm run projection:build`. Pass the same immutable
image digest for every arm. The data adapters use the repository's pinned
releases and verified object cache.

```sh
npm run --silent projection -- GAME_ID local@sha256:IMAGE_ID > reference-tables.json
```

The optional third argument selects the private receipt directory (default
`.cache/reference-projection`). The TypeScript pregame entry point is
`referenceTables(source, gameId, root, model)`. It refits for the target,
backfills earlier 2025–26 Celtics forecasts at their original pregame cutoffs,
and returns the two agent-facing tables as JSON. Missing data products are
recorded by game and reason. If a released Celtics game lacks usable outcomes,
its original forecast is still available with an exclusion and empty errors.

## Contract shared with the forecast scorer

The wire type is [Forecast](../../src/projection/forecast.ts).
`{version: "forecast-v1", gameId, players}` has one row per canonical player ID
in the dated pregame roster, sorted by ID. Each row has `playerId`, `p_play`,
`p_start` (both unconditional), and arrays named `minutes`, `points`,
`rebounds`, `assists` and `fantasy_points`. Each array holds the 5th, 10th,
25th, 50th, 75th, 90th and 95th percentiles **given that the player plays**.
Fantasy points use the v4 brief's weights, including the cumulative bonuses
for two and three double-digit categories. Fantasy ranges have a floor of −10,
the other quantities a floor of zero, and minutes a ceiling of 58.

`tonight` holds the target game, cutoff, model hash and forecast. Each entry in
`history` carries the same fields for a released game, plus the actuals and the
signed errors (actual minus forecast) for playing, starting, and each
conditional median. Players who sat have no conditional errors. An unknown
starter flag yields a null starting error. The V2 scorer owns interpolation,
validation and primary losses. V3 can expose these tables without exposing
private training rows or the receipt directory.

## Fit and calibration

Each game becomes eligible at 9 a.m. New York time the next morning. Both the
game release and the box/participation envelopes must precede the cutoff.
Historical features advance on release as well: a later tip on the same day
cannot see an earlier game's unreleased results. Each target uses the verified
season roster and last pre-tip team injury snapshot; Out and Doubtful get zero
play and start probability. The Playing Brier excludes those players. The minutes pinball loss includes them, so the reference incurs a loss if one plays. The model uses every eligible team's history.

- Three histogram gradient-boosted estimators predict playing, minutes given
  playing, and starting given playing. Starting probability is the latter
  probability times the chance of playing. Fitting uses 300 iterations at
  learning rate .05, maximum depth 5, minimum leaf size 40, seed 1.
- Inputs include recent playing and starting frequency, minutes, games played,
  absences, and the roster's redistributed minutes and rank. Played-game
  minutes and starts decay by .80, playing frequency by .85. Minutes are
  scaled by team to a 240-minute expectation before clipping the conditional
  center to 1–46 minutes.
- Production centers multiply conditional minutes by each player's recent
  per-minute rates, decayed by .95 and shrunk by 60 minutes toward fixed
  priors. Fantasy rates use historical fantasy totals including bonuses.
- For uncertainty, fit a separate copy of the estimators using games released
  before the final fifth of the historical schedule. On that later fifth,
  collect actual minus predicted values from players who played. Add empirical
  residual percentiles to each target's center, grouped by predicted minutes
  (under 8, 8–18, 18–30 and 30+). Buckets with fewer than 40 observations use
  the pooled residuals. The final point models refit on all eligible games.

Historical fitting and residual calibration use the retrospective inactive flag for availability and for redistributing team minutes. A pregame injury report can disagree with that flag. Residuals from historical centers may therefore understate game-day uncertainty; observed interval coverage measures the combined effects of this mismatch and other model errors.

The harness identity includes model and feature source, forecast contract and
runtime image. Each immutable pregame receipt binds the input hash, learned
trees, residual quantiles and forecast to that identity. Retrying with the
same inputs returns the original receipt. Conflicting inputs fail explicitly.

## Comparison with the headroom check

On Celtics games 1–70, the reference misplaced **33.14 minutes per game**
using expected minutes over box-score membership. The [headroom study](headroom-check.md)
reported **34.6** on that measure. Both used the same 70 games. The reference
refits before each game and projects the dated pregame roster. This comparison
measures the overall difference across those choices.

The V4 diagnostic, using the median of the minutes distribution over the dated
roster, was **31.22 misplaced minutes per game**. The DNP probability changes
the median: a player with a 40% chance of playing and 20 minutes if he plays
has 8 expected minutes and a median of zero.

| Forecast population and quantity | Player-games | Inside 10th–90th | Inside 25th–75th |
| -------------------------------- | -----------: | ---------------: | ---------------: |
| Minutes, entire dated roster     |        1,160 |            88.4% |            67.6% |
| Minutes, given playing           |          757 |            77.9% |            47.7% |
| Points, given playing            |          757 |            79.0% |            48.5% |
| Rebounds, given playing          |          757 |            72.4% |            48.3% |
| Assists, given playing           |          757 |            85.7% |            49.8% |
| Fantasy points, given playing    |          757 |            78.2% |            45.8% |

Coverage includes observations equal to either endpoint. The nominal targets
are 80% and 50%. Rebounds had the lowest outer-interval coverage, with 548 of
757 played rows inside. Whole-roster minutes include the probability mass at
zero. These figures measure calibration across all sources of forecast error;
they cannot isolate the effect of using retrospective inactive flags.

A fresh c8g.4xlarge built all 70 pregame tables in 509.8 seconds. In a separate
process with the first 69 receipts available, building game 70's tables took
39.6 seconds, including its refit. Repeating the call with all receipts and
the in-memory caches warm took 3.5 seconds. The fresh fit reproduced game
70's model hash. All per-game errors, model hashes and aggregate coverage
counts matched across both runs. The audit selected outcomes through game 70.
[Per-game results and coverage counts](../evidence/reference-projection/games1-70.json)
· [Machine, revision and timing](../evidence/reference-projection/graviton-run.json).

Development verification used a planted cutoff fixture, independent refits in
the pinned numerical image, and a synthetic current-season target with the real
opening roster and the pinned 2024–25 training release. The latter fit used
1,228 eligible prior games and produced 17 player rows. Two regular-season
games had unusable normalization products. No holdout game was needed.

The independent-refit check needs the pinned Docker image. CI runs it in the projection job. To run it locally:

```sh
PROJECTION_IMAGE="local@$(docker image inspect nba-agent-projection:local --format '{{.Id}}')" npx tsx --test test/reference-projection.test.ts
```

To measure the 70-game comparison, run the following from the repository root
on the audit host. The last argument is the durable receipt directory. A retry
checks completed receipts and fits the remaining games. Use a fresh receipt directory when changing the image or source revision. To reproduce a published audit, use the revision and image digest recorded with its evidence.

```sh
npx tsx scripts/reference-audit.ts "$PROJECTION_IMAGE" reference-audit.json .cache/reference-projection
```

The audit integrates the conditional minutes quantile function, multiplies by
`p_play`, then compares those expected minutes to the official boxes. For the
V4 diagnostic it takes the median after adding the DNP mass. Both metrics sum
absolute errors, halve the sum per game, and average across games. Minutes
coverage is reported both over dated rosters using the mixture and over players
who played using the conditional ranges. All four production coverage figures
are conditional on playing. The output records the denominators, hits, per-game
hashes, and elapsed time to build game 70's tables and to retrieve them again.

The audit also records `tails` and a `scored` block (SPO-886). For players who
played, `tails` counts results below the 10th percentile, above the 90th, and
strictly above the interpolated 85th, per quantity. The rate above the 85th
fantasy-point percentile is the realised base rate of a ceiling game given
that the player plays. `scored` repeats every counter for games 21–70 alone:
both coverage intervals for whole-roster minutes and for production,
conditional-minutes coverage, and the tails. The counters live in
`src/projection/audit.ts` and are tested on a fixture that crosses games 20
and 21 with a DNP. These figures are not in the committed evidence yet: the
rerun can reuse the 70 receipts retained on the audit host with the [pre-cleanup audit code](https://github.com/pregan716/nba-agent/tree/f0a69d3e2d3194aa34259483b0a6acd1a234b5c5) and the recorded image digest. The projection-only image and relocated input sources have a new identity and require fresh receipts.
