# Pregame reference projection (SPO-879)

Run the trusted V4 pregame producer from the repository root with the numerical
Python image built by `scripts/assembler-build.ts`. Pass the same immutable
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
play and start probability. The model uses every eligible team's history.

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

The harness identity includes model and feature source, forecast contract and
runtime image. Each immutable pregame receipt binds the input hash, learned
trees, residual quantiles and forecast to that identity. Retrying with the
same inputs returns the original receipt. Conflicting inputs fail explicitly.

## Comparison with the headroom check

The [34.6 misplaced minutes per game](headroom-check.md) are the mean for a
single fit on 2024–25, over **retrospective box-score membership** on games
1–70. That calculation scores expected minutes (probability of playing times
the conditional center). The V4 diagnostic scores the median of the mixture
that includes DNPs. For a player with a 40% chance of playing and 20 minutes
if he plays, those two point estimates are 8 and 0. V1 also uses the dated
roster, incorporates newly released games at each refit, and calibrates
conditional ranges on later historical games. The 34.6 figure is the
published comparator. This implementation has no measured 70-game V4 score yet.

Development verification used a planted cutoff fixture, independent refits in
the pinned numerical image, and a synthetic current-season target with the real
opening roster and the pinned 2024–25 training release. The latter fit used
1,228 eligible prior games and produced 17 player rows. Two regular-season
games had unusable normalization products. No holdout game was needed.
