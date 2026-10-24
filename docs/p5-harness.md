# P5 agent harness (SPO-781)

`src/harness/` is the v1 homemade harness: a hand-written tool loop over direct Anthropic SDK calls, plus the three null baselines, the prompts, the harness-version builder, the contamination probe and the trusted launcher. It holds exactly the three contract handles the brief allows (session endpoint, metered model endpoint, memory-mode instructions) and nothing else. Workspace enforcement, sandbox lifecycle and token metering live in P3 and P4 and are not duplicated here.

## Pieces

| File | Role |
| --- | --- |
| `prompts.ts` | System prompt, phase prompts (pregame, commit, postgame, mandated postgame), memory-mode instructions (stateless, season-editable, season-append-only, window). Every string is part of the harness version. |
| `loop.ts` | `analystHarness(options)`: the model loop. `offeredTools(context)` picks the tools the model sees. |
| `baselines.ts` | `marketBaseline`, `randomDeviationBaseline(seed)`, `naiveStatsBaseline(parameters)`. Same `Harness` type, no model calls. |
| `version.ts` | `harnessConfig(options)` fills the run config's `harness` block so P4's manifest hash covers identity, prompts, memory instructions, tool definitions, submission format, retry policy, loop parameters (effort, thinking, max tokens, timeout, turn and nudge caps), SDK version, sandbox image and code revision. |
| `presets.ts` | `presetConfig(...)` builds a whole run config for the launcher, with the generous, **not approved** pilot budget `pilot-generous-v0-not-approved` and a placeholder price schedule that must be verified before any cost claim. |
| `scripts/run.ts` | Trusted launcher (`npm run launch -- --mode=… --memory=… --purpose=…`). The only place that holds the Anthropic key, opens the corpus and constructs the runner. |
| `scripts/contamination-probe.ts` | `npm run probe` (or `--dry-run`): asks the pinned model, with no tools, for 2025-26 outcomes and events; writes a JSON record shaped for `config.contaminationProbe`. |

## The loop

Fresh conversation every invocation, for A and B alike; memory is the workspace and the environment enforces it. One `Anthropic` client per session over `handles.model` (`baseURL`, scoped `apiKey`), `maxRetries: 0`, an explicit 10-minute timeout (non-streaming calls need one), and only the request fields the metering proxy accepts: `model`, `max_tokens`, `system`, `messages`, `tools`. The proxy pins the model, thinking mode and effort.

- **Opening message.** Pregame: the pregame prompt, the full `context` result, and the question set from `list_questions`. Postgame: the postgame prompt (mandated variant for configuration C), the context, and `read_released_results` for the game. System = `SYSTEM_PROMPT` + the memory instruction handed in by the runner.
- **Tools offered.** `offeredTools(context)`: tools legal in the phase (pregame spans commit, so `begin_commit` and `submit` are offered), whose capability group is enabled for the run (`context.capabilities`, added to the contract by this issue), excluding workspace tools in a stateless run.
- **Turn handling.** Assistant content is echoed back verbatim, thinking blocks and signatures included. Each `tool_use` becomes a `session.call`; a `SessionError` becomes a `tool_result` with `is_error: true` and the error's JSON (`error`, `message`, `problems`, `attempts_remaining`), so a rejected submission comes back with every problem named and the model fixes it. Any other error is infrastructure and propagates. Every `contextEvery` tool rounds the harness refreshes `context` and, if the budget warning is set, appends a budget line.
- **Submission.** The model drives `begin_commit` and `submit` itself. After a successful `submit` the pregame loop ends. If the model ends its turn without submitting, the harness nudges up to `nudges` times, then returns; the runner records `invalid_output` with no market filling, as the brief requires.
- **Budget.** A `429` from the proxy naming `research_tokens` means the research allowance is spent: the harness calls `begin_commit` on the model's behalf (the brief: stop research and require a submission from the reserve) and asks for the submission. A hard `tokens` limit, or any limit in postgame, ends the loop. A `max_tokens` stop gets a short "cut off, proceed" message.
- **Safeguards.** `maxTurns` caps model turns per phase; the budget is the real limit.

## Baselines

All three use only session tools and never call the model; the launcher gives them a provider that throws.

- **Market**: `p = q`. Scores exactly zero by construction.
- **Random deviation**: `p = clip(q + U[-0.15, 0.15])` with a seeded PRNG keyed by seed and game id, so a replicate reproduces. Rationale attached when the deviation reaches 0.05.
- **Naive stats**: for each question, the player's eligible 2025-26 box scores via `query_game_history`; `P(over) = (overs + 0.5) / (n + 1)` shrunk toward the market with weight `n / (n + k)`, `k = 10`; market probability below `minimumGames = 5`. Pushes count as not over. Documented here as the brief asks.

## Harness version

`harnessConfig` is the single constructor of the `harness` block; the test shows that changing a prompt, a tool description, the effort, or switching to a baseline changes the manifest's `harnessVersion`, and that the SDK version recorded is the installed one. Baselines get their own identity (`baseline-<name>-v1`) and empty tool definitions, so a baseline run never shares a harness version with the analyst.

## Contamination probe

`npm run probe -- --dry-run` prints the prompt. Without `--dry-run` it needs `ANTHROPIC_API_KEY` from Doppler (`doppler run --project nba-agent --config prd -- npm run probe`), calls the pinned model with no tools and adaptive thinking, and stores `{ model, prompt, output, executedAt, tools: [] }` plus usage under `.cache/`. Pass that file to the launcher with `--probe=<file>`; `manifest()` refuses a scored run without it. The prompt asks separately for regular-season outcomes (contamination if known) and 2025 offseason moves (pre-season knowledge, not contamination), and asks the model to label each item known, unsure or unknown.

## Launcher

```
npm run launch -- --mode=market --purpose=pilot --run-id=market-dev
doppler run --project nba-agent --config prd -- npm run launch -- \
  --mode=analyst --memory=season --purpose=pilot --run-id=pilot-b-1 --code
```

`--mode` is `analyst`, `market`, `naive-stats` or `random-deviation`; `--memory` is `stateless` or `season`; `--revision`, `--process`, `--effort`, `--replicate`, `--seed`, `--root`, `--probe=<file>` and `--code` (sandbox on; needs `npm run sandbox:build`) as named. `--purpose=pilot` runs the ten development games; `fixture` runs the whole schedule. The launcher prints the harness version and, at the end, submission and phase-status counts.

Smoke-checked against the pinned corpus: `--mode=market --purpose=pilot` and `--mode=naive-stats --purpose=pilot` each complete ten pregame submissions (postgame skipped, stateless) in a few seconds with no model call.

## What is not here

- No budget numbers: `PILOT_BUDGET` is a generous ceiling for the pilot and is labelled not approved. The pilot procedure in the brief sets profile v1.
- No scoring: released results carry `score: null` until P6 supplies the scorer.
- No live analyst run was made in this issue; that is the budget pilot, which spends money and is the user's call.
