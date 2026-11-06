# Evaluation from experiment records (SPO-854 / R6)

The evaluator reads hash-chained SQLite records and writes `report.md` and
`report.json`. It does not run research, assembly, Jev, baselines or probes. It
needs neither the original run's source checkout, corpus, workspace blobs nor
caches. It uses the evaluator's existing `scoreWindow` and `summarize`; there is
no second implementation of window scoring.

```sh
npm run evaluate -- \
  --record=M0=.cache/runs/my-M0/r1 \
  --record=M3=.cache/runs/my-M3/r1 \
  --record=baselines=.cache/runs/my-baselines/r1 \
  --out=.cache/reports/comparison
```

Each `--record=label=path` accepts a run directory or a `record.sqlite` file. Labels
must be unique. Every predictor in a baseline record becomes a separate report
stream. Add replicate records with distinct labels. Outputs contain full
precision numbers in JSON; Markdown tables round display values only.

`--resamples=10000 --seed=8542026` overrides the bootstrap settings. The defaults
(10,000 draws and seed 8,542,026) were accepted by the user on Nov 6, 2026. Both are recorded
in the report. Resamples must be 1–100,000 and the seed an unsigned 32-bit integer.
The report is deterministic for the same records, labels, paths and settings.

## Inputs, provenance and refusals

The reader opens SQLite read-only, verifies contiguous sequence numbers and the
entire event hash chain, and records the file SHA-256 and last event hash. It does
not create a missing `manifest.json` or repair a record. A file changing during
read is refused; use a completed run or stable checkpoint copy. Inputs must use
the recorder's DELETE journal mode; WAL-dependent databases are refused as
`unsupported_journal_mode` so a standalone file is sufficient for reproduction.

Each `replay_window` is tied to its recorded dataset/predictor manifest. The
scorer recomputes validation and scores from the recorded state, actual action,
raw prediction and failure. A mismatch with the stored scores or validation is
refused as `score_mismatch`. Duplicate windows and inconsistent dataset, state or
Jev identities are refused. A missing or inconsistent per-game `replay_summary`
marks that game incomplete, and comparisons of it are refused.

The chronological run manifest supplies game indexes and the selected dataset
list. Replay-only records can also be read when their manifest includes a `games`
array with `gameId` and zero-based season `index`, plus the existing replay
manifest fields. Missing game indexes are a named `missing_game_tags` refusal:
NBA game IDs and record order are not substitutes for the season schedule.
The committed gate JSON artifacts (`docs/evidence/replay-mvp/audit.json` and
`docs/evidence/policy/gate2-live.json`) contain aggregate evidence, not the window
records needed to reproduce all scores. They are deliberately refused as inputs;
no window observations or missing tags are fabricated from them.

For each pair, comparison returns a named refusal when any of these differ:

- `decision_dataset_mismatch`: per-game dataset version, release hash or input
  hash. Same window names do not establish the same dataset.
- `state_schema_mismatch`: state schema descriptor.
- `jev_model_or_settings_mismatch`: the complete recorded Jev settings object,
  including model. An absent identity is `jev_identity_unavailable`, not a match.
- `game_list_mismatch`: full recorded schedule/index/tag metadata or selected game
  list. A partial run cannot silently stand in for a complete season.
- `window_identity_mismatch`: same matched key but different recorded window
  state, actual action, position or exclusions.
- `incomplete_replay`: missing/mismatched final replay summary for a compared game.

Harness-version and budget-profile differences are printed and flagged, not
silently equated or used to suppress a comparison. Both run profiles, complete
harness/budget descriptors, dataset identities, per-game predictor descriptors,
code revisions and differing top-level profile axes are printed. Refused pairs
remain visible in the report with their reasons; other report streams can still
be inspected.

Baseline profiles retain the launch descriptors but use `memory: null` and an
explicit `baseline` predictor ID. They are not memory variants. Comparisons name
the `predictor` axis whenever predictor IDs differ; the `memory` axis is compared
only between two agent variants. The baseline label is represented by the
predictor axis, not a separate profile axis.

## Game tags and claim limits

Indexes 0–9 are development (games 1–10), 10–19 warm-up, 20–69 scored and 70–81
holdout. Recorded split tags, when present, must agree with those indexes.
Headline aggregates and comparisons use **scored games only**. All selected games
also have diagnostic aggregates and per-game rows. Development and warm-up
comparisons are explicitly diagnostic, never the headline. Fixture runs are
flagged as not evidence regardless of their synthetic tags. This command makes
no empirical claim of learning.

If a selected game is holdout, the command refuses before writing a report unless
`--holdout-revealed` is supplied. With that explicit flag, holdout aggregates and
comparisons appear separately and never enter the scored headline. The flag only
permits reporting already recorded results; it does not reveal data to an agent,
run a holdout experiment or bypass the launcher's holdout protections. Merely
having future holdout dates in the full season schedule does not select them for
evaluation.

Learning curves show the three primary losses by original game index on games
common to every supplied stream, with tags. Missing/noncommon games are listed,
never renumbered or filled with zero. No charts or fitted trend claims are added.

## Metrics and denominators

All quantities below come from the existing scorer. Undefined means are `null`,
not zero. Per-window JSON includes the original input, recomputed validation and
scores; per-game, per-run, scored-headline and revealed-holdout aggregates use the
same summarizer.

Let `y=1` when the actual action substitutes at least one player, otherwise zero;
`p` is the validated substitution probability after the prescribed fallback.
For `N` scored windows:

- **Timing Brier (primary):** `sum((p-y)^2)/N`, lower is better.
- **Log loss:** mean `-[y log(q) + (1-y) log(1-q)]`, with
  `q=min(0.999,max(0.001,p))`. Count each window where `q != p`; only this metric
  clips probabilities.
- **Calibration:** ten bins `[0,.1), …, [.9,1]`, each with count, mean predicted
  probability and observed substitution fraction. Empty bin means are null.
- **Precision/recall:** threshold `p >= .5`. Precision is `TP/(TP+FP)` and recall
  is `TP/(TP+FN)`, null when the respective denominator is zero.

At actual-substitution windows, let `k` be the actual number moved, `E` the
eligible on-court set (exit) or eligible bench (entry), `A` the actual set, and
`r_j` the normalized predicted probability:

- **Exit/entry Brier (primary):** mean over windows of
  `sum_j((k*r_j - 1[j in A])^2)/|E|`. This implements the brief's Proposed
  scale-by-k normalization without changing it.
- **Top-1:** the highest-ranked player is in `A`.
- **Top-k:** the set of the `k` highest-ranked players equals `A` exactly.
  Ties follow the existing canonical player-ID ordering. These scores are
  evaluated even if Jev predicted no substitution.

**Exact action** is the fraction of scored windows with a valid derived action
and exactly the actual entrants/exits, including no-substitution cases.
**Partial overlap** is Jaccard `|predicted ∩ actual| / |predicted ∪ actual|` over
windows with a nonempty union. Entries and exits have distinct direction labels,
so an entry cannot count as the correct exit of the same player. Both empty is
undefined for overlap and omitted from that average.

## Invalid answers, exclusions and failures

Invalid answers are counted per question, with each validation reason counted as
`question:reason`. The existing fallbacks remain substitution .5, uniform count,
and uniform eligible exit/entry distributions. Valid answers in other questions
are preserved. Derived-action invalidity is counted separately.

Dataset exclusions are counted by reason and remove the window from all scores.
Provider failures and invalid-package windows are unscored. An `assembler_error`
uses the existing invalid-output fallbacks and stays scored. The report counts
failures by category, lists invalid-package games (including a recorded game
failure with no eligible windows), and lists games whose provider failures exceed
5% of their eligible windows. Exactly 5% is not flagged. This reuses the existing
summarizer's eligible-window denominator; a game flag is disclosed, not used to
silently discard all its other scored windows.

## Matched comparisons and uncertainty

Pairs match by `(gameId, windowId)` after identity checks. A window absent or
unscored on either side is dropped from both. The report lists every dropped key
and left/right reasons, including dataset exclusions, missing states/actuals,
provider failures and invalid packages. The dropped-window count is a union count;
a window can contribute multiple reasons, so reason counts need not sum to it.

Every primary difference is **right minus left**. Negative favors the right run
for all three primary losses. Estimates pool matched windows, using each metric's
own scored/actual-substitution denominator; they are not unweighted averages of
per-game means.

For each bootstrap draw, sample the matched games with replacement, drawing as
many games as the matched set contains. Use the same sampled games on both sides
and carry all matched windows for each sampled game together. Recompute pooled
means and their difference using per-game sufficient statistics from the scorer.
The deterministic generator is Mulberry32. The 90% interval is the interpolated
5th and 95th percentile of the resampled differences (linear interpolation at
`(n-1)*p`). A sample with no denominator for a metric is undefined; valid and
undefined draw counts are reported. A metric with no valid draws has a null
interval. The bootstrap unit is the game, never independently resampled windows.

For each metric, remove each matched game in turn and recompute the difference.
Report up to five with the largest absolute change from the full matched
estimate, ties by game ID; null leave-one-out estimates remain explicitly null.
Each row includes the remaining games' recorded cost/time and loss-per-unit
ratios. No score is imputed if removing a game leaves no denominator.

Within a memory variant, replicate groups must share profile, harness, budget,
dataset/state/Jev descriptors and game selection, and have distinct nonempty
replicate IDs. On scored windows scored in every replicate, report each value,
mean, minimum, maximum and sample standard deviation
`sqrt(sum((x-mean)^2)/(n-1))`. Incomplete or incompatible groups are flagged.
This is replicate spread, not an additional confidence interval.

## Cost and observed time

Analyst dollars come from model settlements' `details.usd`, not both the response
and settlement. Jev dollars come from each recorded response, including attempts
when usage is available. Analyst research is assigned only to the variant stream;
baselines in the same record do not inherit it. Jev events are assigned using the
exact game/input/predictor/call scope, including predictor IDs that contain colons.

The report provides both roles, their known-dollar sum, uncertain-call counts and
`totalUsd`. If requests have no priced settlement/response or retry errors leave
billing uncertain, `totalUsd` is null and the known subtotal remains visible.
These are recorded model-provider charges, not inferred infrastructure bills.
Unapproved budgets and placeholder price profiles are flagged.

Recorded seconds sum session-attempt `elapsedMs`, Jev attempt `latencyMs` and
successful replay assembly `computeSeconds`. This is observed work, **not** the
calendar span between first/last record events, and excludes outages. Missing
attempt duration or unmeasured failed assembly makes the total unknown. Baseline
fitting/prediction CPU and other unmetered work are unavailable, not invented.

Each primary comparison and sensitivity result includes both sides' cost/time,
loss per dollar and loss per recorded second. Costs cover all the compared games,
including failed/unmatched windows, not just successful windows. Ratios are null
for zero or unknown denominators. These loss/unit ratios are descriptive; more
spending can lower a ratio without improving the loss, so they are not a causal
return-on-investment measure. Full-run cost is reported separately from the
headline/matched-game cost.

## Learning diagnostic slots

For each variant with any memory gate on, list each game's session workspace
diffs, before/after session memory-size records when available, and checkpoint
memory sizes, with `annotation: ""`. Missing recorded measurements remain null.
The evaluator does not inspect or interpret memory text, invent a learning
explanation, fill the annotation or adjudicate a boundary-audit flag.

## Validation

`test/evaluation.test.ts` covers hand-computed constant-rate timing and selection
scores, top-k, dropped/missing windows, named incompatibilities, harness/budget
flags, deterministic zero-width bootstrap intervals, five-game sensitivity,
replicate spread, costs, failure accounting, holdout refusal and record integrity.
The CLI test copies only SQLite into a separate directory, removes the original
run directory, generates both artifacts, and verifies that the input is unchanged
and no run-side files are created. Existing launcher fixture records are also a
supported smoke-test input. No run is executed by evaluation and fixture values
are not evidence.
