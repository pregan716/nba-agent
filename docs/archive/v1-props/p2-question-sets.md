# P2 question sets (SPO-778)

`src/questions/builder.ts` turns the pinned consensus release into frozen game-level question sets for points, rebounds and assists. It copies published lines and probabilities without recomputing consensus, de-vigging prices or renormalizing probabilities.

## API and boundaries

```ts
const layer = await loadQuestionLayer(corpus.odds, identities);
const set = buildQuestionSet(
  { game_id: nbaId, espn_event_id: espnId, scheduled_start: tipoff },
  layer,
);
const agentView = set.questions.map(agentQuestion);
```

The trusted loader verifies manifest-pinned methodology, consensus, book-line and summary bytes through the P1 release reader, validates aggregate summary counts and resolves canonical player identities. Keep this full-season layer inside the environment; it is not an agent tool.

`buildQuestionSet` is pure. It selects the game's agreed-stat rows with `snapshot_kind=scheduled_start`, requires both `requested_at` and `scheduled_start` to equal the normalized game cutoff, and emits each source row exactly once. Invalid or duplicate observations, missing identity mappings, incomplete contributor evidence and unknown statuses fail construction. Probabilities must be finite, in [0, 1] and complementary within 1e-9; their original values are retained. No minimum question count or contributor count beyond one is imposed. An all-excluded game returns an empty question list with its exclusions; an absent game fails explicitly.

Question IDs are `q1_` plus SHA-256 of a JSON tuple containing the manifest hash, methodology hash, canonical game ID, ESPN game ID, normalized cutoff, canonical player ID, stat and selected line. Source rows and contributing pairs are sorted deterministically. Returned records and projections are recursively frozen and detached from caller-owned objects.

## Records and agent view

Each question carries the canonical player, stat, selected line, `p_over`, `p_under` and pinned source references. `provenance.consensus_row` preserves every published field, including contributing books/count, dispersion, inferred identity, contributor/line change flags, timestamps, method and rejected pairs. `provenance.contributing_pairs` preserves the accepted two-sided raw prices at the published selected line. Manifest and methodology hashes are also explicit provenance fields.

Every non-ok cutoff row becomes an exclusion with its original row, source hashes and status: `no_quotes`, `dfs_only` or `no_complete_sportsbook_pair`.

`agentQuestion` uses an explicit allowlist and exposes exactly:

- `question_id`
- `player` (`id`, `name`)
- `stat`
- `line`
- `p_over`

Full provenance, exclusions, raw prices and the complementary probability remain environment-side.

## Season validation

Run `npm run questions` using the existing read-only Doppler configuration. Full sets and agent views go to ignored `.cache/questions/`; the count and hash census is committed at `docs/evidence/question-sets-2025-26.json`. Each recorded question-set hash covers compact `JSON.stringify(set)`, not the pretty-printed cache file bytes.

The pinned 2025–26 Celtics release produces **82 games, 1,779 questions and 210 exclusions**. April 12 (NBA `0022501186`, ESPN `401811041`) remains included with one question and 11 exclusions.

The published `summary.json` contains aggregate counts only, so it cannot supply the per-game comparison requested in the issue. The loader checks its row, game, status, usable quote, prop and snapshot totals. The season command checks the 1,779 cutoff-question total against that summary and checks every game's status counts against the existing P1 coverage diagnostic with the same manifest hash. This distinction is recorded in the census; no per-game summary counts are invented.

Tests cover deterministic construction, mutation isolation, the agent allowlist, every exclusion status, malformed inputs, duplicate observations, complementary probabilities, source integrity and the season census. The specification is the P2 section and question-record requirements in the implementation brief v2.
