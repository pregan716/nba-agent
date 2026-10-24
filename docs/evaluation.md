# Evaluation and reporting (SPO-782)

Run `npm run report -- RUN_DIRECTORY [OTHER_RUN_DIRECTORY ...]` to print a deterministic JSON report. Use the directory containing `record.sqlite` (the runner nests this under the run/replicate IDs). Redirect stdout to preserve the report. This command opens SQLite read-only, verifies the event hash chain and referenced workspace blobs, and never opens a data adapter or model connection.

The trusted environment captures the released official box scores and participation summaries into a `resolution_input` event, including source provenance and unavailable-source reasons. Capture happens even for stateless configurations, which skip the postgame harness. Older records without this event report unresolved outcomes rather than fetching live data. Postponed/cancelled status voids questions. Official box scores settle the stat; participation summaries determine DNP. The documented partial-summary exception permits box-score minutes fallback; missing/conflicting sources remain unresolved. Actual values equal to the line are pushes. These and DNP/void questions are excluded.

Positive skill is **market log loss minus agent log loss**, following the brief's prose and positive-is-better acceptance rule. The brief's displayed equation has the reverse sign. The shared scorer is used by released feedback and reports. Brier improvement uses the same direction. Equal probabilities produce exact zero. Submitted probabilities have already been validated and clipped by P3; the evaluator refuses invalid probabilities rather than silently changing a frozen submission.

Reports include all frozen questions, reasons for unscored questions, source question exclusions, failed attempts, calibration deciles, deviations at 0.05/0.10, stat/player/season-third breakdowns, pinned configuration and contamination probe. Scored runs exclude the first ten development games; fixture/pilot results are explicitly labeled and are not scored-run claims. Costs are recomputed from recorded SDK usage at pinned prices. Unknown reasoning tokens stay null, since the provider may not report them independently; they are not added a second time to output tokens. Unsettled reservations are reported separately and mark spend incomplete. Compute includes unsettled reservations conservatively. Session wall time excludes downtime between attempts. Per-game and phase totals include failed attempts. Zero-cost/time efficiency ratios are null.

Comparisons match game, question ID, player, stat, line and market probability, dropping any question unscored on either side. Conflicting outcomes are rejected. The statistic is the question-weighted mean difference, resampling complete games with replacement (10,000 draws, seed 782, percentile 90% interval). Reports show each of the five largest leave-one-game-out changes and the result excluding all five. Every differing profile axis is printed, with warnings for differing budgets, harness versions or de-vig layers. Replicate spread groups identical profiles/budgets/harness/de-vig/purpose and uses only questions resolved across every replicate. A single replicate cannot establish within-configuration variability. Compare this spread against the paired difference before claiming an effect.

## Learning evidence

Persistent runs include each session's before/after workspace snapshots, diffs and verified blob text. These are evidence for review, not an automatic inference that memory caused a prediction. To collect a reviewed example, create an annotation JSON file and run:

```
npx tsx scripts/annotate-learning.ts RUN_DIRECTORY ANNOTATION.json
```

The annotation is appended to the immutable record and appears in subsequent reports. Its shape is:

```json
{
  "category": "stale beliefs",
  "explanation": "Explain the retained claim, eligible contradictory evidence, and later prediction; use actual recorded examples.",
  "workspace": [{"sessionSeq": 123, "path": "notes.txt", "side": "after", "quote": "Exact recorded text"}],
  "questions": [{"gameId": "GAME_ID", "questionId": "QUESTION_ID"}]
}
```

Categories are `stale beliefs`, `useful transfer`, and `repeated errors`. The collector validates snapshot sequence/path/quote and question/outcome references. For useful transfer, cite the earlier memory and later correct probability change; for repeated errors, cite both errors and intervening feedback. A human must assess causality and evidence availability. Without annotations the report explicitly says evidence review is required; it does not fabricate examples. No harness prompt or workspace organization is prescribed.
