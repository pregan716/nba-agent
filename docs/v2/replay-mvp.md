# Replay MVP — SPO-838

Implements the merged v3 brief's `windows-v2`, `state-v1`, four-question prediction contract and scoring equations. This is a trusted local replay harness with two stub predictors; it does not call Jev or run research agents, assemblers, memory variants or simulated game trajectories. Every window starts from the real historical prefix.

## Reproduce

```sh
npm ci
npm run check
npm test
npm run replay:audit
```

The audit uses `config/datasets.json`, the existing verified object cache at `.cache/objects`, and the existing Doppler-backed object reader on a cache miss. It does not repin data. It writes a new hash-chained SQLite record under `.cache/replay/audit-*`, its manifest and local input export, and `docs/evidence/replay-mvp/audit.json`. Object bytes are hash-verified even when cached. The committed evidence records the implementation revision, release hash, per-game input hashes, fitted parameters, training game IDs, per-game exclusions and unanchored ledger, and all metric denominators. SQLite contains the full states, labels, raw answers, validation, derived actions and window scores. Large local records are not committed. Both audit scripts capture the implementation revision before generating outputs and append `-dirty` when staged or unstaged tracked changes are present (untracked local files are ignored). The manifest records the implementation commit used to run the audit; a subsequent evidence-only commit can therefore be the PR head without matching `codeRevision`.

`loadReplayInputs(corpus, pregames)` requires timestamped frozen pregame evidence supplied by its caller. `auditPregames` supports the full 2025–26 Celtics regular season: it applies the curated opening roster and membership events in availability order, strictly before scheduled tip. Opening members retain the opening cutoff; arrivals and re-signings carry the event timestamp. Injury and announced-starter names resolve against that game’s roster. It refuses unresolved identities. Unknown/missing team reports do not carry an older status forward; they retain the full roster with `availability_unknown`. Same-game box-score membership and later participation never establish bench eligibility.

`config/roster-evidence.json` pins the SHA-256 and byte length of the curated transactions file and official-feed extract. Both are verified before use and recorded as local path/hash references in `Pregame.sources`; remote injury and lineup sources retain their object references. The curated file is unchanged by SPO-847. Its evidence and availability conventions are described in [season-roster-evidence.md](season-roster-evidence.md).

## Dataset and state boundaries

- `src/replay/dataset.ts` builds deterministic candidates, outcomes and the per-game ledger. The dataset version is `windows-v2:<release-manifest-sha256>`; the input hash also binds the pregame evidence. Every persisted row carries the release hash and dataset version, including the manifest, window, ledger and summary records. Replaying a different dataset revision into an existing record is rejected.
- `src/replay/state.ts` explicitly projects only the prefix. Normal snapshots include the opener. Retrospective jump-ball snapshots stop before the first substitution by either team or the jump-ball row itself, including negative examples. Observed same-clock play before that cut is included; any non-substitution row between the first substitution and jump ball produces `interrupted_jump_ball_substitutions` and `ambiguous_stoppage`. Other late markers are excluded and have no predictor state. Free-throw pending is nullable unless the prefix establishes it. For retrospective jump-ball snapshots, timeout team and free-throw pending are both null: these attributes are null by rule for jump-ball stoppages, even when the observed prefix contains a same-clock timeout.
- Adjacency attaches an otherwise unanchored bucket only to the immediately preceding independent opener in the same period, at a positive gap of at most 2,000 ms. It neither creates candidates nor chains. The state stays at the opener.
- Between-period outcomes are net five-to-five changes, including opening-clock substitutions. Input is the prior period-end five and score with the next opening clock. No opening-tip or final-end window is added.
- Offensive foul/turnover duplicates coalesce. Distinct whistles, subsequent live action/timeouts, multiple Celtics blocks, exit/re-entry, incomplete or unreconciled substitution batches receive `ambiguous_stoppage` plus specific reasons and spans. Residual substitution blocks have their own sequence spans and mechanisms.
- Minutes are integrated from observed lineups; stint length resets at period start; rest is game-clock time since exit, null before a player's first exit. Fouls use `fouler` participants, excluding typed/described technicals, with stint entry foul totals as a check. Reconciliation checks source stint totals, per-player elapsed minutes, substitution batches and coverage, without putting future stint ends or cumulative exit statistics into state.
- Required state failures always exclude. Every partial-summary finding must parse as a view name followed by named `statistic:status` entries. Named defects null only intersecting `state-v1` fields for the entire game and add `unqualified_running_box_score` only when that intersection is nonempty. A named defect outside the state (for example SPO-843's `plus_minus:mismatch`) leaves every state field intact, adds no summary flag, and does not exclude the window. Missing or unparseable findings remain `unqualified_summary`; failed summaries remain excluded because rule 7 permits this exception only for partial coverage. Final official box scores never fill those nulls. A rejected alternative rotation source does not disqualify canonical lineups/stints whose published coverage and reconciliation are valid.

The pinned `spo-839` releases expose qualifiers, but a team rebound never opens a window. The merged brief withdraws that opener: `deadball` denotes missed-free-throw dead-ball context, including final technical/flagrant attempts, and neither establishes an independent stoppage nor means another attempt is pending. `TEAM` text only describes residual ledger mechanisms. The new release hash changes the dataset version; candidate counts remain unchanged.

Predictors receive a recursively frozen clone of the typed state, never the window, outcome, future events or final box. Outcomes and source-quality checks belong to the trusted evaluator. The current predictors are trusted functions, not a security sandbox; isolated assembler execution belongs to the next issue.

## Contract, scores and failures

`validatePrediction` validates each of `substitution`, `count`, `exit`, and `entry` independently. It rejects absent/malformed answers, wrong types, non-finite/out-of-range probabilities and non-exact option sets. Only that question falls back: 0.5 for timing, uniform for count/exit/entry. There is no probability-map renormalization or sum-to-one rejection beyond the brief's contract.

Timing below 0.5 derives an empty action. Otherwise count argmax chooses one/two/three, with `none` mapped to one. Count ties follow `none`, `one`, `two`, `three_or_more`; player ties use ascending canonical ID. Too few eligible players produces an invalid action, not a silent reduction of k. Action validation rejects unequal swaps, duplicates, ineligible players and an illegal resulting five.

The pure scorer reports timing Brier, log loss (only here clipping to [0.001, 0.999]), clip count, ten calibration bins, precision and recall. Conditional entry/exit Brier uses `k * p_j`, with actual k, and divides by eligible-set size. Top-1 and exact top-k selection are evaluated on every actual substitution regardless of predicted timing. Exact-action accuracy includes empty actions; overlap is Jaccard on direction-labelled moved players and omits empty/empty windows. Empty metric denominators are null.

For outcome y in {0,1}, timing Brier is `(p-y)^2`; log loss is `-[y log(p_clip) + (1-y) log(1-p_clip)]`. For actual moved set A of size k and eligible set E, selection Brier is `sum_j_in_E (k*p_j - 1[j in A])^2 / |E|`. Exact action requires equality of both sets; partial overlap is `|predicted ∩ actual| / |predicted ∪ actual|` on direction-labelled players.

Provider failures are unscored and flag a game above 5% of eligible windows. An invalid package on its first eligible window makes the entire game unscored and prevents further calls. Assembler errors use all four fallbacks and remain scored. Informational availability/summary flags do not remove windows. Every failure and invalid question is counted separately. The append-only record verifies its hash chain, binds inputs/predictor/harness versions to the manifest, and resumes already-recorded windows without recalling the predictor.

## Baselines

Both baselines fit only qualified windows in chronological Celtics games 11–20, the brief's warm-up split. The MVP chooses this simple warm-up-only fit rather than adding 2024–25 training. No audited game's label is used in this fit. The opener precedes training and is explicitly a retrospective development diagnostic, not out-of-sample evidence. Dec 5 and Jan 23 follow warm-up. This three-game implementation check is not a statistical comparison over the scored season.

- **Constant:** warm-up substitution rate, uniform count and player maps. The rate is about 0.319 on 596 qualified warm-up windows. This is a rate over independently marked stoppages, which over-represent fouls/timeouts and substitutions; it is not the true rate over all coaching opportunities.
- **Statistical:** deterministic logistic regression with intercept, capped maximum current stint / 6 minutes, capped absolute margin / 15, period / 4, timeout indicator, between-period indicator, and maximum personal fouls / 6. Full-batch gradient descent uses 500 steps, learning rate 0.1 and L2 0.01 excluding the intercept. Count probabilities are warm-up empirical frequencies. Exit probabilities rank current stint length; entry probabilities rank observed rest, with never-entered players first. Rank weights descend n through 1 and normalize to one; canonical ID breaks ties. This intentionally simple entry rule does not infer who will later play. The fitted count distribution is unconditional and its argmax is `none`; whenever timing predicts a substitution, the derived-action rule maps that to one player. Thus this baseline never proposes a multi-player swap on the audited fit, mechanically limiting exact-action accuracy at those windows.

## Cached audit

[Machine-readable evidence](../evidence/replay-mvp/audit.json) includes every exclusion and unanchored block. Candidate counts below reproduce the spike's adopted `opener_counts` exactly, before qualification:

| Game | In-period candidates | Positive candidates | Own substitution buckets | Adjacency attachments | Unanchored buckets | Boundaries | Scored windows |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Oct 22 opener, 0022500083 | 72 | 23 | 26 | 0 | 3 | 3 | 66 |
| Dec 5 Lakers, 0022500338 | 55 | 17 | 19 | 0 | 2 | 3 | 54 |
| Jan 23 Brooklyn, 0022500637 | 80 | 28 | 31 | 1 | 3 | 5 | 82 |

All 8 residual buckets have an explicit mechanism and block span. The 218 candidates including boundaries yield 202 scored windows: 9/4/3 distinct ambiguous windows excluded respectively. Detailed reasons overlap and must not be summed. There are no candidate-count discrepancies with the spike; its counts were explicitly before ambiguity/state exclusions. The December game's 54 scored windows all carry null field-goal attempts, offensive rebounds and total rebounds, with valid lineups/stints and the informational summary flag. Brooklyn includes two overtime transitions. Its adjacency attachment links opener bucket 449 to substitution bucket 453, one second later.

| Game | Constant timing Brier | Statistical timing Brier | Constant exit / entry Brier | Statistical exit / entry Brier |
| --- | ---: | ---: | ---: | ---: |
| Opener (retrospective diagnostic) | 0.22792 | 0.18570 | 0.17739 / 0.10293 | 0.19942 / 0.12128 |
| Lakers | 0.22915 | 0.22814 | 0.18526 / 0.12736 | 0.20164 / 0.15005 |
| Brooklyn | 0.23864 | 0.20219 | 0.17548 / 0.13607 | 0.20129 / 0.16963 |

The statistical baseline improves timing on these three matched sets but loses on both conditional player-selection scores. This is a limitation of the simple rank model, not evidence of general predictive superiority. All comparisons use the same qualified windows. Marked stoppages over-represent fouls/timeouts and substitution opportunities; these results apply only to that restricted dataset. Exclusions are also outcome-correlated: the [independent season diagnostic in the PR review](https://github.com/pregan716/nba-agent/pull/40#issuecomment-6675867979) reported 165/1,299 (12.7%) in-period positive windows excluded versus 236/3,277 (7.2%) negative windows, due to the prescribed ambiguity rules. That diagnostic used synthetic pregame inputs, not production season rosters; its exclusion comparison is a composition warning, not a season scoring result.

## Verification

`test/replay.test.ts` covers the five-window hand calculation (timing Brier 0.268, exit Brier 0.56/3, entry Brier 2/9, exact-action 0.6, overlap 0.5), including invalid entry with valid timing and exit answers. It also covers frozen state/pregame cutoff, planted future values, action legality, per-question fallback, adjacency limits/non-chaining, boundary input, missing-summary precedence, repaired ordering, stint failure, bench availability, provider/package failures, record resumption and hash verification.

`test/fixtures/replay/jump-prefixes.json` contains projected canonical prefixes and participants from the original `spo-771` cached export (retained as historical regression fixtures), with its release reference and frozen pregame provenance. The revised cutoffs are 26 and 200 (after the preceding rebounds, before any substitution). The real opener 25–28 fixture retains Queta rather than Tillman; Brooklyn 199–206 retains Pritchard rather than Brown despite the interleaved opponent batch. Mutating later recovery descriptions, after-lineups and scores leaves each state unchanged. The live cached audit additionally checks both complete games and the December summary-null case.

## SPO-846: windows-v2

PR #42 revised the jump-ball prefix. Historical `windows-v1` artifacts retain their bucket-start meaning. `windows-v2` uses the same source pins, candidates, outcomes and eligibility rules, with the first-substitution-or-jump-ball cutoff and the additional interrupted-block exclusion. Its dataset identity is distinct even when all counts match. The paired synthetic fixtures include a missed shot and player rebound in both states and prove full state equality with and without a substitution; opponent-only substitutions and an administrative interruption are also covered.

Run `npx tsx scripts/replay-cutoff-audit.ts` to reproduce the [season prefix audit](../evidence/replay-mvp/windows-v2-cutoffs.json) from hash-verified event partitions. It inventories changed cutoffs without inventing season rosters or running season scores. The pinned release has 163 jump-ball buckets, 28 moved cutoffs and one interrupted bucket (`0022500520`, 176–183), already ambiguous under the existing whistle rules. No score changes at the new cuts; the five affected field-goal rows are misses. The full three-game replay audit is regenerated separately with the new version and committed implementation revision. Its candidate counts, eligibility counts, fitted parameters and baseline scores match the previous `windows-v1` audit; 202 windows remain scored.

## SPO-847: full-season frozen rosters

Run `npx tsx scripts/replay-season-audit.ts` to reproduce the [season roster build](../evidence/replay-mvp/season-rosters.json). All 82 rosters exactly match the independent committed roster cross-check, with every membership timestamp strictly before tip. Building every game produces zero `lineup_outside_frozen_roster` exclusions. Before exclusions, counts remain 4,576 in-period candidates, 1,299 positive candidates, 159 unanchored substitution buckets and 248 between-period windows. These are decisions at independently marked stoppages, which over-represent fouls and timeouts; they are not all coaching substitution opportunities.

Tests cover the game-52 trades, the same-day signings in games 55, 60 and 72, strict timestamp equality, Banton’s and Bassey’s expiries, per-game name resolution, planted same-game roster evidence and tampered evidence files. The three-game replay audit is regenerated with the new provenance; roster membership, predictor states, eligibility and baseline scores for those earlier games are unchanged.
