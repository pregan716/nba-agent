# NBA Coaching Policy Agent — Implementation Brief v3

Nov 4, 2026 · @Patrick Regan · Draft for review (SPO-836)

## Purpose and research question

Build a chronological NBA replay system that tests which kinds of accumulated knowledge help an autonomous research agent get better at a specialised job over repeated episodes. The job is to encode the Boston Celtics head coach's substitution tendencies into a decision policy. Before every game the research agent studies the team from time-restricted sources and writes a frozen policy package: prompt components plus deterministic assembly code. During a replay of the real game, at every substitution-eligible window, the assembly code builds a prompt from the observable game state and a fast, inexpensive decision model ("Jev") predicts whether the coach substituted and who came in and out. The predictions are scored against what the coach actually did. After the game the research agent sees a detailed trace of how its package performed and may reflect.

The central question is not whether an elaborate policy prompt beats a plain one. It is whether, and which kinds of, knowledge preserved between games improve the next game's predictions: coach-specific knowledge, procedural knowledge about how to do the research and build the package, or executable skills. The primary experimental manipulation is what the agent may keep between games. Everything else is held constant.

The agent predicts what the coach would do, not what the coach should do. The main outcome is out-of-sample substitution-prediction quality. A later experiment asks whether a learned policy improves player-minutes distributions and rotation realism in full-game simulation.

A good score alone does not establish that an agent learned. Findings must connect score differences to what the agent kept, and negative results are valuable when the comparison and diagnosis are sound.

## How to use this brief

Agreed items are requirements. Proposed items are recommended defaults for the first implementation, not approved decisions. Open items must be resolved explicitly before a scored experiment. Coding agents must preserve these distinctions when writing project specs and issues, and must not silently infer an Open item.

| Status | Meaning |
| --- | --- |
| Agreed | Explicit user choice, or established architecture and task scope |
| Proposed | Concrete default offered for review |
| Open | Unresolved choice that must not be inferred |

This brief supersedes the v2 player-prop brief, archived at [`docs/archive/v1-props/`](archive/v1-props/README.md), and the research proposal it was built from, archived at [`docs/archive/v2_agent_spec.md`](archive/v2_agent_spec.md). Decisions carried over from the v2 brief are marked "carried" and are not relitigated here; the v2 brief remains the record of why they were made.

### What changed from the v2 brief

The v2 brief asked an analyst agent to state P(over) for every market-priced player prop and scored it against the consensus market. Four development-games pilots ran on it. The last, pilot-b-4, scored positively but showed the agent's method drifting from a projection model to small-sample hit rates and its workspace becoming a tout sheet. The task rewarded selective deviation from a strong baseline, which is a hard place to see learning. The v3 task replaces it:

- The question changes from "beat the market on prop probabilities" to "predict the coach's substitutions". There is no market baseline; the baselines are a conventional statistical predictor and a generic Jev prompt.
- The agent's deliverable changes from a probability per question to a frozen policy package: prompt components and deterministic assembly code that a second model executes hundreds of times per game.
- The memory axis changes from horizon, revision rights and process to three gated categories: coach profile, best-practices document, custom skills. The first comparison is a 2 × 2 on the first two.
- A second model role, Jev, is added and pinned.
- The odds consensus is no longer the question source. The odds adapters stay in the repo; whether the game spread is exposed as pregame context is Open.

What carries over unchanged in intent: the data contracts and pinned releases, the availability conventions, the scheduled-start cutoff and strict-before rule, the next-morning release, the isolation requirements, the metering proxy, the per-session sandbox, the experiment record, the contamination probe, the development-games rule and the per-run descriptor discipline. SPO-835 removed the prop-task code and kept this infrastructure.

## Scope and design principles

| Area | Value | Status |
| --- | --- | --- |
| Team | Boston Celtics | Agreed, carried |
| Season | 2025–26 regular season. Playoffs, play-in and preseason excluded. 2024–25 games are historical evidence from the start of the replay. | Agreed, carried |
| Research agent task | Before each game, research and freeze a policy package (prompt components, deterministic assembly code, configuration) for Jev. After each game, review the replay trace and, where the variant permits, update persistent memory. | Agreed |
| Decision task | At each eligible window in a replay of the real game, Jev predicts whether the Celtics substituted and, conditional on a substitution, who exited and who entered. | Agreed |
| Primary scores | Substitution timing: Brier score of P(any substitution) over all eligible windows. Player selection: conditional entry and exit probability scores at windows where the coach substituted. Reported separately, never combined into one number. | Agreed |
| Secondary metrics | Exact and partial action match, false-positive substitution rate, breakdowns by period, score margin, foul state and availability, invalid outputs, Jev latency, research tokens and compute, skill and runtime cost, memory token footprint, wall-clock per phase | Agreed |
| Learning scope | Research and knowledge updates may cover anything eligible, not only what the trace flagged | Agreed, carried |
| Core boundary | All external observations and binding actions go through the environment. Each run owns isolated agent memory. The research agent never touches the replay engine or Jev directly. | Agreed, carried |
| Replay timing | Pregame cutoff at scheduled tip. Postgame release at 9 a.m. America/New_York the following morning. | Agreed, carried |
| Research-agent model | Pinned per role. v2 pinned `claude-opus-4-6` because its training data cutoff (Aug 2025) precedes the Oct 21, 2025 opener. The constraint still applies; see Open decisions. | Open |
| Jev model | A fast, inexpensive model whose training cutoff precedes the season. See Open decisions. | Open |
| Evidence judge | Not in v3 | Agreed, carried |

### Guard against unnecessary process

Specify the access rules, the package contract, the Jev contract, the scoring and the differences between variants rigorously. Leave the research agent free to choose its research process, how it writes components and code, and how it organises what it keeps. Do not force a coach-profile schema, a research checklist or a feature list. The first stage tests memory permissions, not representations; representation is a second-stage question.

### Naming

"Jev" is also the name of the relevance-labelling model recorded in the beat-reporting bucket's label policy (Jev 1.14.0, see the sports-text data description). The two are unrelated. In this brief and in code, "Jev" means the decision model role. Where the label policy is meant, write "the relevance labeller".

## The task

### Decision windows

Status: Proposed, pending the feasibility spike SPO-837. The spike reports what the pinned play-by-play release can reconstruct and proposes the definition below in terms of release fields; its findings may amend this section.

A decision window is a moment in a real Celtics game at which the coach could have substituted. The decision dataset contains every reliably identifiable window, including the majority where no substitution occurred. Proposed definition:

- A window opens at every dead-ball stoppage: foul, timeout, out-of-bounds, violation, free-throw sequence, replay review, and each period boundary. Live-ball moments are not windows.
- Simultaneous substitutions in one stoppage are one decision. Opponent substitutions in the same stoppage are context, and only those that precede the Celtics decision in canonical event order are observable.
- Period-boundary lineup changes are windows tagged `between_periods` and are reported separately from in-period windows.
- A window whose state cannot be reconstructed (unknown lineup, unrepaired event order, a stint that does not reconcile) is flagged with a reason and excluded from scoring, never silently dropped.
- The actual decision is one of: no substitution; or a set of players out and an equal-sized set of players in.

The three Celtics gap games in the releases (`0022400061`, `0022400230`, `0022500338`) are handled as the spike reports; the first two are 2024–25 historical evidence only.

### Observable state

Status: Proposed. The state handed to the assembler at a window contains only what was observable before the decision. It is a typed, versioned schema (`state-v1`) and the version is part of the harness version.

| Group | Fields |
| --- | --- |
| Clock and score | period, period type, clock remaining, home and away score, score margin from the Celtics' side |
| Stoppage | stoppage type, whether a timeout was called and by whom, whether free throws are pending |
| Lineups | the Celtics five and the opponent five on the floor before the decision |
| Eligible bench | Celtics roster minus on-court minus players ruled out in the last pregame injury report minus players fouled out or ejected |
| Per player (Celtics) | minutes so far, current stint length, game-clock rest since last exit, personal fouls, box-score line so far |
| History in this game | all prior Celtics substitutions with their windows; opponent substitutions observable before this decision; prior timeouts |
| Pregame context | the frozen pregame injury statuses and announced starters, as the agent saw them |

The actual decision and anything after the window are held outside the state object; the assembler cannot receive them by construction. Nothing from the eligible bench's future (whether a player later entered) is in the state.

### Policy package

Status: Agreed in shape; Proposed in detail. Before the cutoff the research agent writes one package per game and freezes it through the environment. A package has:

- **Components**: text files the assembler may select from. Instructions, examples, rotation expectations, player roles, matchup notes, exceptions. Free-form.
- **Assembly code**: one Python entry point, `assemble(state) -> {prompt, diagnostics}`, that reads the observable state, derives whatever features it wants, selects and orders components, and returns the prompt Jev receives plus a diagnostics object naming the components used and the features computed.
- **Manifest**: component list with hashes, the state schema version it targets, and free-text notes.

Freezing is atomic and happens before the cutoff; the frozen package is what the replay uses, and a later write to the package directory for that game is refused. A package that fails to load, or whose entry point raises on the first window, is a failed session with status `invalid_package`; the game is replayed with no predictions and reported as such. The package directory for each game is retained for audit and is never automatically visible to the next game's research agent; what the agent may carry forward is governed by the memory permissions below.

The assembler is deterministic and sandboxed: no network, no model calls, no file writes outside a scratch directory, no access to the workspace during replay, and a per-window compute limit. Given the same package and state it returns the same prompt. It must not produce the substitution decision itself; Jev is the decision maker. An assembler that returns a prompt instructing Jev to copy a hard-coded answer is within the rules, since Jev still decides, and the trace shows what was done.

### Jev prediction contract

Status: Agreed in shape; schema details Proposed. Jev receives the assembled prompt and returns one JSON object:

```text
{
  p_any_substitution: float in [0, 1],
  p_exit_by_player: { player_id: float },     // conditional on a substitution; Celtics players on the floor
  p_entry_by_player: { player_id: float },    // conditional on a substitution; eligible bench
  proposed_action: { players_out: [player_id], players_in: [player_id] }   // empty lists mean no substitution
}
```

The environment validates every output: probabilities in range, players exist and are eligible for their list, `players_out` and `players_in` have equal length, and the resulting five is legal. An invalid output is recorded with its reason and scored by the documented rule in Scoring; it is never repaired. Entry and exit probabilities are marginal scores over players, not a joint distribution over multi-player actions.

Jev's model, output schema, inference settings (effort, thinking, max tokens, structured output), state schema and validation rules are identical across every variant in a comparison. They are part of the harness version. Jev receives nothing but the assembled prompt; it has no tools and no memory between windows.

### Replay

For each window in canonical order, the environment builds the observable state from the real game, calls the frozen assembler, sends the prompt to Jev through the metering proxy, validates and records the output, and scores it against the actual decision. The next window is built from the real historical state, not from Jev's proposal; earlier hypothetical substitutions never alter later states. Replay is a trusted environment process; the research agent is not running during it.

### Feedback trace

Status: Agreed in shape; fields Proposed. After replay and scoring, the environment releases the game's trace at the next-morning release. The trace is the same for every variant and contains, per window: the state summary, the diagnostics the assembler returned (components selected, features computed), the assembled prompt, Jev's raw output and its validation result, the actual decision, and the per-window scores. Per game it contains the aggregate scores, the invalid-output count and reasons, failure categories, Jev latency and the package manifest hashes.

The trace is an observation, not a memory artifact. Every variant, including M0, reads the previous game's trace in its next pregame. Older traces are not retained as private memory unless a variant's permissions allow the agent to copy from them into a permitted memory directory.

## Scoring

One deterministic scoring implementation lives in the evaluation layer. The environment exposes scores only when the runner's phase policy permits, and agent feedback uses the same code.

### Substitution timing

Over all eligible, unflagged windows i with outcome y_i = 1 if the coach substituted and 0 otherwise, and Jev's p_i = P(any substitution):

```latex
\mathrm{Brier} = \frac{1}{N}\sum_i (p_i - y_i)^2
```

Lower is better. Report alongside it: log loss where numerically stable (p clipped to [0.001, 0.999] for the log-loss column only, clips counted), a calibration table in deciles of p, and precision and recall at p ≥ 0.5 as diagnostics. Raw accuracy is not reported as a headline because no-substitution dominates.

### Player selection

At windows where the coach substituted, regardless of what Jev predicted, score the conditional exit and entry distributions. Proposed normalization: renormalize Jev's reported marginals over the eligible set to sum to the number of players actually moved, k, so that an exit score at a two-for-two window compares a two-player distribution against two actual exits. For the exit side with eligible on-court set E, actual exits A ⊂ E with |A| = k, and normalized marginals q_j:

```latex
\mathrm{exit\ score} = \frac{1}{|E|}\sum_{j \in E} (q_j - \mathbb{1}[j \in A])^2
```

The entry score is the same over the eligible bench. Lower is better. Also report top-k accuracy (the k highest marginals equal A) and top-1 accuracy (the highest marginal is in A). A player in the eligible set with no reported probability is scored as 0.

### Action match

Exact match: `proposed_action` equals the actual decision including the no-substitution case. Partial overlap: Jaccard similarity of the proposed and actual moved-player sets, averaged over windows where either is non-empty. Reported, not primary.

### Invalid outputs and failures

| Case | Handling |
| --- | --- |
| Jev output fails validation | Window scored as p = 0.5 for timing and uniform marginals for selection; counted and reported with reason. Proposed. |
| Jev call fails at the provider after retries | Window unscored; counted as infrastructure; the game is flagged if more than 5 % of its windows are affected. Proposed threshold. |
| Package fails to load or raises on first window | Session status `invalid_package`; every window of the game unscored; reported |
| Assembler raises or exceeds compute on a later window | That window scored as an invalid output; counted under `assembler_error` |
| Window flagged by the decision dataset | Excluded from every score; counted and reported with reason |
| Game postponed or cancelled | Session voided; replayed on the rescheduled date's data |

### Comparison between variants

Compare on matched windows only: identical decision dataset, identical Jev. Windows within a game are correlated, so the game is the unit of uncertainty. Agreed, carried: a paired bootstrap over games, reporting the 90 % interval on each primary score difference, sensitivity to the five most influential games, and within-variant replicate spread where replicates exist. Report cost and time next to every difference, as score per unit cost and per unit time.

Learning curves: each primary score by game index for every variant on the same games. The M0 curve on the same games is the control for schedule and opponent difficulty, not a variant's own early games.

### Baselines

Run on the same windows so the variants have a reference:

- **Constant rate**: p = the warm-up-window substitution rate at every window; uniform marginals. Establishes the floor.
- **Statistical predictor**: a documented simple model from the observable state only (for example a logistic hazard on stint length, period, score margin, fouls and stoppage type, fit on 2024–25 and the warm-up games), with player marginals from stint-length ranks. The conventional benchmark the proposal asks for. Proposed form; the replay MVP fixes it.
- **Generic Jev**: a fixed, hand-written prompt with the observable state and no agent-written components. Establishes what Jev does unaided.

Baselines are not variants of the memory axis. If no variant beats the statistical predictor, that is reportable on its own.

## System architecture and module ownership

Six logical modules in one repository, plus external ingestion. These are ownership boundaries, not deployed services.

| Component | Owns | Does not own |
| --- | --- | --- |
| External ingestion | Collecting, normalising and preserving source records with provenance | Run-specific access rules |
| Runner | Configuration, schedules, budgets, run isolation, checkpoints, controlled clock, the metering proxy for both model roles | Basketball reasoning, replay construction |
| Environment | Read adapters, temporal filtering, workspace tools with memory-permission enforcement, the research sandbox, package freeze, feedback release | Agent research strategy or memory contents |
| Replay engine | The decision dataset, observable-state construction, the assembler sandbox, Jev calls, validation, the trace | Scoring policy |
| Agent harness | The research agent's model loop and prompts. v3 is the homemade harness carried from v2 | Workspace enforcement, sandbox lifecycle, metering, replay |
| Evaluators | Scoring, baselines, matched comparisons, learning curves, reports | Changing frozen packages or traces |
| Experiment record | Immutable events, source references, configurations, package and workspace snapshots, traces | A shared memory across runs |

### Control and data flow

```text
      Runner                                                   Evaluators
 (config, clock, budgets, record, proxy)                  (score frozen traces)
        |                                                          ^
        | 1. pregame session: cutoff = scheduled start             | 6. score windows
        v                                                          |
  +-----------+  2. research with tools    +------------------------+-----------+
  |  Harness  | -------------------------> |            Environment             |
  | (research |  <--- observations ------  |  cutoff-filtered reads; workspace   |
  |   agent)  |  3. write package;         |  with memory permissions; sandbox   |
  |           |     freeze_package ------> |  package freeze (atomic, pre-cutoff)|
  +-----------+                            +------------------+-----------------+
                                                              |
                            4. replay (trusted, no agent)     v
                            +-------------------------------------------------+
                            |  Replay engine: for each window                 |
                            |    state <- real game ; prompt <- assemble(state)|
                            |    output <- Jev(prompt) via proxy ; validate    |
                            +-------------------------------------------------+
                                                              |
        7. postgame session: cutoff = 9 a.m. next day         | 5. trace frozen
        v                                                     v
  +-----------+  read_feedback(game)       released trace (states, diagnostics,
  |  Harness  | <------------------------  prompts, Jev outputs, actuals, scores)
  |           |  update permitted memory
  +-----------+  dirs only
        |
        v
  workspace checkpoint; next game
```

## Memory and artifact contracts

### Ephemeral versus persistent

Status: Agreed. The workspace separates per-game artifacts from cross-game knowledge by directory, and the environment enforces what each variant may read, create and revise.

| Directory | Contents | Persistence |
| --- | --- | --- |
| `packages/<game_id>/` | The frozen policy package for one game | Frozen at commit, retained for audit, readable to the agent only for the current game and, as part of the trace, the previous game |
| `feedback/<game_id>/` | The released trace for one game | Written by the environment; the previous game's trace is readable in every variant; older traces are not readable |
| `memory/coach_profile.md` and `memory/coach/` | Observations, hypotheses, evidence, exceptions and uncertainty about this coach's rotations and substitutions. Free-form. | Only when the coach-profile gate is on |
| `memory/best_practices.md` and `memory/practices/` | General, coach-agnostic guidance on which analyses to run, how to build components and assembly code, what errors to watch for, how to read a trace | Only when the best-practices gate is on |
| `skills/` | Agent-authored, reusable code and instructions for doing the research and policy-authoring task; loaded into the research sandbox in later pregames with a fixed API | Only when the skills gate is on |
| `scratch/` | Session scratch | Discarded at session end |

A gated directory that is off for a run does not exist from the agent's point of view: not listed, not readable, not writable, and absent from the sandbox mount. Memory directories are writable in pregame and postgame and locked during the freeze. The agent may copy from the previous trace into a permitted memory directory; that is how a variant with permission accumulates episodes.

### Content boundaries

Status: Agreed in principle; audit method Open. The best-practices document and skills must stay coach-agnostic. The agent may not use them as a disguised coach profile or embed team-specific historical labels in a generic skill. Boundaries are light and auditable, not a schema: a reviewer reading `best_practices.md` should find no Celtics player names, no Celtics-specific rotation facts, and no game-specific records. The audit method and its consequence are Open; the Proposed default is a per-game automated check (named-entity list of Celtics players and staff against the generic directories, flagged for human review, never auto-edited) plus a human sample at the end of each run, with a boundary breach reported as a confound on that variant rather than corrected after the fact.

### Memory budget

Status: structure Agreed, number Open. The total retained text in `memory/` is capped at the same token count for every variant that has any memory gate on, measured at each checkpoint and reported per game. A write that would exceed the cap is refused with the current size named. Executable skill size and skill runtime cost are accounted separately and reported, not capped in the first stage.

## Replay lifecycle and environment tool surface

One game runs through six phases. The runner requests transitions; the environment enforces their validity. The agent cannot advance time.

1. Initialize: validate configuration, dataset coverage and the decision dataset for the game; create the isolated run, workspace and record.
2. Pregame: freeze the cutoff at the scheduled start. The research agent reads the previous trace and its permitted memory, researches with the tools, writes the package and calls `freeze_package`. Enforce the research budget.
3. Freeze: validate the package (loads, entry point present, manifest hashes match, state schema version supported), snapshot it, lock the package directory. Idempotent on an identical package.
4. Replay: trusted. Build windows, run the assembler and Jev, validate, record. No agent session.
5. Postgame: advance the clock to 9 a.m. America/New_York on the morning after the game. Release the trace and the game's data. Run the reflection session: the agent reads the trace and updates permitted memory within the postgame budget. Nothing is required of it unless a later variant mandates reflection.
6. Checkpoint: record workspace version, package hashes, costs, events and statuses; advance to the next game.

### Environment tools

Capability contracts, not final API names. Carried tools are implemented; new tools are the replay MVP's and the package issue's work.

| Capability | Expected behaviour | Status |
| --- | --- | --- |
| Session context | Team, game, opponent, phase, cutoff, memory permissions in force, budget remaining | Carried |
| Browse, search and fetch evidence | Beat posts, coach transcripts, lineup announcements, cutoff-filtered on every path | Carried |
| Query game history | Play-by-play, box scores, stints, lineups, summaries for completed games across both seasons; player reference | Carried |
| Read schedule and injuries | Eligible injury reports as printed; schedule | Carried |
| Execute code | Python in the research sandbox over the cutoff-filtered export, scratch, and the permitted workspace directories | Carried; mounts change with permissions |
| Workspace list, read, write, append, delete | Enforce the directory permissions above and the memory budget | Carried; policy changes |
| Freeze package | Validate and atomically freeze `packages/<game_id>/`; return a receipt | New |
| Read feedback | The previous game's trace, and the current game's trace in postgame; nothing older | New |
| Validate package locally | Run the assembler against a small set of sample states from eligible prior games and return prompts and diagnostics, so the agent can test before freezing. Costs research compute. | New, Proposed |

### Code execution sandboxes

Two sandboxes, both per-session Docker containers from pinned images on the harness host, no network, image digests in the harness version. Agreed, carried in form.

- **Research sandbox**: as in v2. Python with pandas, numpy, scipy and scikit-learn over the cutoff-filtered SQLite export and source files, a scratch directory, and the workspace mounted with the run's permissions. Used by the research agent in pregame and postgame.
- **Assembler sandbox**: minimal Python, no data mounts beyond the frozen package and a scratch directory, no workspace, a strict per-window wall-clock and memory limit. Used by the replay engine. The planted-future-record fixture applies: a future record on the host must be invisible from inside both containers.

## Harness contract

Carried, Agreed. The research-agent harness receives three handles and nothing else: a session endpoint exposing the tools above, a metered model endpoint for the analyst role, and the memory-permission instructions for its prompts. It holds no credentials, data paths or direct workspace access. Every model call for either role passes through the runner's metering proxy, which pins the model and settings per role and records usage. Jev is called by the replay engine through the same proxy under the `jev` role; the harness never calls Jev.

## Run profile

Every run declares a profile on four axes, printed on every report. A comparison must name which axes differ.

| Axis | What it declares | v3 values |
| --- | --- | --- |
| Memory permissions | Which persistent directories exist for the run, each with read, create and revise rights | Three gates: coach profile, best practices, skills. First stage: M0 none; M1 coach; M2 practices; M3 coach and practices; M4 coach, practices and skills. Later: representation variants (episodic store, hypothesis ledger, player profiles) and management variants (append-only, periodic consolidation, retrieval) as named values |
| Data sources | Which source types the environment exposes, each with its pinned release | Coach transcripts, play-by-play and box scores, injury reports, starting lineups, beat reporting, player reference. Game spread: Open |
| Agent capabilities | What the research agent can do within a game | Search and fetch, game-history queries, workspace, research sandbox, local package validation |
| Model roles | Which pinned model serves each role, with settings | analyst (Open), jev (Open). Later: reflector, critic |

Rules carried from v2: axes are enumerated and versioned; adding a value never changes an existing one; data sources are declared by type and manifest, not by what was read; model roles are pinned per role and a different version in any role is a different value.

### Per-run descriptors held fixed within a comparison

| Descriptor | What it declares |
| --- | --- |
| Research budget | Pregame and postgame token caps, cache-read weight, compute caps for the research sandbox, the memory token cap, tool-call and wall-clock ceilings, the pinned price schedule. A named, versioned budget profile. |
| Harness version | Harness identity, prompts, memory-permission instructions, tool definitions, loop parameters, SDK version, both sandbox image digests, the state schema version, Jev's settings, the assembler API version, the code revision |
| Decision dataset version | The release manifests and the window-definition version that produced the windows. Changing either changes every score, so it must match across compared runs. Replaces the v2 de-vig descriptor. |

## Experimental configurations

### First stage: which categories of knowledge matter

Status: Agreed as the experiment; variant details Agreed as in the proposal. Every variant writes a package every game and reads the previous trace. What differs is what survives.

| Variant | Coach profile | Best practices | Skills | Question |
| --- | :---: | :---: | :---: | --- |
| M0 Feedback only | No | No | No | How well can the agent prepare afresh with only the last trace? The no-persistent-memory baseline, not a no-feedback baseline. |
| M1 Coach profile | Yes | No | No | Does accumulated team-specific knowledge help? |
| M2 Best practices | No | Yes | No | Does learning how to do the job help without retained coach conclusions? |
| M3 Both | Yes | Yes | No | Are domain and procedural knowledge complementary? |

Analyse M1 − M0, M2 − M0 and the interaction (M3 against M1 and M2). The four runs are independent with separately evolved memory; they never share findings.

Follow-up, conditional on the 2 × 2 results: M4 adds the skills gate to M3. If resources allow, add skills to M0 or M1 to test whether skills substitute for documents. Skills are created and revised in postgame and loaded in the next pregame; they run in the research sandbox with a fixed API and cannot read withheld data or touch evaluation.

### Second stage

Not scheduled; run only after first-stage results and prioritised by the failure modes observed. Carried from the proposal as named future values of the memory axis: episodic store versus synthesised profile; free-form profile versus hypothesis ledger; coach-level versus coach plus player profiles; append-only versus revision versus periodic consolidation; always-in-context versus retrieval. Transfer to a second team with coach-agnostic memory only is the final extension. Each is one flag from the variant it is compared against, and each is written up as its own brief change before it runs.

### Replicates

Carried, Agreed. First comparison: one replicate per variant, uncertainty from the paired bootstrap over games. Before any published claim that a memory variant beats M0: at least two further replicates of that variant, so the difference is reported against the within-variant spread. If the first comparison shows no effect, do not add replicates.

### Warm-up, scored and holdout windows

Status: Open. The proposal suggests about 20 games of warm-up, a rolling scored sequence and an untouched final holdout. The v2 rule was that the first 10 games are development games and never evidence. See Open decisions for the Proposed split.

Any prompt or harness change after scoring begins restarts the scored run. The holdout is either run with learning frozen or revealed once under a prespecified protocol; it is never tuned against.

## Data contracts and temporal access rules

Carried, Agreed. The environment consumes each source's published, immutable, hash-manifested release as published and does verification, temporal filtering, visibility projection and canonical ID joins only. Every record carries its availability time and the convention that assigned it. The full table, the odds findings and the audit dispositions are in the v2 brief; the sources that remain in v3 are:

| Source | Pinned release | Availability time | Change in v3 |
| --- | --- | --- | --- |
| Play-by-play, box scores, lineups, stints | `spo-771-full-v1-2025-26` and `-2024-25` | 9 a.m. America/New_York next morning; 2024–25 eligible from the start | Also the source of the decision dataset. The replay engine reads it at full fidelity; the agent still sees only released games. |
| Injury reports | key `61f65449…` | Printed report timestamp | Also used for the eligible bench in the observable state |
| Player reference | release `15fef727…` | Static | None |
| Beat reporting | snapshot at pin time, NBA-related posts only | Version publication time | None |
| Starting lineups | two JSON datasets | Announcement posting time; at-or-after-start announcements unavailable for their own game | Announced starters also enter the observable state when pregame-visible |
| Coach media | index at commit `cc285352…` | `published_at`, or `stream_ended_at` for livestreams | None |
| Schedule | play-by-play games table cross-checked against the ESPN schedule | Static | None |
| Odds consensus and game lines | `consensus/proportional/v1`, `derived/v3` | `requested_at` | No longer defines the task. Exposure of the spread as context is Open; otherwise absent from the run. |

Temporal rules carried unchanged: apply the cutoff to every access path including search, counts, snippets, derived views, pagination and the sandbox export; non-odds records are eligible strictly before the cutoff; the cutoff is the scheduled start, not actual tip; news after 9 a.m. stays unavailable at that release; the research agent cannot override cutoff, run identity or dataset version.

One new rule: the replay engine's access to the game being replayed is not a cutoff violation, because the agent is not running and the package is frozen. The engine's reads are recorded, and the trace released to the agent is the only path by which replay data reaches it.

## Isolation and reproducibility

Carried, Agreed. Session identity and cutoff enforced outside the prompt; no agent credentials; code execution only over cutoff-filtered exports, scratch and the permitted workspace; planted-future-record fixture for both sandboxes; pin code revision, configuration, harness version, budget profile, model identifiers per role, dataset manifests and the decision dataset version. Capture observations or immutable references sufficient to reconstruct them. Jev's text may vary between replays of the same package; the record stores every Jev output, so a score is reproducible from the record even where a fresh replay would differ.

Two new isolation requirements:

- No memory leakage across variants: each variant has its own run id and workspace; traces are written by the environment and never shared between runs.
- No category leakage: the content-boundary audit above.

## Research budget

Structure Agreed, carried; numbers Open, set by the pilot procedure. Separate pregame and postgame caps, no rollover, cache reads at their price ratio, research-sandbox compute budgeted separately, tool-call and wall-clock ceilings as safeguards only. The pregame cap is matched across variants. Postgame reflection is where memory is written, so a variant's postgame spend is reported as the measured cost of its memory; M0 has a postgame session too, since it may read the trace, so postgame is matched as well. The memory token cap is part of the profile.

Jev's spend is accounted per game under the `jev` role and reported, but it is a property of the replay, not of the agent; it is the same for every variant and is not part of the research budget.

Pilot procedure, carried: run the development games with generous ceilings and record spend, tool calls, compute, elapsed time and package validity for one variant (Proposed: M3, the heaviest first-stage variant); set caps at the 90th percentile; re-run at a smaller and a larger pregame cap; record the chosen numbers as budget profile v1.

## Experiment record and limits on claims

Carried, Agreed, with additions. Every scored claim must be reconstructible from the record alone.

- Run manifest: as in v2, with the memory-permission axis, both model roles, the decision dataset version and the state schema version.
- Session record: as in v2.
- Package record: the frozen package's files and hashes, the freeze receipt, validation result, and the local-validation calls the agent made.
- Window record: window id, state, assembler diagnostics, assembled prompt, Jev raw output, validation result, actual decision, per-window scores, Jev usage and latency.
- Trace record: the released trace exactly as the agent saw it.
- Workspace checkpoints: snapshots before and after each session, with diffs, and the memory size at each checkpoint.
- Boundary audit record: every flag the content check raised and its human disposition.

### Learning diagnostics

Carried in intent. For every variant with a memory gate on, collect reviewed examples of stale beliefs, useful transfer and repeated errors from the workspace diffs and the traces, and report them next to the scores. A score difference without a workspace change that explains it is not a learning claim.

### Contamination

Carried, Agreed. Before any scored run, probe each pinned model, with no tools, for outcomes in the replay window and store the result in the manifest. The probe now covers both roles. Jev is the larger concern: a small model with a later cutoff could carry rotation facts from the season into its predictions. A model whose cutoff follows Oct 21, 2025 is not eligible for either role.

## Resolved decisions

Decisions made for v3, and v2 decisions explicitly re-affirmed. Agreed.

| Decision | Resolution |
| --- | --- |
| Task | Coach substitution prediction via a frozen per-game policy package executed by a pinned decision model. Replaces the prop task. |
| Primary scores | Brier on P(any substitution) over all windows; conditional exit and entry scores at actual substitutions. Reported separately. |
| Memory axis | Three gated directories: coach profile, best practices, skills. First stage is the 2 × 2 on the first two, then skills. |
| Variant independence | Separate run ids and workspaces; no sharing. |
| Trace | Same format for every variant; previous game's trace readable in every pregame; older traces not readable except through a permitted memory copy. |
| Replay semantics | Real historical state at every window; Jev's proposals never alter later states. |
| Jev constancy | Same model, settings, schema and validation across every variant in a comparison. |
| Carried from v2 | Team, season, data contracts, availability conventions, cutoff and release rules, isolation, metering, sandbox form, record, contamination probe, replicate policy, paired bootstrap over games, development games never evidence, harness contract, implementation choices (TypeScript on Node, SQLite plus files, adapters over R2, Docker sandboxes, in-process transport) |
| Repository | v3 is built in the existing repository; prop-task code removed and v2 docs archived by SPO-835. |

## Open decisions

Each must be resolved by the user before a scored run. Coding agents list the relevant ones in each project spec and do not infer them.

| Decision | Proposed starting point | Why it matters |
| --- | --- | --- |
| Research-agent model | `claude-opus-4-6`, re-verified against Anthropic's model documentation at pin time for training cutoff (Aug 2025 as verified Oct 20, 2026) and retirement date (not before Feb 5, 2027). If retired or re-verification fails, the fallback is a model with a documented cutoff before Oct 21, 2025. | The cutoff constraint is the contamination defence; the retirement date bounds when scored runs must finish. |
| Jev model and settings | `claude-haiku-4-5`, the only currently served low-cost model whose training cutoff is believed to precede the season; verify the cutoff against Anthropic's documentation before pinning. Settings: thinking disabled, structured output enforcing the prediction schema, `max_tokens` 1,024, effort not applicable. One retry on transport error. | Jev runs hundreds of times per game; cost and latency bound the experiment. A later-cutoff model would contaminate every prediction. |
| Warm-up, scored and holdout windows | Games 1–10 are development games for prompts, budgets and tooling and are never evidence (carried). Games 11–20 are warm-up: run for every variant so memory accumulates, reported but not in the headline. Games 21–70 are the scored rolling sequence. Games 71–82 are the untouched holdout, revealed once with learning frozen. | Fixing these before any comparison is what makes the holdout a holdout. |
| Memory token cap | 50,000 tokens of retained text across `memory/`, measured with the analyst model's tokenizer at each checkpoint. Skills uncapped in the first stage, size reported. | Equal budgets make M1, M2 and M3 comparable; the number should hold a season of notes without forcing consolidation, which is a second-stage question. |
| Content-boundary audit | Automated per-game check: Celtics player and staff names and game ids against `memory/best_practices.md`, `memory/practices/` and `skills/`; flags to a human queue; never auto-edited; end-of-run human sample of ten reads per generic file; a confirmed breach is reported as a confound, not corrected. | Without it M2's result is uninterpretable. |
| Budget numbers | By the pilot procedure, on M3 at effort `high` with code execution on. | Carried from v2; set by procedure by design. |
| Game spread as pregame context | Expose the scheduled-start Celtics spread and game total in the session context, as SPO-829 did, as a data-source value `game_lines`. Not exposed to Jev or the assembler. | Blowout expectation is an input a real analyst has; the v2 pilot showed the agent used it. Exposing it to the agent but not the state keeps the state schema free of odds. |
| 2024–25 as historical evidence | Yes, from the start of the replay, as in v2. | Rotation tendencies from the prior season are the obvious first source for a coach profile. |
| Reflection in postgame | Voluntary for every first-stage variant; a mandated-reflection flag is a later value of the process sub-axis, as in v2. | Keeps the first stage to one manipulation. |
| Local package validation tool | Provide it, limited to states from eligible prior games, costing research compute. | Without it the agent's first test of its code is the scored replay, which penalises every variant equally but makes the first games noise. |
| State schema fields | The table above as `state-v1`, amended by SPO-837. | The schema is part of the harness version and changing it restarts scored runs. |

## Implementation projects

Seven projects, each one or more Linear issues in `nba-agent-v2`. The decomposition follows the proposal's plan. P1 through P4 of v2 (data adapters, audit, environment, runner, harness loop) are inputs, not rebuilt.

### R0 Repository reset

Complete (SPO-835). Prop-task code removed, v2 docs archived, entry points rewritten.

### R1 Decision-window feasibility

- Inputs: the pinned play-by-play releases, the data dictionary.
- Outputs: `docs/v2/decision-windows-feasibility.md` with counts for stoppage identification, substitution grouping, lineup completeness, fouls, period boundaries and ordering; a three-game hand audit; a proposed window definition in release fields.
- Acceptance: every question answered with counts; audit disagreements listed; the definition uses only fields in the release.
- Status: SPO-837, open.

### R2 Replay MVP

- Inputs: R1's definition, this brief's state schema, prediction contract and scoring.
- Outputs: the decision dataset builder; `state-v1`; the prediction contract and validation; the scorer; the constant-rate and statistical baselines; window and trace records in SQLite.
- Acceptance: windows on the audited games match the hand check or disagreements are listed; the planted future record never appears in a state; invalid predictions are rejected with reasons; hand-computed scores for a five-window fixture match; the statistical predictor is documented.
- Status: SPO-838, open, blocked on R1 and this brief.

### R3 Package, assembler sandbox and Jev

- Inputs: R2; the package contract; the `jev` role in the proxy.
- Outputs: `freeze_package` and its validation; the assembler sandbox image and per-window execution; Jev integration through the proxy with structured output; the generic-Jev baseline; the trace builder; `read_feedback`; the local-validation tool.
- Acceptance: a frozen package cannot be modified; the assembler cannot reach the network, the workspace or the host; the same package and state yield the same prompt; every Jev call and output is in the record; the trace contains no window after the released game.
- Status: to be filed after R2.

### R4 Memory permissions and reflection

- Inputs: the directory permission model; the memory cap; the content-boundary check.
- Outputs: permission-gated workspace policy per variant; mounts that follow permissions; the memory size meter and cap; the automated boundary check and its human queue; the postgame reflection session; configuration schema supporting every named memory value without implementing second-stage representations.
- Acceptance: a gated-off directory is unlistable, unreadable, unwritable and unmounted; a write over the cap is refused with the size; the check flags a planted player name in `best_practices.md`; M0 retains nothing between games while still reading the previous trace.
- Status: to be filed after R3.

### R5 Harness prompts and pilot

- Inputs: R3, R4; the research-budget procedure.
- Outputs: the v3 system and phase prompts and memory-permission instructions; the contamination probes for both roles; the development-games pilot on M3; budget profile v1 proposed.
- Acceptance: changing any prompt changes the harness version; the probes are stored; the pilot observation is written up as a pilot, not evidence.

### R6 Evaluators and reporting

- Inputs: the record; the scoring definitions.
- Outputs: per-window, per-game and per-run scores; calibration; learning curves by game index; matched comparison with the paired bootstrap; replicate spread; cost and time per unit score; the report that prints the profile, descriptors and differing axes and refuses mismatched comparisons; learning-diagnostic annotations.
- Acceptance: the constant-rate baseline scores as computed by hand; the comparison drops windows unscored on either side; the report flags differing harness versions, budgets or decision dataset versions.

### R7 First-stage factorial

- Inputs: everything above; the Open decisions resolved.
- Outputs: M0 through M3 on the warm-up and scored games with the baselines; the write-up; then M4 if justified; then the holdout reveal.

### Build order

R1 and this brief in parallel. R2 after R1. R3 after R2. R4 can start against R3's interfaces. R5 after R3 and R4. R6 after R2's record shape is fixed and can proceed in parallel with R3 and R4. R7 after a pilot on R5 and the Open decisions.

## Delivery sequence and acceptance gates

1. **Replay on fixtures.** R2 on a fixture game with a planted future record; the constant-rate baseline scores as expected; invalid predictions rejected.
2. **One real game end to end.** A hand-written package through R3 on an audited game; the trace released at 9 a.m.; the assembler sandbox passes the isolation fixture; Jev outputs validated and scored; generic-Jev baseline runs.
3. **Several chronological games with memory.** M3 and M0 on the development games through R4 and R5; M3's memory persists and M0's does not; the boundary check runs; a forced crash mid-game resumes without a duplicate freeze or replay; the previous trace is readable and older traces are not.
4. **Scored comparison.** Open decisions resolved; probes stored; budget profile v1 recorded; M0 through M3, one replicate each, on the scored games; report generated from the record alone; the holdout untouched.

Minimum acceptance checks across all gates:

- Future evidence is unreachable by every agent path, including both sandboxes.
- The assembler never receives the actual decision or anything after the window.
- A frozen package is immutable through retries, crashes and later evaluation.
- Flagged windows and invalid outputs are excluded or scored by rule, never silently repaired.
- Variants share no private memory, and generic memory carries no coach-specific content.
- Failed sessions, flagged windows and unresolved games remain visible in every report.
