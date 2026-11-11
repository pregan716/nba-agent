# Running the forecast arms

The development launcher supplies all 82 Celtics games. The runner’s pilot purpose selects the first ten in chronological order. The research prompts are in `src/projection/prompts.ts` (SPO-883): one system prompt shared by both arms, a section on what carries over between games that is the only text differing between them, and the phase prompts. They are part of the harness version. Supply the arm, run ID, replicate ID, pinned research sandbox image, pinned reference projection image and optional record directory. Set the analyst credential in the launch environment. The Pi worker and research container receive scoped session access.

```sh
npm run forecast:run -- no-memory forecast-no-memory r1 "$SANDBOX_IMAGE" "$PROJECTION_IMAGE"
npm run forecast:run -- full-memory forecast-full-memory r1 "$SANDBOX_IMAGE" "$PROJECTION_IMAGE"
```

Use `r2` for the second replicate of each arm. Each run ID and replicate has its own record and workspace. Relaunching with the same manifest resumes that record. The profile uses the carried token and compute accounting with separate, generous development ceilings for pregame and postgame. Scored budget numbers await the pilot.

## What the analyst can use

During initialization, the host prepares reference tables before the analyst clock starts. Arms and replicates reuse immutable receipts in `.cache/reference-projection`. Each analyst phase starts a fresh Pi conversation and research sandbox. Both arms can query released evidence, history, injuries, the schedule and the reference projection. The context includes the Celtics spread and game total at scheduled tip, calculated from pinned team quotes using the SPO-829 method. Player-prop consensus belongs to the evaluator.

- **No memory.** The host records released feedback and skips the postgame analyst session. Python can write temporary files under `/scratch`. The next game starts with fresh scratch space and can request only the preceding game's feedback.
- **Full memory.** Workspace tools and the sandbox mount share the same permissions. Free-form UTF-8 notes in `/workspace/memory` count toward the 50,000-token cap using the recorded analyst token counter. Files in `/workspace/code` may be binary. The aggregate limit is 8,000,000 bytes. For example, add that directory to Python's import path to use a saved module. Context and checkpoints report code bytes.
- **Forecast tools.** `reference_projection({})` returns tonight's forecast and model hash. Use `{list:true}` for available game IDs and `{game_id:"…"}` for a released game's reference and errors. `validate_forecast` and `freeze_forecast` both take `{draft: forecast}`. A successful freeze commits the roster forecast and workspace snapshot together. Postgame opens at 9 a.m. Eastern the following morning. `read_feedback({})` returns the current game in postgame or the preceding game in pregame.

The run record retains the reference forecast and model hash, validation calls and results, frozen forecast or missing status, and the released feedback payload. The release records costs known that morning. The game checkpoint includes postgame costs and elapsed time. Each arm uses only the analyst model role.

For a local two-game integration check, set `FORECAST_SANDBOX_IMAGE` to a locally available immutable research image and run `npx tsx --test test/forecast-arms.test.ts`. The fixture exercises Python file and fitted-model persistence without a paid analyst call.

For post-run scoring and matched comparisons, see [Forecast evaluation](forecast-evaluation.md).
