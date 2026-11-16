# Iteration 3 Notes

## What was done
- Reviewed 2 previous test runs (iterations 1-2)
- Found that lineup and injury reading was failing in sandbox due to schema differences
  - Error: "no such column: startingLineup" and "no such table: injury_players"
  - In my view: lineups table has startingLineup column, injury_players table exists
  - In sandbox: nba_data.session() may have different table/column names
- Rewrote main.py with:
  1. Dynamic column discovery using PRAGMA table_info
  2. Multiple fallback table names for injuries (injuries, injury_players, injury_team_snapshots)
  3. Better name matching for lineup -> player ID (multiple sources including referenceHistory)
  4. Historical bias correction per player (direct bias correction when enough data)
  5. Width calibration based on observed coverage of reference ranges
  6. Conservative redistribution of freed minutes (25% factor)

## Key data findings
- 3 dev teams: 1610612738 (Celtics), 1610612760 (OKC), 1610612764 (Wizards)
- Eval window: Jan 5 - Feb 1, 2026 = 43 team-games (15+14+14)
- Lineup announcements available for 37/43 games (missing 6 Celtics games)
- Lineup announcements are 100% accurate for starters
- Reference doesn't use lineup announcements (big edge)
- Reference handles Out/Doubtful -> p_play=0, but not Questionable/Probable
- Historical minutes errors: MAE ~4.5-5.4 mins, bench players biased high on some teams
- Bench players on WAS have +2.4 min bias (underpredicted actual minutes)

## Submitted
- Full evaluation with hypothesis "baseline_error_correction"
- Expected: ratio < 1.0 due to lineup-based starter identification and historical correction
- Risk: if sandbox still can't read lineups, improvements will only come from historical analysis
- The system falls back to reference on any error, so worst case = reference score

## What to look at next iteration
1. Check sandbox stderr logs - did lineup/injury reading work?
2. Compare per-player and per-tier improvements
3. If lineups worked: look at games WITH vs WITHOUT lineup data
4. If lineups didn't work: need to find correct table/column names from sandbox
5. Check if width calibration helped or hurt
6. Consider adding agents for lineup/injury analysis
7. Look at whether the 25% redistribution factor is right

## Important sandbox details
- nba_data.session() tables in sandbox per spec: player_profiles, player_reference, 
  player_season_stats, player_2024_25_summary, player_career_summary, injuries, 
  injury_team_snapshots, schedule, posts, transcripts, lineups, evidence
- Note: "injuries" not "injury_players" in sandbox!
- Column names might be different (snake_case vs camelCase)
