# NBA team expert projection agent

A chronological Boston Celtics replay experiment asking whether an AI agent that
builds expertise in one team adds value to DFS players and bettors by projecting
each player's minutes and production before every game. The design lives in
[the v4 implementation brief](docs/NBA%20Team%20Expert%20Projection%20Agent%20%E2%80%94%20Implementation%20Brief%20v4.md),
with Agreed, Proposed and Open status on every decision, and starts from
[an offline headroom check](docs/v4/headroom-check.md).

For the current experiment, see the [forecast arms](docs/v4/forecast-arms.md),
[reference projection](docs/v4/reference-projection.md) and
[forecast evaluation](docs/v4/forecast-evaluation.md). The
[substitution-policy archive](docs/archive/v3/README.md) contains the earlier
pilot write-ups, evidence links and Jev integration.

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
specified in `config/datasets.json`. No bucket listing is used.

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

## Available commands

| Command | Purpose |
| --- | --- |
| `npm run check` | TypeScript checks |
| `npm run format:check` / `npm run format` | Check / apply formatting |
| `npm test` | Remaining data and infrastructure tests |
| `npm run pin -- /path/to/sports-transcription` | Intentionally refresh dataset pins |
| `npm run coverage` / `npm run verify:live` | Authenticated data coverage and verification |
| `npm run audit` | Data-quality audit |
| `npm run session:verify` | Verify cutoff-filtered session data |
| `npm run runner:fixture` | Synthetic runner smoke test, no model calls |
| `npm run sandbox:build` / `npm run test:sandbox` | Build pinned Docker image / run isolation tests |
| `npm run probe` | Model contamination probe |
| `npm run projection:build` / `npm run projection` | Build the numerical image / produce pregame reference tables |
| `npm run forecast:run` | Run a development forecast arm with pinned sandbox and projection images |
| `npm run forecast:capture` / `npm run forecast:capture-check` | Capture pregame consensus / verify the capture against the cached export |
| `npm run forecast:evaluate` | Score and compare recorded forecast runs |
