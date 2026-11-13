# Running the forecast arms

The development launcher supplies all 82 Celtics games. By default, the pilot selects the first ten in chronological order. The research prompts are in `src/projection/prompts.ts` (SPO-883): one system prompt shared by both arms, a section on what carries over between games that is the only text differing between them, and the phase prompts. They are part of the harness version. Supply the arm, run ID, replicate ID, pinned research sandbox image, pinned reference projection image and optional record directory. Set the analyst credential in the launch environment. The Pi worker and research container receive scoped session access.

```sh
npm run forecast:run -- no-memory forecast-no-memory r1 "$SANDBOX_IMAGE" "$PROJECTION_IMAGE"
npm run forecast:run -- full-memory forecast-full-memory r1 "$SANDBOX_IMAGE" "$PROJECTION_IMAGE"
```

Use `r2` for the second replicate of each arm. Each run ID and replicate has its own record and workspace. Relaunching with the same manifest resumes that record. The profile uses the carried token and compute accounting with separate, generous development ceilings for pregame and postgame. Scored budget numbers await the pilot.

## What the analyst can use

During initialization, the host prepares reference tables before the analyst clock starts. Arms and replicates reuse immutable receipts in `.cache/reference-projection`. Each analyst phase starts a fresh Pi conversation and research sandbox. Both arms can query released evidence, history, injuries, the schedule and the reference projection. The context includes the Celtics spread and game total at scheduled tip, calculated from pinned team quotes using the SPO-829 method. Player-prop consensus belongs to the evaluator.

- **No memory.** The host records released feedback and skips the postgame analyst session. Python can write temporary files under `/scratch`. The next game starts with fresh scratch space and can request only the preceding game's feedback.
- **Full memory.** Workspace tools and the sandbox mount share the same permissions. Free-form UTF-8 notes in `/workspace/memory` count toward the 50,000-token cap using the recorded analyst token counter. Files in `/workspace/code` may be binary. The aggregate limit is 8,000,000 bytes. For example, add that directory to Python's import path to use a saved module. Context and checkpoints report code bytes.
- **Forecast tools.** `reference_projection({})` returns tonight's forecast and model hash. Use `{list:true}` for available game IDs and `{game_id:"…"}` for a released game's reference and errors. `validate_forecast` and `freeze_forecast` both take `{draft: forecast}`. After a successful validation, `freeze_forecast({})` locks the most recently validated draft in the current session. A successful freeze commits the roster forecast and workspace snapshot together. Postgame opens at 9 a.m. Eastern the following morning. `read_feedback({})` returns the current game in postgame or the preceding game in pregame.

Each tool result in the analyst’s model request includes the remaining token budget. The next turn at or below the configured warning level, and again at half that level, shows the remaining tokens, compute seconds and tool calls. The warning asks the analyst to validate and freeze in pregame or finish writing memory in postgame. The record links each delivered warning to its model request through the reservation ID in `budget_warning_delivered`.

Both arms can read the following JSON files directly from Python under the sandbox’s read-only `/data` mount. The host prepares them before the analyst clock starts.

| Path | Contents |
| --- | --- |
| `/data/reference/tonight.json` | The current game’s `reference_projection({})` result, including its model hash. |
| `/data/reference/history/<game_id>.json` | One file for each prior game listed by `reference_projection({list:true})`, with the identical forecast, errors, actuals and exclusion information returned for that ID. |
| `/data/feedback.json` | The single `read_feedback({})` payload for this phase. In pregame it describes the preceding game, or gives the unavailable status on opening night. If the preceding game has yet to release, the file is absent. In postgame it describes the current game. |

The run record retains the reference forecast and model hash, validation calls and results, frozen forecast or missing status, and the released feedback payload. The release records costs known that morning. The game checkpoint includes postgame costs and elapsed time. Each arm uses only the analyst model role.

For a local two-game integration check, set `FORECAST_SANDBOX_IMAGE` to a locally available immutable research image and run `npx tsx --test test/forecast-arms.test.ts`. The fixture exercises Python file and fitted-model persistence without a paid analyst call.

For post-run scoring and matched comparisons, see [Forecast evaluation](forecast-evaluation.md).

## Continue the V5 pilot through game 20

From the checkout with the merged continuation support, use the retained run directory, original run IDs and replicate, and the immutable images selected for the extension. The final positional argument is the directory **containing** the two run IDs. These commands use the normal metered analyst.

```sh
npm run forecast:run -- no-memory v5-pilot-no-memory r1 "$SANDBOX_IMAGE" "$PROJECTION_IMAGE" .cache/runs --continue --through-game 20
npm run forecast:run -- full-memory v5-pilot-full-memory r1 "$SANDBOX_IMAGE" "$PROJECTION_IMAGE" .cache/runs --continue --through-game 20
```

Game numbers are one-based. A fresh pilot defaults to games 1–10. An explicit end may range from 1 to 20. The extension starts after the original pilot's final game, once every original game has ended. It appends a timestamped `continuation` event with the original manifest digest, the new configuration and the inclusive game range. The original manifest and game events remain available. A retry with the same command and configuration resumes the extension; a different configuration is refused. Full memory resumes the prior workspace, and each arm reads its own recorded game 10 feedback.

The extension uses `forecast-pilot-caps-v2`. Fresh pilots explicitly requesting an end past game 10 also use these caps for their whole run.

| Limit | Pregame | Postgame |
| --- | ---: | ---: |
| Charged tokens | 260,000 | 225,000 |
| Sandbox compute seconds | 300 | 300 |
| Tool calls | 80 | 80 |
| Wall seconds | 2,700 | 1,800 |

The warning fires at 80,000 tokens remaining and again at 40,000 (raised from 50,000 after the first attempt at games 11–20; the profile id changed from `forecast-pilot-caps-v1`). The profile retains the 0.1 cache-read weight, the 50,000-token memory cap and the original per-call sandbox limits. Pricing uses the Opus 4.6 standard schedule. These caps are approved for the pilot extension only. Games 11–20 will run again as warm-up for the scored experiment.

The original `run_end` closes the first segment. A separate `continuation_end` closes the extension and enables capture of its market consensus. To compare only the extension:

```sh
npm run --silent forecast:evaluate -- --games 11-20 .cache/runs/v5-pilot-no-memory/r1 .cache/runs/v5-pilot-full-memory/r1
```

Omit `--games` to include both segments. The report identifies the configuration used for each range, including its revision and budget. Comparisons check the original and continued settings across arms even when the report covers only one segment.

## Check analyst connectivity before a paid run

On the run host, supply the analyst credential and run the smoke check before launching either arm:

```sh
doppler run --project nba-agent --config prd -- npm run forecast:smoke
```

This sends one real, billable request asking for a short reply with the forecast output limit (32,000 tokens). It uses the same streaming provider as the run and prints the model, stop reason and actual usage. A failure exits non-zero. The command needs no run directory.

If a forecast phase exhausts its infrastructure retries, the runner checkpoints the failed attempts and exits non-zero. Fix the underlying problem and repeat the same launch command. The runner restores the workspace at the start of the failed attempt and retries that phase. The record retains earlier attempts and their costs. A budget-limited session or a completed pregame without a frozen forecast follows the usual release and scoring rules.
