# Running chronological v3 games (SPO-853)

The launcher connects Pi research, package freeze, assembler/Jev replay, feedback
release, postgame reflection and the next game. `--memory=M0` through `M4` selects
explicit permissions. Pi is the launcher harness; the older harness remains
available to fixtures through its existing API.

## Offline two-game acceptance run

Build the isolated assembler image once:

```sh
npx tsx scripts/assembler-build.ts
```

Use the printed `local@sha256:…` pin below (replace `<assembler-digest>`). Each
command runs two chronological synthetic games, with real Pi and Docker assembly
but scripted analyst/Jev providers. No secrets, corpus downloads or live provider
calls are needed.

```sh
npm run launch -- --scripted --memory=M0 --assembler-image=<assembler-digest>
npm run launch -- --scripted --memory=M3 --assembler-image=<assembler-digest>
```

Default outputs are `.cache/runs/scripted-analyst-M0/r1/` and
`.cache/runs/scripted-analyst-M3/r1/`. `--root`, `--run-id` and `--replicate` select
other destinations. Repeat the identical command to resume; a finished run does
not run research or replay again.

The script writes a fixture package through normal tools, freezes it, and reads
feedback through `read_feedback`. M3 writes `reflection-prior` in the first
postgame and reads it in the second pregame. M0's attempt to read memory is
refused. Both variants are refused the old package, prior session scratch and
current-game feedback during the second pregame. Only the first game's released
trace is available. This script is a test workload, not a v3 research prompt or
an experiment result. It does not execute research code, so its research sandbox
descriptor is the explicit `none@sha256:…` sentinel; assembly uses the supplied
Docker digest. Token counting is synthetic in this offline fixture.

## Pinned corpus and providers

Without `--scripted`, the trusted launcher opens the hash-verified corpus and
canonical identity mappings, builds season pregame evidence with `auditPregames`,
and builds each decision dataset from the pinned release with `buildDataset`.
The analyst uses `ANTHROPIC_API_KEY`; Jev uses `TYPESAFE_API_KEY`. Those secrets
remain in the launcher process. Pi receives only its scoped proxy credential;
assembly receives no provider credentials. Corpus access uses the existing
Doppler/R2 configuration in `DopplerStore`.

```sh
npm run sandbox:build
# Run in the environment that supplies corpus credentials and both provider keys:
npm run launch -- --purpose=fixture --memory=M3 --run-id=corpus-diagnostic --assembler-image=<assembler-digest>
```

This is infrastructure-only diagnostic work using the existing placeholder
prompts. It can incur provider costs, and the placeholder does not instruct an
analyst to produce a research policy. A pregame with no frozen package is recorded
as `invalid_package`, never silently evaluated as generic Jev. The scripted
command above is the useful no-LLM acceptance path for this issue.

`--infrastructure-only` is no longer required. **Pilot and scored launches are
refused until R5b supplies and wires a v3 prompt set and memory-instruction text.**
There is deliberately no flag that marks the placeholder as approved. A scored
launch also refuses a `local@` assembler image. This issue does not enable scored
execution, select the Open budget numbers, or remove the runner's development-only
pilot filter, approved-budget, probe, persistent-host or checkpoint-sink checks.
Existing development ceilings are labelled `development-limits-not-a-budget-profile`
and `pilotApproved: false`; they are not an accepted research budget profile.

Optional `--probe=<analyst-probe.json>` and `--jev-probe=<jev-probe.json>` preserve
existing probe records in the manifest. This command does not generate probes.

## Baselines

Run all three baselines over the same datasets/windows:

```sh
npm run launch -- --scripted --mode=baselines --assembler-image=<assembler-digest>
```

The default destination is `.cache/runs/scripted-baselines-M0/r1/`. Constant-rate
and statistical predictors use the existing `fitBaselines`; generic Jev uses the
same trusted replay and answer validation as variant runs. All write the same
`replay_window` shape, with distinct predictor IDs, for later R6 comparisons.
Repeated commands reuse recorded windows and Jev responses.

For a pinned-corpus diagnostic, omit `--scripted`. Only `TYPESAFE_API_KEY` is
needed for model calls in baseline mode; no analyst runs. Full-season baselines
fit games 11–20, the fixed warm-up set, and record training IDs, hashes and
parameters. Results on earlier development games are retrospective diagnostics,
never evidence. The tiny synthetic fixture fits its first game solely to exercise
the interfaces; its outputs are not comparative results.

## Record and recovery

`manifest.json` pins source manifests, memory permissions, model roles, harness
settings and image descriptors, code revision, budget limits, decision-dataset
hashes/versions, state schema and supplied probes. Games have development,
warm-up, scored or holdout tags. Changing an input or code revision requires a
new run ID; resume refuses a manifest mismatch.

`record.sqlite` is the append-only hash-chained record. Per-game `replay_manifest`
events provide the R3 manifest view without creating a separate database. Thus
research, freeze, Jev responses, window scores, feedback and checkpoints share
one durable log. `replay_window` stores state, actual action, prediction, failure,
validation and score; reapplying `scoreWindow` needs no corpus or provider.
`policy_game_end` and `game_end` report `invalid_package` when a package is absent
or fails its first eligible window; the next game still runs. Other per-window
failures retain the existing R3 failure accounting.

Workspace snapshots live in content-addressed `blobs/`; `frozen-packages/` holds
receipts and immutable packages, `feedback/` holds the released traces, and
`assembly-cache/` contains content-checked deterministic assembly results. The
record and blobs are the checkpoint authority; the latter directories can be
reconstructed or recomputed. Do not edit run contents to resume.

An interrupted uncommitted research/reflection attempt restores its starting
workspace and consumes an attempt under the runner's existing retry policy. A
published freeze receipt is a durable commit: pregame does not run again. During
replay, already recorded Jev responses and scored windows are reused. An answer
received externally but not yet durably recorded may require another provider
call; this is not an exactly-once guarantee across the network. Postgame starts
at the existing next-morning 9 a.m. America/New_York release boundary. Scratch
is ephemeral and only permitted memory survives.

Automated SIGKILL tests cover pregame, after freeze/before replay, immediately
after a durable Jev answer, and postgame. They verify one receipt/replay per game,
no repeat call for a recorded Jev answer, correct feedback/memory visibility and
score reconstruction. Unit integration uses a scripted assembler; the documented
commands additionally exercise the real Docker assembler. Run `npm test`,
`npm run check`, `npm run format:check`, `npm run test:sandbox`, and
`ASSEMBLER_IMAGE=<assembler-digest> npx tsx --test test/policy-sandbox.test.ts`.

## Contract integration notes

R3 expects a replay manifest while the chronological runner expects a run
manifest. The scoped `replay_manifest` view reconciles those storage interfaces
without changing either scoring or temporal-access rules. The merged Pi harness
still uses infrastructure prompt constants; only fixture execution is exposed
until R5b replaces them. No brief decision was changed, and `feedback.ts` is
untouched so SPO-850 can proceed independently.
