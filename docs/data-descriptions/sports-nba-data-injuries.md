# NBA injury report data in R2

This section of the private `sports-nba-data` bucket holds official NBA injury report PDFs, searchable observations extracted from them, and evidence explaining how those observations were collected and interpreted. It covers the 2025–26 season and lives entirely under:

```text
s3://sports-nba-data/nba/injury-reports/2025-26/
```

The injury archive is separate from the bucket’s play-by-play datasets. This guide covers only that injury-report prefix. Access requires authorized R2 credentials; these paths are storage locations, not public download links.

**Start with a release manifest.** It identifies the exact files that belong together. Use the team snapshots to understand each team’s report state, and the player observations to examine individual statuses and reasons.

## What a snapshot means

The NBA publishes a league-wide PDF at a particular time. One PDF may contain several games, both teams in a game, and many players. Updated PDFs can repeat the same player statuses. Those repeats matter: they record what the report showed at different times.

The archive stores each distinct PDF once. There is no separate raw-PDF folder per team or game. Instead, the query tables link a PDF to its games and teams. A **team-game** means one team participating in one game; a **team snapshot** means that team-game’s observation in one PDF.

## Folder map

Paths below are relative to `nba/injury-reports/2025-26/`. `<hash>` represents a SHA-256 fingerprint: a long identifier calculated from file contents. It is not a date or game ID.

```text
2025-26/
├── releases/<hash>.json
├── coverage/<hash>.jsonl
├── team-snapshots/nba-injury-team-v1/
│   └── report_date=YYYY-MM-DD/<hash>.parquet
├── curated/nba-injury-pdf-v2/
│   └── report_date=YYYY-MM-DD/<hash>.parquet
├── evidence/<hash>.json
├── raw/sha256/<pdf-hash>.pdf
├── extracted/nba-injury-pdf-v2/<pdf-hash>.jsonl
├── manifests/<hash>.jsonl
└── discovery/<hash>.json, <hash>.jsonl, <hash>.html
```

Older extraction versions and previous releases also remain in the bucket. The map shows the current data layout, not a list of files to load indiscriminately.

| Folder | What it contains | When to use it |
| --- | --- | --- |
| `releases/` | A JSON manifest listing the player and team Parquet files, coverage and evidence keys, versions, input fingerprints, counts, and limitations. | Choose a reproducible version of the dataset. |
| `coverage/` | One JSON record per inventory game and participating team, summarizing snapshot counts and interpretation categories. | Check coverage for a team-game before analyzing its history. |
| `team-snapshots/` | Two team observations for every game successfully matched within a PDF, including a team that has no explicit row. | Distinguish listed players, pending submissions, corroborated empty lists, and unresolved absences. |
| `curated/` | Game-linked player observations and explicit team placeholders, organized into daily Parquet files. | Query player status, injury reason, team, game, and report time. |
| `evidence/` | Supporting URLs, publishers, excerpts, dates, assessment times, and audited PDF boundaries for empty-report interpretations. | Understand why an absent team was classified as having an empty injury list. |
| `raw/` | Exact PDF bytes as acquired. | Read the original report or verify an extraction. |
| `extracted/` | The parser’s JSONL observations for one PDF, before the release adds game links. | Inspect the extraction or rebuild query tables. |
| `manifests/` | Acquisition records with source URLs, retrieval times, outcomes, and available raw/extracted file keys and hashes. | Trace where a file came from or investigate a failed retrieval. |
| `discovery/` | Archived NBA page captures, archive indexes, discovered URL lists, and discovery metadata. | Audit how candidate PDF URLs were found. |

**JSON** stores one structured document. **JSONL** stores one JSON record per line. **Parquet** is a compressed table format suited to SQL and analytical tools. The `report_date` folder is the printed report’s Eastern calendar date, which may differ from the game date. The version labels identify the parser or team-snapshot format, not an NBA season.

## How to read a release

1. Open the selected object in `releases/`.
2. Read `coverage_key` for team-game coverage and `evidence_key` for supporting interpretations.
3. Load only the keys listed in `team_snapshot_partitions` and `partitions`. The latter contains player observations and explicit team placeholders.
4. Filter by `game_id` and `team_id`, then order by `report_timestamp_utc`.
5. Join team and player observations using `game_id`, `team_id`, and `pdf_sha256`. A team snapshot can legitimately have zero matching player rows.
6. Follow `raw_pdf_key` on a team snapshot, or `raw_key` on a player observation, to open the original PDF. Follow `evidence_ids` to the evidence register when an interpretation needs explanation.

For the latest team report, choose the latest team snapshot and then its matching player rows. Carrying forward each player’s last individual status can incorrectly preserve an old injury after the player disappears from a report.

A PDF with no matched entry for a game generates no team snapshots for that game. We do not treat a game’s total absence from a PDF as two empty injury lists. Player rows that cannot be matched unambiguously to the inventory remain in `curated/` with an explicit unmatched status.

## What the team states mean

| Observed in the PDF | Interpretation | Meaning |
| --- | --- | --- |
| `players_listed` | `players_listed` | The team has one or more player entries. Entries can include “Available,” rest, or G League assignments as well as injuries. |
| `not_yet_submitted` | `not_yet_submitted` | The PDF explicitly says “NOT YET SUBMITTED.” |
| `team_absent` | `empty_report_corroborated` | The matchup is present but this team has no row; dated supporting evidence corroborates an empty list for this audited interval. |
| `team_absent` | `unresolved` | The matchup is present but this team has no row, and we have not established why. |

For example, Denver initially appeared as “NOT YET SUBMITTED” for its October 23 game against Golden State. Later PDFs listed Golden State but omitted Denver. Contemporary reporting corroborated Denver’s empty injury list. The dataset preserves the earlier placeholders and the later absence observations, with a separate evidence-backed interpretation. It does not invent Denver’s exact submission time.

Coverage schema v2 counts `player_entry_reports`, `empty_report_corroborated_reports`, `not_yet_submitted_reports`, and `unresolved_absence_reports`; their sum is `reports`. `resolved_reports` adds the player-entry and corroborated-empty counts. `explicit_team_reports` counts only snapshots with an actual team row. A team-game can have resolved reports and still have unresolved snapshots at other times.

## Dates and historical availability

`report_timestamp_utc` records the printed PDF time converted from Eastern time. The original Eastern timestamp is also retained. Filenames alone are unreliable: a file named `05PM` may contain a report printed at 5:30 p.m. Ambiguous daylight-saving timestamps have a null UTC value and an explicit ambiguity flag.

Acquisition manifests record when we retrieved a source. Evidence records distinguish publication dates from retrieval and assessment times. `interpretation_assessed_at` records our retrospective assessment, not when someone could have known the conclusion before the game.

Historical availability fields remain null where availability is unverified. A printed timestamp is useful for arranging report history, but does not certify when those exact bytes were publicly accessible. Backtests must account for that distinction and must not silently treat later corroboration as pregame knowledge.

## Current release and coverage

As of October 20, 2026, use this release key within the bucket:

```text
nba/injury-reports/2025-26/releases/61f65449f459752a0ad06c0f41efd1cc8c13494f7b5f9c838f6536637c411c2e.json
```

| Contents of this release | Count |
| --- | ---: |
| Distinct source PDFs | 5,025 |
| Extracted player observations and team placeholders | 545,675 |
| Team snapshots | 148,504 |
| Daily player Parquet files | 170 |
| Daily team Parquet files | 170 |
| Regular-season games in the inventory | 1,230 |
| Regular-season team-games with player entries or corroborated empty reports | 2,460 |
| Corroborated empty snapshots across eight audited team-games | 174 |
| Other absent-team snapshots still unresolved | 153 |

These are counts for the selected release, not a count of every historical object in the bucket. No preseason PDFs have been acquired. The player dataset retains 2,822 unmatched rows, including the excluded NBA Cup championship and four game-date/matchup combinations. Having coverage for every regular-season team-game does not establish that every published update was acquired; the release’s `complete` flag remains false.

## Versions and auditability

Published objects are immutable. A rebuild writes new content under new fingerprints and publishes a new release manifest; previous versions remain available. Loading every file under a prefix can therefore mix versions and double-count observations. Hash filenames do not sort chronologically, and there is no `latest.json` pointer in this injury archive. Use the release key documented here or the replacement identified by the maintained verification record.

The current release manifest pins analysis files, coverage, and corroboration evidence. Discovery and acquisition manifests are separate audit records; the release does not bundle an exhaustive list of those manifests. Raw-PDF keys in observations provide the direct route back to source bytes.

For implementation, acquisition commands, and rebuilding, see [the injury-report operations guide](injury-reports.md). For the current release keys and verification results, see [team-snapshot verification](injury-team-snapshot-verification.json). Those records document independent verification of 343 release files and confirm that the player partitions were unchanged by the team-snapshot addition.
