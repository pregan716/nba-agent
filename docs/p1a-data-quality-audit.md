# P1a data quality audit — SPO-777

Audit date: 2026-10-24. Scope: the immutable P1 corpus pinned in `config/datasets.json`, served through the adapters on the merged SPO-776 implementation. **Audit complete with findings; this is not an unconditional Gate 2 approval.** No dataset pins, identity mappings, replay availability rules, question sets, scoring rules, or implementation-brief decisions were changed.

## Results

| Check | Result |
| --- | --- |
| Cross-bucket identity | All 17 propped Celtics players resolve uniquely to NBA, reference and injury identities. All 234 names in served lineups resolve, including 218 opponent names. Three other injury names remain unresolved/ambiguous. |
| Schedule agreement | **Pass: 82/82** agree across NBA scheduled tipoff, ESPN schedule and cutoff observation `requested_at`; zero cutoff changes proposed. |
| Timestamp plausibility | 139/164 lineup announcements precede the cutoff; 25 are at/after it. Final pregame injury reports exist for both teams in all 82 games. One pregame video was published 87 seconds late. All 1,425 original post publication times are inside the documented collection window. |
| Resolution integrity | **Pass: 663/663 game-player identities** have official box scores; 26 have zero reconstructed playing time. December 5 uses the agreed box-score fallback. Consensus **50/50** and second-source outcomes **50/50** agree. |
| Content | All 20 sampled transcripts are consistent with Mazzulla as the primary interviewee. Of 50 sampled labelled posts, 33 are verifiably basketball-related and 17 are indeterminate from retained evidence; none is demonstrably off-topic. Apparent transcription errors are flagged separately. |
| Availability conventions | All near-cutoff records are enumerated with IDs, times, conventions and object hashes. Includes 1,779 odds, 35,684 injury, 158 lineup, 54 post and 5 transcript records. |

The numeric audit uses [summary.json](evidence/audit/summary.json); qualitative decisions are in [content-review.json](evidence/audit/content-review.json). The proposals below are for the user to accept, reject, or defer before Gate 2. They are not runtime overrides.

## Reproduction and evidence

Run `npm ci`, `npm run audit`, `npm run check`, `npm test`, and `npm run format:check`. The live audit uses the existing GET-only `nba-agent/prd` Doppler reader. `.cache/objects` is optional, ignored, and hash-checked before use. No credentials or source audio are exported. The audit memoizes verified box-score/summary decodes within its process so repeated per-game adapter reads do not repeatedly decode a season partition.

`npm run audit` overwrites the generated evidence, but does **not** generate qualitative judgments or edit this report. It exports the selected readable transcripts into ignored `.cache/audit-content/` for review. If the pins or sample change, redo the qualitative review; the evidence test detects stale sample IDs/text hashes. The committed qualitative review is Codex's text-based review, not independent audio/video speaker authentication.

All samples use SHA-256 ranking of `seed + newline + stable record key`, taking the first N distinct rows without replacement. The seed `SPO-777-v1` and suffixes `:consensus`, `:outcomes`, `:transcripts`, `:posts` were fixed before inspection. Input ordering cannot change selection. Samples cover the full served/published populations specified below, not hand-picked favorable rows. A sample pass is not a claim that every unsampled record is correct.

Every evidence file retains immutable object references (bucket, key, SHA-256). [summary.json](evidence/audit/summary.json) records the dataset versions, methodology hash, transcript manifests and identity-map hash. Evidence is for environment/audit use; it is not analyst-visible replay input.

| Evidence | Contents |
| --- | --- |
| [identity.json](evidence/audit/identity.json) | Per-player cross-source joins, all served lineup names, supplementary raw lineup names, all injury-name outcomes and candidate profiles |
| [schedule.json](evidence/audit/schedule.json) | All 82 three-way comparisons, including every distinct requested/start value |
| [timestamps.json](evidence/audit/timestamps.json) | Every served lineup, 164 final injury reports, all 104 title-screened transcript candidates, post-window violations |
| [resolution.json](evidence/audit/resolution.json) | Official stats and participation basis for all 663 game-player combinations |
| [dec5-fallback.json](evidence/audit/dec5-fallback.json) | All December 5 box-score players, including zero-minute rows, and confirmation that partial summaries are absent |
| [consensus-sample.json](evidence/audit/consensus-sample.json) | 50 samples with raw prices, independently normalized pairs, main-line votes and medians |
| [outcome-sample.json](evidence/audit/outcome-sample.json) | 50 cutoff questions with NBA and ESPN actual stats and outcomes |
| [content-sample.json](evidence/audit/content-sample.json) | Exact 20 transcript IDs/hashes and 50 posts with retained reference context |
| [content-review.json](evidence/audit/content-review.json) | Per-item qualitative judgments, transcript time spans and limitations |
| [boundary-records.jsonl](evidence/audit/boundary-records.jsonl) | Complete near-cutoff record list, grouped only to avoid repeating provenance |

## 1. Cross-bucket identity

Method: rebuild name candidate sets from the pinned NBA player catalogs for both seasons and the opening player profiles; honor the published guest-identity exceptions, but never resolve a collision by taking the first candidate. Compare independently resolved prop names with the stored ESPN-to-NBA map. Check each game’s ESPN athlete name/team against the propped identity and the NBA box-score team. Injury names use the P1 `Family, Given` conversion. This tests existing mapping behavior without creating replacement mappings.

All 17 propped Celtics players have exactly one NBA and reference profile and at least one injury-name match. Sixteen have at least one served lineup appearance. Chris Boucher has none in the selected regular-season starting announcements; this is absence of a starting appearance, not an unresolved name. The 164 served announcements contain 820 name occurrences: all 234 distinct names resolve, including all 218 opponent names. The raw-lineup supplement also checks nonpreferred announcements and preseason names: all 18 Celtics and 226 opponent name strings in the full datasets resolve, including Boucher there.

All 559 distinct matched regular-season injury names were checked: 556 resolve and three fail. None is a propped Celtics player or an unresolved served opponent starter. Injury counts include all teams served by the adapter, not only Celtics games.

| Injury spelling | Observations | Finding | Celtics game association |
| --- | ---: | --- | --- |
| `Jones, Dillon` | 1,117 | Ambiguous between `1641794` and `196295686` | `0022500757` (Feb 8); exact association retained in evidence |
| `Williams, Jaylin` | 798 | Ambiguous between `1631119` and `1642444` | None in these injury rows |
| `Yang, Hansen` | 854 | P1 converts to `Hansen Yang`, while NBA/reference publish `Yang Hansen` (`1642905`) | None in these injury rows |

The two Jaylin Williams profiles have different birth dates (2002-06-29 and 2000-07-26). They must not be collapsed by name. The Yang reference profile identifies Portland. Dillon's extra PBP ID is not one of the already-published guest exceptions; do not infer an exception from ID magnitude. See proposals I1–I3.

## 2. Schedule agreement

Method: for each canonical Celtics game, compare the PBP games table's `scheduled_tipoff`, the preserved ESPN schedule event's `date`, **every distinct `requested_at` on `snapshot_kind=scheduled_start`**, and the consensus rows’ `scheduled_start`. Normalize instants rather than comparing timestamp formatting. The identity map uses teams/date; the audit checks the timestamps themselves.

All 82 comparisons pass. There are no missing cutoff observations, multiple cutoff timestamps, or NBA/ESPN/request disagreements. The cutoff is unchanged. This checks agreement among archived schedules, not whether scheduled start equals actual tipoff or whether an earlier schedule revision existed.

## 3. Timestamp plausibility

### Lineups

Method: assess all 82 selected Celtics and 82 selected opponent announcements against their game’s scheduled cutoff. Operationalize “a few hours before tip” as `-180 <= minutes < 0`. All announcements are between 45 minutes before and 44 minutes 44 seconds after the cutoff; none is implausibly early.

**25 convention findings:** 18 Celtics and 7 opponent announcements are at/after scheduled start. These are not proven timestamp data errors: a real lineup announcement can be posted near actual tip, after scheduled tip. Under the current strict-before convention these announcements are unavailable. Two are exactly equal to cutoff. Do not backdate them or move games to actual tip on this evidence.

| Game | Side | Minutes at/after cutoff | Source |
| --- | --- | ---: | --- |
| `0022500060` | celtics | 0.000 | [Post](https://x.com/celtics/status/1993801941013663755) |
| `0022500293` | celtics | 0.000 | [Post](https://x.com/celtics/status/1994889105294201193) |
| `0022500302` | celtics | 1.900 | [Post](https://x.com/celtics/status/1995267069844049941) |
| `0022500320` | celtics | 5.000 | [Post](https://x.com/celtics/status/1996022824272887985) |
| `0022500444` | celtics | 0.267 | [Post](https://x.com/celtics/status/2005413520561820063) |
| `0022500503` | celtics | 0.067 | [Post](https://x.com/celtics/status/2008335221595496629) |
| `0022500520` | celtics | 0.283 | [Post](https://x.com/celtics/status/2009052500004098231) |
| `0022500545` | celtics | 5.250 | [Post](https://x.com/celtics/status/2010156013366980719) |
| `0022500580` | celtics | 44.733 | [Post](https://x.com/celtics/status/2011970339685752933) |
| `0022500660` | celtics | 0.300 | [Post](https://x.com/celtics/status/2015952976150724930) |
| `0022500702` | celtics | 0.117 | [Post](https://x.com/celtics/status/2018059308647456911) |
| `0022500741` | celtics | 0.267 | [Post](https://x.com/celtics/status/2019931684968554856) |
| `0022500757` | celtics | 6.283 | [Post](https://x.com/celtics/status/2020552278172696605) |
| `0022500874` | celtics | 0.200 | [Post](https://x.com/celtics/status/2028274138302087518) |
| `0022500986` | celtics | 0.250 | [Post](https://x.com/celtics/status/2033687316661997810) |
| `0022500999` | celtics | 0.333 | [Post](https://x.com/celtics/status/2034404566314406354) |
| `0022501035` | celtics | 0.300 | [Post](https://x.com/celtics/status/2035869206718427240) |
| `0022501054` | celtics | 0.250 | [Post](https://x.com/celtics/status/2036948808752652429) |
| `0022500146` | opponent | 9.283 | [Post](https://x.com/HoustonRockets/status/1984774781875458289) |
| `0022500158` | opponent | 1.267 | [Post](https://x.com/utahjazz/status/1985505085934195087) |
| `0022500459` | opponent | 3.067 | [Post](https://x.com/utahjazz/status/2006184299578454352) |
| `0022500673` | opponent | 6.517 | [Post](https://x.com/ATLHawks/status/2016671766295294090) |
| `0022500728` | opponent | 11.033 | [Post](https://x.com/HoustonRockets/status/2019217166365782502) |
| `0022500859` | opponent | 5.500 | [Post](https://x.com/BrooklynNets/status/2027543146150633923) |
| `0022501168` | opponent | 8.483 | [Post](https://x.com/nyknicks/status/2042386697451671626) |

### Injury reports

Method: scan every served team snapshot and choose the latest printed timestamp strictly before each cutoff for each participating team. Check existence and age; this is deliberately a pregame selection, not a claim that reports after cutoff do not exist. All 164 latest snapshots precede cutoff by **15–120 minutes**. Availability is the P1 printed-time convention, not proof of live PDF delivery.

One content gap accompanies this timestamp pass: Boston’s final snapshot for `0022501149` (Apr 7, ESPN `401811004`) is **`team_absent`**, printed at `2026-04-07T23:00:00Z`, 60 minutes before cutoff. The other 163 are `players_listed`. Absence is not “everyone healthy.” The precise record ID, partition and PDF hash are in `finalReports`; proposal T3 preserves this missingness explicitly. This is a data-coverage finding, not a timestamp correction.

### Transcripts

Method: screen all 134 titles for `pregame`, `postgame`, `post game` and the published typo `postgane`. Compare original publication time with the nearest scheduled Celtics game across **all phases**, without first selecting a game on the desired side of the timestamp. Retain candidate game and signed distance for review. This prevents a late pregame upload from being made to pass by matching it to the next game. The nearest-game join is an audit association, not a new canonical media mapping.

104 titles match the screen. Manual review of the title/game associations removes one false positive: [the Jan 14 practice interview](https://www.youtube.com/watch?v=uZj53B1FJfA) discusses earlier “Post Game Comments”; it is not a postgame interview for the nearest future game. Of the **103 actual pre/postgame titles**, 102 are on the expected side of tip; 4 are preseason, 87 regular season, and 12 playoffs. The other 30 titles are practice/general media and are outside this specific title test, not silently discarded from the corpus or content sampling.

The sole timing violation is [“Celtics Made SUBSTITUTIONS to Address Effort”](https://www.youtube.com/watch?v=ebSoNLUohzA), game `0022500174`: published `2025-11-06T00:31:27Z`, against cutoff `00:30:00Z`. **Classification: convention error** if “pregame” is used to imply pre-cutoff availability; no evidence establishes an erroneous publication timestamp. Retain publication-time gating (proposal T2). Postgame uploads delayed until the next day still correctly fall after their games. Livestream availability remains stream end; the boundary list uses that availability, not a stream's earlier publication/start.

### Beat posts

All **1,425/1,425** labelled logical posts have original publication times inside the guide’s preseason-plus-regular-season window: `[2025-09-29 00:00 Eastern, 2026-04-13 00:00 Eastern)`. This is wider than the first/last Celtics tipoff; preseason coverage is intentional. No timestamp violations. The adapter separately excludes four relevant versions with unknown edit-publication time, leaving 1,299 served relevant versions; the content sample still draws from all 1,303 relevant labels, as requested.

## 4. Resolution integrity

Method: call the P1 box-score and summary adapters for every Celtics regular-season game, checking per-game coverage. Enumerate the union of propped players over all four observations, including non-`ok` consensus rows. Require unique NBA box-score rows, nonnegative integer points/rebounds/assists, Celtics team membership, and usable participation evidence. Cross-check ESPN athlete names/team where present. The NBA official box score supplies actual stats; reconstructed PBP minutes determine participation unless summaries are partial.

**663/663 game-player combinations have official stats; no missing or duplicate propped box rows and no participation disagreements.** Of these, 26 have zero reconstructed minutes and resolve to DNP under the existing rule, not under. ESPN explicitly corroborates DNP for 14; the other 12 are absent from ESPN’s box-score athlete lists. That absence is not used to invent a second-source stat. All 663 are present in NBA official box scores, so no missing-box fallback is needed. No game exclusion is proposed.

For **Dec 5, 2025, Lakers `0022500338`**, normalization is valid and summaries are partial: the adapter serves zero summary rows and 34 official box rows, nine with zero minutes. All eight propped Celtics players played; box-score seconds and official points/rebounds/assists are:

| Player | Seconds | Points | Rebounds | Assists |
| --- | ---: | ---: | ---: | ---: |
| Derrick White | 1777 | 19 | 5 | 6 |
| Jaylen Brown | 2021 | 30 | 8 | 8 |
| Sam Hauser | 1461 | 12 | 3 | 0 |
| Payton Pritchard | 1809 | 15 | 2 | 6 |
| Anfernee Simons | 952 | 8 | 4 | 2 |
| Neemias Queta | 1562 | 10 | 6 | 2 |
| Jordan Walsh | 1577 | 17 | 4 | 1 |
| Josh Minott | 1376 | 6 | 3 | 3 |

This confirms the already-agreed box-score-minutes fallback, including zero-minute detection on the full game. It does not substitute derived PBP statistics for official resolution.

**Consensus sample:** 50 rows sampled from all 6,666 `ok` rows, across all observations. Join accepted pairs by ESPN game, requested time, ESPN player and prop. Independently convert each raw American price to implied probability, proportionally normalize the pair, select each book’s main line by distance from 0.5 (overround then lower-line ties), choose the offered main line nearest the median vote (votes, pair count, lower-line ties), and take the median normalized probability from books at that line. Check all pair probabilities, main/contribution flags, selected line, probability and contributing-book set/count. **50/50 pass**, tolerance `1e-12`; no production consensus is recomputed or replaced. This checks accepted pairs, not a fresh audit of rejected raw quotes.

**Outcomes sample:** 50 rows sampled from the 1,779 `ok` scheduled-start questions. Compare the NBA official stat and over/under result to the **preserved ESPN box-score response** pinned by the odds archive. Match ESPN athlete ID and stat labels `PTS`, `REB`, `AST`, rather than relying on column order. **50/50 actual values and outcomes agree** (25 over, 25 under). These are two publisher datasets, not two calculations over the NBA summary, although they may ultimately share league statistical information. The random sample contains no DNP or push; the full participation census and synthetic tests cover those cases, so the sample alone must not be claimed to validate them. No correction to resolution or question eligibility is proposed.

## 5. Content checks

### Coach media: 20 of 134

Read all 20 sampled readable transcripts in full. Each consists of a coach interview with sustained Celtics coaching answers, direct address to Joe or explicit coach context, and no competing primary interview subject. **20/20 consistent with Mazzulla as primary interviewee; observed admission error 0/20 (0%).** This is a qualitative text audit, not voice authentication or a bound on unsampled error.

Each judgment has its own ID, source hash, supporting time span and explanation in `content-review.json`. Cluster names are not identities: Mazzulla’s answer cluster is A in one sample, C in two, and B in the others; sample 12 even splits an answer into another cluster. No “speaker_A means Mazzulla” heuristic is used.

Two apparent transcription defects merit source review, separately from primary-speaker admission:

- [Jan 17 pregame](https://www.youtube.com/watch?v=qbNq7SENj1c), **38.300–52.420 seconds**: a question describes “Luka Dončić” coming from college and becoming useful for the Lakers, while the answer discusses “our” player. This is internally inconsistent with the Celtics interview and suggests player/team-name corruption. Do not silently replace it with a guessed name.
- [Nov 11 pregame](https://www.youtube.com/watch?v=iKhUMH6aoVo), **77.380–90.470 seconds**: a question about integrating Anfernee Simons contains “Ben Affleck.” Flag for source-media verification.

These are suspected data errors; the audit does not estimate an ASR word-error rate. See C2.

### NBA-related posts: 50 of 1,303 labels

Read the text and any referenced post also present in the same pinned label dataset. Do not treat the model’s label/probability as evidence of its own accuracy, and do not substitute present-day web content for missing historical context. **33/50 are verifiably basketball-related** (29 directly, four through retained context), **0/50 demonstrably off-topic**, **17/50 indeterminate** because they are link-only or context-poor replies/quotes. The review lists every item and reason.

A true label-error point estimate cannot be justified from those 17: the observed confirmed-error fraction is 0/50, while the possible sample error ranges **0–34%**. This is a missing-evidence bound, not a population confidence interval and not a claim of a 0% false-positive rate. The finding is insufficient retained content to validate those labels. C1 proposes explicit treatment of this limitation; this audit does not relabel them or alter the published label threshold.

## 6. Availability within 30 minutes of a cutoff

Method: compare every served record's modeled availability with all 82 cutoff instants, inclusive at both `-30` and `+30` minutes. Include records from other NBA teams/games because the adapters expose that history. Excluded unknown-time posts do not acquire invented timestamps. For PBP, every table shares its game's next-morning-9-AM-Eastern release convention: checking every regular-season game timestamp in both pinned seasons proves no PBP table records can fall in these windows. Static reference and schedule availability are checked separately.

| Source | Records within ±30 minutes |
| --- | ---: |
| Odds (`ok` rows, requested time) | 1,779 |
| Injury player observations | 29,642 |
| Injury team snapshots | 6,042 |
| Selected lineup announcements | 158 |
| Eligible relevant post versions | 54 |
| Coach transcripts | 5 |
| PBP/box-score products (both seasons) | 0 |
| Opening player reference (all six tables) | 0 |
| Static schedule | 0 |

The JSONL file groups by source, object hash, availability timestamp and cutoff game, and **lists every individual record ID** in `ids`; it is not just an aggregate. Delta seconds is signed. The five transcript deltas are −990 (`0022500146`), +87 (`0022500174`), −1237 (`0022500580`), −335 (`0022500673`), and −1286 (`0022500839`). Odds at exactly the cutoff are intentionally the question observations; the generic strict-before rule used for pregame announcements must not erase those odds.

Printed injury times and requested odds times remain modeled availability, not measured live delivery. The boundary file identifies exactly where a future change to these conventions could change inputs. No boundary-based exclusions were applied.

## Proposed dispositions for user review

All items are **proposed**, not accepted brief changes. There are **no proposed whole-game exclusions, cutoff changes, or stat-resolution corrections** on the evidence examined. For Gate 2, explicitly disposition the data limitations below instead of treating an audit run finishing as approval.

| ID | Proposal | Evidence / affected scope |
| --- | --- | --- |
| I1 | Approve a source- and team-scoped injury alias for `Yang, Hansen` → `1642905` (Portland), implemented and tested in a follow-up. Do not reverse all unrecognized names globally. | 854 observations; `identity.json` injury record/partition plus Yang Hansen reference profile and Portland team ID `1610612757`. |
| I2 | Approve team-scoped disambiguation of `Williams, Jaylin` for OKC (`1610612760`) to `1631119`, backed by roster evidence; preserve `1642444` as a distinct person. | 798 observations all attributed to OKC; candidate profiles have distinct birth dates and only `1631119` has opening OKC membership. |
| I3 | Keep Dillon Jones joins refused until the source provides an explicit crosswalk/identity exception for `196295686` versus `1641794`. Record the incomplete opponent injury join for `0022500757`; do not exclude the game or collapse the IDs. | 1,117 Knicks injury observations; PBP name collision and injury partitions in `identity.json`. |
| T1 | Accept the 25 at/after-cutoff lineup announcements as unavailable under the current convention. Explicitly retain the two equal-cutoff cases in that group unless the user separately approves an equality-policy change. | Complete per-game table above and `timestamps.json`; no evidence supports backdating. |
| T2 | Retain publication-time gating for the Nov 5 pregame upload; it is unavailable at `0022500174` cutoff despite its title. Do not treat the Jan 14 practice title as a postgame event. | +87-second publication evidence; practice-title false-positive adjudication above. |
| T3 | Preserve Boston’s Apr 7 `team_absent` injury state as unknown; do not treat it as an empty healthy roster or carry an earlier report forward without an explicit rule. | `0022501149`, printed 23:00Z, PDF SHA-256 `945f1c04b12fd805d713870099e5827682defaaba7e3edcc630f2cd43ccfdb48`. |
| C1 | Accept the published relevance labels with the documented 17/50 unverifiable sample items, or commission a context-complete source audit before relying on their precision. Any new filtering/relabeling requires a new pinned source/policy decision. | Every ambiguous post ID is in `content-review.json`; no missing link is counted as a correct label. |
| C2 | Flag the two suspect transcript spans for source-media review. Keep the immutable text until a corrected source release or explicit exclusion is approved; never use ASR name strings as authoritative identity mappings. | Two source URLs, spans and hashes in `content-review.json`. |

Tests cover sample stability/duplicates, consensus normalization and alternate-line contribution, incorrect probabilities/lines, DNP/push/missing evidence, and inclusive boundary endpoints. Evidence consistency checks ensure all required samples and all 82 games are represented and qualitative judgments still refer to the sampled text. The implementation changes in this PR are audit tooling, tests and evidence only.
