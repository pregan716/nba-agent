# Historical odds data in R2

The `pm-data-platform` bucket contains historical odds for all 82 Boston Celtics regular-season games in
2025–26, with four requested snapshots per game. Start with the consensus files for one de-vigged player-prop
quote per observation, or the book-level files to inspect the original prices.

All paths below are relative to:

```text
s3://pm-data-platform/external/the-odds-api/v1/league=nba/season=2025-26/team=bos/
```

Access uses the existing bucket permissions and S3-compatible R2 endpoint. Credentials are in the project's
Doppler `prd` configuration as `R2_*`. These objects are available to bucket readers; they are not public links.
A copy of this guide is stored at `README.md` under the prefix above.

## Files to use for analysis

| Need | Path | Contents |
| --- | --- | --- |
| One consensus line and probability | `consensus/proportional/v1/consensus.csv` | One game × requested snapshot × Celtics player × prop row. |
| Same consensus data for programmatic reads | `consensus/proportional/v1/consensus.ndjson.gz` | Identical rows as gzip NDJSON. |
| Audit the consensus calculation | `consensus/proportional/v1/book-lines.ndjson.gz` | Accepted sportsbook over/under pairs, raw prices, normalized probabilities, and contribution flags. |
| Exact calculation rules | `consensus/proportional/v1/methodology.json` | Pairing, line selection, tie rules, probability aggregation, exclusions, and field semantics. |
| All returned book-level quotes | `derived/v3/quotes.ndjson.gz` | All four snapshots, both teams, ten sources, and all five requested markets; one row per outcome. |
| Book-level availability | `derived/v3/coverage.ndjson.gz` | Every planned book × market × snapshot, including missing books and markets. |

Each published dataset also has `summary.json` for counts and `_MANIFEST.json` for object keys, sizes,
SHA-256 checksums, and source references. Version names belong to their own layers: `derived/v3` is the
four-snapshot quote dataset, while `consensus/proportional/v1` is its first consensus calculation.

## Folder layout

```text
team=bos/
├── README.md
├── plan.json
├── reference/
│   ├── schedule-response.json.gz
│   └── game=<ESPN-event-id>/boxscore-response.json.gz
├── discovery/date=<Eastern-date>/response.json.gz
├── game=<ESPN-event-id>/snapshot=<requested-UTC-time>/response.json.gz
├── quotes.ndjson.gz
├── coverage.ndjson.gz
├── summary.json
├── _MANIFEST.json
├── derived/
│   ├── v2/{quotes.ndjson.gz,coverage.ndjson.gz,summary.json,_MANIFEST.json}
│   └── v3/{quotes.ndjson.gz,coverage.ndjson.gz,summary.json,_MANIFEST.json}
├── scheduled-start/
│   ├── plan.json
│   ├── game=<ESPN-event-id>/response.json.gz
│   ├── summary.json
│   └── _MANIFEST.json
└── consensus/proportional/v1/
    ├── consensus.csv
    ├── consensus.ndjson.gz
    ├── book-lines.ndjson.gz
    ├── methodology.json
    ├── summary.json
    └── _MANIFEST.json
```

Braces abbreviate separate files, not a literal object name. `game=` partitions use ESPN event IDs;
`odds_api_event_id` in the data identifies the corresponding provider event.

The root archive contains the original **three pregame snapshots** and their initial derivatives. For starts
at or after 7 PM Eastern, requested times are 11 AM, 2 PM, and 6 PM Eastern. Earlier starts use scheduled tip
minus six, three, and one hours. Root `plan.json` lists the exact UTC requests, with daylight saving accounted for.

`reference/` preserves the ESPN schedule and boxscores used for game and player identity. `discovery/` preserves
The Odds API event listings used to map games. Raw odds responses live in the root `game=` partitions.

`derived/v2/` enriches those original quotes with player identities. `scheduled-start/` adds the fourth snapshot,
requested at the archived ESPN scheduled start, with its own plan, raw responses, and manifest. `derived/v3/`
combines all 328 requested observations and keeps the enriched identities. Earlier versions remain unchanged.

The ten sources are DraftKings, FanDuel, BetMGM, Caesars (`williamhill_us`), BetRivers, Bovada, Fanatics,
BetOnline.ag, PrizePicks, and Underdog. Full-game markets are `player_points`, `player_rebounds`,
`player_assists`, `spreads`, and `team_totals`. The consensus covers only the three player-prop markets.

## Reading consensus rows

Filter `status == "ok"`, then use `selected_line`, `p_over`, and `p_under` together. Probabilities are fractions:
`0.523` means 52.3%. The selected line is an actual sportsbook threshold, not an interpolated or rounded line.

The row key is `(espn_event_id, requested_at, espn_player_id, prop_type)`. The player universe is the union of
identified Celtics players with any observed prop in that game across the four snapshots. Each such player gets
all three prop types at all four requested times, including missing cases. Players with no prop quote anywhere
in that game are outside this universe; this is not a full roster export.

| Field | Interpretation |
| --- | --- |
| `status` | `ok`, `no_quotes`, `dfs_only`, or `no_complete_sportsbook_pair`. Non-`ok` rows have null probabilities. |
| `selected_line`, `p_over`, `p_under` | Selected threshold and complementary de-vigged probabilities. |
| `contributing_books`, `contributing_book_count` | Sources that contributed at exactly the selected line. One-book estimates remain eligible. |
| `probability_min`, `probability_max`, `probability_stddev` | Dispersion of the contributing books' normalized over probabilities. |
| `probability_basis` | `unconditional` for noninteger thresholds; `conditional_on_no_push` for integer thresholds. Push probability is not estimated. |
| `season_inferred_identity_in_inputs` | At least one input quote used the season identity fallback described below, including inputs not selected as contributors. |
| `contributor_set_changed`, `selected_line_changed` | Changes from the preceding requested snapshot for that game/player/prop. They do not establish why a line moved. |
| `dfs_reference_lines` | Observed DFS thresholds, retained without using indicative DFS prices in the consensus. |

Proportional normalization divides each side's implied probability by the sum of the over and under implied
probabilities, within the same book and line. Each sportsbook votes once with its line nearest 50/50. The
consensus selects an offered main line nearest their median, then takes the median normalized probability from
books quoting that exact threshold. Extra lines can contribute at that threshold; books never get extra votes.
Detailed ties and rejected pairs are documented in `methodology.json` and the result rows.

As published on October 20, 2026, there are **7,956 rows: 6,666 usable quotes, 1,178 no-quote cases, and
112 DFS-only cases**. All selected usable lines are half-integers. No integers were converted. Celtics assists
were unavailable in all four April 12 snapshots. Individual books and players have additional coverage gaps.

## Timestamps and availability

All stored timestamps are UTC. Eastern time determines the requested sampling schedule.

| Field | Meaning |
| --- | --- |
| `requested_at` | Historical observation time chosen for the pull. Use as the environment's modeled `available_at`. |
| `snapshot_at` | Provider snapshot label returned for that request, usually about 4.4 minutes earlier. |
| `last_update` | Individual sportsbook market update time, available in book-level quotes and accepted line pairs. |
| `last_update_oldest`, `last_update_newest` | Update-time range among the selected consensus contributors. |
| `receivedAt` | Actual download time during the October backfill, stored in raw response envelopes. |
| `snapshot_kind` | `pregame` for the original three observations or `scheduled_start` for the fourth. |

Use `available_at = requested_at` for historical replay. Some market updates occur after the provider's
`snapshot_at` label, by up to 68 seconds in the accepted consensus inputs; none occur after `requested_at`.
Backdating the complete consensus to `snapshot_at` would therefore expose some updates too early.
This availability rule is a conservative replay convention, not a measured historical delivery timestamp.
Scheduled start also does not guarantee actual tipoff or a closing line.

## Raw formats and player identities

A `.ndjson.gz` file is gzip-compressed JSON, one record per line. CSV nested columns are JSON-encoded strings;
missing values are blank. A raw `response.json.gz` instead contains a **single JSON envelope** with sanitized
`request.{host,path,params}`, HTTP `status`, quota `headers`, `receivedAt`, and `rawBody`. Parse `rawBody` again
to inspect the original provider JSON. Credentials are excluded from the archives.

Book-level quote files retain both over and under as separate rows and may contain several thresholds for one
book/player/prop/snapshot. For Celtics props, filter `is_celtics_player == true`. For game spreads, use `selection`
to identify the team; for team totals, use `description`. Game markets have null player ownership.

Player identity first uses the game's boxscore. If a quoted player is absent, the fallback assigns identity/team
only when the saved season boxscores agree on one player and one team participating in that game. This can
recover quotes posted before a player was ruled out. `player_identity_basis` records `game_boxscore` or
`season_boxscores_unique_team`; unresolved ownership remains null. Identity inference does not imply participation
and does not alter the provider's lines or prices.

## Reproducing the calculation

From the repository root, the following republishes the consensus from the archived v3 inputs without making
new Odds API requests:

```sh
doppler run --project pm-data-platform --config prd -- node --import tsx scripts/publish-celtics-consensus.ts
```

Calculation logic and tests are in `src/backfill/odds-api-celtics-consensus.ts` and
`src/backfill/odds-api-celtics-consensus.test.ts`. The publication script verifies source and output hashes.
Manifests trace consensus → combined v3 quotes → the enriched original archive and scheduled-start supplement.
Use them to pin a reproducible input version; `README.md` is a separate navigation guide.
