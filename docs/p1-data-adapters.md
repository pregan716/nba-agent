# P1 data contracts and adapters — SPO-776

## Published releases and API boundary

`openCorpus(ObjectStore, root, cache)` constructs the seven source adapters from
`config/datasets.json`: odds, both play-by-play seasons, injuries, opening player
reference, labelled posts, two lineup selections, and coach media. `ObjectStore`
supports only `get(bucket, key)`. A manifest's hash is checked before its references
are trusted; each referenced object's exact bytes and optional size are checked
before parsing. A corrupt cache entry fails closed. PBP's game index selects only
manifest-listed files; no folder listing participates in discovery.

`records()` (and injury `partitions()`) return `RecordEnvelope`s with stable IDs,
availability timestamps and conventions, distinct event/collection/revision times,
source-object references and manifest hashes. Missing source timestamps remain null.
Parquet dates and integers become JSON-safe values; unsafe integers are refused.
Player-reference access is restricted to the six published tables. Raw source archives,
audio, injury corroboration evidence, and lineup box-score comparisons are not returned.

The corpus, `Release`, `auditRows()`, `coverage()`, and version descriptors belong to
trusted environment/operator code. They intentionally allow whole-season inspection
for diagnostics and P2/P1a. **They are not a cutoff-scoped analyst tool surface.** P3
must apply its cutoff to every query path before exposing records or metadata. Do not
hand the analyst the corpus, the store, dataset paths, or diagnostic files.

The odds adapter's `records()` exposes the agreed v1 fields only: ESPN game/player,
prop, selected line, and probability. Trusted `auditRows()` retains all published
statuses and provenance for P2 and the exclusion log. The run data-source descriptor
includes the odds manifest and methodology hashes, every root selection, the exact
transcript index revision/hash, and the 134 transcript manifest hashes.

Credential reads use the `nba-agent` Doppler project, `prd` configuration, for all four
buckets. `dev` and `stg` are empty as of October 24, 2026. `DopplerStore({project, config})`
allows explicit alternatives; the worker validates injected project/config markers and
uses only `R2_ENDPOINT_URL`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`. Injection is
confined to reader subprocesses. GETs allow 180 seconds; `verify:live` performs an
uncached, hash-verified read from each bucket so warm caches cannot mask access failures.

Exclusion logs are unique by source/record/table scope, so repeated reads do not grow
duplicate diagnostic entries. Callers receive snapshots rather than mutable log arrays.
P2 reads `snapshot_kind` and `season_inferred_identity_in_inputs` from trusted odds
`auditRows()`; these provenance fields intentionally stay out of the analyst projection.

## Availability

| Source | Convention |
| --- | --- |
| Odds | `requested_at`, never provider snapshot or backfill time |
| PBP products | 9 a.m. Eastern on the next calendar morning; only regular-season games and products with `valid` coverage |
| Schedule | Static at the opening reference cutoff; scores and final status omitted |
| Injuries | Printed UTC report time; ambiguous Eastern timestamps use the later fold. Only matched regular-season rows and observed PDF fields are returned |
| Player reference | Static at `2025-10-21T23:29:59Z` |
| Posts | Version publication time. An original version can use publication time; unknown edited/hash-only version times are excluded and reported |
| Lineups | Announcement posting time, preferred announcement only |
| Coach media | Indexed publication time; livestream end for livestreams/premieres; end of Eastern day for day precision; review-required entries excluded |

These are the agreed replay conventions, not proof of historical delivery. P3 must
use a strict cutoff for non-odds evidence and permit the scheduled-start odds
observation at equality. Official box scores remain available for the December 5
Lakers game while partial derived summaries return absent with a reason. This does
not perform the resolution or DNP calculation owned by P6.

The opponent dataset explicitly marks `preferredForGame`. The Celtics dataset has
no such field: one March 2 game has two announcements 18 seconds apart containing
the identical five players. The adapter selects the earlier publication of that
identical five; all source rows remain available to the operator audit. Conflicting
unmarked fives or multiple marked preferences raise an error. This selection rule is
covered by a regression test and does not substitute box-score starters.

The transcript index's `jsonSha256` describes the upstream local export wrapper,
not the R2 normalized transcript. The adapter verifies artifact hashes from each
pinned manifest and matches its media/run IDs against the index. Publication source
artifacts and raw evidence are verified too; local livestream evidence is checked
against the index's hash. Speaker labels remain anonymous provider clusters.

## Player-reference pin and coverage review

Selected release: **`15fef7276244e616b0817be4`**. Manifest SHA-256:
`7d9e7802344e90852d55eee4895b305a24a4f59e46fd18d87915b17ecfd8837f`.
The exact verified [coverage report](evidence/player-reference-coverage.json) is saved
alongside this summary.

- 739 included NBA players; 522 opening-roster players across all 30 teams.
- 689 prior-game players from 1,394 cached prior games; 31 separate identity exceptions.
- 9,585 season-stat rows, 1,657 2024–25 summary rows, 1,016 career summary rows.
- 88 opening two-way players; two unknown contract types; four players missing opening physical fields.
- 733 field-gap records; 25 players needed the official statistical fallback; 53 dated release cross-checks.
- Statistical history for included NBA IDs is complete. Overall `coverage_complete`
  and `exact_historical_fidelity` remain false.

The historical directory capture predates cutoff by about 46 hours and was reconciled
against date-only, retrospectively retrieved transactions. Statistical corrections may
be retrospective; original statistical versions are unavailable. Historical-only mutable
profiles and unsourced rookie designations intentionally remain null. The prior-game
universe is the existing acquisition cache, not a certification of complete acquisition.
International preseason guest IDs stay separate and must not be merged by name.

## Identity and coverage diagnostics

`config/identities.json` records provider-to-canonical mappings and their hash-pinned
evidence. NBA game/team/player IDs are canonical decimal strings; ESPN and Odds API
events map explicitly to NBA IDs. ESPN games are joined by both teams and UTC game
date, with scheduled-time agreement reported independently. X account/post IDs and
media IDs retain their stable namespaces. Lineup and injury names map to NBA IDs.
The injury join converts the printed `Family, Given` ordering before normalization,
while preserving the original printed name as the `injury-name` provider ID. Each
mapping includes the injury partition and NBA catalog evidence. Explicit team
placeholders have no player mapping. Unresolved names are recorded under
`injuryIdentityFindings`; no mapping is invented, and `Identities.resolve()` fails for
these names. Ambiguous name joins also throw; the diagnostic catches those failures,
records candidate IDs and observation counts, and prints an explicit refused-join
warning. Ordinary ambiguous joins do not produce mappings.

The [brief's shared contract requirements](NBA%20Analyst%20Agent%20%E2%80%94%20Implementation%20Brief%20v2.md#shared-contract-requirements)
accept exactly two injury-source exceptions (SPO-783, implemented in SPO-784):
`Yang, Hansen` → `1642905` with basis `brief_sanctioned_alias`, and
`Williams, Jaylin` → `1631119` only for Oklahoma City (`1610612760`), with basis
`brief_sanctioned_team_scoped_name`. The latter mapping stores `scope.teamId`;
`Identities.resolve()` requires matching `{ teamId }` context and refuses missing
or other-team context. Diagnostic caching includes team for this spelling, so an
OKC observation cannot authorize a later non-OKC observation. Player `1642444`
remains distinct. No generic alias or other disambiguation is introduced.

`injuryObservation` already preserves `player_name` and `team_id`. It serves the
observed PDF fields, not a canonical player ID; resolution and mapping publication
happen in the diagnostic. Downstream mapping consumers must pass the retained team
to `Identities.resolve()` for scoped mappings.

The 31 published player-reference identity exceptions retain distinct source IDs but
are excluded from name-join candidates, as required by their release. This prevents a
preseason guest ID (for example Noa Essengue's `196295093`) from competing with an NBA
ID (`1642855`) without merging or guessing a crosswalk.

Name matching normalizes accents, punctuation, and trailing Jr./Sr./II/III/IV suffixes
against the complete pinned player catalogs. It requires exactly one candidate;
missing names, collisions, and conflicting provider mappings throw. It never uses
first-match, fuzzy matching, or a season participation guess. These are mechanical
joins; P1a owns independent verification of identity and schedule correctness.

The generated diagnostic reports every Celtics regular-season game, all PBP product
statuses/reasons, injury team-snapshot counts (both teams, Celtics only, and distinct
PDFs), selected own/opponent announcements before cutoff, cumulative eligible NBA
post versions and recordings, and consensus statuses across all observations and at
the cutoff. Injury counts represent snapshots, not unique injured players. Post and
transcript counts include all eligible history, not just game-tagged media.

`npm run coverage` asserts 82 games, 7,956 consensus rows (6,666 `ok`, 1,178 `no_quotes`,
112 `dfs_only`) and 1,303 NBA-related posts out of 1,425 labels. It also reports
availability exclusions separately from relevance counts. The live source smoke check
and offline tests supplement this full diagnostic. CI uses only fixture data and
receives no Doppler credentials. This is P1 verification, not the P1a audit or Gate 2.

## Verified run results

The checked-in [82-game report](evidence/coverage-2025-26.json) reproduces all required
published totals. All 82 NBA and ESPN scheduled starts agree. Four NBA-related post
versions lack a known edit-publication time, so 1,299 of the 1,303 relevant versions
are eligible under the convention. All 134 selected transcripts verified successfully.
At the scheduled-start cutoff, 18 Celtics games and seven opponent games have no
eligible preferred lineup announcement; these are temporal coverage gaps, not missing
source datasets. They remain visible in the diagnostic for P1a rather than being
backdated or replaced with box-score starters.

The first game has 27 Celtics injury snapshots (54 across both teams), one eligible
announcement for each team, 204 eligible posts, and 12 eligible transcripts. Its
scheduled-start observation contains 21 usable prop rows. The final game's observation
contains one usable row, seven `no_quotes`, and four `dfs_only` rows, matching the
published thin-game behavior.

The diagnostic scans all matched regular-season injury-player observations and
publishes **558** unique `injury-name` mappings, including the two sanctioned
exceptions (854 Yang Hansen observations and 798 OKC Jaylin Williams observations).
`injuryIdentityFindings` now contains only `Jones, Dillon` (IDs `1641794` /
`196295686`, 1,117 observations), with its source-partition evidence unchanged.
Dillon Jones remains refused pending a published maintainer exception. All existing
per-game coverage fields and totals remain unchanged. The P1a audit evidence remains
its original pre-disposition snapshot; the regenerated P1 coverage reflects these
accepted rules.

PBP adapters reuse verified schedule, coverage, and game-index metadata for their
pinned release; public metadata reads return copies. `openCorpus` opens the odds
release once. Per-record/lazy transcript access remains a P3 integration follow-up.
