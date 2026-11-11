# Forecast scoring and release

The host creates a `ForecastRecord` in each arm and replicate's private run directory and binds `forecastSession` to its scheduled game, projection source, pinned reference model, replay clock and per-game metering. The session exposes `validate_forecast(draft)`, `freeze_forecast(draft)` and `read_feedback()`. Drafts use the V1 forecast format. Each player’s probability of starting must be at most their probability of playing. Equal probabilities are valid. A rejected draft returns a reason and can be corrected before tip. A successful freeze locks the snapshot in SQLite against the game's reference receipt. Reopening the record preserves that lock.

Postgame feedback opens at 9 a.m. Eastern on the calendar day after tip. Pregame feedback selects the immediately preceding Celtics game. Both paths call the evaluation function `scoreGame`. Its player boxes, forecast fields and scores form the feedback payload. A missing submission receives the reference forecast's scores and the status `no_forecast` so reports can include or exclude those games.

When V1 excluded the preceding game, pregame feedback returns its game ID, the status `excluded` and the recorded reason.

## Reading a game score

- Each pinball mean averages the seven levels per player, then the eligible players in the game. Minutes include the DNP mass at zero. Production and its coverage use players who played. Minutes also report conditional coverage over players who played, using their stated minutes percentiles. Both coverage measures include their endpoints. A metric with no eligible players has count zero and mean null.
- Play Brier and ceiling candidates exclude the last pregame report's Out and Doubtful players. Start Brier uses known starter flags. The tier cuts follow the headroom analysis, with right-inclusive bounds at 5, 15 and 26 reference expected minutes. The tier summaries include the full dated roster, including Out and Doubtful players. The headroom table excluded those players. Expected minutes integrate the full minutes distribution.
- Ceiling picks use the unconditional probability of strictly beating the reference's conditional 85th percentile. A DNP pick remains in the denominator and is counted as a void. Tier summaries partition the game's picks. For the reference benchmark, pool the reported weighted numerators and denominators before dividing. The weight is the reference probability of playing.
- Market evaluators can use the distribution's inclusive or strict probability function. A flat segment contributes its entire probability mass when its value meets the specified inequality.
- Cost is in US dollars and elapsed wall time in milliseconds, supplied by the host for the game being scored.

## Fantasy points

Verified November 11, 2026 against the [DraftKings NBA Classic scoring rules](https://www.draftkings.com/help/rules/nba/classic). Each point scores 1, each made three adds 0.5, a rebound scores 1.25, an assist 1.5, a steal or block 2, and a turnover −0.5. Reaching double digits in two of points, rebounds, assists, blocks and steals adds 1.5 once. Reaching three adds 3 once. The scoring table lists both bonuses, each marked “Max 1 Per Player”. It gives no explicit stacking example. V1 applies each qualifying bonus once, for 4.5 bonus points on a triple-double.

Nikola Jokić’s March 7, 2025 triple-double against Phoenix provides a worked check. His 31 points, three made threes, 21 rebounds, 22 assists, three steals, zero blocks and four turnovers yield 95.75 before bonuses. Adding 1.5 and 3 reproduces the reported 100.25 DraftKings points. [NBA box score](https://www.nba.com/game/phx-vs-den-0022400909/box-score) · [FantasyLabs game scoring recap](https://www.fantasylabs.com/articles/nba-dfs-picks-breakdown-on-draftkings-monday-march-10/)
