# Forecast evaluation (SPO-882)

Run the evaluator on completed run directories containing `record.sqlite` and their `blobs/` directories. One run gives the comparison against its frozen reference and the market. Supply both arms with the same replicate IDs for the memory comparison.

```sh
npm run --silent forecast:evaluate -- "$FULL_RUN" "$NO_MEMORY_RUN" > report.md
npm run --silent forecast:evaluate -- --json "$FULL_RUN" "$NO_MEMORY_RUN" > report.json
```

The Markdown summary reports the primary scores, market test, big overs and ceiling picks. JSON adds the four reference-minutes tier splits, replicate-level results, per-game learning curves, sensitivity and all denominators. Differences are left minus right. Lower is better for pinball, Brier and log loss. A negative upper bound on the analyst's held-out blend change supports an improvement over the market alone.

## Record and scope

The host appends each game's scheduled-tip consensus after the run ends and checkpoints the record. Rows come from the pinned odds release, joined by the ESPN game and player mappings. Capture records the release and methodology hashes, usable lines and probabilities, and the number of unusable rows. A usable prop without a matching forecast player fails evaluation. The scorer verifies the record chain, feedback blobs and forecast receipts. Reporting requires no credentials, corpus reads, sessions or model calls. Player markets and market-relative feedback stay outside agent sessions.

Capture refuses a usable row whose `probability_basis` is not `unconditional`. On an integer line the release's over probability is conditional on no push, while the scorer counts a push as an under. The current pin selects only half-integer lines, so no row is refused.

To attach the same inputs to an older, finished local forecast run, use `npm run forecast:capture -- "$RUN_DIRECTORY"` with the run's dataset pins. Repeating capture checks the saved inputs. A missing or different release cannot silently supply a comparison.

Pilot records report development games. Scored records report games 21–70. The evaluator refuses holdout games. Excluded games retain the recorded reason. Missing forecasts use the recorded reference forecast. The report includes a second comparison with every game flagged for a missing forecast or infrastructure failure removed from all participating runs. Both views fit their own market blends. Comparisons require matching games, reference receipts, outcomes, market inputs and non-arm settings.

## Reading the scores

- Primary scores and coverage first average within each game. Event rates and prop scores instead pool their numerators and denominators. In JSON, each estimate includes the sum, weight, mean and interval. For a pick hit rate the sum and weight are hits and picks. For void rates they are voids and picks.
- Market Brier scores use identical played props. Forecast probabilities come from the frozen conditional distribution strictly above the line and are clipped to [0.02, 0.98]. Market Brier uses the published probability. Both logistic models include an intercept and use clipped log-odds as predictors. Each fold excludes a whole game. We use unit ridge penalty on slopes against summed negative log likelihood, a half-count correction for single-class training sets, and omit losses for folds with no training props. The reported change is the pooled held-out loss of the blend minus that of the market-only fit.
- Big overs use all usable points, rebounds and assists props. Rank by the probability of playing times the conditional inclusive tail at the line plus one standard deviation. Break ties by numeric player ID, then stat. A DNP in the first three is a void and a miss. Both the reference and the agent rank the same pool. Tier splits partition the original picks.
- Ceiling probabilities and outcomes use the strict fantasy-point threshold recorded by the V2 scorer. In an analyst/reference comparison the right-hand ceiling hit rate is the pooled reference-weighted outcome over eligible players. Its numerator and denominator are weighted sums. Pick and void counts apply to the analyst. In a memory comparison both sides use their actual picks.
- All 10,000 paired bootstrap draws sample whole games with replacement (seed 8542026). The 90% interval uses the 5th and 95th percentiles of defined estimates. Each draw divides the sum of losses or events by its corresponding count. The report identifies the five largest absolute leave-one-game shifts in each paired difference and gives the difference after jointly omitting them. The blend interval and sensitivity summarize the held-out predictions obtained in the original folds.
- Replicate comparisons use matched IDs. The pooled memory comparison averages each game's sums and weights across replicates before resampling games. Costs and wall-clock time come from final game metering and include retries. Independent reference execution cost is unavailable. A null score or interval means its denominator or training fold was empty.

## Headroom replay

Using the cached headroom export for Boston games 1–70, the evaluator reproduced **51 hits in 210 picks with one void**, from 1,562 usable props. This check supplies the headroom model's original pregame probabilities to the shared ranking and outcome rules. Live forecast evaluation derives its probabilities from V2 percentiles.

```sh
uv run --with pandas --with numpy --with scikit-learn python docs/evidence/projection-headroom/scripts/analyze.py \
  --cache "$HEADROOM_CACHE" --out /tmp/headroom-results.json --baseline-props /tmp/headroom-props.json
npx tsx scripts/forecast-headroom-check.ts /tmp/headroom-props.json
```

## Capture check on the real release

The headroom replay above feeds the headroom export's rows straight to the ranking rules. This check exercises the other half: the join of the pinned consensus release to games and players that capture performs after a run.

```sh
npm run --silent forecast:capture-check
```

It runs capture over Celtics games 1–70 and fails unless it finds the headroom pool. The comparison is by digest of every sorted (game, player, stat, line, over probability), so two swapped player identities fail it even though every count is unchanged. The expected digest comes from the headroom export, which joins the release through separate code. Pass the export's `props.json` as an argument to recompute the expected digest from the file as well. On the current pin (Nov 11, 2026, SPO-886) it found **1,562 usable props over 70 games**, 18 to 28 per game, with 142 scheduled-tip rows that had no usable consensus. Its digest (`b5d415c4…`) equals the headroom export's. It reads the schedule and the consensus release only; no outcome is decoded.
