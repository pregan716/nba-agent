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
amortizing Docker startup. Each state keeps the existing output and wall-clock
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
phase compute. Successful history loads are cached at the trusted runner for
the current cutoff and charged once; later calls reuse them. Failed loads are
not cached, and moving to another cutoff discards the old cache. A timeout returns `complete:false`, `error:"compute_limit"`, and
scores only for completed windows, with their count and `eligibleWindows`; if
loading did not finish, `eligibleWindows` is null because eligibility has not yet
been established. It does not
silently sample the history. Windows run newest game first so partial results
include the most recent games. Slow packages can still exceed the per-call limit. Temporary snapshots are removed after the call. The runner records
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
