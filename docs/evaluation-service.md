# Five-team evaluation service

The host opens one persistent evaluation pool per development experiment and passes the methods returned by `developmentService(host)` to the architect harness. The service owns the schedule, prices, data mounts, pool and sandbox configuration. Packages and run IDs are the architect's inputs. The host keeps the pool directory and raw run records outside the architect's workspace.

## Requests

| Kind | Required fields | Games | Counts toward the full-run cap |
| --- | --- | --- | --- |
| `full` | `package` | Jan 5–Feb 1, 43 team-games | Yes |
| `test` | `package`, `games` | One to five distinct development team-games before the holdout | No |
| `check` | `runId`, `window` | `opening` (41) or `late` (42) | Yes |
| `repeat` | `runId` | Same package, trained models and team-games as that run | Yes |

Each request is a JSON object with a `kind`. For a test, each element of `games` has `teamId` and `gameId`. Times in the fixed windows follow the brief's UTC schedule selection. Each run gets a fresh artifact store. The game loop can use the earlier released reference history.

The default pool holds $1,000 and admits up to 12 full evaluations. The SQLite ledger reserves the maximum run cost atomically across processes before starting work. Completion releases the unused reservation and retains actual spend plus unresolved provider charges. A refused budget or cap request is recorded. A failed admitted full run still uses its full-run slot. After a host process dies, the next service instance reconciles its reservation from the run record. Unsettled provider requests remain charged at the reserved amount. Full-run limits, UTC windows and replay allowances belong to the host profile and are pinned when a pool opens.

## Scores and archive

Minutes pinball is averaged over roster players, then over team-games. The target divides the system mean by the reference mean. Paired intervals use 10,000 Mulberry32 resamples with seed 8542026 and the 5th and 95th percentiles. Both sides of a shared NBA game stay together in each draw. Undefined ratios are null. A positive lower endpoint on the system-minus-reference difference for fantasy-point pinball or play Brier flags the configuration. Missing forecasts use the game's reference and carry a fallback flag. Unavailable outcomes are reported separately.

Results include v4 non-prop metrics overall and by game, team, reference role tier and player. Comparisons require matching team-games, tips and outcome availability. They report cost and time, leave-one-game-out influence and the estimate without the five most influential games. Repeat results also compare against their parent.

The development archive contains the submitted package and a forecast record for each team-game with its team-perspective spread, game total, artifact values, fallback flag and recorded failure reason. A null line means the value was unavailable or the older replay did not record it. The `calls` section includes rendered instructions, tasks, transcripts and replies. The `sandboxSteps` section includes the file, action, exit status, limit and captured stderr tail, including for code-only failures. Both traces carry the team-game and event sequence number.

The architect's SQLite `game_lines` table contains `game_id`, `team_id`, `scheduled_tipoff`, `spread` and `total`. Each row represents one development team's perspective at scheduled start. A game between two development teams has two rows with opposite spreads. Coverage is limited to 2025–26 games before the holdout involving Boston, Oklahoma City or Washington. Denver and Memphis appear only as opponents in the eligible schedule. Player prop lines and scores derived from them remain excluded from the data view, game loop and archive.

| SQLite table location | Tables |
| --- | --- |
| Architect view and game session | `schedule`, `posts`, `transcripts`, `lineups`, `injury_players`, `injury_teams` |
| Architect view and released game shards | `player_box_scores`, `team_box_scores`, `team_period_scores`, `events`, `lineup_stints`, `player_stints`, `matchup_stints`, `player_game_summary`, `team_game_summary`, `possessions`, `unavailable` |
| Architect view only | `rosters`, `game_lines` |
| Game session only | `session`, `evidence`, `injuries` and `injury_team_snapshots` (latest report), `player_profiles`, `player_reference`, `player_season_stats`, `player_2024_25_summary`, `player_career_summary`, `player_identity_exceptions` |
| Game shards only | `games`, `_history_metadata` |

Filter lineup and injury rows by `game_id` and `team_id`. In `lineups`, `startingLineup` is a JSON array of player names. The parallel JSON array `starterIds` gives their canonical IDs in announcement order. In `injury_players`, `player_id` is the canonical ID for the printed name and team. An unresolved name has a null ID in either table. Both views select the latest eligible post edition per account and post ID, with a permalink in `posts.url`. In `injury_players` and `injury_teams`, `available_at` is the printed report time. These tables retain earlier eligible observations. The game sandbox reads session tables through `nba_data.session()` and released shards through `nba_data.query()`.

Development runs exclude Denver and Memphis from session evidence, including team-keyed player reference rows. The 14 games against development teams before the holdout remain on the session schedule, and attached evidence must precede both the replay cutoff and the attached game's tip. Released-game shards remain league-wide. Final evaluation uses the full pregame session evidence for the nominated run and both ablations.

## Training

Declare Python filenames in the package's `training` list. Each defines `train(path)`, where `path` is a read-only SQLite database built by the training view. The only data mounted for this build are the 2024–25 training export and the submitted Python source. A script returns a JSON-serializable value or binary bytes. For example:

```python
def train(path):
    import sqlite3
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as db:
        return {"games": db.execute("SELECT count(*) FROM schedule").fetchone()[0]}
```

A script named `fit.py` produces `/data/models/fit.py.json` or `/data/models/fit.py.binary` in each game sandbox. The host verifies the hash before mounting it, records the model digest with the run, and reuses the same build for checks, repeats and ablations. Only source files are accepted in a submitted package. The separate configuration reviewer checks for season-derived content embedded in source.

## Local operator commands

```sh
npm run evaluation -- evaluate POOL_DIR PINNED_SANDBOX PINNED_PROJECTION request.json
npm run evaluation -- list POOL_DIR PINNED_SANDBOX PINNED_PROJECTION
npm run evaluation -- archive POOL_DIR PINNED_SANDBOX PINNED_PROJECTION RUN_ID
npm run evaluation -- compare POOL_DIR PINNED_SANDBOX PINNED_PROJECTION LEFT_ID RIGHT_ID
npm run evaluation -- refusals POOL_DIR PINNED_SANDBOX PINNED_PROJECTION
```

Use the repository's data-store credentials and pinned image references. Live specialists read their credentials from `ANTHROPIC_API_KEY` and `TYPESAFE_API_KEY` in the host process. The service prints JSON to stdout.

The separate operator command `final POOL_DIR PINNED_SANDBOX PINNED_PROJECTION NOMINATED_RUN_ID` closes development and evaluates an eligible nomination on all 164 Denver and Memphis team-games. It runs the nominee, the agents-off ablation if agents are declared, and the per-game artifact reset ablation. Final runs are outside the development pool and archive. The amended brief retains ceiling scores and drops player-prop market tests and big-over picks.

### Leakage reviews

The host scans each submission before reserving evaluation funds or building models. Checks, repeats and final nominations review the stored package again. The scan uses the pinned season player and team identity dimensions, opening player profiles, the Boston staff reference, and the Coaches tables from all 30 archived NBA CommonTeamRoster responses. The roster digests in `config/review-coach-rosters.json` are verified against the existing player-reference release. The reviewer's only user message is the configuration, including its submitted hypothesis. The host uses `ANTHROPIC_API_KEY` for a fresh Opus request after the package passes the scan and schema checks.

Run `npm run evaluation:reviews -- POOL_DIRECTORY` to list accepted submissions. Add a review ID to print its configuration, hash, findings, decision, reasons and reviewer spend. This command reads the local review record without model credentials or data access. A pending entry means the process stopped before recording a decision. A failed review means the reviewer was unavailable. The architect can submit the same configuration again in that iteration. A null reviewer spend means usage was unavailable for at least one attempt. Reviewer spend is separate from the evaluation pool.

### Architect iterations

Run `npm run evaluation -- architect POOL_DIR PINNED_SANDBOX PINNED_PROJECTION` once per iteration. Use the same pool directory for the experiment. The command starts a fresh Pi conversation on `claude-opus-4-6`; A5b owns the final architect prompt. A submission that reaches review and is rejected ends the iteration with reasons available in the iteration archive. The nominee passes leakage review before development closes. A rejection leaves development open. The separate final process verifies the accepted configuration hash and bytes against the recorded review. The operator runs the separate final command after the human review sample.

The architect can run Python against the filtered SQLite export at `/data/session.sqlite`. Its notes and draft files live in a separate persistent workspace. Write package metadata in `package.json` and Python files separately. Each submission records the draft or archived package, the named open hypothesis, and its expected effect before evaluation. The submission record identifies the experiment hypothesis for analysis. A test run returns its run ID in the same conversation and the iteration continues; a full, repeat or check evaluation, a nomination or a review rejection ends it. The package’s hypothesis text describes the configuration and is part of its reviewed bytes. The iteration waits for evaluation to finish, which may take hours for a full run. The architect makes no model requests during this wait. The next iteration can inspect development scores, forecasts, agent calls and code through the filtered archive.

Each model request reserves its estimated input and maximum output within the remaining $30 iteration and $350 experiment budgets. Actual usage settles the reservation. An interrupted request with unknown usage continues to count against the budget. Tool results include the current balance and a warning at $3 remaining. The host keeps the transcript, submission decisions, review receipts, documents and spend in `architect.sqlite` outside the sandbox.
