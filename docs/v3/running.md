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
`--prompts=research-v3|research-v3-code|infrastructure` overrides the default,
which is `research-v3-code` for pilots with `--code-predictions`, `research-v3`
for other pilots and `infrastructure` for fixtures; a fixture run may select a
research set for a smoke test. A research set must match the contract:
`research-v3` with `jev-contract-v2`, `research-v3-code` with `jev-contract-v3`
(SPO-874). A pilot refuses the infrastructure
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

**All-teams starter training (SPO-870; agreed Nov 8, 2026).**
`loadAllTeamsTraining(corpus, cutoff, options)` returns `{ datasets, skipped }`.
It selects regular-season team-games from 2024–25 and 2025–26 whose next-morning
9 a.m. Eastern release is strictly before the cutoff. `options.seasons` can
restrict the seasons; `batchSize` (1–100, default 60) bounds input batches.
Only pinned manifest/index paths are read; no bucket listing is used. A partition
containing several games is filtered before roster construction and window building.
Missing box-score rosters, unbuildable inputs, and games with no qualified windows
are skipped with the game, team, season, and reason. Individual excluded windows
retain their existing ledger reasons in otherwise usable datasets.

Every returned dataset has `teamId` and `trainingOnly`, including Boston's current
season. Retrospective rosters include DNP rows, retain unknown injury status and
synthetic timestamps, and use `same-game-box-score-v1`. Boston's 2025–26 rows
instead use the existing curated pregame evidence (`season-pregame-v1`); the
loader does not substitute box-score membership for that evidence. Both policies
are forbidden as evaluation inputs. The existing statistical-baseline loader and
its two empty gap datasets are unchanged.

`buildDataset(input, teamId = BOS)` and the state builder preserve Boston as the
default. Non-Boston datasets keep real team ids in history and bind the target
team into their input hash. For compatibility, `celtics`, `celticsHome`, and
Celtics-named diagnostic fields describe the selected team; an absent dataset
`teamId` means Boston. Training consumers must key rows by team as well as game
and window id, since both teams share the canonical game and event identifiers.

The offline `scripts/team-training-audit.ts` accepts the pre-change experiment's
`datasets.json` plus an optional object-cache directory. It compares all 82 prior
Boston datasets and the 20 development/warm-up datasets, loads prior-season league
training, audits three non-Boston team-games against the experiment's relabeling
method, and checks current Boston training against its pregame-evidence windows.
It never loads the scored or holdout Boston games for compatibility evaluation.
The [Nov 8 audit](../evidence/replay/team-training-audit.json) matched all 102
Boston datasets and all three non-Boston comparisons. The league loader returned
2,442 team-games and 145,712 candidate windows (including individually excluded
windows), skipping four missing-roster team-games and 14 with no qualified
windows. The experiment retained the latter empty-of-qualified-data cases, which
accounts for the coverage-count difference.

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

## Previewing Jev during package validation (SPO-863)

`validate_package({jev: true, samples: 8})` assembles a draft on released prior-game
states and returns Jev's answers alongside each request and its diagnostics.
Both arguments are optional: `jev` defaults to false and `samples` to 3 (1–24).
With Jev off, answers are absent and the summary is null. With Jev on, the summary
reports attempted samples, answered samples, mean substitution probability and
answered counts/means by stoppage group. Invalid answers are errors, not fallback
predictions. Each output identifies the prior `gameId` and `windowId`; no actual
substitution or score is returned.

Selection is deterministic, round-robin across timeout, between-periods, foul,
dead-ball turnover and other stoppages, then across first/second-half periods
(overtime joins the second half), then games. Less-used halves and games are
preferred, with newer released games winning game ties and a hash of game/window
identity breaking window ties. Empty strata are skipped. Before any run game is
released, validation retains the existing three fixed 2024–25 practice states;
a request for more than three returns the available three with a note. No new
prior-season states are added.

Calls use the replay Jev provider, context guard, 60-second request timeout and
retry policy. An oversized request or individual provider failure has null
answers and an error, while other samples continue. Session cancellation and the
whole tool's compute deadline still stop the call. Temporary validation assembly
caches are separate from guarded replay caches so oversized drafts can be shown
with their guard error without ever being sent to Jev.

Each validation remains one pregame tool call and consumes research compute.
Jev usage is priced and recorded separately from analyst tokens under
`<game_id>:pregame:validation:<n>` (`n` increments for every validation, including
assembly-only checks). Requests and responses retain the standard `jev_request`
and `jev_response` event types. Evaluation includes these costs for the variant,
not for baseline predictors, and avoids counting their latency twice in elapsed
time. Tool definitions change the harness version; no manifest fields are added.

The brief records the Nov 7, 2026 approval. The system-prompt description is left
for the separate SPO-855 follow-up; the tool description states the new contract.

## Released decision-window history (SPO-865)

The `game_history` capability exposes `decision_windows` and
`unanchored_substitutions` through `query_game_history`, per-game SQLite shards,
`nba_data.table` and `nba_data.query`. These are pinned replay-derived facts,
never predictions, scoring losses, aggregates or experiment-record data. The
scope is Celtics regular-season decision datasets; other games have empty tables.

The launcher registers its already-built datasets. Other released Celtics games
are loaded on demand by the same reconstruction code; the 2024–25 datasets use
`loadPriorSeasonTraining`, as validation does. The existing prior-season roster
caveats apply: retrospective same-game box membership including DNPs, unknown
injuries and synthetic pregame timestamps, never an evaluated game's roster.
Known prior-season coverage gaps retain their empty windows and ledger entries.

A game must be released, strictly before the current game's scheduled start, and
not the current game. This also holds in postgame; current-game raw history keeps
its existing visibility, but its decision tables stay empty. Window state is the
exact `state-v1` JSON used by replay. Opener sequence is the actual marker's
sequence, not the state cutoff, and is null for boundaries. Excluded windows are
retained. Multiple exclusion reasons are joined with semicolons. Unknown states,
lineups and outcomes remain null rather than being reported as no substitution;
known no-substitution outcomes use empty arrays and `substituted=0`.

The ledger exports every dataset ledger entry, including excluded-window
qualifications as well as unanchored substitution blocks. Mechanism and sequence
span are preserved; players are the Celtics substitution participants in that
span. Coverage-gap entries have null clock/player details.

With `include_metadata=true`, the history tool returns column descriptions and a
`table_description` naming `windows-v2`. In Python use `include_metadata=True`:
`frame.attrs['column_descriptions'][table]` and
`frame.attrs['table_descriptions'][table]` expose the shard dictionaries. Columns
remain ordinary queryable data. Existing history table columns and values are
unchanged; dictionaries live separately in `_history_metadata`.

Exposure identity `decision-history-v1` is recorded on the data-sources axis.
`history-export-v5` shard keys also include the dataset input hash and whether
these decision tables are visible. Existing shards are not reused accidentally.
Rebuild the research sandbox image to include the updated `nba_data` helper;
no prompt text is changed here.

## Set-valued Jev contract (SPO-866)

Non-scripted launches use `jev-contract-v2`. The manifest records
`harness.policy.swapContract`: the contract id, the five size-prior probabilities,
and each warm-up game's id/input hash. The prior is the distribution of qualified
substitution sizes in games 11–20, pinned before the run and shared by all variants
and baselines. The launcher loads those ten datasets even for development
analyst runs; this is evaluator calibration, not extra history made available to
the agent. Historical four-question records and scripted legacy fixtures retain
`prediction-v1`; evaluation preserves their original scoring and refuses
cross-contract comparisons with `jev_contract_mismatch`. Different pinned priors
are also incompatible. Changing the contract or prior changes the harness hash.

The assembler adds `candidates`, an array of 1–8 `{out, in}` sets. Each set has
1–5 distinct eligible players on each side and equal sizes. Sets are unordered;
keys are `out:<lexicographically sorted comma-separated ids>|in:<sorted ids>`.
The request contains `substitution` and `swap`; `instructions.swap` and
`criteria.swap` describe the candidates and the `other` option. When the eligible
bench is empty, candidates and swap criteria are empty and only `substitution`
is sent. The research prompt update is tracked separately in SPO-867.

Swap values require exact keys, finite probabilities in [0,1], and a total within
0.05 of one. Raw answers are retained; accepted values are normalized before all
scoring. Invalid answers use uniform option probabilities. `other` is distributed
once across unlisted legal moves using the pinned prior, renormalized over sizes
with remaining support and uniform within a size. Zero retained prior mass uses
uniform feasible sizes. Exhausted support redistributes `other` proportionally
among listed candidates (uniformly when their total is zero), recording
`other_unsupported`. Ties use lexicographic option-key order. The action is the
highest-probability listed set when substitution probability is at least 0.5;
`other_argmax` is recorded even though the action remains a listed set.

Set log loss uses the actual set's listed or expanded probability, clipped to
[0.001,0.999], with clips counted. Reports include candidate hit rate, set top-1,
mean candidate count and `other` mass on actual substitution windows, including
per-game, stoppage and mid-period breakdowns. Paired game bootstrap reports add
set log loss. Exit/entry Brier uses inclusion probabilities directly, without
multiplying by the observed number of movers. Legacy selection log loss and MRR
normalize inclusion probabilities to one; these columns do not make the contracts
comparable. Trace validation includes candidates, normalized swap probabilities,
expanded per-set probabilities, inclusion marginals, count distribution and flags.
`validate_package` uses the same candidate checks and returns derived quantities
when `jev: true`; it never returns sample outcomes. Decision-history tables remain
dataset facts only and contain no run predictions or scoring losses.

An invalid candidate list is a window-level `assembler_error`, including on the
first window. No Jev call is made. It receives an environment-only fallback:
empty candidates, all swap mass on `other`, substitution 0.5, and empty action.
A first-window execution failure still invalidates the whole package. Later
execution failures receive the same scored fallback. Neither an assembler nor a
Jev response can request this trusted fallback representation.

V2 baselines retain the existing timing models. The constant baseline uses no
candidates and all conditional mass on `other`, while retaining its fitted timing
rate. The statistical baseline retains the hazard and rank marginals; it
ranks never-played eligible bench players last (`restMs ?? -1`, approved Nov 7,
2026), then multiplies exit/entry rank weights within each size, normalizes within size, and
weights by the statistical training size prior (prior season plus warm-up).
The statistical id includes `rested-first-never-played-last-v1`; the legacy
four-question entry ranks remain unchanged. Its eight highest-probability size-one/two sets are listed; remaining mass is
`other`, expanded with the shared warm-up prior. The generic Jev baseline proposes
one- and two-player swaps (when feasible): longest-current-stint players out and
longest-rested eligible players in, with never-played players ordered last and
player-id tie breaks. These choices use only observable state.

The adapted gate-2 package is `examples/policy-swap`. Run the one-game audit and
nine-option shape probe with a scripted provider first:

```sh
npx tsx scripts/policy-audit.ts --swap --image=<pinned-assembler-image>
```

It writes `docs/evidence/policy/gate2-swap-fixture.json` and reports a conservative
cost bound for two attempts per request. Adding `--live` invokes paid Jev calls
and writes `gate2-swap-live.json`; obtain the user's spend approval first. Neither
mode calls the research-agent model. The ordinary gate-2 command without `--swap`
remains available to reproduce the legacy contract.

## Code-first prediction (`jev-contract-v3`, SPO-871)

Opt in with `scripts/run.ts --code-predictions` (non-scripted runs), or pin
`harness.policy.swapContract.version` to `jev-contract-v3` in a programmatic
configuration. The size prior and candidate/answer validation remain those of
v2. The default launcher remains v2 until the v3 research prompts are delivered
by SPO-874. Contract identity is included in harness and cache hashes, and
cross-contract evaluation comparisons are refused.

The package keeps the existing Jev request fields and adds `prediction`:
`{ substitution: { type: "noul", noul: p }, swap: { type: "choice",
probabilities: { ...candidateKeys, other: pOther } } }`. The swap keys must be
those of the request. With an empty bench, omit swap and use empty candidates
and swap criteria. Prediction fields never supply candidates or fallback flags.
`defer` is absent/null for package scoring, or `{ "reason": "nonempty text" }`
(up to 1,000 characters) to defer both questions to Jev. Other shapes are
`assembler_error`. See `examples/policy-code` for a deterministic hand-written
package that defers between-period windows.

Every valid assembled request also goes to Jev in shadow. The record stores a
trusted envelope with the package prediction, candidates, deferral reason,
shadow answer and provider error. Per-window `result.code` records the scored
source, both validated counterfactuals and scores, and regret (chosen loss minus
alternative loss; positive means deferral selection was worse). Invalid package
predictions take the degenerate form; on a deferred window this affects only
the package counterfactual. Invalid Jev answers take per-question fallbacks.
Invalid candidates or malformed deferrals skip Jev and score the degenerate
form. First-window execution raises still invalidate the package.

An exhausted shadow provider call leaves a non-deferred primary score intact
and is counted separately as `shadow_provider_failure`. On a deferred window it
leaves the primary score unavailable and counts as `provider_failure` toward
the existing infrastructure flag. The package counterfactual is retained even
then. Resume reuses the recorded envelope and never repeats a completed call.

Trace summaries, feedback, and evaluation reports include `code`: primary and
eligible counts; invalid-prediction counts; deferred counts by stoppage kind;
shadow failure counts/rate; a missing-shadow flag above 5%; and package-only,
Jev-only and regret aggregates. Each counterfactual is paired with the primary
on windows where both exist and includes matching primary losses, exclusions
by reason and per-metric counts (selection metrics exclude no-substitution
windows). Regret requires both package and Jev scores. A positive regret is
worse, and null is unavailable, not zero. Compact feedback includes source,
answer previews, both score sets and regret; full window paging retains the
complete envelope. `validate_package` returns `prediction`, `defer`, and
`predictionValid` even without a Jev call.

Offline acceptance: `npx tsx scripts/policy-audit.ts --code-predictions
--image=<pinned assembler image>`. Add `--live` only after the user approves the
Jev spend. This replays development game `0022500083`, also sends the nine-option
probe, records both sources and writes `docs/evidence/policy/gate2-code-*.json`.
No analyst model is used. Starter-model fitting and `backtest_package` belong to
subsequent issues.

### Package-only backtesting (SPO-872)

`backtest_package({per_window?: boolean})` is a pregame research tool for a draft
package under a swap contract (`jev-contract-v2` or `jev-contract-v3`). It snapshots
`packages/<current game>/` without freezing the final submission, then executes
the assembler in batches of up to 256 states, with a second pass to check
determinism. Each state runs in a fresh child process with reset module/random
state, closed input and clean scratch, preserving single-window behavior while
amortizing Docker startup. Both execution modes use `--ipc none` to omit Docker’s writable shared-memory
mount. System V shared memory and POSIX message queues can still persist within
a container’s private IPC namespace; packages using them may differ from
single-window replay. Chronological execution prevents such persistence from
carrying later-window information into an earlier prediction.
Within each batch, states execute in
chronological order and outputs are mapped back to their selected windows.
Each state keeps the existing output and wall-clock
limits, and the whole call keeps its deadline. Only the
observable state crosses into the assembler; the evaluation scorer receives the
outcome separately. No Jev or research-model calls are made by the tool.

The launcher loads **all released prior Celtics games**, independently of the run's
evaluation-game selection: 2025–26 uses actual pregame roster evidence, and
2024–25 uses `same-game-box-score-v1` membership, including DNP rows. That prior
roster is retrospective, injury status is unknown, and its timestamps are
synthetic; it remains training-only and is never used for evaluated games. Game
release must be strictly before both the current cutoff and the session clock.
Filtering precedes indexed game-shard reads. Coverage gaps are returned under
`skipped`, rather than silently disappearing.

Results are labelled **package-only; deferral ignored**. Every eligible window is
scored using the draft's own `prediction`, including windows it would defer.
Invalid predictions or candidate lists use the scorer's degenerate form and are
counted in `invalidByReason`. `wouldDefer` counts each stoppage kind, and `split`
reports package-only scores for would-defer and non-deferred windows separately.
`summary` is the evaluation scorer's output, including timing Brier and skill,
calibration deciles, set log loss, candidate hit rate, other mass and stoppage
breakdowns; `calibrationByStoppage` adds deciles within each kind. `per_window`
returns window IDs, scores, reasons and deferral status. These are historical
package scores, never scores of the deployed package-plus-Jev policy.

The call charges elapsed research compute, including snapshotting and loading,
against the lesser of the configured `sandbox.perCallSeconds` and remaining
phase compute. History loads belong to the runner lifetime and are cached for
the current cutoff. A tool deadline stops waiting without aborting or discarding
the load; later calls reuse the pending or completed load. Calls pay only for
their waiting time. Failed loads are not cached. Moving to another cutoff cancels
the old load, and closing the runner cancels any outstanding load. A timeout returns `complete:false`, `error:"compute_limit"`, and
scores only for completed windows, with their count and `eligibleWindows`; if
loading did not finish, `eligibleWindows` is null because eligibility has not yet
been established. It does not
silently sample the history. Batches are selected newest game first so partial
results include recent games, but each container executes its states oldest
game and earliest window first to prevent cross-window lookahead. Slow packages can still exceed the per-call limit. Temporary snapshots are removed after the call. The runner records
`backtest_start` and `package_backtest` with the package receipt, data hashes,
roster provenance, results and compute charge. Tool definitions are included in
the harness hash.

The starter model is not installed by this issue. Until SPO-873 provides it, the
result explicitly reports `starter.label:"unavailable"`. The trusted integration
accepts a model hash and predictor; when supplied, it scores exactly the same
completed windows and labels those scores **in-sample**. Starter exceptions are
reported under `starter.errors`, with attempted and scored counts, without losing
package scores. A v2 package without its own `prediction` receives degenerate
scores at every window; this is not an estimate of its Jev policy.

Real-history acceptance for this tool is recorded in
[`backtest-spo872.json`](../evidence/policy/backtest-spo872.json), produced by
`scripts/backtest-audit.ts` from clean revision
`26c3fbbfff8de175fc5f54718075a5fca26aae0d`. At game `0022501206`'s cutoff,
104 released Celtics games supplied 5,397 eligible windows (80 prior-season and
24 current-season games; two prior-season coverage gaps reported separately).
The first call completed in 112.38 seconds, including 80.79 seconds of history
loading. A repeat call completed in 31.53 seconds with exactly the same scores;
history was loaded once. Both calls used the unchanged 120-second limit, reported
317 would-defer windows and zero invalid outputs, and made no model calls.

### Environment starter model (SPO-873)

For real-data launches, `--code-predictions` now enables the environment-owned
starter as well as `jev-contract-v3`, in both analyst and baselines modes. Use the
new numerical assembler image (`npx tsx scripts/assembler-build.ts`). Legacy and
scripted fixture launches retain their existing contract. The starter-enabled
assembler has a 512 MiB memory limit; its 15-second per-window and output limits
are unchanged. The image pins NumPy 2.2.6, pandas 2.2.3, SciPy 1.15.3 and
scikit-learn 1.6.1, matching the research image.

Before each pregame, including holdout games, the trusted runner exports the
SPO-870 all-team datasets at `release < scheduledStart`, then fully refits all
four HistGradientBoosting classifiers. No evaluated game's retrospective roster
enters its fit. Parameters match experiment variant E: learning rate .05,
250 iterations maximum, depth 4, minimum leaf size 40, L2 1, seed 0, and Celtics
row weight 5. Player minutes, completed substitution stints and start rate have
a 21-day half-life; team overall and stoppage-kind rates use 20 pseudo-windows
toward the 2024–25 league rates. The prior-season league shrinkage prior is a
training-population aggregate, as in the experiment; player/team rolling
histories use only games released before each feature row's scheduled start.
The model form and both Python source hashes are in the harness version.

The fit runs with eight CPU threads and a 6 GiB container limit. Data preparation
and fitting occur inside the pregame wall-clock interval, before the research
agent starts; the `starter_fit` event records their durations. Cancellation
removes the fit container. The complete fit repeats on restart and must match
the recorded hash before a frozen package can resume. Pregame, postgame and
replay for a game share that game's pregame artifact. Postgame releases never
update the current game's model.

`context` identifies the artifact hash and API. In both sandboxes:

```python
from nba_starter import predict
model = predict(state)
answer = model["prediction"]
candidates = model["candidates"]
```

The result also contains `exit` probabilities by on-court player, `timing`,
`size` probabilities for 1/2/3/4+, `entry` probabilities by size and bench player,
`sets` (the complete size-1–3 conditional-Bernoulli distribution), its residual
`other`, and `features` (`context`, `players`, `aggregates`). Missing feature
values are JSON null. The scored answer takes the top eight sets and puts all
remaining mass on `other`; swap probabilities are conditional on a substitution.
`examples/policy-starter` is a complete non-deferring package using this API.

`/starter/model.json` and the installed `nba_starter` module are read-only. The
artifact uses canonical JSON tree arrays, not executable pickle. Research code
can inspect its features and parameters, use the installed numerical libraries
to fit modified models, and save its own artifacts under the usual workspace
rules. The environment's artifact is never overwritten. The hash is recorded
in the session, frozen-package receipt and replay policy/trace, and binds the
model, prediction API and fit specification. Batched assembly preloads the
trusted model before forking a fresh child per state; a package's mutations
cannot affect another prediction. The sandbox's existing isolation rules remain
in force.

Baselines mode adds `starter`, with a full cutoff-specific fit for every game.
Reports show it alongside constant, statistical and generic-Jev. Package
backtests include starter scores on the same completed windows, explicitly
labelled in-sample because the current pregame model was fitted on that history.

Acceptance evidence and reproduction commands are recorded with the SPO-873
results below. These measurements use the official loader, not the experiment's
cached export. Differences from the experiment include the larger official
training population, real pregame rosters for released current-season Boston
games, release-time (rather than tip-time) history eligibility, and reconstructing
starters from each observable prefix. The set-size prior used by the scorer
remains the pinned warm-up prior.

**Backtest cost with the starter.** On the same 104 released Boston games and
5,397 eligible windows as the SPO-872 measurement above,
[`backtest-spo873.json`](../evidence/policy/backtest-spo873.json) records a package
calling the starter at every window, plus the independently evaluated starter
comparison. At the unchanged 120-second allowance, the cold call completed 768
windows (69.44 seconds spent loading history) and the cached call completed
1,792. Both returned `complete: false`, `error: compute_limit`; these are partial
scores, not a full-history accuracy result. Neither call had invalid predictions
or starter errors, and package/starter scores matched exactly on completed
windows. The fit for that December 12 cutoff took 45.04 seconds. No time limit,
full-refit requirement, or two-pass package determinism check was relaxed. The
measurement ran alongside the development audit on this machine, so throughput
is indicative rather than an isolated hardware benchmark.

Reproduction (local cached corpus access required; no analyst/Jev provider calls):

```sh
npx tsx scripts/assembler-build.ts
# Use the immutable local@sha256:... pin printed by the build below.
npx tsx scripts/starter-audit.ts --image=<pin>
npx tsx scripts/starter-development.ts --image=<pin>
npx tsx scripts/starter-backtest.ts --image=<pin>
ASSEMBLER_IMAGE=<pin> npx tsx --test test/starter.test.ts test/policy-sandbox.test.ts
npm run sandbox:build
npm run test:sandbox
```

The first audit exports the official data available at the opener. The
subsequent audits reuse only its already-released 2024–25 rows, and export the
2025–26 rows separately at each target cutoff. Refit comparison is byte-for-byte
on canonical artifacts; Python fixtures also compare native serialized-tree
predictions with scikit-learn and plant malformed records exactly at and after
the cutoff. The official-loader fixture additionally fails on any attempted
future partition read, including the streaming export path.

**Development acceptance.**
[`spo873-scores.json`](../evidence/starter-model/spo873-scores.json) records all ten
development games: **584 scored windows, 192 substitutions, timing Brier
0.164863 and set log loss 4.323300**, versus the experiment's approximately
0.164 and 4.29. Full per-game refits in the clean rerun took 30.97–38.44
seconds. All ten model hashes and complete per-game score summaries matched
the original run exactly, including the opener's model/API/spec hash,
`9b6e71e3ae2b0c465824864ec7381390209b7c9022ade4403c5c528c46b0f9fc`.
The original cold all-team export took 386.61 seconds, separate from fitting;
this rerun reused that official prior-season export and freshly exported
current-season rows at each cutoff. Cold preparation plus fitting therefore
cost roughly seven minutes of pregame wall time in the original measurement.
The holdout uses the same full-refit path.

The official prior population is exactly SPO-870's 2,442 team-datasets and
145,712 windows (134,737 eligible training windows), compared with the
experiment's 2,374 datasets and 142,150 windows. The opener also has four
already-released current-season team-datasets, with 288 eligible windows. This
is a **data change**, not a replacement of the four-model form or its
hyperparameters. The code changes relative to the reference are release-based
rolling-history eligibility, per-prefix starter reconstruction, and a stable
lexical tie-break for equally likely candidates. Their joint result is the
small score movement above; this audit does not isolate each change's numerical
contribution. Serialization parity with native scikit-learn is independently
tested to 1e-12, including missing features and single-class models.

Both evidence files were regenerated from clean commit
`c01ca95dc6bba14c01c2b40950fd1166181acb64`. Both audit scripts refuse a dirty
revision, and the development audit writes the revision into its evidence
automatically. The numerical model's training and prediction source hashes
are bound by the recorded model identity and harness spec. Validation: 327 Node tests
(312 passed, 15 optional-image skips), both starter Docker tests, all three
assembler isolation tests, and all 15 research sandbox tests passed.

### Complete starter backtests (SPO-876)

The environment now prepares starter backtest predictions once per model hash
and cutoff, after fitting and before the research agent starts. This trusted
preparation is not charged to the agent's 900-second compute allowance; its
elapsed time is recorded as `starter_backtest_prepare` and remains inside
pregame wall time. Each tool call scores the cached predictions on exactly its
completed windows, retaining the `in-sample` label. Missing or changed states
fail closed rather than silently using a different prediction. Source data
still passes the release, team, roster-policy and current-game exclusion gates.

`BACKTEST_EXECUTION` fixes concurrency at **four containers** and batch size at
256, recorded in the harness version. Two batches can execute together, with
each batch's two determinism passes running concurrently. Each container still
runs states oldest-first, has no network or shared-memory mount, mounts the
package and starter read-only, forks a fresh child for each state, and applies
the per-state time/output limits. Cancellation joins every container's cleanup
before removing the package snapshot or returning. The 120-second per-call
limit and 900-second pregame compute budget are unchanged. Charges remain
**elapsed wall-clock seconds**: parallel execution buys more CPU per charged
second, equally for every variant.

The faster Python runtime traverses entry-model trees once for the three entry
sizes and retains artifact-only per-game history caches in the trusted batch
supervisor before forking. Probability transforms retain their original array
shapes, preserving exact numerical output. Package mutations still disappear
with each child. No future state is read to warm these caches.

Fitted artifact identity remains unchanged: `starter/reference/nba_starter.py`
is the frozen SPO-873 reference used for training and stored with each artifact.
`STARTER_SPEC` continues to hash those exact reference bytes. The optimized
installed `nba_starter` module is separately bound by `STARTER_RUNTIME` in the
harness, replay identity and assembly cache identity. Both sandboxes use this
read-only runtime; `/starter/nba_starter.py` remains the artifact's reference.
This separates execution changes from the existing model identity without
silently changing either version.

Reproduction: build the numerical assembler, commit implementation changes,
then run `scripts/starter-development.ts --image=<pin>` for all ten refits and
byte-for-byte full API comparison against the reference (including features),
and `scripts/starter-performance.ts --image=<pin> --game-id=<id>` for
`0022501206` and `0022501149`. The performance audit preloads history and prepares
the starter comparison outside the charged call, measures a full cached call,
and checks its scores against serial reference predictions on every window.
`--artifact=<directory>` may reuse a verified cutoff-matching fitted artifact;
`--probe` permits exploratory measurements but writes only to the local cache,
never committed acceptance evidence. Formal evidence requires a clean revision.

Clean-revision acceptance with image
`local@sha256:22d5fd90c12183212964dfebc31284ccf84d1fe03c866720fbca2cd5e14ba66c`:

| Cached-history target | Eligible/scored windows | Charged seconds | Result | Exact reference API comparisons |
| --- | ---: | ---: | --- | ---: |
| Midseason `0022501206` | 5,397 / 5,397 | 88.68 | `complete: true` | 5,397 |
| Game 79 `0022501149` | 8,207 / 8,207 | 95.59 | `complete: true` | 8,207 |

The [midseason evidence](../evidence/policy/backtest-spo876-0022501206.json)
was recorded from clean `28df49ccef19a0c43057b447138ef15c103e21f1` while the
development audit was also running. The
[late-season evidence](../evidence/policy/backtest-spo876-0022501149.json)
was recorded from clean `5d28914bd052b0e95cb9eb89e1aa0736f74c0243`, with no
concurrent training fit during the timed call. Both use the same execution
and runtime versions. The latter commit only adds temporary-export cleanup to
the audit scripts.

Both calls had zero invalid predictions and zero starter errors. Every full
Python API result (including features and the complete set distribution) was
compared byte-for-byte against the frozen serial reference, and every summary
field matched serial scoring on the same windows. The prepared comparison
scores also matched the package. Trusted preparation, including the initial
history load, took 116.21 and 148.25 seconds respectively, outside the charged
call. These timings are machine measurements, not a guarantee for arbitrary
agent-authored packages; slower packages still return explicit partial results
at the unchanged deadline.

The [development rerun](../evidence/starter-model/spo876-scores.json), from clean
`5d28914bd052b0e95cb9eb89e1aa0736f74c0243`, fully refitted all ten games and
reproduced all ten SPO-873 model hashes and every per-game score summary
exactly: **584 windows, timing Brier 0.16486313135424627, set log loss
4.323299538360917**. Full API outputs matched the reference byte-for-byte on
all 584 states. Validation also passed: 315 Node tests (16 optional-image
skips), all six starter/assembler Docker tests, and all 15 research sandbox
tests. The parallel tests check serial score parity, oldest-first execution,
fresh children, shared-memory isolation, four-container concurrency, and
cleanup after cancellation and timeout. Audit exports are removed after fitting
to avoid accumulating large temporary copies.
