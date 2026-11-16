# Iteration 1 Notes

## Dev Teams
- 1610612738 (BOS)
- 1610612760 (OKC)
- 1610612764 (WAS)

## Evaluation Window
- Full eval: Jan 5 - Feb 1, 2026, 43 team-games

## Strategy: Reference Error Correction
Only modify minutes percentiles and p_play/p_start based on the reference's own error history.
Leave all other stats (points, rebounds, assists, fantasy_points) untouched.

### What works
- Error correction on minutes with 0.3 correction strength
- Exponential weighting toward recent games (decay=0.9)
- Width calibration based on 10-90 coverage rate
- p_play and p_start correction from play/start errors
- Thresholds: 0.03 for p_play/p_start, 0.3 for minutes shift

### What doesn't work
- Injury report reading (blew up play Brier in Run 3: 1.75x!)
- Lineup announcement reading (also harmful)
- Tier-aware correction (too conservative for core, lost signal)
- Scaling other stats (made fantasy guardrail worse)

### Test Results (5 games)
- Run 4 (current draft): minutes ratio 0.9895, play Brier 0.943, fantasy 1.000
- 90% CI for minutes: [0.967, 1.009]

## Next iteration priorities
1. Look at full eval results - understand where gains and losses come from
2. Consider using artifacts to track player-specific adjustments between games
3. Consider using `scores` (our own past scores) for self-correction  
4. Consider spread/total adjustments for blowout games
5. Consider using `nba_data` game history more directly instead of only referenceHistory
6. Think about whether width calibration is actually helping

## Important findings
- The reference is already quite good - hard to beat by much
- The reference doesn't handle Questionable status well but reading injury reports ourselves is risky
- Fantasy guardrail is safe as long as we don't modify fantasy_points
- Play Brier is easy to make worse by modifying p_play incorrectly
