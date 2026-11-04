# Archived v1 player-prop experiment

The v1 experiment asked an NBA analyst agent to predict player-prop probabilities
and evaluated improvement over the market. It ran four B pilots and several
stateless experiments on the ten development games. `pilot-b-4-observation.md`
is the last written record. These documents are historical, not the current design.
The pilot-b-4 notes and final brief edit were preserved in commit `0354283`
before this archive move.

Local experiment branches contain additional work: `exp/brown-points`,
`exp/points-only`, `exp/points-sharp`, and `exp/rationale-length`. Unwritten
stateless runs in `.cache/runs` are `pilot-a-1`, `pilot-a-2`, `pilot-a-r1`,
`pilot-a-v4`, `pilot-a-sharp`, and `pilot-a-brown`. Deleting those branches or
run directories later is a known loss; this archive does not contain their full
code, transcripts, or run records.

Data audits and coverage remain in `docs/evidence/audit/` and
`docs/evidence/coverage-2025-26.json`. The reusable infrastructure remains in
`src/`; the v1 task, output contract, baselines, scoring and reports were removed
by SPO-835. Existing v1 run manifests are historical and cannot be resumed with
the new configuration schema. Use the historical revision to inspect those runs.
