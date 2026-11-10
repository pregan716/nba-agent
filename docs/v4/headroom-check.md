# Projection headroom check (SPO-878)

Nov 10, 2026. An offline check, with no agent and no model calls, run before
the v4 design was written down. It asks how much room there is between a plain
statistical projection and the truth, how the prop market compares, and where
the misses are.

It scores Celtics games 1–70 of 2025–26. Games 71–82, the holdout, were not
read. The numbers are in
[`results.json`](../evidence/projection-headroom/results.json); the scripts
are in [`scripts/`](../evidence/projection-headroom/scripts/).

## Method

- **The plain model.** Three boosted-tree models fitted once on every team's
  2024–25 games: whether a player plays, his minutes if he does, and the same
  with tonight's starter flag. Inputs are each player's recent minutes, play
  rate and start rate (exponentially weighted), and the minutes freed by
  teammates known to be out. Projections are scaled to 240 minutes per team.
  No hyperparameter was tuned.
- **Production.** Projected minutes times the player's recent per-minute rate
  for points, rebounds and assists. The chance of clearing a line assumes a
  spread proportional to the square root of the projection, with the constant
  estimated per stat on 2024–25.
- **What the baseline knows.** Players listed Out or Doubtful on the last
  injury report printed before scheduled tip get zero minutes.
- **Oracles.** The same model given, in turn, the true inactive list, the
  actual starters, who actually played, and the minutes actually played. These
  are not achievable forecasts; they bound what each kind of knowledge is worth.
- **Market.** The pinned consensus at the scheduled-start snapshot, on the
  1,554 player-props where the player played.
- **Uncertainty.** Bootstrap over games, 90 % intervals.

## Minutes

"Misplaced minutes" is half the summed absolute error over the roster: of the
240 minutes on the floor, how many the projection gave to the wrong players.

| Projection                                           | Misplaced minutes per game | Change games | Other games | Mean miss per rotation player |
| ---------------------------------------------------- | -------------------------- | ------------ | ----------- | ----------------------------- |
| Recent minutes, redistributed for injury-report outs | 34.2                       | 34.2         | 34.1        | 5.57                          |
| Plain model, injury report known (the baseline)      | 34.6                       | 35.7         | 33.3        | 5.53                          |
| Plus the true inactive list                          | 33.8                       | 34.5         | 32.9        | 5.47                          |
| Plus the actual starters                             | 31.8                       | 32.0         | 31.5        | 5.14                          |
| Plus who actually played                             | 26.8                       | 28.1         | 25.1        | 4.80                          |

- Knowing who starts and who plays is worth 7.8 minutes per game (interval 6.1
  to 9.8), about a quarter of the baseline's error.
- A change game is one whose starting five, or set of absent rotation players,
  differs from the previous game. 39 of the 70 games are change games, and the
  baseline is barely worse in them. The misses are not concentrated there.
- 15.5 % of rotation player-games miss by ten minutes or more, and 37.6 % by
  six or more.

By the player's expected minutes before the game (players not listed out):

| Tier             | Player-games | Mean miss | Share of total error |
| ---------------- | ------------ | --------- | -------------------- |
| Deep bench (< 5) | 209          | 4.2       | 18 %                 |
| Fringe (5–15)    | 204          | 6.4       | 27 %                 |
| Rotation (15–26) | 291          | 5.7       | 34 %                 |
| Core (26+)       | 240          | 4.2       | 21 %                 |

## Production against the market

Brier is the squared error of the over probability at the market's line; 0.25
is a coin flip. "Right side" is how often the projection is on the side of the
line that the result landed on.

| Forecast                                        | Brier | Mean absolute error | Right side |
| ----------------------------------------------- | ----- | ------------------- | ---------- |
| Market consensus                                | .2485 | 2.94                |            |
| Baseline: projected minutes × recent rate       | .2643 | 3.07                | 49.2 %     |
| Baseline knowing the actual starters            | .2618 | 3.05                | 51.3 %     |
| Baseline knowing starters and who played        | .2624 | 3.05                | 51.2 %     |
| Baseline rates with the minutes actually played | .2277 | 2.69                | 61.3 %     |

- The baseline is worse than the market by .016 (interval .012 to .021) and has
  no edge on which side to take.
- The same rates with the minutes actually played beat the market by .021
  (interval .013 to .028). Minutes are the lever.
- Knowing who starts and plays barely helps here. Props are mostly on core
  players whose availability is rarely in doubt; what matters for them is how
  long they stay on the floor.

## Big overs

A big over is a result at least one standard deviation above the line, using
the per-stat spread above (about 6 points over a 15.5 line). 19.8 % of props
are big overs, 4.4 per game.

| Who picks the three likeliest per game          | Hit rate |
| ----------------------------------------------- | -------- |
| Any prop (base rate)                            | 19.8 %   |
| Baseline                                        | 25.2 %   |
| Baseline knowing starters and who played        | 27.6 %   |
| Baseline rates with the minutes actually played | 36.7 %   |

The market's own over probability barely separates big overs from the rest
(AUC .549). Players with a big over played 2.3 minutes more than projected on
average, against 1.4 fewer for the others; 35 % of big overs came with four or
more extra minutes.

## What it does and does not show

- There is room on minutes against a plain projection, and it sits in the
  middle of the roster.
- Beating the market needs foresight about how long core players play. The
  check cannot say how much of that is knowable before tip.
- Splitting results by change games is not informative for this team; a split
  by player tier is.

Limits:

- The baseline is plain. It ignores the opponent, pace, and the change in a
  player's per-minute rates when a teammate is out, so the gap to the market
  is probably larger than it would be for a commercial projection.
- The roster for each game is the players in that game's box score, a
  retrospective approximation.
- The release marks some injured players `dnp` instead of `inactive`, so the
  2024–25 training label for "available" is noisy.
- Game `0022501149` has no usable pregame injury report. It is outside the
  scored range.
- The big-over definition and the tier split were chosen after looking at
  games 1–70. The check involves no agent, so no agent result is affected, but
  the market and baseline figures here are descriptive, not a pre-registered
  test.

## Reproducing

```sh
npx tsx docs/evidence/projection-headroom/scripts/export.ts
uv run --with pandas --with numpy --with scikit-learn \
  python docs/evidence/projection-headroom/scripts/analyze.py
```

The export reads the pinned releases through the repository's adapters
(Doppler credentials for anything not already cached) and writes to the
ignored `.cache/projection-headroom/` directory.
