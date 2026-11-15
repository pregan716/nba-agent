# Five-team data for SPO-901

The environment builds two read-only SQLite inputs from the pinned corpus. Run either command with the repository's data-store credentials and a fresh destination directory. Mount only that directory into the corresponding process.

```sh
npm run data:view -- architect .cache/architect-data
npm run data:view -- training .cache/training-data
npm run data:coverage
```

Both mounts carry league-wide regular-season history for 2024–25. The architect also gets Boston, Oklahoma City and Washington games for 2025–26, their roster snapshots, team evidence and pregame injury reports. The exact boundary is Boston's 71st scheduled tip, March 23 at 00:00 UTC. Selection happens on schedule columns before reading indexed game rows. Outcomes must also have been released before that instant. The 14 games against Denver or Memphis enter through a development team's schedule. The training mount has no current-season schedule, history or research tables.

The game loop uses `fiveTeamReplay` with the ordinary league-wide history cutoff. Its schedule is keyed by NBA team ID and game ID. Each team has its own dated roster, reference prediction and score, including when two participating teams meet. To reproduce a team's forecast and earlier released reference receipts:

```sh
npm run projection -- GAME_ID PINNED_IMAGE .cache/reference-projection OKC
```

## Sources and coverage

The four release files in `config/five-team/` carry sports-text release keys, SHA-256 hashes, the upstream transcript index entries and the verified manifest hashes in sports-transcription. Each file records both upstream Git revisions. ESPN event IDs were matched to the NBA schedule by team pair and Eastern game date. Reporter posts retain their published text, account ID and version timestamp. Coach transcripts use the published cutoff convention. Lineups expose the announced five and the publication time.

Roster files start with the pinned opening player reference. Each club's official NBA movement extract and curated membership events have separate checksums. Date-only transactions become available after the Eastern calendar day. Same-day moves cite timestamped announcements in each team's boundary cases. Ten-day contracts count the signing day as day one. Three documented Memphis exceptions cover Lawson Lovering through February 20 and the final Adama Bal and Lucas Williamson hardship deals through April 12.

Run `python3 scripts/roster-crosscheck.py TEAM` from the repository root to reproduce a team's report in `docs/evidence/roster/`. The check selects games by scheduled tip and next-morning release before reading the pinned box-score identities. Disagreements retain both sets of player IDs and their transaction evidence.

[Coverage counts](coverage.json) use public evidence and the schedule. Posts and transcripts count team-games with a publication since the previous tip. Injuries and lineups require a pre-tip report for that game. A null prop count means there is no pinned team consensus release. The four new teams currently have no such release in the published NBA archive. The optional `odds` field on each team pin accepts the consensus manifest object reference when available. Scheduled-start spreads and team totals are a separate collection under SPO-911.

## Reference verification

[The reference check](reference-check.json) records the 70-game Boston audit and two independent cold refits of game 70 using the same image and inputs. The receipt hash includes the harness identity. The fitted model itself also matched a cold refit on the merged baseline. Each team's opening-game reference passed forecast validation, and all 354 pre-holdout team-games passed the roster and injury identity check.
