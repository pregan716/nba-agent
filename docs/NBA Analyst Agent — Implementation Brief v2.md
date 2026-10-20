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

## Scope and design principles

One team, one season, chronological replay, a stateless baseline against one persistent-knowledge intervention. Multi-team knowledge sharing and agent organizations are later extensions.

| Area | Baseline | Status |
| --- | --- | --- |
| Team | Boston Celtics | Agreed |
| Season | Pin in run configuration; regular season only unless stated | Open |
| Agent task | For each main-line prop question on the game's rotation, state P(over). 50% means no view. | Agreed |
| Primary score | Log-loss improvement over the market-implied probability, averaged across questions | Agreed |
| Learning scope | Research and knowledge updates may cover anything eligible, not only the questions answered | Agreed |
| Core boundary | All external observations and binding actions go through the environment. Each run owns isolated agent memory. | Agreed |
| Ingestion | Odds, press conferences, beat reporting, and play-by-play live in separate repos | Agreed |
| Replay timing | Pregame cutoff immediately before actual tip. Postgame release at 9 a.m. America/New\_York the following morning. | Agreed |
| Model | Claude Opus 4.6 preferred for its believed pre-season cutoff. Verify identity, cutoff documentation, and pricing before execution; pin the version. | Agreed, verify |
| Evidence judge | Not in v1. May return as a varied capability in a later configuration. | Agreed |

### Guard against unnecessary process

Previous attempts became overly constrained. Specify access rules, the output contract, scoring, and the differences between configurations rigorously. Leave the agent free to choose its research process and how it organizes its knowledge. Do not require a claims ontology, a research checklist, or a projection model. The output contract below is deliberately minimal: a probability and a short rationale per question, nothing that forces the agent to model players it has no view on.

### Why the market line stays

The line is the question, not a betting instrument. It does two jobs nothing else does cheaply: every question is hard by construction because the market centered it, and the price supplies a competent baseline probability. Scoring against the market answers the real question: does the agent know something the market does not.

## The task

Each game, the environment constructs a question set from the frozen pregame odds snapshot. The agent returns one probability per question. Missing questions and malformed submissions are handled by explicit rules, never by inference.

### Question set construction

A question is one (player, stat, line) tuple. The environment builds the set as follows:

1. Take the odds snapshot at the pregame cutoff from the configured reference book (Proposed: one reference book, with an ordered fallback list for props it does not offer; Open: which book).
2. For each Celtics player and each eligible stat, select the book's main line. Proposed: the line whose two sides have the smallest absolute price gap; ties broken by the line closest to the player's eligible season-to-date mean. Record the rule version.
3. Compute the market-implied P(over) by de-vigging the two sides. Proposed: proportional normalization, p\_over = (1/d\_over) / (1/d\_over + 1/d\_under). Open: whether to use a power or Shin method instead; the choice matters at the tails and must be pinned.
4. Exclude questions where either side is missing, suspended, or stale beyond the configured threshold. Record exclusions with reasons.

The rotation is defined by the market: a player is in the set if the reference book offers at least one eligible main line for them at the cutoff. Proposed stat set: points, rebounds, assists, three-pointers made. Open: whether to add PRA, steals, blocks, or minutes if offered.

Typical size is 20 to 35 questions per game. Lines are usually half-integers; an integer line is retained and pushes are excluded at scoring.

### Agent output contract

One atomic submission per game, frozen before any postgame information is accessible. Proposed schema:

| Field | Rule |
| --- | --- |
| question\_id | Must match an id in the issued set |
| p\_over | Float in \[0.01, 0.99\]. 0.50 means no view. Values outside the range are clipped and the clip is logged. |
| rationale | Short free text. Required when abs(p\_over − 0.50) ≥ 0.05; may be empty otherwise. |
| evidence\_refs | Optional list of source record ids the rationale relies on |

Plus an optional free-text notes field for the whole submission, stored and never scored. The agent may write anything it likes there: theses about usage, flags on unbet players, questions for itself.

A submission that omits a question is incomplete. Proposed: the harness returns a validation error naming the missing ids and allows up to two resubmissions within the remaining budget; if still incomplete, the session is recorded as failed and excluded from scoring with its status visible. Do not fill missing questions with 0.50 silently. Repeated delivery of an identical valid submission must not create a second record.

### What the agent is not asked to do

It is not asked to produce a projection for every player, to answer alternate lines, to size anything, or to form a view where it has none. Stating 0.50 is free and expected to be the majority answer for an honest agent. The design rewards selective, well-founded deviation.

## Scoring

The primary score is the agent's mean log-loss improvement over the market across all resolved questions. A positive value means the agent's probabilities carried information the market's did not. One deterministic scoring implementation lives in the evaluation layer; the environment exposes results only when the runner's phase policy permits, and agent feedback uses the same code.

### Resolution

For each question, the actual stat comes from the game-data repository. Outcome y = 1 if actual > line, 0 if actual < line.

| Case | Handling |
| --- | --- |
| actual = line (push) | Excluded from scoring; counted and reported |
| Player did not play | Excluded; counted and reported. Proposed: did-not-play means zero seconds in the play-by-play. |
| Player played any minutes | Resolved normally, including early exits |
| Game postponed or cancelled | Session voided; questions carried to the rescheduled date are rebuilt from that date's snapshot |
| Missing or conflicting stat source | Unresolved, never scored as a loss; flagged for manual review |

### Per-question score

```latex
\mathrm{skill}_i = \big[\,y_i \log q_i + (1-y_i)\log(1-q_i)\,\big] - \big[\,y_i \log p_i + (1-y_i)\log(1-p_i)\,\big]
```

where p\_i is the agent's P(over) and q\_i is the market-implied P(over). Lower log loss is better, so a positive skill means the agent beat the market on that question. A 0.50 answer scores approximately zero against a market near 0.50; it is neither rewarded nor punished.

### Reported alongside the primary score

- Brier-score improvement over market, same construction.
- Deviation count and rate: questions where abs(p − 0.50) ≥ 0.10 (Proposed threshold).
- Hit rate on deviations: fraction where the agent's side was correct.
- Calibration table in deciles of stated probability.
- Breakdown by stat, by player, and by game index (first third, middle, last third of the season).
- Failed sessions, exclusions, and unresolved questions, each with reason.

### Comparison between configurations

Compare on matched questions only: a question scored for one configuration but excluded for another is dropped from the paired comparison. Questions within a game are correlated (shared injury news, blowouts, pace), so treat the game as the unit for uncertainty. Proposed: a paired bootstrap over games, reporting the 90% interval on the primary score difference. Report sensitivity to the five most influential games. Run each configuration with at least three seeds and report within-configuration variance; a between-configuration difference smaller than within-configuration spread is not a finding.

A learning curve is a score that rises with game index for the persistent configuration and not for the stateless one, on the same games. Schedule difficulty and market efficiency change through a season, so the stateless baseline on the same games is the control, not the persistent agent's own early games.

### Null baselines

Run these on the same question sets so the stateless LLM's score has a reference:

- Market: p = q for every question. Scores exactly zero by construction.
- Naive stats: p from the player's eligible season-to-date distribution for that stat, via a documented simple model.
- Random deviation: p drawn uniformly from \[0.35, 0.65\]. Establishes the cost of noise.

If the stateless agent does not beat naive stats, that is reportable on its own.

## System architecture and module ownership

Five logical modules in one core repository, plus external ingestion repositories. These are ownership boundaries, not a requirement for separate deployed services. The environment controls the observable world and legal actions; the harness controls the agent's reasoning loop and workspace; the runner controls the experiment; evaluators measure frozen records.

| Component | Owns | Does not own |
| --- | --- | --- |
| External ingestion | Collecting, normalizing, and preserving source records with provenance | Run-specific access rules or agent interpretations |
| Runner | Configuration, schedules, budgets, run isolation, checkpoints, controlled clock advancement | Basketball reasoning or source ingestion |
| Environment | Read adapters, temporal filtering, question-set construction, submission validation, frozen submissions, released outcomes | Agent research strategy or memory contents |
| Agent harness | Model and tool loop, prompts, workspace access, memory persistence and reflection modes | Authority to reveal future sources or change the output contract |
| Evaluators | Resolution, scoring, baselines, calibration, matched comparisons, reports | Changing frozen submissions or unrestricted feedback to the agent |
| Experiment record | Immutable events, source references, configurations, workspace checkpoints | A shared memory accessible to every agent |

### Source archive versus agent memory

The source archive holds timestamped evidence any configuration can query under identical rules. Agent memory holds interpretations, hypotheses, lessons, and procedures produced by one run. A stateless agent can query historical sources but must not inherit prior conversation state, private notes, generated summaries, or caches containing its earlier analysis. The operational audit log is not an agent-visible tool.

### Control and data flow

&#91;embedded content: control and data flow · one game\]

The runner creates a run and sets the phase and cutoff. The harness invokes the agent with the permitted tools and workspace. The environment reads pinned datasets, filters them to the cutoff, and returns observations; the agent submits its probabilities through the environment, which validates and freezes them. The runner then advances time; evaluators score the frozen record against game data, and the environment releases scores and postgame observations at the next-morning release. The harness carries forward or resets memory according to the configuration.

## Data contracts and temporal access rules

The environment consumes ingestion datasets through read adapters and does not duplicate their pipelines. Before integration, inspect representative records and schemas from each repository; the contents below are required semantics, not claims about existing implementations.

| Dataset | Required contents |
| --- | --- |
| Odds | Timestamped quotes per book, player, stat, line, and side, with market definition. Main-line and implied-probability derivation happen in the environment, not ingestion. |
| Coach media | Recording identity, publication time, transcript, speaker labels where available, references to recording segments |
| Beat reporting | Original posts or articles, author, publication time, source links, edit and version metadata where available |
| Injuries and schedule | Timestamped availability reports, game identities, actual tip times, schedule changes. Repository ownership is Open. |
| Game data | Raw events, substitutions, player and lineup stints, opponent on-floor context, box-score stats per player per game |

### Shared contract requirements

- Stable canonical game, team, and player IDs with explicit mappings from provider IDs. Never join on ambiguous names.
- Stable source and record IDs, schema versions, provenance, and immutable dataset manifests or equivalent snapshots.
- Separate event time, public availability time, collection time, and revision time. Define timezone and precision. Each record carries a documented eligibility timestamp and the reason it was assigned.
- Preserve corrections and revisions where available. If history cannot be reconstructed, document the limitation and apply a predetermined exclusion or approximation policy.

### Odds data: the critical dependency

The design needs, at minimum, one book's main line and both prices for each rotation player and stat at a snapshot close to tip. Audit the odds repository first and report: snapshot cadence, how close the last pregame snapshot typically falls to actual tip, which books and stats are covered, and whether lines can be observed moving within the final hour. If snapshots are sparse, define the cutoff as the last snapshot before tip and report snapshot staleness as a per-question statistic. Do not interpolate between snapshots.

### Temporal access rules

Apply the cutoff to every access path: search, direct fetch, metadata, aggregates, snippets, derived views, and pagination. A query for a future record must not expose its title, existence, count, or contents. Derived statistics use only eligible observations. Agent requests cannot override the session cutoff, run identity, or dataset version.

An old recording transcribed today represents information available at its publication, provided the transformation uses only that recording. A retrospective article written today cannot be backdated. For completed games, define explicitly when results and derived views become available; reconstructed data is not necessarily a faithful snapshot of contemporary corrections.

### Game data scope already requested

Play-by-play collection covers all teams and games for the 2024–25 and 2025–26 seasons. Clarify competition coverage in the ingestion contract. Early replay games may use prior-season data if eligible under the cutoff. Opponent substitutions can occur inside an own-team lineup stint, so opponent-context queries need event-level segments.

## Replay lifecycle and environment tool surface

One game runs through five phases. The runner requests transitions; the environment enforces their validity. The agent cannot advance time.

1. Initialize: validate configuration and dataset coverage; create the isolated run, workspace, and record; select the first game.
2. Pregame: freeze the cutoff immediately before actual tip and build the question set from the snapshot at that cutoff. Allow research using only eligible information. Enforce the research budget.
3. Commit: validate and freeze one complete submission. Return a stable receipt. Identical resubmission is idempotent.
4. Postgame: advance the clock to 9 a.m. America/New\_York on the calendar morning after the game date. Release eligible game observations, per-question outcomes and scores, and run reflection if the configuration enables it.
5. Checkpoint: record workspace version, costs, events, and completion status; advance to the next game.

Final submissions remain frozen through retries, crashes, and later evaluation. A missing or invalid submission is a failed session with an explicit status, never a valid set of 0.50 answers. Pregame research runs against frozen simulated time; wall-clock does not move the cutoff. Use records strictly before actual tip; if actual tip cannot be established, apply a documented fallback (Proposed: scheduled tip minus 5 minutes, flagged). News published after 9 a.m. remains unavailable at that release.

### Environment tools

These are capability contracts, not final API names.

| Capability | Expected behavior |
| --- | --- |
| Session context | Return team, game, opponent, phase, cutoff, budget remaining, and dataset versions |
| Search and fetch evidence | Search eligible media; retrieve stable source records with provenance and citations |
| Query game history | Retrieve eligible events, stints, lineup context, and box-score aggregates with explicit definitions |
| Read injuries and schedule | Return eligible status reports and schedule information with timestamps |
| List questions | Return the frozen question set for the current game: question\_id, player, stat, line, and market-implied P(over). Complete, no pagination needed at this size. |
| Submit | Validate completeness, ids, and ranges; atomically freeze; return a receipt |
| Read released results | Expose, at the next-morning release, eligible game observations and each prior question's outcome, agent probability, market probability, and per-question score |

Whether the agent sees the market-implied probability alongside each question is Agreed: yes. It is part of the question, and hiding it would turn the task into reconstructing the market rather than beating it.

Workspace read and write belong to the harness, not the environment. The experiment record separately captures tool calls, responses or replayable references, errors, submissions, and workspace checkpoints.

### Isolation and reproducibility

Enforce session identity and cutoff outside the model prompt, with a scoped token or trusted session object. Agents have no unrestricted internet or storage credentials. Optional code execution operates only on permitted exports and the isolated workspace, with no path to future data. Pin code revision, configuration, prompts, model identifiers, tool versions, and dataset manifests. Capture observations or immutable references sufficient to reconstruct them; model text may still vary between runs.

## Experimental configurations and research budget

The first scored comparison is A versus B. Everything else is held fixed: source access, question sets, output contract, model, prompts other than the memory instructions, and total token budget.

| Configuration | Capability difference | Status |
| --- | --- | --- |
| A Stateless | Historical sources accessible; no carried interpretations, notes, or conversation memory between games | Agreed, v1 |
| B Persistent knowledge | Agent retains and freely edits its own workspace between games. It may reflect voluntarily during the postgame phase. | Agreed, v1 |
| A′ Static dossier | Stateless, but every game starts with the same fixed preseason dossier the agent cannot edit. Separates having background knowledge from updating it. | Proposed, v1 if cheap |
| B-frozen | Workspace written through game k, then read-only. Separates accumulation from ongoing revision. | Proposed, second experiment |
| C Explicit reflection | B plus a mandated postgame step comparing stated probabilities with outcomes and revising the workspace | Later |
| D Independent critique | Adds a second agent that scrutinizes B's workspace updates | Later |

Define for B exactly when it gets workspace write opportunities (Proposed: throughout pregame research and throughout the postgame phase). C then tests a dedicated reflection process, not the mere possibility of thinking about results.

Run each v1 configuration with at least three seeds. Save examples of stale beliefs, useful transfer, and repeated errors from B's workspace diffs to connect score changes to observable learning behavior.

### Dev and evaluation games

A sequential learner cannot have games held out mid-season. Proposed: the first 12 games of the pinned season are development games for prompts, budgets, and tooling, and are never reported as evidence; games 13 onward are scored. Any prompt change after scoring begins restarts the scored run. Report any reuse explicitly.

### Research budget

Status: Proposed. Use a fixed token cap per phase as the primary resource budget for v1, matched across configurations. Report input, output, cached, and reasoning tokens separately, and report spend at a pinned price schedule alongside.

- Separate pregame and postgame caps; report their sum per game. Memory maintenance and reflection count against the postgame cap, so a memory-enabled agent gets no free compute.
- Predeclare whether unused postgame allowance can roll into the next pregame. Proposed: no.
- Add generous tool-call and wall-clock ceilings as loop safeguards. Log which limit ended each session.
- Do not use tool-call count or wall-clock as the comparison budget.

Reserve part of the pregame cap for the final submission. Warn the agent when the research allowance runs low, then stop research and require a complete submission from the reserve. Exhaustion, invalid output, and infrastructure failure get distinct recorded statuses.

To choose the numbers, pilot the development games with generous ceilings and record spend, token mix, calls, elapsed time, and output validity. Test a smaller and a larger allowance if the agent appears constrained. No numerical budget is agreed in this brief.

## Experiment record and limits on claims

Every scored claim must be reconstructible from the record alone.

- Run manifest: team, season, game list, configuration, seed, model and prompt versions, code revision, dataset manifests, budgets, and all policy settings including the main-line rule and de-vig method versions.
- Session record: game, phase, cutoff, tool requests and observations (or replayable references), model outputs, token counts, errors, retries, completion status, and which limit ended the session.
- Question record: question\_id, player, stat, line, both prices, book, quote timestamp, snapshot staleness, market-implied probability, construction rule version, and any exclusion reason.
- Submission record: immutable submission id, per-question probabilities and rationales, evidence references, notes, commitment timestamp, and clip events.
- Outcome record: actual stat and its source, resolution status, per-question score, scorer version; release eligibility recorded separately.
- Workspace checkpoints: isolated snapshots before and after each session, with diffs available for diagnosis.

### Contamination

Temporal access control cannot remove knowledge already in model weights. Before any scored run, execute a contamination probe: ask the pinned model, with no tools, for outcomes and notable events in the replay window and record what it produces. Document the result alongside the run. A model whose cutoff is known to predate the pinned season reduces the concern but does not eliminate it.

The cleanest version of this experiment is prospective: the same system with cutoff equal to now, run on a live season. The replay infrastructure is nearly identical, and a prospective run eliminates both contamination and reconstructed-snapshot concerns. Treat the replay as the development environment and keep a prospective run as the intended confirmatory study.

### Reporting

The public output should state which learning mechanisms helped or failed, what evidence supports the conclusion, what it cost, and what the contamination probe showed. The headline figure is market-relative skill, not money. The experiment demonstrates a method; it does not by itself establish performance in unrelated domains.

## Open decisions

Each must be resolved by the user before a scored run. Coding agents list the relevant ones as remaining user decisions in each project spec and do not infer them.

| Decision | Proposed starting point or required input |
| --- | --- |
| Season and competition coverage | Celtics fixed. Pin the season; regular season only unless stated. |
| Reference book and fallback order | Depends on the odds audit. Prefer the book with the most complete prop coverage and densest snapshots. |
| Stat set | Points, rebounds, assists, threes. Decide on PRA, steals, blocks, minutes. |
| Main-line rule | Smallest price gap, tie to nearest season mean. Confirm or replace. |
| De-vig method | Proportional. Decide whether power or Shin is worth the complexity. |
| Quote staleness threshold | Set after the odds audit reports snapshot cadence. |
| Actual tip source and fallback | Establish a source for actual tip times; fallback is scheduled minus 5 minutes, flagged. |
| Did-not-play definition | Zero seconds in play-by-play. Confirm handling of players listed but inactive. |
| Deviation threshold | 0.10 for reported deviation statistics. |
| Dev game count | First 12 games. |
| Token caps and ceilings | Choose after the development pilot. |
| Resubmission allowance | Two resubmissions on validation error. |
| B write opportunities | Throughout pregame and postgame. |
| A′ inclusion in v1 | Include if the dossier can be built from preseason sources with under a day of effort. |
| Rationale visibility to future runs | Whether B's released results include its own past rationales (yes, they are its workspace) and whether A sees any (no). Confirm. |
| Implementation choices | Language, storage, session transport, and deployment, after contracts are clear. |

## Implementation projects

Six projects, each with inputs, outputs, dependencies, and acceptance criteria. These are decomposition boundaries, not a mandate for separate repositories. Each project spec must state its remaining user decisions by reference to the Open decisions table.

### P1 Data contracts and adapters

- Inputs: the ingestion repositories (odds, coach media, beat reporting, play-by-play), sample records, and the contract requirements above.
- Outputs: canonical ID mappings; a read-adapter interface per dataset; dataset manifests; an odds audit report covering snapshot cadence, book and stat coverage, and distance from last snapshot to tip; a coverage diagnostic for the pinned season.
- Depends on: nothing. Starts first.
- Acceptance: every record carries event, availability, collection, and revision time; adapters resolve any eligibility query without touching ingestion pipelines; the odds audit answers whether the main-line contract is satisfiable and at what staleness; ambiguous name joins fail loudly.

### P2 Question-set builder

- Inputs: P1 odds adapter; main-line rule; de-vig method; staleness threshold; stat set.
- Outputs: a pure function from (snapshot, rules version) to a question set with full question records; exclusion log.
- Depends on: P1.
- Acceptance: deterministic on fixed fixtures; every rotation player with an eligible main line appears exactly once per stat; implied probabilities sum to one per question; rule version is recorded; a fixture with a suspended side produces an exclusion, not a question.

### P3 Replay environment

- Inputs: P1 adapters, P2 builder, temporal access rules, tool contracts, output contract.
- Outputs: scoped session objects; cutoff-filtered tool implementations; submission validation and freeze; released-results tool; phase enforcement.
- Depends on: P1, P2.
- Acceptance: an adversarial fixture containing future records is unreachable by every tool path including search, counts, and pagination; a submission missing one question is rejected with the ids named; identical resubmission returns the same receipt; a submission after reveal is refused; released results appear only after the runner advances to 9 a.m.

### P4 Runner and experiment record

- Inputs: configuration schema; P3 session interface; record schema.
- Outputs: run creation and isolation; chronological scheduling; phase transitions; budget enforcement with warn, stop, and reserve; checkpoint and resume; immutable event log; workspace snapshotting.
- Depends on: P3 interface (can be built against a stub).
- Acceptance: a run killed mid-game resumes without duplicating a submission; a stateless run and a persistent run share no workspace state; every session ends with one of the defined statuses and the limit that ended it; the manifest reproduces a run's configuration exactly.

### P5 Agent harness

- Inputs: P3 tools, P4 workspace and budget hooks, model configuration, memory-mode specification for A, B, and A′.
- Outputs: model loop; prompts; workspace read and write; persistence and reset per configuration; submission formatting and retry on validation error; null-baseline agents (market, naive stats, random).
- Depends on: P3, P4.
- Acceptance: configuration A starts each game from an empty workspace and no conversation history; B's workspace diff is captured per session; the agent never holds credentials or paths that bypass the environment; the three baselines run end to end on the same question sets; the contamination probe script exists and its output is stored in the run manifest.

### P6 Evaluators and reporting

- Inputs: P4 record; P1 game-data adapter; scoring definitions.
- Outputs: deterministic resolution; per-question and aggregate scores; calibration tables; matched-question comparison with paired bootstrap over games; influential-game sensitivity; per-stat, per-player, and per-game-index breakdowns; a report generator.
- Depends on: P1, P4.
- Acceptance: a push and a did-not-play fixture are excluded, not scored; the market baseline scores exactly zero; hand-computed scores for a five-question fixture match; the comparison drops questions unresolved in either configuration; the same scorer produces the agent's released feedback.

### Build order

P1 first. P2 and P4 in parallel once P1's odds audit is in. P3 after P2. P5 and P6 after P3 and P4. The one-game end-to-end gate below needs all six on fixtures before any real adapter is connected.

## Delivery sequence and acceptance gates

Four gates, in order. Do not start the next until the current one passes.

1. One game on fixtures. Small fixed datasets including future records that must stay hidden. All six projects wired. The market baseline runs end to end and scores zero.
2. One real game. Real adapters connected; the odds audit's staleness numbers confirmed on a live snapshot; a hand check of five questions against the book's displayed lines.
3. Several chronological games. Configuration B's workspace persists and diffs are captured; A's does not; a forced crash mid-game resumes without a duplicate submission; the next-morning release exposes scores and nothing later.
4. Scored comparison. Development games pinned and excluded; contamination probe stored; three seeds per configuration; report generated from the record alone.

Minimum acceptance checks across all gates:

- Future evidence is unreachable by every tool path.
- Every eligible main line appears in the question set exactly once; exclusions carry reasons.
- A submission is complete, in range, and frozen before reveal; retries are idempotent.
- Pushes and did-not-play questions are excluded, never scored as losses.
- Stateless and persistent runs share no private memory.
- Failed sessions, exclusions, and unresolved questions remain visible in every report.
