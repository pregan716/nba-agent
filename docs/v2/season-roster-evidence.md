# Season roster evidence — SPO-845

The replay engine needs the Celtics roster as it stood before each tip. The pinned player reference gives the opening roster only. This note records the curated evidence that covers the rest of the 2025–26 regular season. It is evidence and a cross-check; the loader change that consumes it is a separate issue.

## Decision

Decided by the user on Nov 5, 2026: the source of truth is a curated, dated transactions file. Box-score membership from released games is a cross-check and never a source. The replayed game's own box score is never used.

## Files

| File | What it is |
| --- | --- |
| `config/celtics-transactions-2025-26.json` | The curated file: opening roster, 13 membership events, four contract changes that do not alter membership, sources, and three boundary cases |
| `docs/evidence/roster/nba-player-movement-celtics-2025-26.json` | Every Celtics row of the NBA's public player-movement feed from July 2025 through April 2026, verbatim, with the SHA-256 of the full download |
| `scripts/roster-crosscheck.py` | Rebuilds the roster at each scheduled tip and compares it with the released box score |
| `docs/evidence/roster/crosscheck.json` | The cross-check output: the roster for each of the 82 games and any disagreement |

## Rules

- A move is available at the end of its official date in Eastern time. The official feed has dates and no times.
- Where a game tips on the official date, a timestamped secondary source may establish an earlier time. Those sources show no time zone, so the clock time is read as Pacific, which gives the latest possible instant.
- A 10-day contract runs through its tenth calendar day in Eastern time. The feed has no expiry rows, so each end is corroborated by a secondary source or by the next official signing.

## What changed during the season

| First game affected | Tip (UTC) | Roster size | Change |
| --- | --- | ---: | --- |
| 1 | 2025-10-22 23:30 | 17 | Opening roster, identical to the pinned player reference |
| 52 | 2026-02-07 00:30 | 15 | Simons, Boucher, Minott and Tillman traded on Feb 5; Vučević and Tonje acquired |
| 55 | 2026-02-20 03:00 | 16 | Banton signed to a 10-day contract on Feb 19 |
| 60 | 2026-03-02 01:00 | 15 | Banton's 10-day contract expired after Feb 28; Tonje's expired the same night and he re-signed on a two-way contract on Mar 1 |
| 68 | 2026-03-16 23:30 | 16 | Bassey signed to a 10-day contract on Mar 15, then a second on Mar 25 |
| 78 | 2026-04-05 19:30 | 15 | Bassey's second 10-day contract expired after Apr 3 |
| 82 | 2026-04-12 22:00 | 16 | Banton signed for the rest of the season on Apr 11 |

## Cross-check result

`python3 scripts/roster-crosscheck.py` on the pinned `spo-839-full-v1-2025-26` release: 82 games, zero disagreements between the curated roster at tip and the Celtics players in the released box score.

## Boundary cases

Three games tip on the official date of a signing. Each is resolved by a timestamped source that puts the signing hours before tip even when read in the latest time zone:

| Game | Tip (UTC) | Move | Source time, read as Pacific |
| --- | --- | --- | --- |
| 55, `0022500799` | 2026-02-20 03:00 | Banton 10-day | Feb 19, 2:52 pm, 22:52Z |
| 60, `0022500874` | 2026-03-02 01:00 | Tonje two-way | Mar 1, 9:12 am, 17:12Z |
| 72, `0022501054` | 2026-03-25 23:30 | Bassey second 10-day | Mar 25, 12:00 pm, 19:00Z |

## Limits

- The official feed has no row for Tonje's arrival in the Feb 5 trade. His arrival rests on two secondary sources and on the feed's later "re-signed" row.
- Secondary sources are cited by URL and quoted, not archived. The official feed extract is committed.
- Membership is not availability. Injuries, G League assignments and inactive lists are separate; the pregame injury report still governs who is removed from the eligible bench.
