# Five-team evaluation service

The host opens one persistent evaluation pool per development experiment and passes the methods returned by `developmentService(host)` to the architect harness. The service owns the schedule, prices, data mounts, pool and sandbox configuration. Packages and run IDs are the architect's inputs. The host keeps the pool directory and raw run records outside the architect's workspace.

## Requests

| Kind     | Required fields    | Games                                                          | Counts toward the full-run cap |
| -------- | ------------------ | -------------------------------------------------------------- | ------------------------------ |
| `full`   | `package`          | Jan 5–Feb 1, 43 team-games                                     | Yes                            |
| `test`   | `package`, `games` | One to five distinct development team-games before the holdout | No                             |
| `check`  | `runId`, `window`  | `opening` (41) or `late` (42)                                  | Yes                            |
| `repeat` | `runId`            | Same package, trained models and team-games as that run        | Yes                            |

Each request is a JSON object with a `kind`. For a test, each element of `games` has `teamId` and `gameId`. Times in the fixed windows follow the brief's UTC schedule selection. Each run gets a fresh artifact store. The game loop can use the earlier released reference history.

Reference fits are shared between pools in `.cache/reference-fits` under the data checkout. Entries are keyed by the data versions, pinned projection runtime and source, and the full model input (including team, game and cutoff). Each pool still records its own immutable reference receipt. Concurrent callers serialize cold fits and validate stored receipts before reuse.

The default pool holds $1,000 and admits up to 12 full evaluations. The SQLite ledger reserves the maximum run cost atomically across processes before starting work. Completion releases the unused reservation and retains actual spend plus unresolved provider charges. A refused budget or cap request is recorded. A failed admitted full run still uses its full-run slot. After a host process dies, the next service instance reconciles its reservation from the run record. Unsettled provider requests remain charged at the reserved amount. Full-run limits, UTC windows and replay allowances belong to the host profile and are pinned when a pool opens.

## Scores and archive

Minutes pinball is averaged over roster players, then over team-games. The target divides the system mean by the reference mean. Paired intervals use 10,000 Mulberry32 resamples with seed 8542026 and the 5th and 95th percentiles. Both sides of a shared NBA game stay together in each draw. Undefined ratios are null. A positive lower endpoint on the system-minus-reference difference for fantasy-point pinball or play Brier flags the configuration. Missing forecasts use the game's reference and carry a fallback flag. Unavailable outcomes are reported separately.

Results include v4 non-prop metrics overall and by game, team, reference role tier and player. Comparisons require matching team-games, tips and outcome availability. They report cost and time, leave-one-game-out influence and the estimate without the five most influential games. Repeat results also compare against their parent.

The development archive contains the submitted package and a forecast record for each team-game with its team-perspective spread, game total, artifact values, fallback flag and recorded failure reason. A null line means the value was unavailable or the older replay did not record it. The `calls` section includes rendered instructions, tasks, transcripts and replies. The `sandboxSteps` section includes the file, action, exit status, limit and captured stderr tail, including for code-only failures. Both traces carry the team-game and event sequence number.

The architect's SQLite `game_lines` table contains `game_id`, `team_id`, `scheduled_tipoff`, `spread` and `total`. Each row represents one development team's perspective at scheduled start. A game between two development teams has two rows with opposite spreads. Coverage is limited to 2025–26 games before the holdout involving Boston, Oklahoma City or Washington. Denver and Memphis appear only as opponents in the eligible schedule. Player prop lines and scores derived from them remain excluded from the data view, game loop and archive.

| SQLite table location                   | Tables                                                                                                                                                                                                                       |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architect view and game session         | `schedule`, `posts`, `transcripts`, `lineups`, `injury_players`, `injury_teams`                                                                                                                                              |
| Architect view and released game shards | `player_box_scores`, `team_box_scores`, `team_period_scores`, `events`, `lineup_stints`, `player_stints`, `matchup_stints`, `player_game_summary`, `team_game_summary`, `possessions`, `unavailable`                         |
| Architect view only                     | `rosters`, `game_lines`                                                                                                                                                                                                      |
| Game session only                       | `session`, `evidence`, `injuries` and `injury_team_snapshots` (latest report), `player_profiles`, `player_reference`, `player_season_stats`, `player_2024_25_summary`, `player_career_summary`, `player_identity_exceptions` |
| Game shards only                        | `games`, `_history_metadata`                                                                                                                                                                                                 |

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

The separate operator command `final POOL_DIR PINNED_SANDBOX PINNED_PROJECTION NOMINATED_RUN_ID` closes development and evaluates an eligible nomination on all 164 Denver and Memphis team-games. It runs the nominee, the agents-off ablation if agents are declared, and the per-game artifact reset ablation. The runs still to do go side by side in one process; a run whose record already exists is not run again. If one run fails, the others are left to finish before the failure is reported. Final runs are outside the development pool and archive. The amended brief retains ceiling scores and drops player-prop market tests and big-over picks.

### Leakage reviews

The host scans each submission before reserving evaluation funds or building models. Checks, repeats and final nominations review the stored package again. The scan uses the pinned season player and team identity dimensions, opening player profiles, the Boston staff reference, and the Coaches tables from all 30 archived NBA CommonTeamRoster responses. The roster digests in `config/review-coach-rosters.json` are verified against the existing player-reference release. The reviewer's only user message is the configuration, including its submitted hypothesis. The host uses `ANTHROPIC_API_KEY` for a fresh Opus request after the package passes the scan and schema checks.

Run `npm run evaluation:reviews -- POOL_DIRECTORY` to list accepted submissions. Add a review ID to print its configuration, hash, findings, decision, reasons and reviewer spend. This command reads the local review record without model credentials or data access. A pending entry means the process stopped before recording a decision. A failed review means the reviewer was unavailable. The architect can submit the same configuration again in that iteration. A null reviewer spend means usage was unavailable for at least one attempt. Reviewer spend is separate from the evaluation pool.

### Architect iterations

Run `npm run evaluation -- architect POOL_DIR PINNED_SANDBOX PINNED_PROJECTION` once per iteration. Use the same pool directory for the experiment. The command starts a fresh Pi conversation on `claude-opus-4-6`; A5b owns the final architect prompt. A submission that reaches review and is rejected ends the iteration with reasons available in the iteration archive. The nominee passes leakage review before development closes. A rejection leaves development open. The separate final process verifies the accepted configuration hash and bytes against the recorded review. The operator runs the separate final command after the human review sample.

Add `--only=test` (or another comma-separated list of kinds) after the image references to restrict what that iteration may submit. A refused kind returns an error to the architect and leaves the iteration open. The architect pilot uses this to make the first submission a test run.

On the cloud host, `scripts/cloud/architect-iteration.sh POOL_DIR MAX_USD [--only=test]` runs one iteration under a watcher (`scripts/pilot-watch.ts`). The watcher reads the pool directory and stops the run on the first team-game with no forecast in a full, check or repeat evaluation, on more than five failed agent calls in one such evaluation, on any evaluation, test runs included, that fails after the iteration starts, or when the model spend recorded in the pool passes `MAX_USD`. It leaves a test run's missing forecasts alone. The script checks the watcher's arguments before it starts the run, stops the run if the watcher fails or cannot read the pool, and exits nonzero unless the run ended by itself with status 0.

For the final evaluation, run `scripts/cloud/final-evaluation.sh POOL_DIR MAX_USD RUN_ID` on the cloud host. It uses the same watcher, process-group shutdown, and exit rule, with logs prefixed `final-`. The watcher includes all final modes in pool spend and enforces missing-forecast and agent-failure limits per mode. Modes completed before the prelaunch snapshot are treated as history, while their spend still counts. Its output contains progress counts, failure reasons and spend.

The architect can run Python against the filtered SQLite export at `/data/session.sqlite`. Its notes and draft files live in a separate persistent workspace. Write package metadata in `package.json` and Python files separately. Each submission records the draft or archived package, the named open hypothesis, and its expected effect before evaluation. The submission record identifies the experiment hypothesis for analysis. A test run returns its run ID in the same conversation and the iteration continues; a full, repeat or check evaluation, a nomination or a review rejection ends it. The package’s hypothesis text describes the configuration and is part of its reviewed bytes. The iteration waits for evaluation to finish, which may take hours for a full run. The architect makes no model requests during this wait. The next iteration can inspect development scores, forecasts, agent calls and code through the filtered archive.

### Architect models

The architect runs on `claude-opus-5-5` unless `--model=ID` names another permitted model: `claude-opus-4-6`, `gpt-6.2-sol` (OpenAI), `gemini-4-neon` (Google) or `accounts/fireworks/models/kimi-k3p1-pro` (Kimi K3.1 Pro, served by Fireworks). The credentials are read from `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` and `FIREWORKS_API_KEY`. The tools, data view and budgets are the same for every model. The three other-provider models receive the round-one prompt with one addition: a target of 0.75 for the minutes ratio against the reference, and a nomination passage that matches it (`TARGET_PROMPT`). The Anthropic models receive the round-one prompt as it is. A round-two pool has the round-two prompt. A pool belongs to the model of its first iteration: an iteration on another model is refused, so pass the same `--model` every time. The reviewer and the game-loop agents do not change with the architect's model.

Prices come from the Pi library's table for each model, and the tests pin the ones in use. The input of a request is held at the dearest of the model's input, cache-read and cache-write prices across its price tiers, and the output at the dearest output price. Every request carries an output limit that includes reasoning tokens, set by the session whether or not the adapter set one. Only Anthropic has a token-count endpoint; for the others the hold's input is the byte bound alone. A reply that reports no input tokens has lost its usage report and is charged its whole hold. A reply that costs more than its hold stops the iteration with an error. The session reads the model each reply names from the provider's own stream events (the adapters do not all pass it on) and records each distinct name as a `reply_model` event. A completed reply that names another model, or none, stops the iteration before the reply enters the transcript or any of its tool calls runs; the reply is still charged. A provider's prefix, dated suffix or difference in case is accepted.

Before the first iteration on a provider, run `doppler run -- npx tsx scripts/architect-provider-check.ts MODEL`. It sends the real prompt and tools, asks for one tool call and one reply, and prints the tokens, the charge and the hold of each request. It makes paid requests costing a few cents.

Architect requests use high reasoning effort (adaptive thinking on Anthropic's models) and prompt caching with five-minute retention where the provider has that setting. The configuration reviewer also uses adaptive thinking at high effort. Each model request reserves its input and maximum output. The input is bounded by the size of the serialised request in bytes plus 1,000 tokens (the preflight count is only an estimate), and priced as a cache write. The reservation is held within the remaining $30 iteration and $350 experiment budgets. Actual usage settles the reservation. Because the bound is several times the real token count, an iteration ends once the balance cannot hold one more request of the conversation's size, which in a long conversation can leave a few dollars unspent; the low-budget warning starts at $3 or at $2 above the current hold, whichever is higher. An interrupted request with unknown usage continues to count against the budget. Tool results include the current balance and a warning at $3 remaining. The host keeps the transcript, submission decisions, review receipts, documents and spend in `architect.sqlite` outside the sandbox.

### Round-two pools

Seed a new, nonexistent pool directory from a completed round-one pool:

```sh
npm run evaluation -- seed-round-two ROUND_TWO_POOL PINNED_SANDBOX PINNED_PROJECTION ROUND_ONE_POOL
```

The seed uses the source pool's nominee as the draft and copies notes, hypotheses and completed development records before the late window. It excludes late checks, final records, previous conversations and budget charges. The new pool has no nominee and starts with its own full-evaluation, evaluation-dollar and architect budgets. Historical records retain their original run IDs and environment pins and are available through archive and compare; list marks them as inherited. Source records are read-only snapshots, so a different code revision does not require reopening or migrating the old pool. New evaluations retain the normal current-environment guard.

Pool metadata records round 2 and the baseline run, package hash and source environment. The host can read the round through `developmentService(host).round()`. The budget tool reports `agentGate.met` and `agentGate.qualifyingRunId`. Nomination requires a new completed full evaluation with successful agent replies in at least half its distinct team-games. Imported runs, checks, repeats and tests cannot satisfy the gate; multiple replies in one team-game count once. Once the gate is met, a code-only package may be nominated, including the inherited baseline. In a round-two pool the architect session uses `ROUND_TWO_PROMPT` (`src/architect/prompt.ts`): the round-one text with a section on the round's terms, including the target of a 0.75 minutes ratio against the baseline (a goal the service does not enforce), and the first message of each iteration names the baseline run. A round-one pool gets the round-one prompt unchanged.

For round two, append the operator-only path `ROUND_ONE_POOL/final/BASELINE_RUN_ID/nominated` to the final command (or as the fourth argument to `scripts/cloud/final-evaluation.sh`). The service verifies the baseline package, original environment and the same 164 DEN/MEM team-games before execution, then returns `againstRoundOne` with paired comparison estimates and intervals. The baseline final record is read outside the new pool and is never added to its development archive.
