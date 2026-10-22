# Opening 2025–26 player reference (SPO-750)

This dataset is isolated in the existing private `sports-nba-data` bucket under
`nba/player-reference/2025-26-opening/`. It does not modify play-by-play or injury data.
The supplied requirements are preserved in [the specification](player-reference-specification.md).

## Bucket layout and access

- `archive/raw/<sha256>`: exact NBA responses, archived official pages and prior game boxes. Some archived responses are gzip encoded. **Ingestion only:** current responses can contain later information.
- `archive/evidence/<sha256>` and `archive/requests/<sha256>`: retrieval evidence and request outcomes, including failures.
- `archive/manifests/<sha256>.json`: pinned prior-player universe, opening roster reconciliation and acquisition records.
- `releases/<release-id>/`: five requested Parquet tables plus an identity-exceptions table, DuckDB SQL, data dictionary, field-gap ledger, coverage report, source catalog, and manifest.

Only release tables/views belong in the replay agent's evidence. Raw current-source responses must stay outside its input context. An object hash is the SHA-256 of its exact bytes. Publication uses create-only writes and reads every object back to verify its hash. The manifest is written last; there is no mutable `latest` pointer. Read the coverage report when selecting a release.

## Historical evidence

The cutoff is **2025-10-21T23:29:59Z**, one second before the first scheduled 7:30 p.m. Eastern tip. This is a conservative scheduled-tip boundary, not a claim to know the exact jump-ball second. The [NBA opening-night announcement](https://www.nba.com/news/nba-rosters-set-for-2025-26-regular-season) supplies the schedule evidence. The original article links to live roster pages, so it alone cannot establish historical membership.

An [archived official NBA player directory](https://web.archive.org/web/20251020010514id_/https://www.nba.com/players), captured at 2025-10-20T01:05:14Z, contains 523 NBA player IDs and historical team/physical fields. Its original gzip response matches the Internet Archive CDX SHA-1 digest `YYVFP4XVA62EP3OZOETOWBR5JW46B22S`. The build reconciles late changes with the [official NBA transaction feed](https://stats.nba.com/js/data/playermovement/NBA_Player_Movement.json), filtering out transactions after October 21. The feed contains no October 21 transactions. The date-only precision and retrospective retrieval are recorded limitations.

The reconciliation removes Kobe Bufkin and Tyler Smith and adds Javonte Cooke, producing 522 players across all 30 NBA teams. This includes injured and two-way players; no 2025–26 appearances are used to select the roster. Dated Raptors, Pelicans and Kings announcements provide independent table checks and preferred physical fields, joined by NBA ID, team, normalized name and exact birth date. Conflicting historical physical observations are retained in reconciliation evidence. Cooke's dated official signing announcement supplies his physical fields. The Wizards announcement supplies an independent roster-count check; its roster is an image, not a parsed table.

The NBA transaction feed supplies contract type from the most recent signing/conversion before the cutoff; trades retain contract type, while a waiver ends the prior evidence chain. Unknown types remain null. A dated roster table explicitly marking two-way players supersedes that inference. Rookie designation is only populated when a dated source explicitly says `R`; absence of that label is not evidence of non-rookie status.

The historical universe is the union of that opening roster with every player in the supplied existing 2024–25 mobile game-box cache, including DNP and preseason entries. This is a snapshot of existing acquisition, not a certification that every game was acquired. NBA IDs remain decimal strings compatible with the project's canonical IDs. Players absent from the opening roster remain available for historical joins. Their mutable opening profile fields are null. Thirty-one source IDs used only for international preseason opponents are preserved separately in `player_identity_exceptions`: all had placeholder biographies, and some duplicate real NBA people under guest IDs. They are not merged by name or included as authoritative profiles. The union of profiles and identity exceptions covers every pinned prior-box ID.

NBA `CommonPlayerInfo` supplies name, birth date and draft information; its current team, height, weight, position and experience are ignored. `PlayerCareerStats`, pinned through `nba-api==1.11.3`, supplies NBA season totals. When it returns an empty object, `PlayerProfileV2` is the documented official NBA fallback with the same season-total fields. Empty career responses are never silently interpreted as zero history. The fallback response must supply the required result sets, even when those sets have no rows.

Only regular-season and playoff season rows through 2024–25 are extracted. Current career totals, future seasons, preseason, play-in and standalone Cup-final totals are not ingested into analytical tables. Retrospective NBA statistical corrections remain possible. Team rows and all-team rows are both retained. Missing all-team totals are constructed from team splits and labeled. Supplied totals are checked against the splits (whole-minute rounding tolerance is limited to the number of team splits). Missing components propagate to totals and rates.

## Rebuild and publish

From the repository root, using the existing Doppler runtime configuration:

```sh
uv sync --locked --extra storage --extra evaluation --extra publication

doppler run --project sports-nba-data --config dev --no-fallback -- \
  uv run --locked --extra storage --extra evaluation --extra publication \
  python -m sports_nba_data.player_reference_pipeline \
  --root data/player-reference \
  --prior-box-cache /path/to/existing/2024-25/raw/acquisition \
  --publish
```

The prior-box directory must contain the existing `*.index.json` acquisition metadata and referenced raw response files. The first run pins that universe; resuming the same root reuses it. Use a fresh root for an intentionally refreshed input snapshot. Successful source responses are hash checked and reused. Failed requests use at most three attempts with exponential backoff and may be retried on resume. NBA requests are paced and concurrency is bounded. No new infrastructure, secret copies, or public endpoints are created.

`--offline` rebuilds from the pinned local inputs without fetching. Omit `--publish` for a local build. The pipeline locks its working directory against concurrent pipeline runs. A missing or invalid required profile/statistical response stops the build and prevents a release manifest. A validation error also stops publication. Source-fetch and roster modules are independently runnable for diagnosis; do not run them concurrently against the same root.

For local DuckDB access, download the release files into one directory and run `views.sql` with that as the working directory. Use `player_age_on(birth_date, replay_date)` to calculate age for a requested replay date. Filter `scope='all_teams'` when aggregating season summaries. Career summaries already use only all-team season rows.

## Quality and limitations

The release report records counts and verification results. Tests cover traded totals, missing fields, future-season exclusion, competition separation, weighted rates, zero denominators, unknown draft status and suppression of mutable current profile fields. The live build round-trips every Parquet table and compares every value in all three derived SQL views with its materialized Parquet counterpart.

The field-gap ledger lists missing fields per player. Historical-only mutable fields and most sourced rookie designations are intentionally null. Opening roster membership is reconstructed from archived official evidence and dated NBA transactions, not independently certified against all 30 teams' original roster filings. Source retrieval dates are distinct from source effective/publication dates. Do not describe this release as an exact replica of everything available to a person at the cutoff.
