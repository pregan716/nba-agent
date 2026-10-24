# NBA analyst agent

Chronological NBA replay research for the Boston Celtics. The agreed design lives in
[the implementation brief](docs/NBA%20Analyst%20Agent%20%E2%80%94%20Implementation%20Brief%20v2.md).

## Data adapters (SPO-776)

Requires Node 22 or newer. Install the locked dependencies and run offline checks:

```sh
npm ci
npm run check
npm test
```

The TypeScript adapters in `src/data/` read published releases without recomputing
consensus, relevance, lineups, or game statistics. `config/datasets.json` pins every
root manifest and selected transcript manifest; objects are verified before parsing.
The transcript index and publication evidence are copied from the exact Git revision
specified in the brief. No bucket listing is used.

With Doppler installed and authenticated for `nba-agent/prd`:

```sh
npm run coverage
npm run verify:live
```

`coverage` reproduces the published odds/post counts, writes the 82-game diagnostic to
`docs/evidence/coverage-2025-26.json`, and records canonical mappings in
`config/identities.json`. `verify:live` checks all reference tables, official box-score
access in both seasons, the December 5 partial-summary exclusion, and an injury-player
partition, plus uncached authenticated reads from all four buckets. Neither command publishes data or calls an ingestion API.

Credentials are injected only into private reader subprocesses with `doppler run
--no-fallback`. Their protocol supports object GET only. The parent and future analyst
harness do not receive secrets. All four buckets use the `nba-agent` Doppler project
(`prd` config; `dev` and `stg` are empty as of October 24, 2026). `DopplerStore` accepts
explicit `project` and `config` options, defaulting to `nba-agent` and `prd`. The worker
checks the injected project/config against those arguments. Cached **data**, never
credentials, goes to the ignored `.cache/objects/` directory and is rehashed on reads.

For an intentional new dataset version, run `npm run pin -- /path/to/sports-transcription`.
The checkout must contain commit `cc28535292efc47316c163c6969d759875e95f86`.
This resolves the beat-post active pointer once, hashes the exact lineup bytes, reads
and saves the player coverage report, and pins selected transcript manifests. Review
the resulting config diff before adopting it; normal reads never follow a live pointer.

See [adapter contracts and verified coverage](docs/p1-data-adapters.md) for API boundaries,
availability conventions, limitations, and the player-reference release decision.
