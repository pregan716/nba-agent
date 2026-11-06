# Policy packages, assembler and Jev — SPO-841

R3 connects a frozen Python package to the existing `windows-v2` replay, per-question validator and scorer. `src/policy/` owns package validation, isolated assembly, fixed requests, replay traces, feedback access and the typed contamination probe. `MeteringProxy.jev` is the trusted replay role; the analyst's scoped HTTP endpoint still accepts only Anthropic Messages.

## Package and freeze

The agent writes `packages/<game_id>/` through the workspace tools or mediated research filesystem. The package contains `assemble.py`, optional components, and `manifest.json`:

```json
{
  "stateVersion": "state-v1",
  "components": {
    "assemble.py": "<SHA-256 of the actual bytes>",
    "components/instructions.txt": "<SHA-256 of the actual bytes>"
  },
  "notes": "Free-form notes"
}
```

Every file except the manifest must appear in `components`, including the entry point. Paths are relative; symlinks, hard links, devices, unlisted files, more than 256 files or more than 8 MiB are refused. The manifest and all file hashes form the package identity. See the runnable [hand-written package](../../examples/policy/assemble.py).

`freeze_package` takes no agent-supplied game id or path. It validates hashes and schema, copies the bytes into a staging directory, loads the entry point inside the assembler container, checks the trusted logical clock again, and atomically renames the snapshot into the run's `frozen-packages/<game_id>/`. Both clock checks require strictly before scheduled tip. Identical pre-cutoff retries return the same receipt; changing a frozen package is refused. A failed freeze returns `status: invalid_package` and a reason, publishes no snapshot, and permits fixing the draft before cutoff. The replay caller passes a final failed freeze through `replayPolicy.invalidPackage` to mark the game unscored.

Snapshots are outside the agent workspace, with read-only files/directories. The workspace service checks the durable receipt on write, append, delete, mkdir and filesystem authorization; this also covers the mediated research mount. Old packages cannot be listed or read in a new game's session. With the policy tools installed, the current package is writable even for stateless/append-only memory configurations; ordinary memory permissions are unchanged. The host administrator can modify files, but the replay verifies the snapshot's hashes before assembly and before cache use. Immutability is an agent/tool boundary, not a claim against a privileged host administrator.

## Assembler API and containment

`assemble(state)` returns exactly:

- `jev_state`: string;
- `instructions`: strings for `substitution`, `count`, `exit`, `entry`;
- `criteria`: `substitution.true`/`false` strings; `count` descriptions under `none`, `one`, `two`, `three_or_more`; `exit` and `entry` descriptions keyed by exactly the observable state's respective player sets;
- `diagnostics`: JSON object.

The assembler never receives a window, actual decision or future rows. A fresh container/interpreter receives only the state on stdin, the read-only package at `/package`, and a writable tmpfs at `/scratch`. There is no workspace or data mount, host PID namespace, provider credential or network. The root filesystem is read-only, all capabilities dropped, privilege escalation disabled, process count capped at 16, and memory/swap capped equally. Container cleanup follows success, failure, timeout and cancellation. Package validation also executes inside this boundary, never on the host.

The gate uses 15 seconds per window (including both verification executions), 128 MiB memory and a 256,000-byte combined output cap. These are explicit development assembler limits, not the unresolved research budget profile. The immutable image digest, limits, API version, context guard, model settings and determinism rule are in `harness.policy`; package hashes and code revision also identify the predictor. Research harness configs accept the same policy descriptor.

Each new package/state/image combination executes twice, with fresh scratch, fixed Python hash seed and seeded standard-library RNG. Canonical outputs must match. The validated request and diagnostics are then stored in an integrity-checked content cache; repeated execution uses those exact bytes. This catches observed nondeterminism rather than claiming arbitrary Python cannot inspect clocks or OS entropy. The cache makes the accepted request stable through retry/resume. A first-window load/assembly exception is `invalid_package` and leaves the entire game unscored; a later exception is `assembler_error` and scores the existing fallback. Context-limit failures are `assembler_error`, including the first window.

Build and test the real boundary:

```sh
npx tsx scripts/assembler-build.ts
# Use the printed immutable pin:
ASSEMBLER_IMAGE=local@sha256:<digest> npx tsx --test test/policy-sandbox.test.ts
```

The real Docker test plants a host future record and a runner credential, tests network and package writes, verifies fresh scratch, enforces wall-clock and memory failure, and checks request identity/cache reuse. It is explicitly skipped when `ASSEMBLER_IMAGE` is absent; the ordinary unit suite does not claim container isolation coverage.

## Jev request, provider and scoring

The environment constructs four questions. Names, types and eligible option keys cannot be chosen by the package. `count` criteria are sent as the ordered array `none`, `one`, `two`, `three_or_more`. TypeSafe returns score probabilities under `"0"` through `"3"`; the adapter translates those four keys to the contract's semantic names. Missing or extra keys remain invalid. Raw responses, including the original numeric keys, are retained.

The runner calls `POST https://api.typesafe.ai/v1/systemone` with `model: jev-1.14.0`, `state` and `questions`. Only the trusted provider constructor receives `TYPESAFE_API_KEY`. It sends neither long-context nor image headers. Every attempt, raw response, error, versioned response model, latency and usage is written to the hash-chained record. A mismatched response model or invalid usage is recorded and rejected. There is one retry for 429 or transport failure, honoring numeric/date `Retry-After` and cancellation. Other HTTP errors are not retried. Spend is input tokens × $0.042 / 1,000,000, output free; even a rejected model response retains reported usage and cost.

The existing validator and derived-action rule are reused without relaxing them. Invalid answers fall back only for that question. Model probabilities are not summed, normalized, filled or repaired. A malformed `entry` map with valid timing/count/exit therefore retains those other answers. Provider failures remain unscored, with the existing >5% game flag. TypeSafe `max_tokens_exceeded` responses are recorded as assembler errors.

The [System One API](https://docs.typesafe.ai/api/system-one), [Score response](https://docs.typesafe.ai/primitives/score) and [request errors](https://docs.typesafe.ai/api/errors) were checked during implementation. The numeric count mapping is an API adaptation, not a scoring change.

## Proposed brief detail raised in this PR

The API documentation does not expose a tokenizer/count endpoint. The implementation therefore refuses a request when UTF-8 bytes of serialized state plus one question, plus 1,024 bytes of framing allowance, exceed 32,000; it also guards the serialized full request plus 4,096 against 64,000. This is a conservative capacity guard, **not an exact token count**, and can reject requests below the token limit. The brief's Jev settings section now explicitly offers this narrower guard as a Proposed implementation detail for review. An exact tokenizer would change the harness version. No research budget numbers or other Open decision are inferred here.

## Trace, feedback and local validation

`replayPolicy` plugs into the existing frozen-state `Predictor` interface. It records assembly diagnostics and measured wall time, request, raw responses, usage, validation, derived action, actual decision and per-window scores. The trace contains all candidates, including exclusions and failures, plus package/harness identity, aggregate scores, invalid-answer reasons, latency and spend. Saved predictions and received valid responses are reused after a crash; uncertain in-flight calls remain visible as attempts rather than invented usage. A committed trace is published atomically outside the workspace.

`PolicyTools` takes the trusted chronological schedule, current game, logical clock, and prior sample states. `read_feedback` returns exactly the immediate previous game in pregame or current game in postgame, only at/after its next-morning 9 a.m. Eastern release. Explicitly asking for an older/current/future game outside that rule returns the same unavailable error. The schedule's release times are validated. The agent cannot set the clock, supply a trace path, or nominate its own validation states.

`validate_package` snapshots the draft separately and assembles at most three sample states from games released by the logical clock and strictly before current tip. It returns requests and diagnostics, never invokes Jev, and is charged against research compute through the runner's reservation/settlement path. The meter conservatively charges elapsed assembly/setup wall time; limits abort validation and preserve the error in the result. Tests plant current and future samples and confirm they are ignored.

Integration: supply `sessionEnvironment`'s `policy` factory with a `PolicyTools` instance and put `policyHarness(assembler)` in the research harness config. The factory receives only trusted session/run context. Pregame uses a logical instant strictly before scheduled tip; postgame uses the game's release. Call `replayPolicy` during trusted replay, then publish via `PolicyTools.saveFeedback`. The analyst's model handle cannot call the `jev` role. Pi and the chronological learning runner are the subsequent R4/R5 work, not replaced here.

## Generic baseline, probe and gate 2

`genericAssembly` uses a fixed observable-state template and fixed instructions, with no package components or retained memory. The hand-written package goes through freeze and Docker assembly; both use the same request builder, provider, validator and scorer.

`probeJev` sends only typed factual questions with an empty state. Truth and source provenance stay outside the request. It records invalid answers, accuracy against 0.5 chance, Brier against 0.25 chance, and the difference between mean probabilities on true and false statements. The gate runs a small paired opener-result probe and embeds its result in the replay manifest; its own request/response record is retained. Two questions about one game cannot establish absence of contamination. The larger pilot probe and model repeatability evaluation remain R5.

```sh
# Fixture responses, real Docker and pinned audited data:
npx tsx scripts/policy-audit.ts --image=local@sha256:<digest>
# Real Jev, with the credential only in the runner:
doppler run --project nba-agent --config prd -- npx tsx scripts/policy-audit.ts --live --image=local@sha256:<digest>
```

The script uses the opener `0022500083`, verifies the pinned corpus, builds its frozen pregame and windows, runs both predictors, verifies the hash chain, and publishes/reads the postgame traces. Full local records live under `.cache/policy/gate2-*`; the compact [live gate evidence](../evidence/policy/gate2-live.json) records the implementation revision, image, package, dataset, probe, scores and usage. Both predictors scored all 66 eligible windows from 75 candidates, with zero invalid answers or provider failures in the initial gate. This is a development integration check, not evidence of learning or a scored comparison. The decision dataset contains independently marked stoppages, which over-represent fouls/timeouts; it is not all coaching decisions.
