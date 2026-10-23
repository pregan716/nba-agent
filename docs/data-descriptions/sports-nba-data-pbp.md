# What's in the R2 bucket

This project's data lives in the private Cloudflare R2 bucket `sports-nba-data`, entirely under the `nba/` prefix. This guide explains what each part of that prefix holds and where to start reading. It is written for someone who has never looked inside.

```text
s3://sports-nba-data/nba/
```

Access requires authorized R2 credentials, which come from Doppler (see [runtime secrets](runtime-secrets.md)). These paths are storage locations, not public links.

The map below was checked against a read-only listing of the bucket on 2026-10-22. At that time it held about 96,000 objects and 20.5 GB.

## Three rules

1. **Nothing is overwritten.** Every write is create-only: a key, once written, keeps its exact bytes. A correction is a new version under a new key, and old versions stay so earlier results remain reproducible.
2. **Start from a manifest.** Each dataset version has one manifest that lists exactly which files belong to it. Never collect files by listing a folder: folders can also hold unrelated versions, or objects from an upload that never finished.
3. **Long hex names are fingerprints.** A 64-character name such as `4c8e6c…f799` is the SHA-256 hash of the file's contents, or of a configuration. It is not a date, game or player ID. If you re-hash the file and get the same value, you have the bytes that were written.

There is no `latest` pointer. Each release is chosen by its name.

## Folder map

```text
nba/
├── releases/<dataset-version>/          play-by-play datasets (start here)
│   ├── manifest.json
│   └── objects/<configuration-hash>/...
├── raw/                                 original source bytes and provenance
│   ├── sha256/<2 hex>/<sha256>.json     official NBA responses
│   ├── documents/<sha256>.json          retrieval records and job documents
│   ├── runs/<run-version>/              acquisition plans and manifests
│   ├── selections/<version>-<game>/     pinned inputs chosen for reconstruction
│   ├── alternate/<site>/                third-party game-flow pages
│   └── supplemental/spo753/             recovered official responses for repairs
├── quality/alternate-repairs/spo753/    quality reports on the alternate evidence
├── injury-reports/2025-26/              separate injury-report dataset
└── player-reference/2025-26-opening/    separate player-reference dataset
```

| Prefix | Objects | Size | What it is |
| --- | ---: | ---: | --- |
| `releases/` | 38,147 | 16.7 GB | Published play-by-play datasets: Parquet tables, coverage and validation, plus copies of the raw bytes each release was built from. |
| `raw/` | 44,348 | 2.65 GB | Everything collected from sources, exactly as received, with records of how and when it was collected. |
| `injury-reports/` | 10,532 | 1.09 GB | Official NBA injury report PDFs and tables extracted from them. See the [injury report bucket guide](sports-nba-data-injuries.md). |
| `player-reference/` | 3,035 | 41 MB | Historical player profiles and statistics through 2024–25. See [player reference](player-reference.md). |
| `quality/` | 6 | 4.5 MB | Hash-named quality reports on the third-party rotation evidence. |

`nba/_checks/` is used only by the credential check. It writes one disposable object and deletes it, so the prefix is normally empty.

## Play-by-play releases

Each folder under `releases/` is one immutable dataset version. The **current** play-by-play releases are:

- `spo-771-full-v1-2024-25`: 1,394 inventory games
- `spo-771-full-v1-2025-26`: 1,393 inventory games

They are the accepted two-season backfill. Their remaining gaps (41 games) are listed in [season releases](season-releases.md#releases-that-close-the-remaining-fixable-gaps-spo-769771).

The other versions are kept for reproducibility. Don't use them for new work.

| Versions | What they are |
| --- | --- |
| `spo-768-full-v1-*`, `spo-767-full-v1-*`, `spo-763-full-v1-2025-26`, `spo-761-full-v1-*` | Earlier full-season releases, each superseded by the next fix |
| `spo-727-review-v2-*` | Season-assembly samples with one detailed game per season |
| `spo-725-review-v1-*`, `spo-722-review-v1-*` | Early per-game and coverage-only review samples |

Inside one release:

```text
releases/spo-771-full-v1-2024-25/
├── manifest.json                       the commit point: written last, lists every file and its hash
└── objects/<configuration-hash>/
    ├── tables/<table>/season=<season>/phase=<phase>/part-NNNNN.parquet
    ├── tables/<table>/shared/part-NNNNN.parquet      rows not tied to one game
    ├── raw/season=<season>/phase=<phase>/game=<id>/<sha256>.json
    ├── raw/shared/<sha256>.json                      season schedules and inventories
    ├── game_index.json                 which rows of which file hold each game
    ├── coverage.jsonl                  one status record per game and product
    ├── validation.json
    └── configuration.json, input_*.json, inventory_evidence.json
```

- **A release exists only once its manifest exists.** Objects under `objects/` without a manifest are an unfinished upload; ignore them.
- **Tables** are Parquet, grouped by season and phase (preseason, regular season, play-in, Cup championship, playoffs). Each file holds whole games in game-ID order. The table names and columns are defined in the [data dictionary](data-dictionary.md).
- **`coverage.jsonl`** says, for every game and product (raw, normalization, lineups, stints, summaries, possessions, validation, inventory), whether it is `valid`, `partial` or `failed`, and why. Check it before trusting a game.
- **Raw copies.** Each release carries its own copy of the raw bytes it was built from, so it can be downloaded and checked on its own. This duplicates bytes across releases on purpose.

Don't read these files by hand. Fetch a release with the project's commands, which verify every hash, then query it with DuckDB:

```sh
doppler run --project sports-nba-data --config dev --no-fallback -- \
  uv run --locked --extra storage --extra publication nba-data release-fetch \
  --dataset-version spo-771-full-v1-2024-25 --output data/release-fetch/spo-771-full-v1-2024-25 \
  --doppler-config dev

uv run --locked --extra publication nba-data release-query \
  --release data/release-fetch/spo-771-full-v1-2024-25 \
  --sql "SELECT phase, count(*) FROM games GROUP BY phase"
```

[Releases](releases.md) documents the full protocol, and [research queries](research-queries.md) has cutoff-safe examples.

## Raw data

`raw/` keeps the original evidence that the releases are built from.

| Prefix | Contents | Notes |
| --- | --- | --- |
| `raw/sha256/<first two hex>/<sha256>.json` | Exact official NBA responses: play-by-play, box scores, rotations and schedules (9,781 objects) | Deduplicated: identical bytes are stored once, whichever run fetched them. The two-character folder is just the first two characters of the hash. |
| `raw/documents/<sha256>.json` | Retrieval records (source, endpoint, parameters, UTC retrieval time, HTTP status, content hash), inventory snapshots and per-game job documents (24,135) | Each raw response has a retrieval record saying where and when it came from. |
| `raw/runs/<run-version>/plan.json`, `manifest.json` | One folder per acquisition run (2,791), mostly per-game runs named `spo-730-validated-v2-<season>-<game>` | The plan is written when a run starts and the manifest only after every job finishes. 672 per-game runs have a plan but no manifest. Locate inputs through a release or selection manifest, not by listing runs. |
| `raw/selections/<version>-<game>/manifest.json` | Pinned input choices for offline reconstruction (2,718), such as the complete official CDN pair chosen for a game | A selection records which existing raw inputs a rebuild uses. It is not a new acquisition, and the original failures remain recorded. [Repaired-input backfill](repaired-input-backfill.md). |
| `raw/alternate/hoopstate/`, `raw/alternate/popcornmachine/` | Third-party game-flow HTML pages (`sha256/`) and their retrieval records (`documents/`) | Not official NBA data. Used only as qualified supporting evidence for missing rotations. [Alternate game-flow acquisition](alternate-gameflow-acquisition.md). |
| `raw/supplemental/spo753/` | 20 recovered responses (official CDN pairs and PopcornMachine pages) plus 20 retrieval records | Used to repair specific games. [Alternate rotation repairs](alternate-rotation-repairs.md). |

`quality/alternate-repairs/spo753/<sha256>/` holds the quality checks and the owner-accepted exceptions for that alternate evidence: `game-checks.jsonl.gz`, `summary.json` and `accepted-exceptions.json`.

## Tracing a number back to the source

Every row in a release carries `raw_object_ids`. To see the original bytes behind a row:

1. Look up the ID in the release's `raw_objects` table. `content_hash` is the SHA-256 of the bytes, and `object_location` is the original key, for example `r2://sports-nba-data/nba/raw/sha256/4c/4c8e…f799.json`.
2. In the fetched release, the manifest's `raw_files` maps the same ID to the release's own copy under `objects/<configuration-hash>/raw/`.
3. Either copy must hash to `content_hash`. The retrieval record in `raw/documents/` says where and when the response was collected.

Issue IDs on a row resolve in the `data_quality_issues` table.

## Separate datasets

The injury reports and the player reference share the bucket but not the play-by-play release format. Each has its own manifests and guide:

- [NBA injury report data in R2](sports-nba-data-injuries.md): `injury-reports/2025-26/`
- [Opening player reference](player-reference.md): `player-reference/2025-26-opening/`, with `archive/` for raw responses and evidence and `releases/<release-id>/` for the published tables

## Listing the bucket yourself

Listing is read-only, but it still needs credentials. With the project's runtime:

```sh
doppler run --project sports-nba-data --config dev --no-fallback -- uv run --locked --extra storage python -c "
import json; from pathlib import Path
from sports_nba_data.runtime import load_runtime, create_client
t = json.loads(Path('config/r2.json').read_text()); c = create_client(load_runtime(t, doppler_config='dev'))
for p in c.list_objects_v2(Bucket=t['bucket'], Prefix='nba/', Delimiter='/')['CommonPrefixes']: print(p['Prefix'])"
```

Do not write to the bucket by hand. Every write goes through the pipeline commands, which enforce create-only keys and hash checks.
