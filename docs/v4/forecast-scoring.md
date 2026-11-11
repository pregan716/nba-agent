# Forecast scoring and release

The host creates a `ForecastRecord` in each arm and replicate's private run directory and binds `forecastSession` to its scheduled game, projection source, pinned reference model, replay clock and per-game metering. The session exposes `validate_forecast(draft)`, `freeze_forecast(draft)` and `read_feedback()`. Drafts use the V1 forecast format. A rejected draft returns a reason and can be corrected before tip. A successful freeze locks the snapshot in SQLite against the game's reference receipt. Reopening the record preserves that lock.

Postgame feedback opens at 9 a.m. Eastern on the calendar day after tip. Pregame feedback selects the immediately preceding Celtics game. Both paths call the evaluation function `scoreGame`. Its player boxes, forecast fields and scores form the feedback payload. A missing submission receives the reference forecast's scores and the status `no_forecast` so reports can include or exclude those games.

## Reading a game score

- Each pinball mean averages the seven levels per player, then the eligible players in the game. Minutes include the DNP mass at zero. Production and its coverage use players who played. Coverage includes both endpoints. A metric with no eligible players has count zero and mean null.
- Play Brier and ceiling candidates exclude the last pregame report's Out and Doubtful players. Start Brier uses known starter flags. The tier cuts follow the headroom analysis, with right-inclusive bounds at 5, 15 and 26 reference expected minutes. Expected minutes integrate the full minutes distribution.
- Ceiling picks use the unconditional probability of strictly beating the reference's conditional 85th percentile. A DNP pick remains in the denominator and is counted as a void. Tier summaries partition the game's picks. For the reference benchmark, pool the reported weighted numerators and denominators before dividing. The weight is the reference probability of playing.
- Market evaluators can use the distribution's inclusive or strict probability function. A flat segment contributes its entire probability mass when its value meets the specified inequality.
- Cost is in US dollars and elapsed wall time in milliseconds, supplied by the host for the game being scored.

## Fantasy points

Verified November 11, 2026 against the [DraftKings NBA Classic scoring rules](https://www.draftkings.com/help/rules/nba/classic). Each point scores 1, each made three adds 0.5, a rebound scores 1.25, an assist 1.5, a steal or block 2, and a turnover −0.5. Reaching double digits in two of points, rebounds, assists, blocks and steals adds 1.5 once. Reaching three adds 3 once. The scorer uses the V1 box calculation, including cumulative bonuses for a triple-double.
