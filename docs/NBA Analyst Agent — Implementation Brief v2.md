# NBA Analyst Agent — Implementation Brief v2

Oct 20, 2026 · @Patrick Regan

## Purpose and research question

Build a chronological NBA replay system that tests whether an agent's decisions improve as it accumulates, challenges, and revises knowledge about one team. The agent studies the Boston Celtics, researches coaching and player usage from time-restricted sources, and each game states a probability for every main-line player prop on the team's rotation. It is scored on whether those probabilities carry information the market's prices do not.

The central question is whether accumulated experience improves future decisions, and which learning processes cause the improvement. A season of prop questions supplies a repeated decision task with a built-in difficulty control (every line is market-centered near 50/50) and a built-in baseline (the market's own implied probability). The broader goal is to develop and demonstrate expertise in organizational learning for AI agents through reproducible experiments, explanations of failure, and evidence about what changes help.

A good score alone does not establish that an agent learned. Useful findings must connect differences in score to memory, reflection, knowledge revision, or other explicitly varied capabilities. Negative results are valuable if the comparison and diagnosis are sound.

## How to use this brief

Agreed items are requirements. Proposed items are recommended defaults for the first implementation, not approved decisions. Open items must be resolved explicitly before a scored experiment. Coding agents must preserve these distinctions when writing project specs and issues, and must not silently infer an Open item.

| Status | Meaning |
| --- | --- |
| Agreed | Explicit user choice, or established architecture and task scope |
| Proposed | Concrete default offered for review |
| Open | Unresolved choice that must not be inferred |

### What changed from v1

v1 framed the task as allocating $100 of simulated prop bets per game and scoring on net profit. This revision removes the betting layer entirely. The reasons, so they are not relitigated:

- Net profit over 82 games has no statistical power to detect a plausible learning effect. The per-game outcome variance swamps any realistic difference between configurations.
- Forcing a wager every game removed abstention, the skill a knowledge-building agent most needs to show.
- Stake sizing, best-odds-per-side selection, alternate-line ladders, arbitrage handling, settlement rule groups, and budget-exhaustion portfolio rules were all machinery in service of a metric that could not answer the question.

What stays: the market line as the question, because it controls difficulty and supplies a baseline for free. What is removed: money, stakes, bet counts, book selection, the LLM evidence judge (deferred, not rejected), and dollar-based research budgets (replaced with token caps for v1). The temporal access rules, source contracts, run isolation, and experiment record carry over unchanged in intent.

### Finalization changes (Oct 24, 2026)

- P1 pinned player-reference release `15fef7276244e616b0817be4` after reading its verified coverage report. The dataset table records the manifest hash and links to the coverage summary; historical-fidelity limitations remain explicit.
- P1a data quality audit complete ([report](p1a-data-quality-audit.md), SPO-777). All 82 schedules agree, 663 of 663 propped game-player rows resolve from official box scores, 50 of 50 consensus rows and 50 of 50 outcomes reproduce. The user accepted all eight proposed dispositions (I1–I3 identities, T1–T3 timestamps, C1–C2 content). None changes a question set, a cutoff, or a resolution. Recorded below in the shared contract requirements, the datasets table, and Resolved decisions. Gate 2's P1a prerequisite is met.
- P3 replay environment complete as six sub-issues (SPO-786 contract, SPO-787 session core and read tools, SPO-788 evidence search and fetch, SPO-789 phases, submission freeze and released results, SPO-790 workspace and memory modes, SPO-791 export and Docker sandbox). P4 runner, metering proxy and record complete (SPO-780). P5 homemade harness, null baselines, prompts, contamination probe script and launcher complete (SPO-781). P6 evaluators and reporting complete (SPO-782); the per-question score equation's sign and the clip-versus-reject sentence corrected to match the implementation. Gate 1 is met: every project runs on fixtures, and the market baseline scores exactly zero while the random-deviation baseline scores negative over the ten development games against the pinned corpus. Next: the development-games pilot, starting with the contamination probe.
- P2 question-set builder complete (SPO-778). Acceptance amended (SPO-785): the published consensus `summary.json` is aggregate-only, so the per-game count check is against the P1 coverage diagnostic and the season total is checked against the summary. No behaviour change.

### Finalization changes (Oct 23, 2026)

- Data contracts rewritten against the bucket guides in `docs/data-descriptions/`. The environment now consumes pinned, hash-manifested releases as published and no longer recomputes derived tables. Consensus corrected to the published method (median across contributing books, three exclusion statuses). Player reference added as an always-on static source. Injury and lineup ownership closed. Availability conventions stated per source. Beat reporting limited to NBA-related posts. Two new Open decisions: transcript availability time and play-by-play gap games. P1, P2, and Gate 2 rewritten accordingly.
- P1a Data quality audit added as a seventh project, required before Gate 2. Linear issues SPO-776 to SPO-782 created for P1, P1a, P2 to P6.
- Transcript availability closed the same day: index republished with `published_at` and livestream boundaries; coach media row pinned to the new commit and marked Agreed.
- Play-by-play gap question closed the same day: three Celtics games among the gaps, all with play-by-play; resolution source fixed as the official box score; did-not-play fallback to box-score minutes for games with partial summaries.

### Finalization changes (Oct 21, 2026)

- Harness contract added. v1 is a homemade harness; a third-party harness may be swapped in later as a new harness version. Workspace tools with memory-mode enforcement and sandbox lifecycle moved to the environment (P3); a metering proxy for model calls added to the runner (P4). P5 is the loop and prompts only.
- Code execution sandbox specified as a v1 capability: per-session container, cutoff-filtered read-only mounts, scratch directory, writable workspace in persistent configurations, no network, pinned image, compute budget, planted-future-record fixture.
- Memory mode decomposed into three sub-axes (horizon, revision rights, process). Configurations sequenced as a three-stage stack, each one flag from the last: A versus B, B versus B-append, then C against the better B variant. B-k (one-game memory window), B-frozen, D, and context-versus-retrieval moved to a second tier with reasons. Scripts made explicit as persistent workspace content in B, which absorbs the former skills configuration. A and B stated to share harness code.

### Finalization changes (Oct 20, 2026)

- Season pinned to the 2025–26 regular season.
- Stat set fixed to points, rebounds, and assists; three-pointers removed.
- Cost (tokens and compute) and wall-clock time added as secondary evaluation metrics and to every paired comparison.
- A Resolved decisions table added ahead of the Open decisions table.
- A Run profile section added: every run declares memory mode, data sources, agent capabilities, and model roles; comparisons must name the axes that differ. Starting lineups added to the dataset table.
- Odds visibility agreed: current-game and prior-game odds history is queryable; optional line-movement null baseline added.
- Odds audit completed from the ingestion reference export. Market redefined as a cross-book consensus computed in the environment. Cutoff set to scheduled start. Odds availability time set to `requested_at`. Reference book, main-line rule, staleness threshold, and actual-tip decisions closed. Agent sees consensus line and probability only.
- Replicate policy replaces the three-seed requirement: one replicate each for the first comparison, further B replicates before a published claim. Learning diagnostics split into their own subsection covering all persistent configurations.
- Did-not-play definition, development game count (10), and rationale visibility closed.
- No view redefined as submitting the market probability. Deviation measured against the market, threshold 0.05 with a 0.10 reporting level. Random-deviation baseline re-centered on the market.
- Resubmission allowance (two, from the reserve) and B write opportunities (pregame and postgame, not commit) closed.
- Budget structure agreed with pregame cap matched and a pilot procedure for the numbers. Implementation choices agreed and given their own section. Model access method added to the harness version.
- Output contract schema and the paired-bootstrap comparison method confirmed as Agreed. Control-and-data-flow diagram redrawn as text.
- Model verified: Claude Opus 4.6 training data cutoff Aug 2025. Status changed from "Agreed, verify" to Agreed.
- Effort level named as part of the harness version and pinned during the pilot.
- Research budget profile and harness version added as per-run descriptors that must match across compared runs.
- De-vig method resolved to proportional normalization and added as a named per-run descriptor.
- Static-dossier configuration rejected. B-frozen, C, and D moved to a follow-up table conditional on a v1 effect. Research budget promoted to its own section.

## Scope and design principles

One team, one season, chronological replay, a stateless baseline against one persistent-knowledge intervention. Multi-team knowledge sharing and agent organizations are later extensions.

| Area | Baseline | Status |
| --- | --- | --- |
| Team | Boston Celtics | Agreed |
| Season | 2025–26 regular season. Playoffs, play-in, and preseason are excluded. | Agreed |
| Agent task | For each main-line prop question on the game's rotation, state P(over). Submitting the market-implied probability means no view. | Agreed |
| Primary score | Log-loss improvement over the market-implied probability, averaged across questions | Agreed |
| Secondary metrics | Cost (LLM tokens by type, spend at a pinned price schedule, compute) and wall-clock time, per game and per phase, reported for every configuration | Agreed |
| Learning scope | Research and knowledge updates may cover anything eligible, not only the questions answered | Agreed |
| Core boundary | All external observations and binding actions go through the environment. Each run owns isolated agent memory. | Agreed |
| Ingestion | Odds, press conferences, beat reporting, and play-by-play live in separate repos | Agreed |
| Replay timing | Pregame cutoff at scheduled tip. Postgame release at 9 a.m. America/New\_York the following morning. | Agreed |
| Model | Claude Opus 4.6, API ID `claude-opus-4-6`, for the analyst role. Verified Oct 20, 2026 against Anthropic's model documentation: training data cutoff Aug 2025, reliable knowledge cutoff May 2025, both before the season's Oct 21, 2025 opener. Dateless IDs from the 4.6 generation on are pinned snapshots. Pricing $5 input / $25 output per million tokens, cache read $0.50. Retirement not sooner than Feb 5, 2027, so scored runs must complete before then or re-verify. Models are pinned per role; v1 has one role. | Agreed |
| Evidence judge | Not in v1. May return as a varied capability in a later configuration. | Agreed |

### Guard against unnecessary process

Previous attempts became overly constrained. Specify access rules, the output contract, scoring, and the differences between configurations rigorously. Leave the agent free to choose its research process and how it organizes its knowledge. Do not require a claims ontology, a research checklist, or a projection model. The output contract below is deliberately minimal: a probability and a short rationale per question, nothing that forces the agent to model players it has no view on.

### Why the market line stays

The line is the question, not a betting instrument. It does two jobs nothing else does cheaply: every question is hard by construction because the market centered it, and the price supplies a competent baseline probability. Scoring against the market answers the real question: does the agent know something the market does not.

## The task

Each game, the environment constructs a question set from the frozen pregame odds snapshot. The agent returns one probability per question. Missing questions and malformed submissions are handled by explicit rules, never by inference.

### Question set construction

A question is one (player, stat, line) tuple. The environment builds the set as follows:

The market is a cross-book consensus, not a single reference book. It is the consensus layer published in the odds archive (`consensus/proportional/v1`), pinned by its manifest and consumed as published; the environment does not recompute it. Status: Agreed. The method, as recorded in that layer's `methodology.json`:

1. Take the cutoff observation: the odds observation whose modeled availability time (`requested_at`) equals the game's scheduled start (`snapshot_kind = scheduled_start`). Every sportsbook's quotes in that observation are inputs; daily-fantasy operators are not.
2. For each Celtics player and each eligible stat, take every line each book quotes for that market, main and alternate. A (book, line) pair is valid only if the book quotes both sides of it; a pair with a missing side or conflicting prices is rejected with a reason and retained in `book-lines`.
3. Select the consensus line. Each sportsbook votes once, with its line nearest 50/50 (its main line). The selected line is an offered line nearest the median of those votes. Alternate lines do not vote. Every selected line in the 2025–26 data is a half-integer; if an integer line is ever selected, the published probability is conditional on no push (`probability_basis = conditional_on_no_push`), which matches the push exclusion at scoring.
4. De-vig each contributing book at the selected line by proportional normalization within the same book and line: p\_over = (1/d\_over) / (1/d\_over + 1/d\_under).
5. The market-implied P(over) is the median of the contributing books' normalized P(over). The contributing set is every book with a valid pair at the selected line, whether that book offers the line as its main or as an alternate; books never get extra votes. The contributing books, their count, and the dispersion of their probabilities are on the row. Minimum contributing-book count: 1 (Agreed).
6. A (player, stat) that does not resolve to a probability carries one of three statuses: `no_quotes` (no book quoted it), `dfs_only` (only daily-fantasy operators posted a line), or `no_complete_sportsbook_pair` (quotes exist but no book has a valid two-sided pair). Non-`ok` rows are exclusions and are logged with their status.

The environment reads the `ok` rows of the cutoff observation to build the question set, and every observation's `ok` rows to serve odds history. It verifies the layer's SHA-256 manifest before use and records the manifest and `methodology.json` hashes in the run manifest; those hashes are the de-vig descriptor. `docs/data-descriptions/odds_data.csv` is a convenience copy of the published `consensus.csv`, not a separate export.

The rotation is defined by the market: a player is in the set if at least one book quotes a valid main-line pair for them at the cutoff. Agreed stat set: points, rebounds, assists. Three-pointers made, PRA, steals, blocks, and minutes are excluded even when books offer them.

Typical size is 20 to 28 questions per game in the 2025–26 data, median 22. Late-season rest games can be thin (one game has a single question). Thin games are included and scored normally; question count per game is reported.

### Agent output contract

One atomic submission per game, frozen before any postgame information is accessible. Schema, status Agreed:

| Field | Rule |
| --- | --- |
| question\_id | Must match an id in the issued set |
| p\_over | Float in \[0.01, 0.99\]. Submitting the market-implied probability shown with the question means no view and scores exactly zero. Values outside the range are clipped and the clip is logged. |
| rationale | Short free text. Required when abs(p\_over − q) ≥ 0.05, where q is the market-implied probability; may be empty otherwise. |
| evidence\_refs | Optional list of source record ids the rationale relies on |

Plus an optional free-text notes field for the whole submission, stored and never scored. The agent may write anything it likes there: theses about usage, flags on unbet players, questions for itself.

A submission that fails validation (missing ids, unknown ids, duplicate ids, missing required rationales, malformed structure) is rejected; a `p_over` outside [0.01, 0.99] is not a rejection but is clipped and the clip logged, as the table says (clarified Oct 24, 2026). Agreed: the harness returns a validation error naming every problem and allows up to two resubmissions. Retries draw on the submission reserve, never on fresh budget. If the third attempt still fails, the session is recorded as failed and excluded from scoring; the status records which attempt failed and why. Do not fill missing questions with the market probability silently. Repeated delivery of an identical valid submission must not create a second record.

### What the agent is not asked to do

It is not asked to produce a projection for every player, to answer alternate lines, to size anything, or to form a view where it has none. Submitting the market probability is free and expected to be the majority answer for an honest agent. The design rewards selective, well-founded deviation from the market.

## Scoring

The primary score is the agent's mean log-loss improvement over the market across all resolved questions. A positive value means the agent's probabilities carried information the market's did not. One deterministic scoring implementation lives in the evaluation layer; the environment exposes results only when the runner's phase policy permits, and agent feedback uses the same code.

### Resolution

For each question, the actual stat is the official box-score value in the play-by-play release's box-score table, which is what sportsbooks settle on. Play-by-play-derived summaries are not the resolution source, so a game whose derived statistics disagree with the official box score still resolves normally. Outcome y = 1 if actual > line, 0 if actual < line.

| Case | Handling |
| --- | --- |
| actual = line (push) | Excluded from scoring; counted and reported |
| Player did not play | Excluded; counted and reported. Agreed: did-not-play means zero seconds on the floor in the play-by-play. A player listed inactive, or active but never substituted in, is did-not-play under the same test. |
| Player played any minutes | Resolved normally, including early exits |
| Game postponed or cancelled | Session voided; questions carried to the rescheduled date are rebuilt from that date's snapshot |
| Missing or conflicting stat source | Unresolved, never scored as a loss; flagged for manual review |

### Per-question score

```latex
\mathrm{skill}_i = \big[\,y_i \log p_i + (1-y_i)\log(1-p_i)\,\big] - \big[\,y_i \log q_i + (1-y_i)\log(1-q_i)\,\big]
```

where p\_i is the agent's P(over) and q\_i is the market-implied P(over). The first bracket is the negative of the agent's log loss and the second the negative of the market's, so skill is the market's log loss minus the agent's; lower log loss is better, so a positive skill means the agent beat the market on that question. (Corrected Oct 24, 2026: the equation previously had the brackets reversed, contradicting this sentence; the evaluator follows the prose.) An answer equal to the market probability scores exactly zero; it is neither rewarded nor punished. The market probability is shown with every question, so "no view" costs nothing. (Answering 0.50 instead would not be free: in the 2025–26 data the consensus sits a median 0.027 from even and the expected penalty for 0.50 is about 0.005 nats per question, comparable to a plausible real edge.)

### Reported alongside the primary score

- Brier-score improvement over market, same construction.
- Deviation count and rate: questions where abs(p − q) ≥ 0.05, the agent's probability against the market's. Agreed. A second reporting level at abs(p − q) ≥ 0.10 identifies strong deviations; it is a report column, not a different definition.
- Hit rate on deviations: fraction where the agent's side relative to the market was correct, at both levels.
- Calibration table in deciles of stated probability.
- Breakdown by stat, by player, and by game index (first third, middle, last third of the season).
- Failed sessions, exclusions, and unresolved questions, each with reason.
- Cost: input, output, cached, and reasoning tokens separately; spend at the pinned price schedule; sandbox compute seconds and any other tool execution outside the model. Reported per game, per phase, and as a season total.
- Time: wall-clock per game and per phase (pregame research, commit, postgame including reflection), with a season total.

Cost and time are evaluation metrics, not only budget accounting. A configuration that matches another on the target metrics but is cheaper or faster is the better configuration, and the report must make that comparison visible.

### Comparison between configurations

Compare on matched questions only: a question scored for one configuration but excluded for another is dropped from the paired comparison. Questions within a game are correlated (shared injury news, blowouts, pace), so treat the game as the unit for uncertainty. Agreed: a paired bootstrap over games, reporting the 90% interval on the primary score difference. Report sensitivity to the five most influential games. Where a configuration has more than one replicate, report within-configuration variance; a between-configuration difference smaller than within-configuration spread is not a finding. The replicate policy is in Experimental configurations.

Report cost and time next to the primary-score difference for every paired comparison. State the score per unit cost and per unit time so a configuration that reaches the same skill more cheaply or faster is identified, not only one that scores higher.

A learning curve is a score that rises with game index for the persistent configuration and not for the stateless one, on the same games. Schedule difficulty and market efficiency change through a season, so the stateless baseline on the same games is the control, not the persistent agent's own early games.

### Null baselines

Run these on the same question sets so the stateless LLM's score has a reference:

- Market: p = q for every question. Scores exactly zero by construction.
- Naive stats: p from the player's eligible season-to-date distribution for that stat, via a documented simple model.
- Random deviation: p = q plus noise drawn uniformly from \[−0.15, 0.15\], clipped to the valid range. Establishes the cost of noise around the market.
- Line movement (Proposed, optional): p shifted from the market probability in the direction the consensus line moved between the first eligible observation and the cutoff, by a documented fixed amount. Establishes how much of a stateless agent's score is steam-chasing. Cheap once the odds adapter exists.

If the stateless agent does not beat naive stats, that is reportable on its own.

## System architecture and module ownership

Five logical modules in one core repository, plus external ingestion repositories. These are ownership boundaries, not a requirement for separate deployed services. The environment controls the observable world and legal actions, including the workspace and the sandbox; the harness is the agent's reasoning loop; the runner controls the experiment and meters the model; evaluators measure frozen records.

| Component | Owns | Does not own |
| --- | --- | --- |
| External ingestion | Collecting, normalizing, and preserving source records with provenance | Run-specific access rules or agent interpretations |
| Runner | Configuration, schedules, budgets, run isolation, checkpoints, controlled clock advancement | Basketball reasoning or source ingestion |
| Environment | Read adapters, temporal filtering, question-set construction, submission validation, frozen submissions, released outcomes, the workspace tools with memory-mode enforcement, the code execution sandbox | Agent research strategy or memory contents |
| Agent harness | The model loop and prompts: deciding which tools to call and what to write. v1 is the homemade harness; later versions may swap in a third-party harness under the same contract | Workspace enforcement, sandbox lifecycle, token metering, authority to reveal future sources or change the output contract |
| Evaluators | Resolution, scoring, baselines, calibration, matched comparisons, reports | Changing frozen submissions or unrestricted feedback to the agent |
| Experiment record | Immutable events, source references, configurations, workspace checkpoints | A shared memory accessible to every agent |

### Source archive versus agent memory

The source archive holds timestamped evidence any configuration can query under identical rules. Agent memory holds interpretations, hypotheses, lessons, and procedures produced by one run. A stateless agent can query historical sources but must not inherit prior conversation state, private notes, generated summaries, or caches containing its earlier analysis. The operational audit log is not an agent-visible tool.

### Control and data flow

```text
                 Runner                                   Evaluators
     (config, clock, budgets, record)              (score frozen records only)
          |                                                  ^
          | 1. create run, set phase + cutoff                | 5. resolve + score
          v                                                  |
     +-----------+   2. invoke with tools,    +--------------+-------------+
     |  Harness  |      scoped session        |        Environment         |
     |  (model   | -------------------------> |  read adapters over R2     |
     |   loop,   |   3. search / fetch /      |  cutoff filter on every    |
     | workspace)| <---- observations -----   |  path; question set;       |
     |           |                            |  validate + freeze submit  |
     |           |   4. submit probabilities  |                            |
     |           | -------------------------> |  receipt                   |
     +-----+-----+                            +-------------+--------------+
           |                                                |
           | 7. carry forward (B) or reset (A) workspace    | 6. release at 9 a.m.
           |                                                |    next morning
           v                                                v
     workspace checkpoint                        released results tool
     (experiment record)                         (outcomes, scores, postgame
                                                  observations; no rationales)
```

The runner creates a run and sets the phase and cutoff. The harness invokes the agent with the permitted tools and workspace. The environment reads pinned datasets, filters them to the cutoff, and returns observations; the agent submits its probabilities through the environment, which validates and freezes them. The runner then advances time; evaluators score the frozen record against game data, and the environment releases scores and postgame observations at the next-morning release. The harness carries forward or resets memory according to the configuration.

## Data contracts and temporal access rules

Status Agreed (Oct 23, 2026): the environment consumes each source's published, immutable, hash-manifested release as-is, including derived tables that ingestion has already computed (the odds consensus, play-by-play lineups and stints, injury team snapshots, beat-post relevance labels, extracted starting lineups). It does not recompute them. The environment's responsibilities are verification against the manifest, temporal filtering, visibility projection, and canonical ID joins. Each release identifier is the dataset manifest version on the data-sources axis; a different release is a different data-sources value. The earlier principle that the environment performs all processing from raw records is withdrawn. The guides for each bucket are in `docs/data-descriptions/` and are the reference for layouts and field semantics.

Every source has a stated availability convention. These are replay conventions, not measured delivery times: each guide says its timestamps do not certify when bytes were publicly accessible. The convention is recorded as the eligibility reason on every record.

| Source | Bucket and prefix | Pinned release | What the environment exposes | Availability time |
| --- | --- | --- | --- | --- |
| Odds consensus | `pm-data-platform`, `external/the-odds-api/v1/league=nba/season=2025-26/team=bos/consensus/proportional/v1/` | That layer's `_MANIFEST.json` checksums and `methodology.json` hash | `ok` rows: `selected_line` and `p_over` per (game, observation, player, prop). Nothing else from the row. | `requested_at` of the observation |
| Play-by-play, box scores, lineups, stints | `sports-nba-data`, `nba/releases/spo-771-full-v1-2025-26/` and `nba/releases/spo-771-full-v1-2024-25/` | Each release's `manifest.json` | Release tables per the data dictionary. `coverage.jsonl` is consulted per game; a game not `valid` for the product being queried is served as absent with a recorded reason. | Postgame release at 9 a.m. America/New\_York on the morning after the game. 2024–25 games are eligible from the start of the replay. |
| Injury reports | `sports-nba-data`, `nba/injury-reports/2025-26/` | Release key `61f65449f459752a0ad06c0f41efd1cc8c13494f7b5f9c838f6536637c411c2e` | Curated player observations and team snapshots as the PDF showed them, including `not_yet_submitted` placeholders and absent-team observations. The evidence register, `empty_report_corroborated` interpretations, and anything carrying an assessment time are retrospective and never agent-visible. Unmatched rows excluded. | Printed report timestamp (`report_timestamp_utc`). Agreed. A row whose UTC value is null because of daylight-saving ambiguity takes the later of the two readings. A `team_absent` snapshot (Boston, Apr 7, 2026, `0022501149`, printed 23:00Z) is served as unknown, never as a healthy roster, and no earlier report is carried forward. |
| Player reference | `sports-nba-data`, `nba/player-reference/2025-26-opening/releases/<release-id>/` | Release `15fef7276244e616b0817be4`; manifest SHA-256 `7d9e7802344e90852d55eee4895b305a24a4f59e46fd18d87915b17ecfd8837f`; [coverage summary](p1-data-adapters.md) | Release tables and SQL views only: opening roster profiles, career season totals through 2024–25, identity exceptions. `archive/` is never mounted or exposed. | Static. Built to a cutoff of 2025-10-21T23:29:59Z, before the opener, so eligible for every game. Age is computed for the replay date. |
| Beat reporting | `sports-text`, `v1/relevance/celtics-2025-26/` | The snapshot manifest that `active.json` points to at pin time (hash recorded), over backfill report `a57664cd-e4d8-4aaf-9741-1ac0b6b4fcf1` | Only posts labelled NBA-related (1,303 of 1,425 at pin time), latest retained version, with text, author, publication time, and relationships. Unrelated posts are not exposed. The label policy (Jev 1.14.0, threshold 0.10) is part of the pinned manifest. Label precision is accepted with a recorded limitation: in the P1a sample of 50, 33 were verifiably basketball, 0 demonstrably off-topic, and 17 could not be judged from retained text (link-only posts and replies without a retained parent). | Publication time of the version. Agreed. A later version whose edit time is known is available at that time; one whose edit time is unknown is excluded rather than shown at the original time. |
| Starting lineups | `sports-text`, `v1/research/celtics-lineups/extracted-2026-10-16/` and `v1/research/opponent-lineups/2026-10-19-complete/` | SHA-256 of the two JSON datasets | Announced starters per team, the preferred announcement per game, with source post and posting time. Alternates retained as evidence, not exposed. Announced lineups that disagree with box-score starters stay as announced. | Posting time of the announcement. Agreed. Usually shortly before tip, so eligibility against scheduled start decides whether a game's own lineup is pregame-visible. Agreed (Oct 24, 2026): the 18 Celtics and 7 opponent announcements posted at or after the scheduled start, including the two posted at exactly that instant, are unavailable for their own game under the strict rule. They are not backdated and no game moves to actual tip. |
| Coach media | `sports-transcription`, `dev/manifests/bos/<media-id>/<run-id>.json`, selected by the season manifest index at repository commit `cc28535292efc47316c163c6969d759875e95f86` (134 recordings) | The index plus each manifest's checksums; the index's `published_at_provenance` and `livestream_provenance` hashes | Readable transcript and structured transcript with provider speaker-cluster labels (not identities), title, source URL, publication time. Audio not exposed. | Agreed. `published_at` (UTC, second precision, the indexed video's publication, not last-modified or event time) for ordinary uploads. For the 10 livestreams and premieres, `stream_ended_at`, so a recording is visible only once the whole broadcast existed. An entry with `published_at_precision = day` would take the end of its Eastern `publicationDay`; none exist in this revision. An entry with `cutoff_requires_review = true` is excluded until reviewed; none exist. `publicationDay` is a local Eastern day and is never used as a UTC date. Title words are not availability evidence: the Nov 5, 2025 upload titled pregame for `0022500174` was published 87 seconds after the scheduled start and is unavailable for that game. Two transcription defects found by P1a (Jan 17 pregame at 38–52 s, Nov 11 pregame at 77–90 s) are flagged to the maintainers; the immutable text is served as published and a corrected release would be a new data-sources value. |
| Schedule | Play-by-play release games table, cross-checked against the ESPN schedule preserved in the odds archive (`reference/schedule-response.json.gz`) | As above | Game identities, opponents, scheduled start, venue | Static for the season; schedule changes, if any, are recorded with the change's own timestamp. |

### Shared contract requirements

- Stable canonical game, team, and player IDs with explicit mappings from provider IDs: ESPN event ids in the odds archive, NBA game and player ids in the NBA data bucket, X account and post ids in the text bucket, media ids in the transcription bucket. Never join on ambiguous names.
- Name joins (odds player names, lineup names, injury names, which carry no player id) resolve only when exactly one candidate exists in the pinned catalogs after normalization; otherwise they fail and are reported. Agreed (Oct 24, 2026) exceptions, each scoped to the injury source and backed by audit evidence: `Yang, Hansen` is an alias for `1642905` (the catalog prints the family name first); `Williams, Jaylin` resolves by the injury row's `team_id`, Oklahoma City to `1631119`, with `1642444` kept as a distinct person. `Jones, Dillon` stays refused until the play-by-play maintainers publish an identity exception for `196295686`; its observations are served unresolved and the incomplete opponent join for `0022500757` is recorded. No other alias or disambiguation rule exists; adding one is a brief change.
- Every release is immutable and hash-manifested. The adapter verifies every object it reads against the manifest before serving it and refuses an unverified object. Folder listings are never used to assemble a dataset.
- Separate event time, availability time, collection time, and revision time. Each record carries its availability time and the convention that assigned it, from the table above.
- Preserve corrections and revisions where the source has them (post edit chains, injury report updates, multiple transcript runs). Where history cannot be reconstructed, the table's exclusion rule applies and is reported.

### Odds data: the critical dependency

Findings for the 2025–26 regular season, from the published consensus layer:

- Four observations per game: three `pregame` observations requested at fixed Eastern clock times (11 a.m., 2 p.m., 6 p.m. for starts at or after 7 p.m.; tip minus six, three, and one hours for earlier starts), and one `scheduled_start` observation requested at the scheduled start itself. 328 observations.
- Ten sources: eight sportsbooks and two daily-fantasy operators. Daily-fantasy operators never contribute to the consensus; their thresholds are retained on the row as reference and are not agent-visible.
- 7,956 consensus rows: 6,666 `ok`, 1,178 `no_quotes`, 112 `dfs_only`, and the remainder `no_complete_sportsbook_pair`. All `ok` lines are half-integers. Celtics assists were unavailable in all four April 12 observations.
- Per-book quotes and the accepted pairs behind every consensus row are preserved (`derived/v3/quotes`, `consensus/.../book-lines`), so any row can be audited. They are later values on the data-sources axis, not v1 inputs.

Timestamps and availability. The provider returns the stored snapshot closest to and at or before the requested time, labeled `snapshot_at`, about 4.4 minutes earlier than `requested_at`. Some contributing book updates are timestamped after `snapshot_at` by up to 68 seconds, but none after `requested_at`. The modeled availability time for every odds record is therefore `requested_at`. This is a replay convention, not proof of live delivery time; the backfill download time (`receivedAt`) is provenance only. Do not interpolate between observations.

| Field | Meaning |
| --- | --- |
| `requested_at` | The historical observation time chosen by ingestion. The environment's availability time. |
| `snapshot_at` | The provider's stored snapshot label returned for that request. Provenance only. |
| `last_update_oldest`, `last_update_newest` | Range of book update times among contributing quotes. Provenance only. |

Player identity. `season_inferred_identity_in_inputs` means at least one input quote's player identity or team was inferred from season box scores because the player was absent from that game's box score, typically because props were posted and the player was later ruled out. The quote is genuine. The environment carries the flag onto the question record as provenance, does not exclude the question on that basis, and reports the count. Such players usually resolve as did-not-play.

### Temporal access rules

Apply the cutoff to every access path: search, direct fetch, metadata, aggregates, snippets, derived views, and pagination. A query for a future record must not expose its title, existence, count, or contents. Derived statistics use only eligible observations. Agent requests cannot override the session cutoff, run identity, or dataset version.

An old recording transcribed today represents information available at its publication, provided the transformation uses only that recording. A retrospective article written today cannot be backdated. For completed games, define explicitly when results and derived views become available; reconstructed data is not necessarily a faithful snapshot of contemporary corrections.

### Game data scope

The two pinned play-by-play releases cover all teams for 2024–25 and 2025–26 (1,394 and 1,393 inventory games), with 41 gap games across the two seasons listed in the releases' coverage records. Checked with the play-by-play maintainers on Oct 23, 2026: three gap games involve the Celtics and all three have play-by-play; none of the six games with no play-by-play at all is a Celtics game. The three are Celtics–Knicks `0022400061` (Oct 22, 2024, broken substitution chains, so lineup, stint, and possession products are incomplete), Celtics–Raptors `0022400230` (Nov 16, 2024, fifth overtime player unidentified), and Celtics–Lakers `0022500338` (Dec 5, 2025, play-by-play-derived statistics disagree with the official box score, summaries partial). The two 2024–25 games are historical evidence only and their incomplete products are served as absent under the coverage rule. The Dec 5, 2025 game is a scored game; its questions resolve from the official box score, which is unaffected, and did-not-play falls back to box-score minutes for that game because its play-by-play summaries are partial. No exclusion policy is needed. Phases are separated in the tables; preseason, play-in, Cup final, and playoff rows are excluded from the replay. Opponent substitutions can occur inside an own-team lineup stint, so opponent-context queries use event-level segments, which the release's stint tables already provide.

## Replay lifecycle and environment tool surface

One game runs through five phases. The runner requests transitions; the environment enforces their validity. The agent cannot advance time.

1. Initialize: validate configuration and dataset coverage; create the isolated run, workspace, and record; select the first game.
2. Pregame: freeze the cutoff at the game's scheduled start and build the question set from the odds observation requested at that time. Allow research using only eligible information. Enforce the research budget.
3. Commit: validate and freeze one complete submission. Return a stable receipt. Identical resubmission is idempotent.
4. Postgame: advance the clock to 9 a.m. America/New\_York on the calendar morning after the game date. Release eligible game observations, per-question outcomes and scores, and run reflection if the configuration enables it.
5. Checkpoint: record workspace version, costs, events, and completion status; advance to the next game.

Final submissions remain frozen through retries, crashes, and later evaluation. A missing or invalid submission is a failed session with an explicit status, never a valid set of market-copying answers. Pregame research runs against frozen simulated time; wall-clock does not move the cutoff. The cutoff is the scheduled start, not the actual tip. Non-odds records are eligible when their availability time is strictly before the cutoff; the cutoff odds observation, whose availability time equals the cutoff, is eligible. Anything published between scheduled and actual tip is excluded, which is conservative. If a game's scheduled start is revised, use the final scheduled start. News published after 9 a.m. remains unavailable at that release.

### Environment tools

These are capability contracts, not final API names.

| Capability | Expected behavior |
| --- | --- |
| Session context | Return team, game, opponent, phase, cutoff, budget remaining, and dataset versions |
| Search and fetch evidence | Search eligible media; retrieve stable source records with provenance and citations |
| Query game history | Retrieve eligible events, stints, lineup context, and box-score aggregates with explicit definitions |
| Read injuries and schedule | Return eligible status reports and schedule information with timestamps |
| Query odds history | Return eligible consensus observations for the current game and prior games: availability time, consensus line, and market-implied P(over) per (player, stat), plus settled outcomes for prior games once released. No per-book or dispersion fields in v1. |
| List questions | Return the frozen question set for the current game: question\_id, player, stat, line, and market-implied P(over). Complete, no pagination needed at this size. |
| Execute code | Run a Python program in the session sandbox against the mounted session datasets, scratch directory, and workspace; return stdout, stderr, and exit status, truncated to the stdout cap. Compute time is metered against the phase's compute cap. |
| Submit | Validate completeness, ids, and ranges; atomically freeze; return a receipt |
| Read released results | Expose, at the next-morning release, eligible game observations and each prior question's outcome, agent probability, market probability, and per-question score. The agent's own past rationales and notes are part of its workspace, so B sees them and A does not; released results never carry rationales themselves. |

Whether the agent sees the market-implied probability alongside each question is Agreed: yes. It is part of the question, and hiding it would turn the task into reconstructing the market rather than beating it.

Workspace read and write are environment tools, and the memory mode is enforced there: editable or append-only, writable in pregame and postgame and locked during commit, reset to empty per game for A. The harness cannot reach the workspace except through these tools, so the memory mode holds for any harness by construction. The experiment record separately captures tool calls, responses or replayable references, errors, submissions, and workspace checkpoints.

### Code execution sandbox

Status Agreed. The agent is given more data than it can use by reading alone; the value is in aggregating, joining, and modelling it, which means writing and running code. Code execution is therefore a v1 capability, on for every configuration in the stack so it never confounds the memory comparison. Scripts are workspace content. In persistent configurations the agent saves the programs it writes to the workspace and re-runs or revises them in later games, so a feature pipeline or a model-fitting routine written once is available all season; in A every game starts without them. The same holds for what the code produces, such as a fitted model or a cached table. Under B-append, scripts can be added but not edited in place; a revised script is a new file.

Each session (one pregame or one postgame phase) gets:

- A fresh container from a pinned image: Python with pandas, numpy, scipy, and scikit-learn. No network. No package installs beyond the image. The image digest is part of the harness version.
- The eligible datasets materialized as files by the environment, filtered to the cutoff before they are mounted, and mounted read-only. The export is a SQLite file with the same tables the environment tools expose (game history, box scores, injuries, lineups, odds history, released results) plus source text as files. Filtering inside the sandbox is a leak waiting to happen; the sandbox never holds a record it is not allowed to see.
- A scratch directory for the session, writable, discarded when the session ends. It does not survive from pregame to postgame.
- In persistent configurations, the workspace mounted writable, so scripts, models, and cached results saved there persist to later games. In A, a fresh empty workspace. Workspace writes from code obey the same opportunity rules as writes from the harness: pregame and postgame, never during commit.
- CPU and memory limits, a wall-clock limit per call, a cumulative compute cap per phase, and a cap on the bytes of stdout returned to the model. The numbers are chosen in the budget pilot alongside the token caps.

The sandbox runs on the same host as the harness, as a per-session Docker container. Anthropic's hosted code-execution tool is not used: the data would have to be uploaded per session and the temporal filter would sit outside the environment's control. A remote sandbox service adds a vendor for no gain on a single-host deployment.

### Harness contract

The harness is the agent's reasoning loop and nothing else. v1 is a homemade harness: a hand-written tool loop over direct Anthropic SDK calls. Future versions may swap in a third-party harness such as a coding-agent framework or the Claude Agent SDK. To make that a configuration change rather than a rebuild, every harness runs under the same contract:

- It receives three handles and nothing else: a session endpoint (the in-process interface, or its MCP wrapping) exposing the environment tools above, including workspace and code execution; a metered model endpoint (a base URL and scoped key issued by the runner); and the memory-mode instructions for its prompts.
- It holds no credentials, no data paths, and no direct access to the workspace directory, the sandbox, or R2.
- Every model call passes through the runner's metering proxy, which counts tokens, enforces caps, pins the model and effort, and records usage. Token accounting therefore does not depend on the harness reporting it.
- It submits only through the Submit tool.
- Its identity, version, and configuration are the harness version. A run that swaps the harness is a new harness version, and the per-run descriptor rules apply: a comparison that varies the harness and anything else cannot attribute its result to either.

A third-party harness that ships its own file or shell tools must have them disabled or pointed at nothing; the only writable surfaces are the workspace tool and the sandbox scratch directory. Gate tests for isolation run against whatever harness is configured, not only the homemade one.

### Isolation and reproducibility

Enforce session identity and cutoff outside the model prompt, with a scoped token or trusted session object. Agents have no unrestricted internet or storage credentials. Code execution operates only on the session's cutoff-filtered exports, its scratch directory, and the isolated workspace, with no network and no path to future data; the acceptance fixture for this is a future record planted on the host that must be invisible from inside the container. Pin code revision, configuration, harness version (identity, prompts, tool definitions, loop parameters), research budget profile, model identifiers, and dataset manifests. Capture observations or immutable references sufficient to reconstruct them; model text may still vary between runs.

## Run profile

Every run declares a profile on four independent axes. The profile is part of the run manifest, is printed at the top of every report, and is the vocabulary for stating what differs between any two runs. A comparison must name which axes differ; a comparison that differs on more than one axis cannot attribute its result to any single one.

| Axis | What it declares | Initial values |
| --- | --- | --- |
| Memory mode | What the agent carries between games and when it may write to it. Declared on three sub-axes: horizon (window of k games: stateless k = 0, full season, or intermediate), revision rights (editable or append-only), process (voluntary or mandated reflection) | v1: A stateless, B persistent, editable, voluntary. Sequenced follow-ups: B-append, C mandated reflection. Second tier: B-k (k = 1), B-frozen, D independent critique (see Experimental configurations) |
| Data sources | Which source types the environment exposes to the agent, each with its pinned release identifier | Coach media transcripts, play-by-play and box scores, injury reports, starting lineups, beat reporting (NBA-related posts only), player reference (always on, static), consensus odds history (always on; it defines the questions and includes current-game and prior-game observations, line and probability only). Later: per-book quotes and dispersion fields. |
| Agent capabilities | What the agent can do within a game beyond reading sources and submitting | v1: search and fetch, game-history queries, workspace read and write, code execution in the session sandbox (see Code execution sandbox). Later candidates: external calculators |
| Model roles | Which pinned model serves each role, with version | v1: one role, analyst. Later candidates: reflector, critic, researcher, each independently pinned |

Rules for the axes:

- Each axis is enumerated and versioned. Adding a new value (a new source type, a new capability, a new role) adds a named entry; it never changes the meaning of an existing one, so older runs stay comparable.
- Memory mode and agent capabilities are distinct. Memory mode governs what persists across games. Capabilities govern what the agent can do inside a game. Anything a capability produces that should outlive the game, such as a script, a trained model, or a cached calculation, is written to the workspace and follows the memory mode. A stateless run therefore rebuilds it or goes without.
- Data sources are declared by type and manifest version, not by what the agent happened to read. A source type is either exposed under the temporal access rules or absent from the run.
- Model roles are pinned per role. Two runs with the same roles but different model versions in any role differ on this axis.
- The consensus construction rules (line-selection rule, contributing-book rule, minimum book count, exclusion statuses) are question-set policy, not profile axes. They are pinned in the manifest and must be identical across any runs that are compared. The de-vig method is likewise question-set policy and is listed as a named descriptor below because it defines the scoring baseline.

### Per-run descriptors held fixed within a comparison

Three further fields are declared on every run and printed with the profile. They are not experimental axes. Runs that are compared must match on all three, and a report must refuse or flag a comparison where they differ.

| Descriptor | What it declares |
| --- | --- |
| Research budget | The pregame and postgame token caps, the submission reserve, the rollover rule, the tool-call and wall-clock ceilings, and the pinned price schedule used to report spend. Recorded as a named, versioned budget profile so a run can be described as "budget v3" rather than by its numbers. |
| Harness version | One identifier that resolves to the exact set of: harness identity (v1: homemade; later possibly a named third-party harness and its version), system and phase prompts, memory-mode instructions, tool definitions and their schemas, submission formatting and retry logic, loop parameters including the model's effort level and thinking mode, model access method and SDK version, the sandbox image digest, and the harness code revision. Changing any component yields a new harness version. |
| De-vig method | The published consensus layer the questions come from, identified by its path and the hashes of its manifest and `methodology.json`. Initial value: `consensus/proportional/v1` (proportional normalization, median across contributing books). Changing the layer changes the baseline every question is scored against, so it must match across compared runs. |

Harness version and the agent-capabilities axis are different things. Capabilities say which tools the agent may use. Harness version says exactly how those tools, prompts, and the loop were implemented for this run. Two runs can share capabilities and differ in harness version, and that difference must be visible.

The first scored comparison varies the memory-mode axis only. The initial data-source set is coach media, play-by-play and box scores, injury reports, starting lineups, beat reporting, and consensus odds history.

## Experimental configurations

The configurations below are values of the memory-mode axis. That axis decomposes into three sub-axes, each a single flag on the same harness:

1. Horizon: stateless versus persistent. Whether the agent carries a workspace between games at all. In general a window of k games, where A is k = 0 and B is the full season; intermediate k is second tier.
2. Revision rights: editable versus append-only. Whether the agent may rewrite or delete its own notes, or only add to them.
3. Process: voluntary versus mandated reflection. Whether the postgame phase includes a required step comparing stated probabilities with outcomes, or leaves reflection to the agent.

Configurations are run as a stack, not a grid. Each scored comparison differs from the previous one by exactly one flag, and each stage runs only if the previous stage justifies it. Everything else is held fixed: source access, question sets, output contract, model roles, harness version other than the memory-mode instructions, de-vig method, and research budget.

| Stage | Comparison | Flag varied | Runs if | Why this order |
| --- | --- | --- | --- | --- |
| 1 | A versus B | Horizon | Always. This is v1. | The gate. If persistence shows no effect, nothing downstream matters and the null result is the write-up. It is also the cleanest claim: giving the agent a file it can write to did or did not improve its judgment over a season. |
| 2 | B versus B-append | Revision rights | Stage 1 shows a B-over-A effect that survives the paired bootstrap and the B replicate spread | The first design decision anyone building agent memory faces, and the one with the most legible failure mode. Either result is publishable: editing lets the agent correct itself, or editing lets it erase evidence of being wrong. It also yields the stale-belief diagnostic regardless of which arm wins. |
| 3 | B\* versus C | Process | Stage 2 complete; B\* is whichever of B or B-append scored better | The build or no-build decision with the largest engineering implication. If a bare writable workspace captures most of the benefit, teams can skip building a reflection loop. If the mandated step is where the gain comes from, that is the thing to invest in. One extra prompt per postgame. |

### v1 configurations

| Configuration | Memory-mode difference | Status |
| --- | --- | --- |
| A Stateless | Historical sources accessible; no carried interpretations, notes, or conversation memory between games | Agreed, v1 |
| B Persistent knowledge | Agent retains and freely edits its own workspace between games (persistent, editable, voluntary), including notes, scripts, fitted models, and cached results. It may reflect voluntarily during the postgame phase. | Agreed, v1 |

A and B run on the same harness code. A is B with the workspace tools disabled and a fresh empty workspace per game; it is not a separate harness or a single-shot call, since A still queries the environment within the pregame cap.

B's workspace write opportunities, Agreed: throughout pregame research and throughout the postgame phase, and never during the commit step, so the frozen submission and the workspace checkpoint are cleanly separable. Because B may already reflect voluntarily in postgame, the later C configuration tests whether a mandated, structured reflection beats voluntary reflection, not whether postgame writing helps at all.

### Replicates

A replicate is an independent repeated run with an identical manifest. Model APIs do not accept a true seed, so replicates differ only by sampling; each replicate gets its own run id and its own workspace.

Replicates matter for B and barely for A. A is stateless, so every game is an independent draw from the model and the paired bootstrap over games already captures most of its variance. B is path-dependent: a belief written early shapes every later game, so two B runs with the same manifest can diverge. Replicates are the only way to see that spread.

Policy, status Agreed:

- First scored comparison: one replicate of A and one of B. Uncertainty comes from the paired bootstrap over games. This is sufficient to see whether a signal exists.
- Before any published claim that B beats A: at least two further B replicates, so the B-over-A difference is reported against the spread between B runs. Additional A replicates are optional.
- If the first comparison shows no effect, do not add replicates. They cannot create a signal, and the null result is reportable on its own.
- The development-games pilot runs B several times while prompts are tuned and gives an early read on how far B runs diverge. Report it as a pilot observation, not evidence.

### Learning diagnostics

Applies to every configuration with a persistent workspace (B, B-append, C, B-k, and any other second-tier persistent configuration), not to A. A score alone does not establish that the agent learned; the report must connect score differences to observable changes in what the agent believed. Workspace diffs between sessions are the evidence. For each persistent run, collect and report examples of:

- Stale beliefs: a claim retained past the point where eligible evidence contradicted it.
- Useful transfer: knowledge written after one game that correctly changed a probability in a later game.
- Repeated errors: the same mistake made again after feedback that should have corrected it.

Stage 2 (B versus B-append) produces the stale-belief diagnostic whichever arm wins: under append-only, a contradicted claim stays visible next to the evidence against it; under editable, the diff shows whether the agent corrected it or erased it. For B-frozen, stale beliefs are the experiment itself rather than a diagnostic, since a frozen workspace is guaranteed to go stale.

### Sequenced follow-ups

Status Agreed. Each is one flag away from the configuration it is compared against.

| Configuration | Memory-mode difference | Compared against | What it isolates |
| --- | --- | --- | --- |
| B-append | B with the workspace append-only: the agent may add entries but never edit or delete an existing one | B | Whether restricting revision hurts (the agent cannot correct itself) or helps (the agent cannot erase being wrong). Implemented as one permission flag on the workspace write tool. |
| C Mandated reflection | B\* plus a required postgame step comparing stated probabilities with outcomes and revising the workspace, where B\* is the better-scoring of B and B-append | B\* | Whether a dedicated reflection process beats the mere possibility of reflecting. |

### Second tier

These are not scheduled. Each is listed with the reason it ranks below the stack, so that it is not reintroduced without addressing that reason.

| Configuration | Memory-mode difference | Why second tier |
| --- | --- | --- |
| B-k, k = 1 | B with a one-game memory window: the workspace carried into each game holds only what was written during the previous game. | A diagnostic of how much of B's effect comes from accumulation over the season versus the most recent game's context. Run only if B wins stage 1. Mechanically one flag: the workspace is reset to the previous game's writes at each pregame. |
| B-frozen | B's workspace checkpoint at a predeclared game, then read-only for the rest of the season. Pin the checkpoint game before the run; Proposed: the midpoint of the scored games. | A diagnostic of knowledge obsolescence, run only if B wins and only if the question of accumulation versus ongoing revision becomes load-bearing for the write-up. Cheap when run, since it starts from B's existing checkpoint. Stale beliefs are its experiment, not a side diagnostic. |
| D Independent critique | B plus a second agent, in its own model role, that scrutinizes B's workspace updates | Expensive, and its answer depends on critic quality, which would then need to be varied in turn. |
| Context versus retrieval | Whole workspace in context versus retrieved on demand | Will not bind at 82 games of notes, so the result would not generalize to the long horizons where it matters. |

### Considered and rejected

A static-dossier configuration (stateless, but every game starts from the same fixed, hand-prepared preseason dossier) was proposed to separate having background knowledge from updating it. It is rejected. The dossier's author is an uncontrolled variable, a stateless agent can already query every preseason source, and the cost of locating that information is now measured directly as a secondary metric. It mainly measures the dossier. The question it targeted is answered more cleanly by B-frozen, which uses the agent's own knowledge rather than a hand-written stand-in. Do not reintroduce it without a new argument.

### Dev and evaluation games

A sequential learner cannot have games held out mid-season. Agreed: the first 10 games of the 2025–26 regular season are development games for prompts, budgets, and tooling, and are never reported as evidence; games 11 onward (72 games) are scored. Any prompt change after scoring begins restarts the scored run. Report any reuse explicitly.

## Research budget

Structure, status Agreed. Numbers, status Open until the development pilot, chosen by the procedure below. Use a fixed token cap per phase as the primary resource budget for v1. Every run records its budget as a named, versioned budget profile (see Run profile). Report input, output, cached, and reasoning tokens separately, and report spend at a pinned price schedule alongside.

- Separate pregame and postgame caps; report their sum per game. Memory maintenance and reflection count against the postgame cap, so a memory-enabled agent gets no free compute.
- Unused postgame allowance does not roll into the next pregame.
- Sandbox compute is budgeted separately from tokens: a wall-clock limit per code call, a cumulative compute cap per phase, and a stdout cap per call so a careless print cannot consume the token budget. The compute cap is matched between configurations in the same way as the token cap: pregame matched, B's postgame additional.
- Generous tool-call and wall-clock ceilings exist as loop safeguards only. Log which limit ended each session. Tool-call count and wall-clock are never the comparison budget.

What is matched between configurations is the pregame cap. A has nothing to do in postgame because it retains nothing, so matching total tokens would hand A extra research budget equal to B's postgame allowance and change what A is. B's postgame spend is therefore additional, reported as the measured cost of memory, and the cost-adjusted comparison shows whether it paid for itself.

Reserve part of the pregame cap for the final submission. Warn the agent when the research allowance runs low, then stop research and require a complete submission from the reserve. Resubmissions draw on the reserve. Exhaustion, invalid output, and infrastructure failure get distinct recorded statuses.

Procedure for choosing the numbers, status Agreed:

1. Run the 10 development games with generous ceilings and record spend per phase, token mix, tool calls, sandbox compute seconds and stdout sizes, elapsed time, and submission validity. Pick one effort level for the pinned model during this step (Opus 4.6 accepts `low`, `medium`, `high`, `max`; default `high`) and hold it fixed across A and B. Effort is part of the harness version; it is a candidate cost lever to vary only after the main comparison.
2. Set the pregame cap at the 90th percentile of observed pregame spend, and the postgame cap for B at the 90th percentile of observed postgame spend. Set the reserve at a fixed multiple of the observed submission cost. Set the sandbox limits (per-call wall-clock, per-phase compute, stdout cap) by the same percentile rule.
3. Re-run the development games at one smaller and one larger pregame cap. Keep the cap at which submission validity and deviation behavior are stable.
4. Record the chosen numbers as budget profile v1 in the run manifest. Any later change is a new budget profile.

## Experiment record and limits on claims

Every scored claim must be reconstructible from the record alone.

- Run manifest: team, season, game list, run profile (memory mode, data sources with manifest versions, agent capabilities, model roles with pinned versions), research budget profile with its full numbers, harness version with its resolved components, de-vig method identifier, replicate id, code revision, and all policy settings including the line-selection rule version, contributing-book rule, and minimum book count.
- Session record: game, phase, cutoff, tool requests and observations (or replayable references), model outputs, token counts, errors, retries, completion status, and which limit ended the session.
- Question record: question\_id, player, stat, consensus line, market-implied probability, observation `requested_at` and `snapshot_at`, contributing books and count, each contributing book's raw two-sided prices, rejected pairs with reasons, book-update time range, identity-inference flag, line-selection and de-vig rule versions, and any exclusion reason.
- Submission record: immutable submission id, per-question probabilities and rationales, evidence references, notes, commitment timestamp, and clip events.
- Outcome record: actual stat and its source, resolution status, per-question score, scorer version; release eligibility recorded separately.
- Code execution record: every program the agent ran, with its stdout, stderr, exit status, compute seconds, and whether a limit truncated it. Programs are stored verbatim so a result can be re-derived.
- Workspace checkpoints: isolated snapshots before and after each session, with diffs available for diagnosis.

### Contamination

Temporal access control cannot remove knowledge already in model weights. Before any scored run, execute a contamination probe: ask the pinned model, with no tools, for outcomes and notable events in the replay window and record what it produces. Document the result alongside the run. A model whose cutoff is known to predate the pinned season reduces the concern but does not eliminate it. The pinned model's training data cutoff of Aug 2025 is before the regular season but after most of the 2025 offseason, so offseason roster moves may be in the weights; that is pre-season knowledge any analyst would have had and is not contamination. The probe should still ask about regular-season outcomes explicitly.

The cleanest version of this experiment is prospective: the same system with cutoff equal to now, run on a live season. The replay infrastructure is nearly identical, and a prospective run eliminates both contamination and reconstructed-snapshot concerns. Treat the replay as the development environment and keep a prospective run as the intended confirmatory study.

### Reporting

The public output should state which learning mechanisms helped or failed, what evidence supports the conclusion, what it cost in tokens, compute, and time, and what the contamination probe showed. The headline figure is market-relative skill, not money. The experiment demonstrates a method; it does not by itself establish performance in unrelated domains.

## Resolved decisions

Decisions the user has made since the brief was drafted. They are Agreed and reflected throughout the document.

| Decision | Resolution |
| --- | --- |
| Season and competition coverage | 2025–26 regular season. Playoffs, play-in, and preseason excluded. |
| Stat set | Points, rebounds, assists. No threes, PRA, steals, blocks, or minutes. |
| Cost and time in evaluation | Token cost, compute, and wall-clock time are reported as secondary metrics for every configuration and every paired comparison. |
| Run profile | Four declared axes (memory mode, data sources, agent capabilities, model roles) recorded in the manifest and printed on every report. |
| Odds visibility | Agent may query current-game line movement and prior-game movement and settlement, subject to cutoff and release rules. Consensus line and probability only; per-book and dispersion fields deferred. |
| Market definition | The published consensus layer `consensus/proportional/v1`, consumed as-is: each book votes with its main line, selected line nearest the median vote, proportional de-vig per book, median across books contributing at that line, minimum one book. Three exclusion statuses. The environment does not recompute it. |
| Data processing principle | The environment consumes pinned, hash-manifested releases as published, including derived tables, and does verification, temporal filtering, visibility projection, and ID joins only. Decided Oct 23, 2026, replacing the earlier environment-recomputes principle. |
| Source availability conventions | Odds `requested_at`; play-by-play next-morning release; injuries printed report timestamp; beat posts version publication time; lineups announcement posting time; player reference static; transcripts `published_at`, or `stream_ended_at` for livestreams. |
| Transcript availability | Closed Oct 23, 2026. The transcription maintainers added source-provenanced publication timestamps to all 134 index entries (second precision, no day-only records), identified 10 livestreams with actual end times, and republished the index at commit `cc28535292efc47316c163c6969d759875e95f86`. Verified against the index: every timestamp matches its provenance value, every livestream has an end, and no entry requires review. |
| Player reference | Added as an always-on static source, release tables only. |
| Cutoff | Scheduled start. The cutoff odds observation is the one requested at scheduled start. No actual-tip source needed. |
| Odds availability time | `requested_at`. `snapshot_at` and book update times are provenance only. |
| Thin games and inferred identity | Thin games included and scored normally. Identity-inference flag carried as provenance, never an exclusion. |
| Model | `claude-opus-4-6`. Training data cutoff Aug 2025 verified against Anthropic documentation on Oct 20, 2026. Sonnet 4.6 rejected: its training data cutoff of Jan 2026 falls inside the season. Opus 4.5 has the same cutoffs as Opus 4.6 but a 200K context window and a dated ID; it is the fallback if Opus 4.6 is retired. |
| Replicates | One replicate of A and B for the first scored comparison. At least two further B replicates before any published B-over-A claim. None if the first comparison shows no effect. |
| Did-not-play | Zero seconds on the floor in the play-by-play, whether inactive or active-but-unused. Where a game's play-by-play summaries are `partial` in the release, box-score minutes of zero is the fallback test. |
| Resolution source | The official box-score table in the play-by-play release, not play-by-play-derived summaries. |
| Play-by-play gap games | Three of the 41 gap games involve the Celtics, all with play-by-play present; one (Dec 5, 2025 vs. Lakers) is a scored game and resolves from the official box score. No exclusion policy needed. |
| Development games | First 10 games of the season. Games 11 through 82 are scored. |
| Rationale visibility | Past rationales live in the workspace. B sees its own; A sees none. Released results carry no rationales. |
| No view and deviation | No view means submitting the market probability. Deviation is abs(p − q) against the market; 0.05 is the definition for rationale and deviation statistics, 0.10 a second reporting level. |
| Resubmission allowance | Two resubmissions on validation error, drawn from the submission reserve. Third failure is a failed session with the attempt and reason recorded. |
| B write opportunities | Throughout pregame research and postgame; never during commit. |
| Budget structure | Per-phase caps, no rollover, submission reserve, ceilings as safeguards only. Pregame cap matched between A and B; B's postgame spend is reported as the cost of memory. Numbers set by the agreed pilot procedure. |
| Implementation | TypeScript on Node; direct Anthropic SDK (recorded in harness version); SQLite plus files; adapters over R2; local for Gates 1–3, AWS for scored runs with checkpoints synced to R2; in-process transport behind an MCP-wrappable interface. |
| Research budget and harness version | Both recorded on every run as named, versioned identifiers, printed with the profile, and required to match across compared runs. |
| De-vig method | The published layer `consensus/proportional/v1` (proportional normalization per book, median across contributing books), identified by manifest and methodology hashes. Recorded as a per-run descriptor and on every question record; must match across compared runs. A power or Shin layer would be a new published layer. |
| Harness | v1 is a homemade harness (hand-written loop, direct SDK). Future versions may swap in a third-party harness under the Harness contract. Workspace enforcement, sandbox lifecycle, and token metering live in the environment and runner so a swap is a new harness version, not a rebuild. |
| Code execution | A v1 capability for every configuration, run in a per-session Docker sandbox on the harness host with cutoff-filtered read-only data mounts, a session scratch directory, the workspace mounted writable in persistent configurations, no network, and a pinned image. Compute is budgeted separately from tokens; numbers set in the pilot. |
| P1a dispositions | All eight audit proposals accepted (Oct 24, 2026): injury-name alias for Yang Hansen and team-scoped disambiguation for Jaylin Williams; Dillon Jones refused pending a published exception; at/after-cutoff lineup announcements unavailable including equality; title words never imply availability; `team_absent` served as unknown; relevance labels accepted with the 17-of-50 unverifiable limitation; two transcription defects flagged upstream, text kept. No question set, cutoff, or resolution changed. |
| Configuration set | Memory mode decomposes into horizon, revision rights, and process. Run as a stack: A versus B (v1), then B versus B-append if B wins, then C against the better B variant. B-k (k = 1), B-frozen, D, and context-versus-retrieval are second tier with stated reasons. Persisting scripts is part of B, not a separate skills configuration. The static-dossier configuration is rejected. |

## Open decisions

Each must be resolved by the user before a scored run. Coding agents list the relevant ones as remaining user decisions in each project spec and do not infer them.

| Decision | Proposed starting point or required input |
| --- | --- |
| Budget numbers | Token caps, reserve, and sandbox limits (per-call wall-clock, per-phase compute, stdout cap), set by the agreed pilot procedure in Research budget and recorded as budget profile v1. Set by procedure, by design. |

## Implementation choices

Status: Agreed. These are the choices the project specs build against.

| Choice | Decision | Reason |
| --- | --- | --- |
| Language | TypeScript, Node | One language across runner, environment, harness, and evaluators. |
| Harness | v1 is a homemade harness: a hand-written tool loop over direct Anthropic SDK calls, routed through the runner's metering proxy. Harness identity, SDK name and version, and access method are part of the harness version. | Full control over the loop for v1. Because the workspace, sandbox, and metering live outside the harness (see Harness contract), a third-party harness or the Claude Agent SDK can be swapped in later as a new harness version without touching the isolation or budget guarantees. |
| Record storage | SQLite for the experiment record (events, questions, submissions, outcomes, manifests), plus files on disk for workspaces and workspace checkpoints. | Sufficient for one team and one season; the whole record is a single file plus a directory, which keeps reconstruction simple. |
| Data access | Read adapters over the pinned, hash-manifested releases in the four R2 buckets. | The data already lives there; R2 egress is free, so compute location is unconstrained. |
| Compute | Gates 1 through 3 run locally. Scored runs execute on AWS: one small always-on instance with a persistent volume (EC2 with EBS, or Fargate with EFS). Checkpoints and the SQLite record sync to R2 at every checkpoint. | The workload is a long-lived sequential loop that mostly waits on API calls and needs a real filesystem. Cloudflare Workers lack that; Modal is Python-first. Keeping artifacts in R2 puts every output next to the data. |
| Sandbox | Per-session Docker container on the harness host, from a pinned image (Python, pandas, numpy, scipy, scikit-learn). No network, read-only data mounts, writable scratch and workspace, resource limits. Image digest in the harness version. | Keeps the temporal boundary inside the environment: the container only ever holds cutoff-filtered exports. Same host means no new vendor and no data egress. The harness stays TypeScript; the sandbox language is Python because that is where the data tooling is. |
| Session transport | In-process. The environment sits behind a typed interface; the harness calls it directly. The interface is designed so it can be wrapped as an MCP server later without changing the contract. | Simplest path to Gate 1. Isolation is met by construction: the harness receives a scoped session object and no credentials. |

## Implementation projects

Seven projects, each with inputs, outputs, dependencies, and acceptance criteria. These are decomposition boundaries, not a mandate for separate repositories. Each project spec must state its remaining user decisions by reference to the Open decisions table.

### P1 Data contracts and adapters

- Inputs: the bucket guides in `docs/data-descriptions/`, the pinned releases in the datasets table, and the contract requirements above.
- Outputs: canonical ID mappings across the four buckets; a read adapter per source that fetches a pinned release, verifies every object against its manifest, and serves records with their availability time and convention; the player-reference release id pinned after reading its coverage report; a coverage diagnostic for the pinned season that reports, per Celtics game, which products are `valid` in the play-by-play release, how many injury snapshots, lineup announcements, labelled posts, and transcripts fall before the cutoff, and the consensus row counts by status.
- Depends on: nothing. Starts first.
- Acceptance: every served record carries availability time and its convention; an object whose hash does not match the manifest is refused; no adapter lists a folder to assemble a dataset; ambiguous name joins fail loudly; the coverage diagnostic reproduces the counts stated in the bucket guides for the odds layer and the beat-post snapshot.

### P1a Data quality audit

- Inputs: P1 adapters over the pinned releases; the bucket guides; the availability conventions and resolution rules above.
- Outputs: a report committed under `docs/` covering cross-bucket identity resolution for every propped Celtics player and every opponent starter; schedule agreement across the play-by-play games table, the ESPN schedule in the odds archive, and the `scheduled_start` observation; timestamp plausibility for lineups, final pregame injury reports, and pregame or postgame transcripts; resolution integrity for all 82 games including the Dec 5, 2025 fallback, with spot checks of consensus rows against `book-lines` and outcomes against a second source; content checks on samples of transcripts and labelled posts; a list of records whose availability falls within 30 minutes of a cutoff. Plus a list of proposed per-game exclusions or corrections with evidence.
- Depends on: P1. Must pass before Gate 2.
- Acceptance: every check has a result, pass or findings; any finding that changes a question set, a cutoff, or a resolution is a proposed brief change for the user, never applied unilaterally.
- Status: passed Oct 24, 2026 ([report](p1a-data-quality-audit.md)). Dispositions accepted and recorded in Resolved decisions. The I1 and I2 injury-name rules are implemented in the adapters as a P1 follow-up.

### P2 Question-set builder

- Inputs: P1 odds adapter over the pinned consensus layer; stat set.
- Outputs: a pure function from (game, consensus layer version) to the question set: the `ok` rows of the `scheduled_start` observation for the agreed stats, each as a full question record carrying the row's provenance fields; an exclusion log of the non-`ok` rows by status.
- Depends on: P1.
- Acceptance: deterministic on a pinned layer; every `ok` row for an agreed stat at the cutoff observation appears exactly once; no excluded stat appears; `p_over` and `p_under` sum to one within rounding; the layer's manifest and methodology hashes are on every question record; a non-`ok` row produces an exclusion with its status, not a question; the season total of cutoff questions matches the layer's `summary.json` (`usableBySnapshotKind.scheduled_start`), and per-game question and exclusion counts are reported in the evidence file and cross-checked against the P1 coverage diagnostic pinned to the same manifest. The published `summary.json` carries aggregate counts only, so a per-game comparison against it is not possible.
- Status: complete Oct 24, 2026 (SPO-778). 82 games, 1,779 questions, 210 exclusions on the pinned layer; the one-question Apr 12 game is included. Census at `docs/evidence/question-sets-2025-26.json`; builder notes in `docs/p2-question-sets.md`.

### P3 Replay environment

- Inputs: P1 adapters, P2 builder, temporal access rules, tool contracts, output contract.
- Outputs: scoped session objects; cutoff-filtered tool implementations; workspace tools with memory-mode enforcement (editable or append-only, phase locking, per-game reset for A); per-session dataset export (SQLite plus source files, filtered to the cutoff before mounting); sandbox lifecycle (create the container per session from the pinned image, mount the export read-only and the scratch directory and, for persistent configurations, the workspace writable, enforce limits, destroy at session end) behind the Execute code tool; submission validation and freeze; released-results tool; phase enforcement.
- Depends on: P1, P2.
- Acceptance: an adversarial fixture containing future records is unreachable by every tool path including search, counts, and pagination; a submission missing one question is rejected with the ids named; identical resubmission returns the same receipt; a submission after reveal is refused; released results appear only after the runner advances to 9 a.m.; the odds-history tool returns no observation whose `requested_at` is after the cutoff (the scheduled-start observation, requested at the cutoff itself, is eligible) and no settlement before release; the session export contains no record past the cutoff, checked against the same adversarial fixture; a future record planted on the host is invisible from inside the sandbox, and a program that attempts network access or a package install fails; an append-only workspace rejects edits and deletes; a workspace write during commit is refused.
- Status: complete Oct 24, 2026, as sub-issues SPO-786 through SPO-791 under SPO-779. Contract in `docs/p3-session-contract.md`; implementation notes in `docs/p3-session-core.md`, `docs/p3-evidence.md`, `docs/p3-submission-results.md`, `docs/p3-workspace.md`, `docs/p3-sandbox.md`.

### P4 Runner and experiment record

- Inputs: configuration schema; P3 session interface; record schema.
- Outputs: run creation and isolation; chronological scheduling; phase transitions; the metering proxy (scoped model endpoint per session that pins model and effort, counts tokens, and enforces caps); budget enforcement with warn, stop, and reserve, covering tokens and sandbox compute; checkpoint and resume; immutable event log; workspace snapshotting; manifest writing including run profile, budget profile, and harness version.
- Depends on: P3 interface (can be built against a stub).
- Acceptance: a run killed mid-game resumes without duplicating a submission; a stateless run and a persistent run share no workspace state; every session ends with one of the defined statuses and the limit that ended it; a model call that bypasses the proxy is impossible because the harness holds no direct key; the proxy's token counts match the SDK's reported usage on a fixture; the manifest reproduces a run's configuration exactly, including all four run-profile axes.
- Status: complete Oct 24, 2026 (SPO-780); notes in `docs/p4-runner.md`. Follow-up SPO-792 (checkpoint blob deduplication and orphaned-container sweep) before the pilot.

### P5 Agent harness

- Inputs: the harness contract: P3 session endpoint, P4 metered model endpoint, memory-mode instructions for A and B.
- Outputs: the v1 homemade harness: model loop; prompts; submission formatting and retry on validation error; null-baseline agents (market, naive stats, random); a harness-version identifier derived from harness identity, prompts, tool definitions, loop parameters, and code revision. Workspace enforcement, sandbox lifecycle, and token metering are not here; they are P3 and P4.
- Depends on: P3, P4.
- Acceptance: configuration A starts each game from no conversation history and, via P3, an empty workspace; B's workspace diff is captured per session; the harness holds only the three contract handles and nothing that bypasses the environment or the proxy; the three baselines run end to end on the same question sets; the contamination probe script exists and its output is stored in the run manifest; changing any prompt or tool definition changes the harness version.
- Status: complete Oct 24, 2026 (SPO-781); notes in `docs/p5-harness.md`. Effort level and budget numbers remain for the pilot.

### P6 Evaluators and reporting

- Inputs: P4 record; P1 game-data adapter; scoring definitions.
- Outputs: deterministic resolution; per-question and aggregate scores; calibration tables; matched-question comparison with paired bootstrap over games; influential-game sensitivity; per-stat, per-player, and per-game-index breakdowns; a report generator that prints the run profile, budget profile, and harness version of every run in the report and, for comparisons, the axes on which they differ, flagging any comparison across differing budgets, harness versions, or de-vig methods.
- Depends on: P1, P4.
- Acceptance: a push and a did-not-play fixture are excluded, not scored; the market baseline scores exactly zero; hand-computed scores for a five-question fixture match; the comparison drops questions unresolved in either configuration; the same scorer produces the agent's released feedback.
- Status: complete Oct 24, 2026 (SPO-782); notes in `docs/evaluation.md`. The evaluator scores market log loss minus agent log loss, matching the corrected equation above.

### Build order

P1 first. P2 and P4 in parallel once P1's odds adapter is in; P1a once P1 is complete. P3 after P2. P5 and P6 after P3 and P4. Gate 1 needs P1 through P6 on fixtures before any real adapter is connected; Gate 2 additionally needs P1a passed.

## Delivery sequence and acceptance gates

Four gates, in order. Do not start the next until the current one passes.

1. One game on fixtures. Small fixed datasets including future records that must stay hidden, on the host as well as in the adapters. All six projects wired, including the sandbox. The market baseline runs end to end and scores zero.
2. One real game. P1a audit passed; real adapters connected over the pinned releases; the question set matches the consensus layer's `scheduled_start` rows for that game; a hand check of five questions against the accepted pairs in `book-lines`; every source's coverage for that game matches the P1 diagnostic.
3. Several chronological games. Configuration B's workspace persists and diffs are captured; A's does not; a forced crash mid-game resumes without a duplicate submission; the next-morning release exposes scores and nothing later.
4. Scored comparison. Development games pinned and excluded; contamination probe stored; one replicate of A and B for the first comparison, with further B replicates before any published B-over-A claim; report generated from the record alone.

Minimum acceptance checks across all gates:

- Future evidence is unreachable by every tool path, including from inside the sandbox. The fixture is a future record planted on the host filesystem that must not be visible to a program running in the container.
- Every eligible main line appears in the question set exactly once; exclusions carry reasons.
- A submission is complete, in range, and frozen before reveal; retries are idempotent.
- Pushes and did-not-play questions are excluded, never scored as losses.
- Stateless and persistent runs share no private memory.
- Failed sessions, exclusions, and unresolved questions remain visible in every report.
