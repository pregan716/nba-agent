# Running chronological v3 games (SPO-853)

The launcher connects Pi research, package freeze, assembler/Jev replay, feedback
release, postgame reflection and the next game. `--memory=M0` through `M4` selects
explicit permissions. Pi is the launcher harness; the older harness remains
available to fixtures through its existing API.

## Launch preflight and assembler failures (SPO-858)

Before loading data or creating model providers, the launcher resolves the pinned
assembler image and, when research code execution is enabled, the pinned sandbox
image with `docker image inspect`. Both must already exist locally. A missing
image or unavailable Docker daemon stops launch with the affected role and pin;
no model calls are made and the launcher does not pull images automatically.
Build or pull the exact image first, or start a new run with the new immutable
pin. Scripted and baseline runs check only the assembler because they do not use
the research sandbox. Baseline presets disable code execution and record the
standard `none@sha256:…` sandbox identity, independent of the local sandbox pin.
Every launch, including resume, runs this preflight.

An `AssemblerInfrastructureError` ends the research session as an infrastructure
failure without another session attempt. The record retains `retryable: false`
and `failureKind: assembler_infrastructure`; resume honors that decision even
if the process stopped after recording session end but before phase end. Other
infrastructure failures keep their existing bounded retry behavior.

SPO-859: a newly recorded assembler infrastructure failure also records
`run_halted`, checkpoints the run, and stops before postgame or any later session.
No `run_end` is recorded. Once Docker/images are repaired, explicitly relaunch
with the same configuration: preflight runs again, the failed session is skipped,
and execution continues at the next unstarted step. A failed pregame is replayed
as `invalid_package` (unscored) before its postgame session. The failed session is
not retried, and a previously recorded failure does not halt that resume again. This guard
is not registry publication; SPO-848 remains the longer-term image-distribution
work.

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
and builds selected decision datasets from the pinned release with `buildDataset`.
Both corpus modes evaluate only development games 1–10. The full 82-game
schedule remains in the manifest so split tags never shift when selecting games.
Variant diagnostics load only those ten games; baseline diagnostics additionally
load games 11–20 and the 2024–25 Celtics regular season for fitting. Neither path loads holdout inputs. The manifest
refuses holdout evaluation and the baseline runner refuses holdout training.
There is no holdout override: a separate R6 reveal path must own that decision.
The analyst uses `ANTHROPIC_API_KEY`; Jev uses `TYPESAFE_API_KEY`. Those secrets
remain in the launcher process. Pi receives only its scoped proxy credential;
assembly receives no provider credentials. Corpus access uses the existing
Doppler/R2 configuration in `DopplerStore`.

```sh
npm run sandbox:build
# Run in the environment that supplies corpus credentials and both provider keys:
npm run launch -- --purpose=fixture --memory=M3 --run-id=corpus-diagnostic --assembler-image=<assembler-digest>
```

This is infrastructure-only diagnostic work using the placeholder
prompts (the fixture default). It can incur provider costs, and the placeholder does not instruct an
analyst to produce a research policy. A pregame with no frozen package is recorded
as `invalid_package`, never silently evaluated as generic Jev. The scripted
command above is the useful no-LLM acceptance path for this issue.

## Pilot runs (SPO-855)

`--purpose=pilot` runs the v3 research prompts (`research-v3`) under Pi on the
development games only, with the per-variant memory-permission instructions. It
makes live Anthropic and Jev calls and costs money; get the spend approved first.

```sh
doppler run --project nba-agent --config prd -- npm run launch -- \
  --purpose=pilot --memory=M3 --games=10 --run-id=pilot-m3 \
  --assembler-image=<assembler-digest> \
  --probe=<analyst-probe.json> --jev-probe=<jev-probe.json>
```

`--games=N` (1 to 10) limits a run to the first N development games.
`--prompts=research-v3|infrastructure` overrides the default, which is
`research-v3` for pilots and `infrastructure` for fixtures; a fixture run may
select `research-v3` for a smoke test. A pilot refuses the infrastructure
prompts. **Scored launches are refused** until a research budget profile is
approved (the brief's one Open decision); they also refuse a `local@` assembler
image and keep the manifest's probe, persistent-host and checkpoint-sink checks.
Development ceilings are labelled `development-limits-not-a-budget-profile` with
`pilotApproved: false`; they are not an accepted budget profile. See
[research-prompts.md](research-prompts.md) for the prompt set and the probes.

Optional `--probe=<analyst-probe.json>` and `--jev-probe=<jev-probe.json>` preserve
existing probe records in the manifest. This command does not generate probes;
`scripts/contamination-probe.ts` and `scripts/jev-probe.ts` do.

## Baselines

Run all three baselines over the same datasets/windows:

```sh
npm run launch -- --scripted --mode=baselines --assembler-image=<assembler-digest>
```

The default destination is `.cache/runs/scripted-baselines/r1/`. Constant-rate
and statistical predictors use the existing `fitBaselines`; generic Jev uses the
same trusted replay and answer validation as variant runs. All write the same
`replay_window` shape, with distinct predictor IDs, for later R6 comparisons.
Repeated commands reuse recorded windows and Jev responses.

For a pinned-corpus diagnostic, omit `--scripted`. Only `TYPESAFE_API_KEY` is
needed for model calls in baseline mode; no analyst runs. Corpus baseline
diagnostics evaluate only development games 1–10. Accepted Nov 6, 2026 (SPO-856):
the statistical predictor fits on all 82 Celtics regular-season games in the
pinned 2024–25 release plus games 11–20 of 2025–26. The constant-rate baseline
continues to fit only the warm-up substitution rate. The replay audit command
uses the same training sets. Training game IDs, input hashes, roster policy and
fitted parameters are recorded per predictor. Training/evaluation overlap and
holdout training are refused before predictions. No current-season inputs outside
the selected development games and ten warm-up games are loaded for fitting.
Results on earlier development games remain retrospective diagnostics, never evidence.

**Agreed roster source (Nov 6, 2026; statistical-baseline training and unscored practice states):** the prior-season loader
uses every Celtics player listed in that game's pinned `player_box_scores`,
including DNP rows, as its frozen roster. This is retrospective membership, not
pregame availability evidence: it can omit an unlisted roster member or include
an inactive player. Injury status remains unknown; no announced starters are
inferred. Synthetic timestamps one millisecond before tip are used solely to
adapt that roster to the existing state-builder input shape, not as publication
claims. The `same-game-box-score-v1` policy is included in input hashes and
`trainingOnly` metadata, and both replay selection and execution reject those
datasets. This approximation must never be used for an evaluated game. The
2025–26 loader continues to require dated curated membership and pre-tip reports.

Agreed (Nov 6, 2026, SPO-857): the same prior-season datasets may also supply
up to three fixed, released practice states for analyst package validation when
no earlier run game is released. This extends the original SPO-856
baseline-training-only agreement to unscored validation; all roster caveats
and the prohibition on use for evaluated games above still apply.

The two pinned prior-season gaps (`0022400061`, `0022400230`) are retained in
training provenance with zero windows and an explicit coverage-gap ledger entry.
No events or windows are fabricated. Local verification of the pinned input
produced 4,384 candidate windows and 3,997 qualified windows across the other 80
games; these are data coverage counts, not experimental results.

The tiny synthetic fixture uses a separate synthetic training game solely to
exercise the interfaces; its outputs are not comparative results.

## Record and recovery

`manifest.json` pins source manifests, memory permissions, model roles, harness
settings and image descriptors, code revision, budget limits, decision-dataset
hashes/versions, state schema and supplied probes. Games have development,
warm-up, scored or holdout tags; `replay.datasets` pins the evaluation selection.
Only that selection executes, and holdout selection is refused in every mode.
Changing an input or code revision requires a new run ID; resume refuses a
manifest mismatch.

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
without changing either scoring or temporal-access rules. Fixture runs keep the infrastructure prompt constants by default; SPO-855 adds
the research prompt set for pilots. The warm-up-only statistical training choice above is explicitly Proposed for
user decision. No brief decision was changed, and `feedback.ts` is
untouched so SPO-850 can proceed independently.
