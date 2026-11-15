# Roster cross-check reports

The archived [Boston report](crosscheck.json) covers all 82 games of the 2025–26 regular season. Running `python3 scripts/roster-crosscheck.py` from the repository root writes a separate pre-holdout report to `crosscheck-BOS.json`. Pass DEN, MEM, OKC or WAS to reproduce the corresponding team's committed report.

Each disagreement lists the players found only in the box or only on the roster. The `played_not_curated` list identifies box-only players who logged positive minutes.
