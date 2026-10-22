# Guide to the sports text R2 bucket

The private Cloudflare R2 bucket `sports-text` holds the source posts, collection evidence, model results, and lineup datasets for this project. Start with a finished dataset when you want to analyze posts or lineups; use the underlying archive when you need to trace a result back to its source.

This guide describes the bucket as of **October 20, 2026**. There is one shared bucket and one Doppler configuration, `sports-text/dev`. The name `dev` does not mean there is a separate production bucket. `R2_PREFIX` is currently empty, so every key below starts directly at the bucket root.

## Where to start

| What you want | Starting point |
| --- | --- |
| The two Celtics reporters’ collected season posts | The repository’s `data/celtics-2025-26-export.json` pins the R2 backfill report. Use the export command below. |
| Those posts with NBA relevance labels | `v1/relevance/celtics-2025-26/active.json`; follow its manifest reference, then the manifest’s `rows` reference. |
| Celtics starting lineup announcements | `v1/research/celtics-lineups/extracted-2026-10-16/celtics-starting-lineups.json` |
| Opponent starting lineup announcements | `v1/research/opponent-lineups/2026-10-19-complete/celtics-opponent-starting-lineups.json` |
| Evidence behind a specific post | Its normalized record’s `sources` references lead to raw API pages and their original response bodies. |

The reporter collection covers Jay King (`38032945`) and Chris Forsberg (`79806078`), from September 29, 2025 through April 12, 2026 in Eastern time: preseason and regular season, excluding playoffs. It contains **1,430 retained post versions**, representing **1,425 logical posts**. The relevance dataset labels those 1,425 latest retained posts: 1,303 NBA-related and 122 unrelated. Both labels remain stored. NBA-related includes other NBA teams, not just the Celtics.

The lineup datasets cover **86 games**: four preseason and 82 regular-season games. Celtics data has 87 announcements; opponent data has 92 accepted announcements, with one preferred announcement per game. Extra announcements are retained as evidence rather than silently discarded.

## How the bucket is organized

An R2 object is a file-like value identified by a **key**, such as `v1/heads/38032945.json`. Slashes make keys look like folders, but they are prefixes used to group objects. `v1` is the storage format namespace.

```text
sports-text/
└── v1/
    ├── raw/             Original X responses and retrieval metadata
    ├── posts/           Normalized post versions and observations
    ├── intervals/       Collection progress for fixed time ranges
    ├── runs/            Completed run manifests and failure records
    ├── heads/           Current account ownership and commit pointers
    ├── checkpoints/     Saved positions for incremental collection
    ├── sync-intents/     Fixed requests for resumable incremental work
    ├── backfills/       Historical plans, counts, completions, and reports
    ├── budgets/         Durable spending reservations
    ├── comparisons/     Haiku and Jev experiment evidence
    ├── relevance/       Published NBA relevance snapshots
    └── research/        Celtics and opponent lineup investigations
```

These prefixes are present in the live bucket. The contracts also define `v1/registry/` and `v1/enrichments/`, but neither is present at this inventory date. The checked-in reporter inventory is `data/reporters.json`. Current season labels live under `relevance/`, not `enrichments/`. Disposable live checks may temporarily create `smoke-tests/` objects.

## The source archive

### Raw responses

Each collected API page normally has two objects sharing a name:

```text
v1/raw/<account-id>/<retrieval-date>/<run-id>/<page-id>.body
v1/raw/<account-id>/<retrieval-date>/<run-id>/<page-id>.json
```

The `.body` holds the original HTTP response body before JSON parsing, including formatting and error responses. The `.json` is an envelope: request details, retrieval time, status, normalized rate-limit information, parsed JSON when available, and a checksum-bearing reference to the `.body`.

A page can contain many posts. Its folder date is when it was **retrieved**, not when the posts were published. A `.body` is API response data; it is not a downloaded photo or video. Media URLs in an API response do not mean the media file itself was archived.

### Normalized posts

```text
v1/posts/<account-id>/<publication-date>/<post-id>/<encoded-version-id>/<sha256>.json
```

These records make posts consistent to read: text, account ID, publication time, version identity, relationships to other posts, and source references. The date here is the post’s **publication date in UTC**.

An account ID identifies the X account even if its handle changes. A logical post ID groups an edit chain. A version ID identifies the observed text version, using `x:<version-id>` when available or `sha256:<content-digest>` otherwise. Colons are URL-encoded in keys: `x:123` becomes `x%3A123`.

The final hash identifies the exact saved JSON bytes. Multiple observations can produce multiple files for the same logical post/version, for example when another retrieval adds provenance. **Counting objects under `posts/` does not count unique tweets.** Use the verified export, which merges duplicate observations and preserves separate edits.

### Collection records

| Prefix | What it tells you |
| --- | --- |
| `intervals/<account-id>/<interval-id>/<sha256>.json` | Progress or completion for a fixed range, including raw source references and pagination state. |
| `runs/<run-id>/manifest.json` | The raw pages, normalized records, and intervals belonging to a completed run. |
| `runs/<run-id>/failure.json` | A recorded collection failure. |
| `heads/<account-id>.json` | Current ownership and references to published collection state. |
| `checkpoints/<account-id>/<revision>-<fence>.json` | Incremental collection position, including the committed since ID. The fence distinguishes ownership sessions. |
| `sync-intents/<account-id>/<sha256>.json` | The fixed request to resume after an interrupted incremental collection. |
| `backfills/plans/`, `backfills/windows/`, `backfills/reports/` | Historical collection plans, completed-window records, and reports combining window outcomes. |
| `backfills/counts/`, `backfills/identity-lookups/` | Original evidence used to estimate collection size and verify account identities. |
| `budgets/<budget-id>.json` | Spending reservations used to enforce caps. Reservations are conservative controls, not provider invoices. |

The account head is the collector’s commit point. A manifest or checkpoint found by listing may be an unpublished candidate left by an interrupted run. For current incremental state, follow the head. For the pinned historical season, use its backfill report through the verified exporter. The head is not an index of every historical run.

Most source and evidence objects are immutable: new evidence creates a new object. Heads, budget ledgers, and the active relevance pointer are deliberately mutable control records. Do not manually replace them or delete apparently redundant source files; older manifests may still reference those files. See [archive operations](archive.md) for recovery procedures.

## NBA relevance and the model comparison

The experiment is stored under:

```text
v1/comparisons/<dataset-id>/
    dataset.json
    calibration.json
    haiku/<batch-id>/{claim,response,result}.json
    jev/<batch-id>/{claim,response,result}.json
    scores/<hash>.json
```

`dataset.json` identifies the selected posts and batches. Each claim records the request; the response retains the provider response; the result contains parsed classifications. Calibration and score artifacts preserve the human evaluation and threshold selection. These are experiment evidence, not a source-post replacement.

Published labels have a separate entry point:

```text
v1/relevance/celtics-2025-26/active.json
    → snapshots/<hash>.json       manifest with policy, counts, and references
        → snapshots/<hash>.jsonl  one labeled post per line
```

Follow the references instead of choosing the newest-looking filename. The current policy uses Jev 1.14.0 with a probability threshold of 0.10. Each row includes the normalized post and classification evidence. Join labels to source versions using `accountId`, `postId`, and `versionId`; a newer version’s label should not be assigned to older text. The five superseded versions remain in the source archive without labels in this snapshot.

## Starting lineup research

Lineup research has its own layout under `v1/research/`. It includes broad searches, failed candidates, intermediate coverage reports, and final extracted datasets. Listing everything here will mix those stages. Use these completed bundles:

| Dataset | Base prefix |
| --- | --- |
| Celtics | `v1/research/celtics-lineups/extracted-2026-10-16/` |
| Opponents | `v1/research/opponent-lineups/2026-10-19-complete/` |

Inside the Celtics prefix are `celtics-starting-lineups.json`, `celtics-starting-lineups.html`, and `lineup-extraction/evidence.tar.gz`. Inside the opponent prefix are `celtics-opponent-starting-lineups.json`, `celtics-opponent-starting-lineups.html`, and `opponent-lineups/evidence.tar.gz`.

The JSON files have a summary and rows containing source post URLs, posting times, game identifiers, five player names, and supporting evidence. HTML provides a readable table. The compressed evidence bundles preserve model responses, extraction metadata, and supporting photos or video frames. Original videos are not included in these bundles. Their internal paths begin with `exports/`; preserve those paths when extracting so relative evidence links can resolve.

Raw research X responses also live directly under `v1/research/celtics-lineups/` and `v1/research/opponent-lineups/`, often as UUID-named `.body` files. Their request context and source references are recorded in research metadata; do not assume every research body has the core archive’s matching envelope layout.

For opponents, 81 games use an official team or team PR source and five use reporters. `preferredForGame` selects the displayed announcement; alternate announcements remain in the JSON. These are **announced lineups**. Two opponent announcements disagree with box-score starters, and those differences remain flagged rather than overwritten. Research snapshots are completed investigations, not automatically refreshed feeds.

## Reading and verifying data

Use authenticated Cloudflare R2 access or the repository’s S3-compatible client. The bucket is private: an object key is not a public download URL. Credentials come from Doppler; [setup](setup.md) explains configuration.

For the reporter archive, run from the repository root with dependencies installed:

```sh
pnpm build
doppler run --project sports-text --config dev -- node dist/cli.js query \
  --snapshot data/celtics-2025-26-export.json \
  --output exports/celtics-season-reader
```

Choose an output directory that does not already exist. This reads R2, verifies the pinned evidence, and writes `posts.jsonl` plus `coverage.json`. It makes no new X requests. The pinned report is `v1/backfills/reports/a57664cd-e4d8-4aaf-9741-1ac0b6b4fcf1.json`.

For lineups, download the final JSON or HTML from the exact prefixes above. Download and extract the matching evidence bundle when you need the underlying images and model responses. Local `exports/` is ignored by Git and is not automatically mirrored to R2; only explicitly archived objects are durable bucket contents.

A source reference usually contains `objectKey` and `sha256`: where to fetch the object and the SHA-256 digest expected for its exact bytes. Verify against that reference before treating an object as trusted evidence. Do not reformat JSON before checking its byte checksum.

Dates in core keys are UTC. Game dates and Eastern display timestamps in research datasets may differ from the UTC posting date. Retrieval time records when we fetched something, not when it was available before a game. The season archive is retrospective: it cannot prove that later-retrieved edited text existed before tipoff. Successful pagination also cannot recover deleted or unavailable posts. The original count estimate was 1,431 versus 1,430 retrieved versions, an unresolved difference documented in [the export contract](exports.md).

For field-level definitions, see [source contracts](contracts.md). For collection mechanics, see [backfill](backfill.md) and [sync](sync.md). For the evaluation protocol, see [model comparison](model-comparison.md).
