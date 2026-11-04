# Decision-window feasibility — SPO-837

Analysis date: November 4, 2026. Authority: [implementation brief v3](../NBA%20Coaching%20Policy%20Agent%20%E2%80%94%20Implementation%20Brief%20v3.md). The `docs/v2/` destination is required by the issue; this is a v3 feasibility report.

**Result: the release supports ordered substitution actions, lineups, scores and personal fouls, but does not establish an exhaustive set of substitution-eligible opportunities.** Same-clock grouping is insufficient, some stoppages have no independent marker, and the proposed “every dead ball” definition needs a rules correction. Proceed only with a reviewed, explicitly restricted opportunity definition or an upstream evidence improvement. This report does not approve that definition, change the brief, build a replay engine, change adapters, publish a dataset, or authorize scored runs.

## Inputs and reproducibility

Read both manifests pinned in `config/datasets.json`: `spo-771-full-v1-2025-26` and `spo-771-full-v1-2024-25`, schema `0.1.0`, transformation `6695e0b18ce83046602f0c016623414af8a95add`. Scope is all **82 Celtics regular-season games in 2025–26**, plus only the two named historical gap games in 2024–25. Other phases and teams' standalone games are excluded; both teams' events inside a Celtics game are counted.

Reproduce from the repository root with existing Node dependencies, Python 3.8+ (standard library only), and configured read-only Doppler/R2 access:

```sh
npx tsx scripts/decision-window-export.ts
python3 scripts/decision-window-analysis.py
python3 scripts/decision-window-official-audit.py
```

The exporter uses `PlayByPlayAdapter.games()` and `.coverage()` and the existing hash-verifying `Release.rows()` reader, as the audit does. It deliberately inspects underlying release rows even for withheld products; that does **not** bypass the adapter's coverage policy for research sessions. Exported source tables and exact official response bodies remain in ignored `.cache/spo837/`. Committed evidence records the pinned manifests, partition hashes, coverage, findings, counts, and review sheets. No credentials are emitted.

Evidence index:

- [2025–26 summary](../evidence/decision-windows/2025-26-summary.json): complete type/subtype distribution and aggregate counts.
- [All 82 per-game results](../evidence/decision-windows/2025-26-games.json): event denominators, home/away null counts **and rates**, marker counts, ordering checks.
- [2025–26 provenance](../evidence/decision-windows/2025-26-provenance.json) and [historical provenance](../evidence/decision-windows/2024-25-provenance.json): object hashes, official source references, coverage, quality findings.
- [Sample and problematic clock groups](../evidence/decision-windows/2025-26-groups.json), [sample boundary changes](../evidence/decision-windows/2025-26-boundaries.json), [foul-count exceptions to naive counting](../evidence/decision-windows/2025-26-fouls.json).
- [Official comparison and every audited Celtics pre-substitution five](../evidence/decision-windows/official-audit.json), [official descriptions for every sample candidate](../evidence/decision-windows/official-review-sheets.json).
- [Historical per-game results](../evidence/decision-windows/2024-25-games.json) and [historical summary](../evidence/decision-windows/2024-25-summary.json).

### Counting conventions

An **event** is one effective release row. All 45,486 rows in the 82-game sample are `validity=effective`; there are zero superseded, overturned or unresolved rows. Sort each game by `canonical_sequence`, never Parquet row order.

A **clock bucket** is a maximal consecutive run at the same `(period, clock_remaining_ms)`. A **marker bucket** contains at least one of the diagnostic markers in question 1. These are descriptive counts, **not certified legal opportunities**. They deliberately include free throws and both sides of a period break to reveal what the feed supplies. A **substitution block** is a maximal consecutive run of `type=substitution` at the same period and clock, possibly containing both teams. A player replacement normally contributes two event rows, one `out` and one `in`. Group size below counts `sub_in` participants, not rows. Boundary changes are included in substitution totals unless explicitly separated.

## 1. Stoppage identification

| Diagnostic marker (`type`, and `subtype` where needed) | Effective events |
| --- | ---: |
| `foul`: `personal` / `offensive` / `technical` | 2,800 / 270 / 65 |
| `timeout`: `full` / `challenge` | 870 / 17 |
| `free_throw`: `1 of 1` | 427 |
| `free_throw`: `1 of 2` / `2 of 2` | 1,326 / 1,326 |
| `free_throw`: `1 of 3` / `2 of 3` / `3 of 3` | 65 / 65 / 65 |
| `period_start` / `period_end` | 330 / 330 |
| `violation`: `kicked ball` / `delay-of-game` / `defensive goaltending` / `lane` | 29 / 25 / 23 / 6 |
| `turnover` with dead-ball subtypes listed below | 921 |
| `ejection`: `other` | 3 |
| Explicit replay-review event type | 0 |

The 921 turnover markers are `out-of-bounds` 397, `offensive foul` 272, `shot clock` 108, `traveling` 83, `backcourt` 17, `3-second-violation` 11, `offensive goaltending` 9, `5-second-violation` 7, `discontinued dribble` 7, `double dribble` 4, `offensive-kicked-ball` 3, `8-second-violation` 2, and `jumpball violation` 1. `bad pass` (623) and `lost ball` (489) are not independently dead-ball markers. Offensive-foul and turnover rows may describe the same whistle; do not count both as opportunities.

These markers identify **5,135 clock buckets**, of which **3,618 have no Celtics substitution** and 1,517 do. Thus negative examples do exist independently of substitutions. The remainder of the season's 1,683 Celtics substitution buckets includes **166 without any of these markers**; all-team substitution buckets without markers number 265. Of the 166 Celtics cases, 73 have only rebounds among live-event types, 52 have no live-event type at all (substitution-only buckets), 29 have field goals and rebounds, and 12 have other combinations recorded in the group evidence. This is a failure of a universal marker rule, not permission to create positive-only windows.

Out-of-bounds **turnovers** are explicit. Out-of-bounds stops retaining possession are not a separate normalized type: team rebounds, jump-ball records, or substitutions may be the only hints. `rebound/offensive` and `rebound/defensive` also occur in live play and after non-final free throws. There are 8,672 rebound rows and 168 `jump_ball/recovered` rows; neither is a universally safe stoppage opener. The 70 `administrative` rows are heaves, not review markers. The 17 challenge timeouts do not enumerate all reviews.

Free-throw numbers and totals are populated on all 3,274 attempts (zero nulls in either field). They identify position within a series, not every legal substitution interval. `free_throw_type` is null on 2,181 attempts; its non-null values in this release are scoring qualifiers such as `2ndchance` and `fromturnover`, not a reliable technical/flagrant/retained-possession classification. A “pending free throws” value cannot be obtained by looking ahead to the next shot in an assembler state.

**Brief amendment required:** dead ball does not imply permission to substitute. NBA Rule 3, Section V restricts free-throw substitutions and prohibits substitutions during specified suspensions including delay warnings and replay review. Therefore the brief's blanket review/dead-ball rule is not a faithful legal-opportunity definition; the 25 delay-of-game rows must not automatically become negative examples. This is a proposed correction, not an approved change. [NBA official substitution rule](https://official.nba.com/rule-no-3-players-substitutes-and-coaches/).

## 2. Substitution grouping

| Grouping | Groups | One entry | Two entries | Three or more entries |
| --- | ---: | ---: | ---: | ---: |
| Both teams combined, same clock | 2,506 | 1,200 | 617 | 689 |
| Celtics only, same clock | 1,683 | 1,105 | 409 | 169 |
| Celtics only, contiguous same-clock substitution block | 1,699 | 1,133 | 399 | 167 |

There are **10,064 substitution rows** across both teams (5,032 in, 5,032 out). Celtics contribute **2,475 entries and 2,475 exits**. Every Celtics clock bucket has equal entry and exit counts, but **8 have a player in both sets**, so equal counts do not establish a valid single action.

**16 Celtics clock buckets contain non-substitution events between Celtics substitution rows.** Examples:

- `0022500158`, Q4 0.6, sequences 609–624: Queta exits, then an offensive foul and timeouts, then Queta returns. One aggregate action would erase decisions.
- `0022500216`, Q4 5:54, sequences 520–526: one Celtics change before the first free throw, another after it.
- `0022500320`, Q4 12.8, sequences 495–504: substitution, jump ball, timeout, another substitution.
- `0022500959`, Q4 0.8, sequences 533–538: Harper/Queta swap, free throw, timeout, reverse swap.

All 16 are retained in the group evidence with intervening descriptions. There are **2,535** contiguous same-clock substitution blocks across both teams. Contiguity alone is also insufficient: three runs cross clocks (`0022500250`, `0022500728`, `0022500741`). Both order and clock must be checked. Raw in-period entry events number **2,039**, while player stints have **2,036** substitution starts. Three games differ by one: `0022500193` (29 versus 28), `0022500358` (27 versus 26), and `0022501085` (25 versus 24). The first and third contain a player exiting and re-entering within one contiguous batch (Brown at 360–367; Walsh at 457–464); the Toronto case has the timeout-separated White return at 84–92 shown in the group evidence. Stint products therefore must not be treated as an independent exact count of raw replacement events. Retain `stint_action_count_mismatch` for qualification review rather than silently netting these actions.

Zero substitution events, and zero events of any type, have a non-null `order_repair_reason`. That is evidence of no *recorded* repairs, not proof of real-world ordering accuracy.

## 3. Lineup completeness

Across **45,486/45,486** 2025–26 events, both `home_lineup_before` and `away_lineup_before` are non-null five-player arrays. **Every one of the 82 games has 0% home nulls and 0% away nulls**, with individual denominators in the per-game evidence. The 5,135 diagnostic marker buckets have zero unknown own or opponent opening lineups. Score-before fields have zero nulls. All games have zero duplicate canonical sequence positions and zero null event clocks.

Completeness is not a guarantee that a row is the correct decision snapshot. Substitution rows expose the pre-block lineup and the post-block lineup; they are not a sequential stream of four-, three-, then five-player arrays. In particular, a period-start row already includes the new five, and `lineup_after` reveals the action. Use a prefix before the decision, not those post-decision values.

## 4. Personal fouls at decision time

The Celtics have **3,686 player stints**, with **0/3,686 null `personal_fouls_entry` and 0/3,686 null `personal_fouls_exit`**. These are values at stint boundaries, not at every event inside the stint.

Join `event_participants` to effective events by `event_id`, count role `fouler` for the player over the strict canonical prefix, and count only personal-foul contributions. The audit excludes descriptions matching `technical`, `defensive 3 second`, or `delay of game`, consistent with the release's qualification convention. Counting every fouler role blindly disagrees with **25 of 1,348 Celtics player-box rows**. Excluding those non-personal contributions produces **0/1,348 final-total disagreements**, including zero-minute players, and **0/7,372** non-null stint-entry/exit disagreements. The exceptions and individual official totals are retained in the foul evidence.

For a snapshot after a foul trigger, include that foul; do not use the eventual stint exit total. Official final totals are a validation oracle only, never an in-game feature. The two historical gap games also reconcile **34/34** Celtic player-box totals from events, but have **zero player-stint rows**; a null rate over absent stints is undefined, not 0%.

## 5. Between-period changes

The 82 games contain **330 played periods**: 81 regulation games and one six-period game. Celtics stints have **1,650 `period_start` starts**, **1,650 `period_end` ends**, and **2,036 substitution starts/ends**. The period-specific stint convention is directly usable.

There are **248 transitions to a subsequent period**, with known Celtics fives on both sides: **224 change** and **24 do not**. Net entry counts are 0:24, 1:82, 2:84, 3:47, 4:10, 5:1. Compare the prior `period_end` five to the next `period_start` five for the outcome, but keep the next five out of the input state. The audit sheet checks all 11 transitions in the sample games.

Substitution rows at the new period's opening clock often **precede** its `period_start` row. For example, opener sequences 132–135 change the five before Q2 starts at 136; Q4 changes span 428–435 before start at 436. Tag these as one `between_periods` decision, not both an in-period substitution and another period-start decision. The opening tip and the final game end are not transitions to a next-period lineup. The diagnostic 5,135 count has not performed this deduplication and must not be reported as the scored denominator.

## 6. Ordering and observable prefixes

`canonical_sequence` gives a total, unique order in every inspected game, with zero null clocks and zero recorded repairs. **882** substitution clock buckets contain both teams; **263** of these also contain a timeout. Relative to the first Celtics substitution row in a bucket, there are **778 opponent substitution rows before** and **2,132 after**, plus **430 timeouts before** and **18 after**. These are row counts, not player-pair counts.

There are **42 contiguous substitution blocks** with a complete opponent in/out change before the first Celtics row. Release lineups are block-atomic: at opener Q4 9:18, opponent changes occur at 457–460 and the first Celtics row is 461, but that row's opponent `lineup_before` still describes the pre-block five. If the eventual definition permits that prefix as context, reconstruct completed opponent changes from prior participant rows; do not use the block's `lineup_after`, which may include later opponent actions. Partial opponent out/in batches are not a complete observed five and require an explicit withholding/ambiguity reason.

The feed order is stable and auditable; it does not record the referee's beckoning instant or prove that published same-clock ordering equals the coach's information order. Nor may the builder choose its snapshot by searching forward to the first Celtics substitution: that makes the input cutoff depend on the target. An independent opener and a fixed cutoff policy are required for positive and negative examples alike.

## 7. Gap games

| Game | Events | Home lineup nulls | Away lineup nulls | Marker buckets | Buckets with unknown either five | Celtics substitution buckets |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `0022400061` (Oct 22, 2024) | 453 | 77 (17.00%) | 0 | 53 | 10 | 13 |
| `0022400230` (Nov 16, 2024) | 563 | 0 | 51 (9.06%) | 72 | 7 | 18 |
| `0022500338` (Dec 5, 2025) | 533 | 0 | 0 | 63 | 0 | 22 |

The two historical games have valid normalization, partial lineups, failed stints and possessions, and partial summaries. The October game has five `unresolved_lineup` findings and one `rotation_rejected`; the November game has four `unresolved_lineup` findings. The November missing five is the **opponent** (Toronto), so looking only at Celtics completeness misses it. Neither game has player stints. The ordinary adapter must continue serving the incomplete products as absent. Diagnostic event counts do not certify the remaining windows for state-v1.

The December game has valid normalization, lineups, stints and possessions, **46 Celtics player stints**, and zero foul reconciliation discrepancies. It loses qualified summary fields: two quality findings identify **field-goal attempts, offensive rebounds and total rebounds** in player/team summaries. It therefore supports substitution and lineup analysis but **not an unconditionally qualified full box-score-so-far state**. The findings do not localize the discrepancy to an event span. Do not fill a running stat from the final official box or silently omit the game. Under unchanged state-v1, conservatively flag its candidate states `unqualified_running_box_score` until upstream localization/correction or an explicit state-schema amendment permits nullable affected fields. Its 63 marker buckets and 22 substitution buckets remain visible as diagnostics, not silently dropped or declared scored-ready.

## Three-game official hand audit

Selected deliberately: opener `0022500083` (Philadelphia at Boston, Oct 22), the only overtime game `0022500637` (Boston at Brooklyn, Jan 23, two overtimes), and the scored-season gap `0022500338` (Lakers at Boston, Dec 5). This is a structural audit of source data, not a model run or evidence of learning.

The live CDN returned HTTP 403 during this task. The check instead uses the **exact archived official NBA `cdn_pbp` and `cdn_box` responses**, retrieved through their release `raw_objects` references and SHA-256 verified. Their official endpoint URLs, hashes and retrieval times are in provenance. This checks the transformation against its official source, **not an independent contemporary revision or video ground truth**.

| Game | Official / release events | Marker buckets | No-Celtics-sub marker buckets | Celtics out+in rows | Player entries | Celtics substitution buckets / blocks | Period transitions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `0022500083` | 586 / 586 | 76 | 51 | 78 | 39 | 29 / 29 | 3 |
| `0022500637` | 677 / 677 | 89 | 58 | 90 | 45 | 36 / 36 | 5 |
| `0022500338` | 533 / 533 | 63 | 43 | 64 | 32 | 22 / 22 | 3 |

Method: compare every official action number, description, period and clock to the canonical row and sequence; independently start from official box-score starters and walk the official out/in blocks; compare **both pre-block fives at every one of the 87 Celtics substitution blocks**. Then inspect the candidate descriptions and all Celtics changes in the review sheets, including negative markers, period breaks, free-throw placement and simultaneous batches. Every pre-block Celtics five, outgoing set and incoming set is retained with action/sequence identifiers; assertions of equality alone are not the audit evidence.

### Disagreements and limitations found

- **0 missing/extra source rows or order/description/period/clock disagreements**, across 1,796 official/release events. **0 pre-block lineup disagreements** across 87 Celtics blocks, **0 invalid official substitution chains**, and **0 marker-count disagreements** (76/89/63). Grouping by clock agrees with contiguous blocks on these three games; the 16 season-wide counterexamples above must still be handled.
- **11 Celtics substitution buckets lack an independent diagnostic marker**: opener Q1 9:02, Q1 3:14, Q2 3:03, Q3 4:02; Brooklyn Q2 8:57, Q2 5:47, Q4 8:23, Q4 4:47, Q4 3:39; Lakers Q4 7:04 and Q4 3:18. Some have team rebounds or jump balls; others only substitution rows. Thus the marker reconstruction misses 4/5/2 positive buckets respectively. These are eligibility-definition disagreements, even though source and release agree exactly.
- **Same clock is not necessarily one whistle even in a negative bucket:** opener Q3 2:26 includes Queta's foul, two Oubre free throws, Bona's loose-ball foul, and two Boucher free throws (398–403). One clock bucket cannot certify one opportunity. Lakers Q3 9:55 has a timeout followed by a shooting foul and free throws (295–299). Lakers Q2 2.5 has free throws followed by a live turnover/steal (265–270).
- **Source clocks can be awkward without a recorded repair:** Brooklyn Q4 offensive foul is at 4:48 (449–450), while the next Celtics substitution is at 4:47 (453–454). Do not silently merge adjacent clocks. The Lakers Q4 7:04 substitution follows a rebound (445–449), with a shooting foul at 7:03 (450). These are retained observations, not inferred corrections.
- **Lineup semantics, not a source mismatch:** opener Q4 9:18 illustrates the opponent-prefix/block-atomic discrepancy described in question 6. The atomic pre-block audit passes, but treating `lineup_before` as fully sequential at every individual substitution row would be wrong.

The official feed has no total of legal stoppages to compare with 76/89/63. Those are reproducible marker counts, not a claim of zero disagreement about the complete legal opportunity set.

## Proposed definition in existing release fields — for review, not approved

Propose an initially **restricted, independently marked opportunity dataset**, with an exclusion ledger, rather than claiming every legal substitution opportunity. Its version should be pinned separately from `state-v1`. It is a brief amendment because the current Proposed text treats reviews and all dead balls as open windows.

1. Read effective events in `canonical_sequence` order, retain all quality flags and coverage. A candidate must start from a non-substitution marker: `timeout/full`, a personal/offensive `foul`, or a dead-ball turnover/violation from the explicit values above. Exclude isolated `violation/delay-of-game`, review/challenge suspensions, technical-only or ejection-only situations unless an independently qualifying timeout/whistle is established. Do not infer an opener from a substitution, made basket, team rebound, or an observed later entrant.
2. Freeze the candidate snapshot immediately after its opening marker and before any following event. This fixed rule applies whether a Celtics substitution follows or not. Use the marker's scores and five-player state after its statistical contribution; include only fouls, timeouts and completed substitutions through that prefix. Keep free-throw pending state unknown unless the prefix itself establishes it. If state-v1 cannot represent that uncertainty, flag the candidate instead of looking ahead. No outcome, later free-throw result, later timeout, or later opponent change enters the state.
3. For this conservative first definition, coalesce duplicate foul/offensive-turnover records of one whistle, but flag equal-clock runs with another potentially distinct whistle, timeout, live action after the opener, multiple Celtics blocks, re-entry, unknown free-throw eligibility, or incomplete opponent batches as `ambiguous_stoppage`. Do not use equal clock alone to resolve them. Free-throw numbers/total and descriptions support audit, but are insufficient to certify every exception or retained-possession case. Retain an exclusion reason and source sequence span for each rejected candidate.
4. Within a qualified interval, collect `sub_in`/`sub_out` participant IDs from its single contiguous same-period/same-clock Celtics substitution block. Validate unique, disjoint, equal-sized sets against the pre-decision five and eligible roster. No block means no substitution. A substitution without an independent opener is a separately counted `unanchored_substitution`, never a positive-only new window. Do not interpret its absence from the candidate dataset as a negative.
5. Create one separate `between_periods` candidate for each transition to a subsequent `period_start`, with the prior `period_end` state and next-period clock (12 minutes regulation, 5 overtime). Its outcome is the net lineup change across the boundary, including new-period opening substitution rows, and may be empty. Never expose the next-period five in the input. Do not create duplicate windows at both boundary rows, the opening tip, or terminal game end.
6. Exclude unknown/non-five lineups, unsupported running statistics, failed product coverage, and unresolved ordering with explicit reasons. Report all marker candidates, unanchored substitutions, exclusions by reason, and period windows before any scoring. The counts in this report characterize the inputs and failure modes; the final qualified-window count awaits the reviewed definition and R2.

This proposal sacrifices recall to avoid inventing a full denominator. It does not claim that retained opportunities represent all coaching decisions. If that restricted estimand is unacceptable, upstream work is required before R2 window reconstruction.

## What the release cannot supply, and upstream changes needed

| Missing evidence | Consequence | Upstream requirement |
| --- | --- | --- |
| Independent stoppage opener/resumption and legal substitution interval | 166 Celtics substitution clock buckets lack diagnostic openers; negative-opportunity completeness is unmeasurable | Publish source-evidenced stoppage IDs/spans and eligibility reasons for **all** opportunities, including those with no substitutions; preserve uncertainty where official PBP does not establish a stop. Additional official event detail or manual/video qualification may be necessary. |
| Multiple decisions at the same clock | 16 interleaved Celtics groups, 8 with re-entry | Distinguish whistle/timeout/free-throw/live-ball boundaries in canonical sequence; carry the supporting source action IDs and unresolved-order flags. |
| Reliable free-throw/retained-possession and review semantics | FT position exists, but legal entry timing and standalone review opportunities do not follow from it | Normalize source-supported free-throw category and possession-retention facts; separate replay suspension from charged timeout and distinguish non-substitution suspensions. Do not derive these from scoring qualifiers. |
| Fully sequential opponent state within an atomic batch | 42 blocks have a completed opponent change before the first Celtics row | Document atomic batch semantics and expose a qualified prefix/grouping rule (or prefix lineup product) that never imports later changes. R2 may reconstruct this only under the approved cutoff rule. |
| Localized December 5 stat defects | Full state-v1 box score cannot be certified merely because lineups pass | Correct/requalify the three affected stat fields or publish affected player/event spans; otherwise a reviewed nullable-state amendment is needed. |
| Raw actions versus stint occurrences | Three games differ by one in-period entry | Qualify the same-clock re-entry/zero-duration convention against source event spans; preserve an explicit reason for any action netted away. |
| Complete historical gap products | October unknown Celtics state; November unknown opponent state; no stints | Repair source-evidenced lineup chains / missing player identity, regenerate and pin qualified products. Keep current incomplete products unavailable meanwhile. |

No upstream data was changed or published by this spike. **The brief's decision-window section remains Proposed.** Review must choose the restricted definition (including its uncertainty exclusions and any necessary state amendment) or require upstream qualification first; R2 must not silently treat the 5,135 descriptive buckets as an approved dataset.
