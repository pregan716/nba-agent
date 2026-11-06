# NBA Coaching Policy Agent — Implementation Brief v3

Nov 4, 2026 · @Patrick Regan · Revised Nov 4, 2026 after the first review (SPO-836)

## Purpose and research question

Build a chronological NBA replay system that tests which kinds of accumulated knowledge help an autonomous research agent get better at a specialised job over repeated episodes. The job is to encode the Boston Celtics head coach's substitution tendencies into a decision policy. Before every game the research agent studies the team from time-restricted sources and writes a frozen policy package: prompt components plus deterministic assembly code. During a replay of the real game, at every substitution-eligible window, the assembly code builds a prompt from the observable game state and a fast, inexpensive decision model ("Jev") returns calibrated probabilities for whether the coach substituted and who came in and out. The predictions are scored against what the coach actually did. After the game the research agent sees a detailed trace of how its package performed and may reflect.

The central question is not whether an elaborate policy prompt beats a plain one. It is whether, and which kinds of, knowledge preserved between games improve the next game's predictions: coach-specific knowledge, procedural knowledge about how to do the research and build the package, or executable skills. The primary experimental manipulation is what the agent may keep between games. Everything else is held constant.

The agent predicts what the coach would do, not what the coach should do. The main outcome is out-of-sample substitution-prediction quality. A later experiment asks whether a learned policy improves player-minutes distributions and rotation realism in full-game simulation.

A good score alone does not establish that an agent learned. Findings must connect score differences to what the agent kept, and negative results are valuable when the comparison and diagnosis are sound.

## How to use this brief

Agreed items are requirements. Proposed items are recommended defaults for the first implementation, not approved decisions: an implementer builds them as written and may raise a brief change against them before scored runs begin. Open items must be resolved explicitly before a scored experiment. Coding agents must preserve these distinctions when writing project specs and issues, and must not silently infer an Open item.

| Status | Meaning |
| --- | --- |
| Agreed | Explicit user choice, or established architecture and task scope |
| Proposed | Concrete default offered for review |
| Open | Unresolved choice that must not be inferred |

This brief supersedes the v2 player-prop brief, archived at [`docs/archive/v1-props/`](archive/v1-props/README.md), and the research proposal it was built from, archived at [`docs/archive/v2_agent_spec.md`](archive/v2_agent_spec.md). Decisions carried over from the v2 brief are marked "carried", are restated here in full, and are not relitigated; the v2 brief is the record of why they were made and is not needed to implement this one.

### What changed from the v2 brief

The v2 brief asked an analyst agent to state P(over) for every market-priced player prop and scored it against the consensus market. Four development-games pilots ran on it. The last, pilot-b-4, scored positively but showed the agent's method drifting from a projection model to small-sample hit rates and its workspace becoming a tout sheet. The task rewarded selective deviation from a strong baseline, which is a hard place to see learning. The v3 task replaces it:

- The question changes from "beat the market on prop probabilities" to "predict the coach's substitutions". There is no market baseline; the baselines are a conventional statistical predictor and a generic Jev prompt.
- The agent's deliverable changes from a probability per question to a frozen policy package: prompt components and deterministic assembly code that a second model executes hundreds of times per game.
- The memory axis changes from horizon, revision rights and process to three gated categories: coach profile, best-practices document, custom skills. The first comparison is a 2 × 2 on the first two.
- A second model role, Jev, is added and pinned. Jev is TypeSafe's System One decision model, which answers typed questions with calibrated probabilities and generates no text, so the assembler builds a state and a question set rather than a prose prompt.
- The research agent runs under a third-party coding-agent harness, Pi, behind the harness contract the v2 brief already defined, so a different harness is a configuration change. v2 ran a hand-written tool loop over direct SDK calls.
- The odds consensus is no longer the question source. The odds adapters stay in the repo; the scheduled-start spread and game total are exposed to the research agent as pregame context, never to the assembler or Jev.

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
| Research-agent model | `claude-opus-4-6`, as in v2: training data cutoff Aug 2025, before the Oct 21, 2025 opener; retirement not before Feb 5, 2027. Re-verify both against Anthropic's model documentation at pin time. | Agreed (Nov 4, 2026) |
| Jev model | TypeSafe Jev, versioned id `jev-1.14.0`, through the System One API (`POST /v1/systemone`). Never the `jev-latest` alias. The same model the beat-reporting relevance labels were produced with. Credential added to the `nba-agent` Doppler project; held only by the runner's proxy. | Agreed (Nov 4, 2026) |
| Research-agent harness | Pi (`@earendil-works/pi-coding-agent`, MIT) through its SDK, under the harness contract below. The v2 homemade loop remains as a second implementation for fixtures. Swapping harnesses is a harness-version change, not a rebuild. | Agreed (Nov 4, 2026) |
| Evidence judge | Not in v3 | Agreed, carried |

### Guard against unnecessary process

Specify the access rules, the package contract, the Jev contract, the scoring and the differences between variants rigorously. Leave the research agent free to choose its research process, how it writes components and code, and how it organises what it keeps. Do not force a coach-profile schema, a research checklist or a feature list. The first stage tests memory permissions, not representations; representation is a second-stage question.

### Naming

The decision model role and the relevance labeller recorded in the beat-reporting bucket's label policy (Jev 1.14.0, see the sports-text data description) are the same TypeSafe model, used for two unrelated jobs. In this brief and in code, "Jev" means the decision model role in this experiment. Where the label policy is meant, write "the relevance labeller". Nothing about the labelling job informs or constrains the decision job.

## The task

### Decision windows

Status: Agreed on merge of this change (Nov 2026), on the findings of the feasibility spike SPO-837 ([report](v2/decision-windows-feasibility.md), including its opener and adjacency follow-up). The definition is versioned separately from `state-v1` as `windows-v1`; the pair (release manifests, window-definition version) is the decision-dataset version on every run.

**What the spike changed.** The first draft opened a window at every dead-ball stoppage. That is wrong twice over. NBA Rule 3, Section V restricts substitution during free throws and some suspensions, so dead ball does not mean eligible. And the official feed logs statistical actions, not whistles: a missed shot going out of bounds is a team rebound, a held ball is a jump-ball outcome, and an injury stoppage or review is nothing unless a timeout is charged. The releases in use during the spike also dropped the feed's `qualifiers` array, and the spike expected its `deadball` flag to separate an out-of-bounds team rebound from a live one. SPO-839 restored the array in the releases pinned since Nov 5, 2026, and the restored data says otherwise: across the 82 Celtics games every one of the 341 `deadball` team rebounds follows a missed free throw after which the ball stays dead (328 non-final attempts in a sequence, 13 final technical or flagrant attempts after which play resumes with a throw-in), and the 1,149 team rebounds that carry `team` alone follow missed field goals, blocked shots or administrative rows whether or not the ball went out of bounds. The feed does not mark out-of-bounds stoppages at all ([evidence](evidence/decision-windows/2025-26-qualifiers-spo839.json)). So the dataset is defined as **decisions at independently marked stoppages**, with an explicit ledger of what it leaves out, rather than as every coaching decision.

**Definition, `windows-v1`.** Over effective events in `canonical_sequence` order:

1. **Openers.** A candidate window opens at an event of one of these kinds: `timeout/full`; `foul/personal` or `foul/offensive`; a dead-ball turnover (`out-of-bounds`, `offensive foul`, `shot clock`, `traveling`, `backcourt`, `3-second-violation`, `offensive goaltending`, `5-second-violation`, `discontinued dribble`, `double dribble`, `offensive-kicked-ball`, `8-second-violation`, `jumpball violation`); a `violation` other than `delay-of-game`; and a `jump_ball` not at a period start. A team rebound is never an opener, with or without qualifiers: the `deadball` qualifier marks the placeholder rebound after a missed free throw whose miss leaves the ball dead, whether a non-final attempt or a final technical or flagrant attempt, which is free-throw context and not an independent stoppage and does not by itself mean another attempt is pending, and a team rebound after a missed field goal carries no mark of whether the ball went out of bounds. Technical fouls, ejections, delay-of-game violations, coach's challenges and free throws are not openers; a substitution anchored only by one of them goes to the ledger.
2. **Snapshot.** The observable state is frozen immediately after the opener and before any following event: the opener's score and lineups after its statistical contribution, fouls and timeouts through that prefix, completed substitutions through that prefix. The same rule applies whether or not a Celtics substitution follows, so the input never depends on the outcome. One opener is recorded after the decision it marks: the feed writes `jump_ball/recovered` after the substitutions made during the held-ball stoppage (in every one of the 13 season buckets that hold both, the first Celtics substitution row precedes the jump-ball row). For a `jump_ball` opener the snapshot is therefore the state before the first row of its clock bucket that is either a substitution, by either team, or the jump ball itself. Same-clock play before that row, typically the missed shot and rebound that led to the held ball, is in the state (28 of the 163 in-period jump-ball buckets have such rows). The lineup is the one before the stoppage whether or not anyone substituted, and the jump ball's recovery outcome never enters the state. A non-substitution row between the first substitution row and the jump-ball row makes the window `ambiguous_stoppage`, which keeps the cutoff independent of the outcome: the rows before the cut are the same with and without a substitution. For every other opener kind, if the opener row follows the first Celtics substitution row in its bucket, the window is tagged `marker_after_decision`, excluded from scoring, and its substitution goes to the ledger; the post-substitution lineup is never reused as input. Free-throw pending state is unknown unless the prefix itself establishes it; `state-v1` carries it as a nullable field.
3. **Coalescing and ambiguity.** Duplicate records of one whistle (an offensive foul and its turnover row) are one opener. An equal-clock run that contains a second potentially distinct whistle, a timeout after the opener, live action after the opener, two Celtics substitution blocks, a player who exits and re-enters, or an incomplete opponent batch is tagged `ambiguous_stoppage` and excluded from scoring with its sequence span. Equal clock alone never resolves it.
4. **Outcome.** The Celtics decision at a window is the single contiguous same-period, same-clock Celtics substitution block in the opener's bucket after the snapshot point (after the opener row, or from the snapshot point onward for a `jump_ball` opener), read from `sub_in` and `sub_out` participants, validated as disjoint equal-sized sets against the pre-decision five and the eligible roster. No block means no substitution. A Celtics substitution bucket with no opener of its own is attributed to the immediately preceding bucket when that bucket contains an opener, is in the same period, and its game clock exceeds the substitution's by more than zero and at most 2,000 ms; no skipped buckets, no chaining, no new candidate, and the snapshot stays at the opener. This is the adjacency rule, and its count is reported.
5. **Between periods.** One `between_periods` window per transition to a following `period_start`, with the prior `period_end` state as input and the next period's opening clock. Its outcome is the net lineup change across the boundary, including substitution rows stamped at the new period's opening clock, and may be empty. The next period's five never enters the input. No window at the opening tip or the final game end.
6. **Ledger.** Every Celtics substitution block that no opener anchors is an `unanchored_substitution` with its mechanism (team rebound after a missed field goal, which the feed cannot qualify as out of bounds; technical or ejection; delay or challenge; substitution-only after a made basket; other) and its sequence span. Every excluded candidate carries a reason. Both are reported per game before any score, and the ledger's size is a headline diagnostic of the dataset, not a footnote.
7. **Exclusions and permitted nulls.** Two different things. State failures always exclude the window; for an otherwise valid window, named field-level summary defects are represented as nulls and do not themselves cause exclusion. A **state failure** excludes the window with a reason: unknown or non-five lineup for either team, `lineups` or `stints` coverage not `valid` for the game, unresolved or repaired ordering at the window, a stint that does not reconcile, or `marker_after_decision`. A **field-level null** applies only to a window that has no state failure: when a game's `summaries` coverage is `partial` with quality findings that name the affected statistics, the `state-v1` running box-score fields those findings cover are null for every window of that game, the window carries `unqualified_running_box_score`, and it is built and scored. The policy is general to any game with that coverage shape; in the pinned 2025–26 release it applies to one game, `0022500338`, whose findings cover field-goal attempts, offensive rebounds and total rebounds. A null is never filled from the final official box score. The assembler receives the null and the flag and decides what to do with them.

**Sizes on the pinned 2025–26 release (`spo-839-full-v1-2025-26`), before ambiguity and state exclusions.** 4,576 in-period candidate windows, 1,299 with a Celtics substitution (28.4 %), of which 4 became positive through the adjacency rule, which attaches 5 substitution buckets (one to a candidate that already had a direct substitution); 159 of 1,459 in-period Celtics substitution buckets unanchored (10.9 %), 91 of them at team rebounds after missed field goals; 248 between-period windows. The counts are identical to those computed on the superseded `spo-771` releases because the new releases change no event field outside `qualifiers` in any Celtics game, and `windows-v1` does not read that field. Evaluated as an opener on the restored qualifiers, a `deadball` team rebound would add 5 candidates and anchor 1 more substitution bucket; all 5 are missed technical free throws and the anchored bucket also holds an ejection, so the opener would admit through a side door exactly the stoppages rule 1 excludes. It is not part of `windows-v1`. In the spike's audited three games the opener set anchors 68 of 76 substitution buckets (one by adjacency) and leaves 8, three of them team rebounds carrying `team` without `deadball`. The ledger's team-rebound entries can shrink only if upstream publishes an out-of-bounds marker the feed does not carry, which is a new upstream requirement, not a pending release.

**Composition.** Marked stoppages over-represent fouls and timeouts, where substitutions are common, so the dataset's substitution rate is above the true rate over all stoppages. Every variant sees the same windows, so comparisons between variants are unaffected; the restriction is stated wherever a rate is reported.

**Gap games.** `0022400061` and `0022400230` (2024–25) have partial lineups and no stints; they are historical evidence only and produce no windows. `0022500338` (Dec 5, 2025) is in the scored sequence: its lineups, stints and fouls are complete, but two quality findings cover field-goal attempts and rebounds in the running summaries, so under rule 7 its windows are built and scored with `unqualified_running_box_score` and null field-goal attempts, offensive rebounds and total rebounds, until upstream localises or corrects the defect.

### Observable state

Status: Agreed (Nov 4, 2026) as `state-v1`; SPO-837 may propose amendments, each a brief change. The state handed to the assembler at a window contains only what was observable before the decision. It is a typed, versioned schema and the version is part of the harness version.

| Group | Fields |
| --- | --- |
| Clock and score | period, period type, clock remaining, home and away score, score margin from the Celtics' side |
| Stoppage | opener kind, whether a timeout was called and by whom, free throws pending (nullable: unknown unless the prefix establishes it) |
| Lineups | the Celtics five and the opponent five on the floor before the decision |
| Eligible bench | Celtics roster minus on-court minus players ruled out in the last pregame injury report minus players fouled out or ejected |
| Per player (Celtics) | minutes so far, current stint length, game-clock rest since last exit, personal fouls (recomputed from `fouler` participants over the prefix, excluding technicals, with the release's typed fields as the check), box-score line so far (the fields a game's `partial` summaries finding names are null for that game, under Decision windows rule 7) |
| History in this game | all prior Celtics substitutions with their windows; opponent substitutions observable before this decision; prior timeouts |
| Pregame context | the frozen pregame injury statuses and announced starters, as the agent saw them |

The actual decision and anything after the window are held outside the state object; the assembler cannot receive them by construction. Nothing from the eligible bench's future (whether a player later entered) is in the state.

### Policy package

Status: Agreed in shape; Proposed in detail. Before the cutoff the research agent writes one package per game and freezes it through the environment. A package has:

- **Components**: text files the assembler may select from. Instructions, examples, rotation expectations, player roles, matchup notes, exceptions. Free-form.
- **Assembly code**: one Python entry point, `assemble(state) -> {jev_state, instructions, criteria, diagnostics}`, that reads the observable state, derives whatever features it wants, selects and orders components, and returns the `state` text Jev receives, the `instructions` text for each of the fixed questions, the per-option descriptions for the choice questions, and a diagnostics object naming the components used and the features computed. The question names, types and option keys are fixed by the environment (see the Jev contract); the agent controls everything Jev reads.
- **Manifest**: component list with hashes, the state schema version it targets, and free-text notes.

Freezing is atomic and happens before the cutoff; the frozen package is what the replay uses, and a later write to the package directory for that game is refused. A package that fails to load, or whose entry point raises on the first window, is a failed session with status `invalid_package`; the game is replayed with no predictions and reported as such. The package directory for each game is retained for audit and is never automatically visible to the next game's research agent; what the agent may carry forward is governed by the memory permissions below.

The assembler is deterministic and sandboxed: no network, no model calls, no file writes outside a scratch directory, no access to the workspace during replay, and a per-window compute limit. Given the same package and state it returns the same request. It must not produce the substitution decision itself; Jev is the decision maker. An assembler that writes a state asserting the answer is within the rules, since Jev still decides, and the trace shows what was done.

### Jev prediction contract

Status: Agreed (Nov 4, 2026), including the question set and the derived-action rule. Jev is a System One model: it takes a `state` and a set of typed `questions` and returns a probability per question, with no generated text. One request per window carries all questions. The environment fixes the question names, types and option keys; the assembler supplies the state text, each question's `instructions`, and the per-option `criteria` descriptions.

| Question | Type | Options | Answer used |
| --- | --- | --- | --- |
| `substitution` | `noul` | — | `noul`, read as P(any substitution) |
| `count` | `score` | ordered levels `none`, `one`, `two`, `three_or_more` | `probabilities` over levels; the argmax level sets k for the derived action |
| `exit` | `choice` | one option per Celtics player on the floor, keyed by player id | `probabilities` over players, read as exit marginals conditional on a substitution |
| `entry` | `choice` | one option per eligible bench player, keyed by player id | `probabilities` over players, read as entry marginals conditional on a substitution |

The environment constructs the `exit` and `entry` option keys from the observable state, so Jev can never name an ineligible player; the agent writes the option descriptions. Validation is per question: a question's answer is valid when it is present, its type matches, every probability is in [0, 1], and, for `exit`, `entry` and `count`, the keys of its `probabilities` map equal the requested option keys exactly, with none missing and none extra. An invalid answer invalidates that question only; the other questions in the same response are scored normally. The failure and its reason are recorded. Nothing is ever repaired, including a map that is one key short.

**Derived action.** Jev returns marginals, not an action. The environment derives `proposed_action` deterministically: if `substitution` < 0.5 the action is empty; otherwise k is the argmax of `count` (with `none` mapped to one, since the timing question already said yes, and `three_or_more` to three), the k highest `exit` probabilities are the players out and the k highest `entry` probabilities are the players in. The rule is part of the harness version.

**Settings, part of the harness version.** Model `jev-1.14.0` by versioned id; the response's `model` field is checked against it on every call. Default context mode: the assembled state plus one question must stay under the 32k-token per-question limit, and the long-context header is never sent, since TypeSafe documents that mode as slower and less accurate. The assembler sandbox refuses a request over the limit and the window is scored as an assembler error. One retry on 429 or transport error, honouring `retry-after`. `usage.input_tokens` and the versioned model id are recorded per window; spend is computed at the pinned price ($0.042 per million input tokens, output free), so a game of a few hundred windows costs cents.

**Determinism.** TypeSafe does not state whether identical requests return identical probabilities. The record stores every response, so scores are reproducible from the record regardless. Agreed (Nov 4, 2026): the pilot replays one development game twice with the same frozen package and reports the per-window probability differences; if they are material, the replay engine's reproducibility claim is stated as record-level only.

**Contamination.** TypeSafe discloses the training method and that customer requests are not used for training, but no training-data sources and no knowledge cutoff. Jev's probe therefore asks typed questions whose answers are regular-season facts (which team won a named game, whether a named player played) with no state beyond the question, and reports discrimination against chance; a model that recovers season outcomes from the question alone is contaminated. The structural defence is stronger than the probe: Jev sees only the assembled state, which the trace records in full, and it cannot read anything else.

**Access.** The TypeSafe credential is `TYPESAFE_API_KEY` in the `nba-agent` Doppler project, `prd` config (added Nov 4, 2026), and is injected only into the runner process. The metering proxy gains a second provider shape for the System One API alongside the Anthropic Messages shape; the replay engine calls Jev only through it, under the `jev` role. OpenRouter also serves `typesafe/jev-1.14`, but the direct API is the pinned route; a route change is a model-roles axis change.

### Replay

For each window in canonical order, the environment builds the observable state from the real game, calls the frozen assembler, sends the state and questions to Jev through the metering proxy, validates and records the answers, derives the action, and scores against the actual decision. The next window is built from the real historical state, not from Jev's proposal; earlier hypothetical substitutions never alter later states. Replay is a trusted environment process; the research agent is not running during it.

### Feedback trace

Status: Agreed in shape; fields Proposed. After replay and scoring, the environment releases the game's trace at the next-morning release. The trace is the same for every variant and contains, per window: the state summary, the diagnostics the assembler returned (components selected, features computed), the assembled Jev request (state, instructions, criteria), Jev's raw answers and their validation result, the derived action, the actual decision, and the per-window scores. Per game it contains the aggregate scores, the invalid-output count and reasons, failure categories, Jev latency and the package manifest hashes.

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

At windows where the coach substituted, regardless of what Jev predicted, score the conditional exit and entry distributions. Jev's `exit` and `entry` answers are single distributions over the eligible set that sum to about one. Proposed normalization: scale the distribution by the number of players actually moved, k, so that an exit score at a two-for-two window compares a distribution of mass two against two actual exits. For the exit side with eligible on-court set E, actual exits A ⊂ E with |A| = k, and normalized marginals q_j:

```latex
\mathrm{exit\ score} = \frac{1}{|E|}\sum_{j \in E} (q_j - \mathbb{1}[j \in A])^2
```

The entry score is the same over the eligible bench. Lower is better. Also report top-k accuracy (the k highest probabilities equal A) and top-1 accuracy (the highest probability is in A). A `probabilities` map whose keys differ from the requested option set is an invalid answer under the Jev contract and takes the invalid-answer score below; there is no per-player zero.

### Action match

Exact match: `proposed_action` equals the actual decision including the no-substitution case. Partial overlap: Jaccard similarity of the proposed and actual moved-player sets, averaged over windows where either is non-empty. Reported, not primary.

### Invalid outputs and failures

| Case | Handling |
| --- | --- |
| A Jev answer is invalid (absent, wrong type, out-of-range value, option keys differ from the request) | That question only takes its fallback: `substitution` 0.5; `count` uniform over its levels; `exit` or `entry` uniform over its eligible set. The other questions in the response are scored as answered. The derived action uses the fallback values. Counted and reported per question with reason. Proposed. |
| Jev call fails at the provider after retries | Window unscored; counted as infrastructure; the game is flagged if more than 5 % of its windows are affected. Proposed threshold. |
| Package fails to load or raises on first window | Session status `invalid_package`; every window of the game unscored; reported |
| Assembler raises, exceeds compute, or returns a request over the per-question context limit on a later window | That window scored as an invalid output; counted under `assembler_error` |
| Window flagged by the decision dataset | Excluded from every score; counted and reported with reason |
| Game postponed or cancelled | Session voided; replayed on the rescheduled date's data |

### Comparison between variants

Compare on matched windows only: identical decision dataset, identical Jev. Windows within a game are correlated, so the game is the unit of uncertainty. Agreed, carried: a paired bootstrap over games, reporting the 90 % interval on each primary score difference, sensitivity to the five most influential games, and within-variant replicate spread where replicates exist. Report cost and time next to every difference, as score per unit cost and per unit time.

Learning curves: each primary score by game index for every variant on the same games. The M0 curve on the same games is the control for schedule and opponent difficulty, not a variant's own early games.

### Baselines

Run on the same windows so the variants have a reference:

- **Constant rate**: p = the warm-up-window substitution rate at every window; uniform marginals. Establishes the floor.
- **Statistical predictor**: a documented simple model from the observable state only (for example a logistic hazard on stint length, period, score margin, fouls and stoppage type, fit on 2024–25 and the warm-up games), with player marginals from stint-length ranks. The conventional benchmark the proposal asks for. Proposed form; the replay MVP fixes it.
- **Generic Jev**: a fixed, hand-written state template and fixed question instructions over the observable state, with no agent-written components. Establishes what Jev does unaided.

Baselines are not variants of the memory axis. If no variant beats the statistical predictor, that is reportable on its own.

## System architecture and module ownership

Six logical modules in one repository, plus external ingestion. These are ownership boundaries, not deployed services.

| Component | Owns | Does not own |
| --- | --- | --- |
| External ingestion | Collecting, normalising and preserving source records with provenance | Run-specific access rules |
| Runner | Configuration, schedules, budgets, run isolation, checkpoints, controlled clock, the metering proxy for both model roles | Basketball reasoning, replay construction |
| Environment | Read adapters, temporal filtering, workspace tools with memory-permission enforcement, the research sandbox, package freeze, feedback release | Agent research strategy or memory contents |
| Replay engine | The decision dataset, observable-state construction, the assembler sandbox, Jev calls, validation, the trace | Scoring policy |
| Agent harness | The research agent's reasoning loop and prompts. v3 runs Pi through its SDK; the v2 homemade loop stays as a fixture implementation | Workspace enforcement, sandbox lifecycle, metering, replay |
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
                            |    state <- real game ; request <- assemble(state)|
                            |    answers <- Jev(request) via proxy ; validate  |
                            +-------------------------------------------------+
                                                              |
        7. postgame session: cutoff = 9 a.m. next day         | 5. trace frozen
        v                                                     v
  +-----------+  read_feedback(game)       released trace (states, diagnostics,
  |  Harness  | <------------------------  requests, Jev answers, actuals, scores)
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

Status: Agreed (Nov 4, 2026), including the audit method. The best-practices document and skills must stay coach-agnostic. The agent may not use them as a disguised coach profile or embed team-specific historical labels in a generic skill. Boundaries are light and auditable, not a schema: a reviewer reading `best_practices.md` should find no Celtics player names, no Celtics-specific rotation facts, and no game-specific records. The audit is a per-game automated check (Celtics player and staff names and game ids against `memory/best_practices.md`, `memory/practices/` and `skills/`, flagged to a human queue, never auto-edited) plus an end-of-run human sample of ten reads per generic file. A confirmed breach is reported as a confound on that variant, never corrected after the fact.

### Memory budget

Status: Agreed (Nov 4, 2026). The total retained text in `memory/` is capped at 50,000 tokens, measured with the analyst model's tokenizer, for every variant that has any memory gate on, measured at each checkpoint and reported per game. A write that would exceed the cap is refused with the current size named. Executable skill size and skill runtime cost are accounted separately and reported, not capped in the first stage.

## Replay lifecycle and environment tool surface

One game runs through six phases. The runner requests transitions; the environment enforces their validity. The agent cannot advance time.

1. Initialize: validate configuration, dataset coverage and the decision dataset for the game; create the isolated run, workspace and record.
2. Pregame: freeze the cutoff at the scheduled start. The research agent reads the previous trace and its permitted memory, researches with the tools, writes the package and calls `freeze_package`. Enforce the research budget.
3. Freeze: validate the package (loads, entry point present, manifest hashes match, state schema version supported), snapshot it, lock the package directory. Idempotent on an identical package.
4. Replay: trusted. Build windows, run the assembler and Jev, validate, record. No agent session.
5. Postgame: advance the clock to 9 a.m. America/New_York on the morning after the game. Release the trace and the game's data. Run the reflection session: the agent reads the trace and updates permitted memory within the postgame budget. Nothing is required of it in the first stage; mandated reflection is a later value of the process sub-axis, as in v2.
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
| Validate package locally | Run the assembler against a small set of sample states from eligible prior games and return the assembled requests and diagnostics, so the agent can test before freezing. Does not call Jev. Costs research compute. | New, Agreed (Nov 4, 2026) |

### Code execution sandboxes

Two sandboxes, both per-session Docker containers from pinned images on the harness host, no network, image digests in the harness version. Agreed, carried in form.

- **Research sandbox**: as in v2. Python with pandas, numpy, scipy and scikit-learn over the cutoff-filtered SQLite export and source files, a scratch directory, and the workspace mounted with the run's permissions. Used by the research agent in pregame and postgame.
- **Assembler sandbox**: minimal Python, no data mounts beyond the frozen package and a scratch directory, no workspace, a strict per-window wall-clock and memory limit. Used by the replay engine. The planted-future-record fixture applies: a future record on the host must be invisible from inside both containers.

## Harness contract

Carried, Agreed, with the harness choice made Nov 4, 2026. The research-agent harness receives three handles and nothing else: a session endpoint exposing the tools above, a metered model endpoint for the analyst role, and the memory-permission instructions for its prompts. It holds no credentials, data paths or direct workspace access. Every model call for either role passes through the runner's metering proxy, which pins the model and settings per role and records usage. Jev is called by the replay engine through the same proxy under the `jev` role; the harness never calls Jev.

### Pi as the v3 harness

The research agent writes code, and a coding-agent harness is better at that loop than the hand-written one v2 used. v3 runs Pi (`@earendil-works/pi-coding-agent`, MIT, SDK mode) as the harness implementation. Requirements, each an acceptance item for the harness issue:

- **Same contract.** The Pi harness is one implementation of the runner's `Harness` function, receiving the three handles. The v2 homemade loop stays as a second implementation for fixtures and as the fallback. Choosing between them is a harness-version field.
- **No built-in tools.** Pi's file, shell, search and web tools are disabled. The environment's tools are registered as Pi extension tools, and a `tool_call` hook refuses any tool name that is not one of ours. The only writable surfaces remain the workspace tool and the research sandbox.
- **Model access only through the proxy.** Pi's model provider is configured with the proxy's base URL and the scoped per-session key the runner issues; no provider credential reaches the harness process. If Pi cannot be pointed at an Anthropic-Messages-compatible endpoint with a custom base URL, that is a blocker for the harness issue, not something to work around with a real key.
- **No persistence outside the record.** Sessions are in-memory; Pi's own session files, settings directories, skills and extension discovery are off. Each phase is a fresh conversation. The full message history, tool calls and results are copied into the experiment record at the end of each run from Pi's events, so the record does not depend on Pi's storage.
- **Prompts owned by the brief.** Pi's default system prompt is replaced entirely with the v3 system prompt and phase prompts; nothing from Pi's defaults or the host's Pi configuration is appended.
- **Budget stops.** The proxy's budget refusal ends the run through the harness's abort; Pi has no turn cap of its own, so the budget is the limit, as in v2.
- **Harness version.** Pi's package version, the extension and tool definitions, the prompt overrides, the model-provider configuration shape and the harness code revision are all in the harness version. Upgrading Pi is a new harness version and no run spans it.

The v2 brief's rule stands: gate tests for isolation run against whatever harness is configured, and a third-party harness that ships its own file or shell tools must have them disabled or pointed at nothing.

## Run profile

Every run declares a profile on four axes, printed on every report. A comparison must name which axes differ.

| Axis | What it declares | v3 values |
| --- | --- | --- |
| Memory permissions | Which persistent directories exist for the run, each with read, create and revise rights | Three gates: coach profile, best practices, skills. First stage: M0 none; M1 coach; M2 practices; M3 coach and practices; M4 coach, practices and skills. Later: representation variants (episodic store, hypothesis ledger, player profiles) and management variants (append-only, periodic consolidation, retrieval) as named values |
| Data sources | Which source types the environment exposes, each with its pinned release | Coach transcripts, play-by-play and box scores, injury reports, starting lineups, beat reporting, player reference, game lines (scheduled-start Celtics spread and game total, in the research agent's session context only) |
| Agent capabilities | What the research agent can do within a game | Search and fetch, game-history queries, workspace, research sandbox, local package validation |
| Model roles | Which pinned model serves each role, with settings | analyst `claude-opus-4-6`; jev `jev-1.14.0` via the TypeSafe System One API. Later: reflector, critic |

Rules carried from v2: axes are enumerated and versioned; adding a value never changes an existing one; data sources are declared by type and manifest, not by what was read; model roles are pinned per role and a different version in any role is a different value.

### Per-run descriptors held fixed within a comparison

| Descriptor | What it declares |
| --- | --- |
| Research budget | Pregame and postgame token caps, cache-read weight, compute caps for the research sandbox, the memory token cap, tool-call and wall-clock ceilings, the pinned price schedule. A named, versioned budget profile. |
| Harness version | Harness identity (Pi and its package version, or the homemade loop), prompts, memory-permission instructions, tool definitions, loop parameters, SDK versions, both sandbox image digests, the state schema version, Jev's question set, settings and derived-action rule, the assembler API version, the code revision |
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

Status: Agreed (Nov 4, 2026). Games 1–10 are development games for prompts, budgets and tooling and are never evidence (carried). Games 11–20 are warm-up: run for every variant so memory accumulates, reported but not in the headline. Games 21–70 are the scored rolling sequence. Games 71–82 are the untouched holdout, revealed once with learning frozen.

Any prompt or harness change after scoring begins restarts the scored run. The holdout is either run with learning frozen or revealed once under a prespecified protocol; it is never tuned against.

## Data contracts and temporal access rules

Status Agreed, carried in full from the v2 brief (decided Oct 23 and 24, 2026) and restated here so that this brief is the only document an implementer needs. The environment consumes each source's published, immutable, hash-manifested release as-is, including derived tables that ingestion has already computed (play-by-play lineups and stints, injury team snapshots, beat-post relevance labels, extracted starting lineups, derived game lines). It does not recompute them. The environment's responsibilities are verification against the manifest, temporal filtering, visibility projection and canonical ID joins. Each release identifier is the dataset manifest version on the data-sources axis; a different release is a different data-sources value. The bucket guides in `docs/data-descriptions/` are the reference for layouts and field semantics.

Every source has a stated availability convention. These are replay conventions, not measured delivery times: each guide says its timestamps do not certify when bytes were publicly accessible. The convention is recorded as the eligibility reason on every record.

| Source | Bucket and prefix | Pinned release | What the environment exposes | Availability time |
| --- | --- | --- | --- | --- |
| Play-by-play, box scores, lineups, stints | `sports-nba-data`, `nba/releases/spo-839-full-v1-2025-26/` and `nba/releases/spo-839-full-v1-2024-25/` | Each release's `manifest.json` | Release tables per the data dictionary (`config/dictionaries/pbp-0.1.0.md`). `coverage.jsonl` is consulted per game; a game not `valid` for the product being queried is served as absent with a recorded reason. In v3 the same release is also the source of the decision dataset; the replay engine reads the replayed game at full fidelity while the agent still sees only released games. The `spo-839` releases, pinned Nov 5, 2026, add the feed's `qualifiers` array to events and apply the SPO-771 fixes to every game, where the `spo-771` releases had applied them to only the 576 games expected to change. For every Celtics game the events, participants, lineup, stint and coverage tables are otherwise unchanged; the remaining differences are provenance columns in the possession and enriched-event views with no published value changing, plus three non-Celtics 2025–26 games whose `summaries` fall to `partial` for a plus-minus defect tracked upstream as SPO-843. The pin was a data-sources version change only; the decision dataset is unchanged because `windows-v1` reads no changed field. | Postgame release at 9 a.m. America/New_York on the morning after the game. 2024–25 games are eligible from the start of the replay. |
| Injury reports | `sports-nba-data`, `nba/injury-reports/2025-26/` | Release key `61f65449f459752a0ad06c0f41efd1cc8c13494f7b5f9c838f6536637c411c2e` | Curated player observations and team snapshots as the PDF showed them, including `not_yet_submitted` placeholders and absent-team observations. The evidence register, `empty_report_corroborated` interpretations, and anything carrying an assessment time are retrospective and never agent-visible, and never enter the observable state. Unmatched rows excluded. In v3 the last pregame-eligible report also feeds the eligible bench in the observable state; a player listed out is removed, anything else is left in. | Printed report timestamp (`report_timestamp_utc`). A row whose UTC value is null because of daylight-saving ambiguity takes the later of the two readings. A `team_absent` snapshot (Boston, Apr 7, 2026, `0022501149`, printed 23:00Z) is served as unknown, never as a healthy roster, and no earlier report is carried forward; for the eligible bench that game uses the full roster and the window is tagged `availability_unknown`. |
| Player reference | `sports-nba-data`, `nba/player-reference/2025-26-opening/releases/15fef7276244e616b0817be4/` | Manifest SHA-256 `7d9e7802344e90852d55eee4895b305a24a4f59e46fd18d87915b17ecfd8837f`; coverage summary in `docs/p1-data-adapters.md` | Release tables and SQL views only: opening roster profiles, career season totals through 2024–25, identity exceptions. `archive/` is never mounted or exposed. | Static. Built to a cutoff of 2025-10-21T23:29:59Z, before the opener, so eligible for every game. Age is computed for the replay date. |
| Beat reporting | `sports-text`, `v1/relevance/celtics-2025-26/` | The snapshot manifest that `active.json` pointed to at pin time (hash in `config/datasets.json`), over backfill report `a57664cd-e4d8-4aaf-9741-1ac0b6b4fcf1` | Only posts labelled NBA-related (1,303 of 1,425 at pin time), latest retained version, with text, author handle where the release carries it, publication time and relationships. Unrelated posts are not exposed. The label policy (relevance labeller Jev 1.14.0, threshold 0.10) is part of the pinned manifest. Label precision is accepted with a recorded limitation: in the P1a sample of 50, 33 were verifiably basketball, 0 demonstrably off-topic, 17 could not be judged from retained text. | Publication time of the version. A later version whose edit time is known is available at that time; one whose edit time is unknown is excluded rather than shown at the original time. |
| Starting lineups | `sports-text`, `v1/research/celtics-lineups/extracted-2026-10-16/` and `v1/research/opponent-lineups/2026-10-19-complete/` | SHA-256 of the two JSON datasets | Announced starters per team, the preferred announcement per game, with source post and posting time. Alternates retained as evidence, not exposed. Announced lineups that disagree with box-score starters stay as announced. In v3, pregame-visible announced starters also enter the observable state's pregame context. | Posting time of the announcement. Eligibility against the scheduled start decides whether a game's own lineup is pregame-visible. The 18 Celtics and 7 opponent announcements posted at or after the scheduled start, including the two posted at exactly that instant, are unavailable for their own game. They are not backdated and no game moves to actual tip. |
| Coach media | `sports-transcription`, `dev/manifests/bos/<media-id>/<run-id>.json`, selected by the season manifest index at repository commit `cc28535292efc47316c163c6969d759875e95f86` (134 recordings) | The index plus each manifest's checksums; the index's `published_at_provenance` and `livestream_provenance` hashes | Readable transcript and structured transcript with provider speaker-cluster labels (not identities), title, source URL, publication time. Audio not exposed. | `published_at` (UTC, second precision, the indexed video's publication) for ordinary uploads. For the 10 livestreams and premieres, `stream_ended_at`, so a recording is visible only once the whole broadcast existed. An entry with `published_at_precision = day` would take the end of its Eastern `publicationDay`; none exist. An entry with `cutoff_requires_review = true` is excluded until reviewed; none exist. Title words are not availability evidence: the Nov 5, 2025 upload titled pregame for `0022500174` was published 87 seconds after the scheduled start and is unavailable for that game. Two transcription defects found by P1a (Jan 17 pregame at 38–52 s, Nov 11 pregame at 77–90 s) are flagged upstream; the immutable text is served as published. |
| Schedule | Play-by-play release games table, cross-checked against the ESPN schedule preserved in the odds archive (`reference/schedule-response.json.gz`) | As above | Game identities, opponents, scheduled start, venue, status (final, postponed, cancelled) | Static for the season; schedule changes, if any, are recorded with the change's own timestamp. Game status is never visible before the game's release. |
| Game lines | `pm-data-platform`, pinned odds `derived/v3` spreads and team totals, reached through the consensus source manifest (SPO-829) | Source and quotes hashes and the `game-lines-v1` adaptation hash in `config/datasets.json` | The scheduled-start Celtics spread, derived game total and implied team totals with contributor counts, in the research agent's session context only, as the `game_lines` data-source value. Never in the observable state, the assembler or Jev. The player-prop consensus layer is not exposed in v3. | `requested_at` of the observation, including equality with the scheduled start. |

### Shared contract requirements

- Stable canonical game, team and player IDs with explicit mappings from provider IDs: ESPN event ids in the odds archive, NBA game and player ids in the NBA data bucket, X account and post ids in the text bucket, media ids in the transcription bucket. Never join on ambiguous names. The mappings are checked in at `config/identities.json`.
- Name joins (lineup names and injury names, which carry no player id) resolve only when exactly one candidate exists in the pinned catalogs after normalization; otherwise they fail and are reported. Agreed exceptions (Oct 24, 2026), each scoped to the injury source and backed by audit evidence: `Yang, Hansen` is an alias for `1642905` (the catalog prints the family name first); `Williams, Jaylin` resolves by the injury row's `team_id`, Oklahoma City to `1631119`, with `1642444` kept as a distinct person. `Jones, Dillon` stays refused until the play-by-play maintainers publish an identity exception for `196295686`; its observations are served unresolved and the incomplete opponent join for `0022500757` is recorded. No other alias or disambiguation rule exists; adding one is a brief change.
- Every release is immutable and hash-manifested. The adapter verifies every object it reads against the manifest before serving it and refuses an unverified object. Folder listings are never used to assemble a dataset.
- Separate event time, availability time, collection time and revision time. Each record carries its availability time and the convention that assigned it, from the table above.
- Preserve corrections and revisions where the source has them (post edit chains, injury report updates, multiple transcript runs). Where history cannot be reconstructed, the table's exclusion rule applies and is reported.
- The P1a data quality audit (`docs/p1a-data-quality-audit.md`, Oct 24, 2026) passed with eight accepted dispositions: the two injury-name rules above; Dillon Jones refused; at-or-after-cutoff lineup announcements unavailable including equality; title words never imply availability; `team_absent` served as unknown; relevance labels accepted with the 17-of-50 unverifiable limitation; two transcription defects flagged upstream with text kept. None changes a cutoff or a release.

### Temporal access rules

Apply the cutoff to every access path: search, direct fetch, metadata, aggregates, snippets, derived views, pagination and the sandbox export. A query for a future record must not expose its title, existence, count or contents. Derived statistics use only eligible observations. Agent requests cannot override the session cutoff, run identity or dataset version.

The pregame cutoff is the scheduled start, not the actual tip. Non-odds records are eligible when their availability time is strictly before the cutoff; the game-lines observation requested at the scheduled start, whose availability time equals the cutoff, is eligible. Anything published between scheduled and actual tip is excluded, which is conservative. If a game's scheduled start is revised, use the final scheduled start. The postgame cutoff is 9 a.m. America/New_York on the calendar morning after the game date; news published after 9 a.m. remains unavailable at that release.

An old recording transcribed today represents information available at its publication, provided the transformation uses only that recording. A retrospective article written today cannot be backdated. Reconstructed data is not necessarily a faithful snapshot of contemporary corrections.

One rule is new in v3: the replay engine's access to the game being replayed is not a cutoff violation, because the agent is not running and the package is frozen. The engine's reads are recorded, and the trace released to the agent at the postgame cutoff is the only path by which replay data reaches it.

### Game data scope

The two pinned play-by-play releases cover all teams for 2024–25 and 2025–26 (1,394 and 1,393 inventory games), with 44 gap games across the two seasons listed in the releases' coverage records: the 41 carried from `spo-771` and three non-Celtics 2025–26 games whose `summaries` are partial for a plus-minus defect (upstream SPO-843). Three involve the Celtics and all three have play-by-play: Celtics–Knicks `0022400061` (Oct 22, 2024, broken substitution chains, so lineup, stint and possession products are incomplete), Celtics–Raptors `0022400230` (Nov 16, 2024, fifth overtime player unidentified), and Celtics–Lakers `0022500338` (Dec 5, 2025, play-by-play-derived statistics disagree with the official box score, summaries partial). The two 2024–25 games are historical evidence only and their incomplete products are served as absent under the coverage rule. The Dec 5, 2025 game is in the scored window; its windows are built and scored with the `unqualified_running_box_score` flag described under Decision windows. Phases are separated in the tables; preseason, play-in, Cup final and playoff rows are excluded. Opponent substitutions can occur inside an own-team lineup stint, so opponent-context queries use event-level segments, which the release's stint tables already provide.

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

Agreed, carried and extended. Every scored claim must be reconstructible from the record alone. The record is an append-only, hash-chained SQLite event log plus content-addressed workspace blobs, checkpointed after every session and synced to R2 for scored runs.

- Run manifest: team, season, game list with the development, warm-up, scored and holdout tags, run profile (memory permissions with each gate's read, create and revise rights; data sources with manifest versions; agent capabilities; model roles with pinned versions and settings), research budget profile with its full numbers including the memory cap, harness version with every resolved component, decision dataset version (release manifests plus window-definition version), state schema version, replicate id, code revision, contamination probe records for both roles, and all policy settings.
- Session record: game, phase, cutoff, attempt number, every tool request and its observation (or a replayable reference), every model request and response including thinking blocks where the provider returns them, token counts by class, errors, retries, completion status, and which limit ended the session.
- Package record: the frozen package's files and their hashes, the freeze receipt and timestamp, the validation result, and every local-validation call the agent made with its inputs and outputs.
- Window record: window id, canonical sequence position, the observable state, the assembler's diagnostics and compute time, the assembled Jev request, Jev's raw response with the versioned model id and `usage`, per-question validation results, the derived action, the actual decision, per-window scores, Jev latency, and any flag or failure reason.
- Trace record: the released trace exactly as the agent saw it, with its release time.
- Code execution record: every program the agent ran in the research sandbox, with stdout, stderr, exit status, compute seconds and whether a limit truncated it. Programs are stored verbatim so a result can be re-derived.
- Workspace checkpoints: snapshots before and after each session, diffs, and the measured memory size at each checkpoint.
- Boundary audit record: every flag the content check raised, the text it matched, and its human disposition.

### Learning diagnostics

Carried in intent. For every variant with a memory gate on, collect reviewed examples of stale beliefs, useful transfer and repeated errors from the workspace diffs and the traces, and report them next to the scores. A score difference without a workspace change that explains it is not a learning claim.

### Contamination

Carried, Agreed. Before any scored run, probe each pinned model for outcomes in the replay window and store the result in the manifest. The analyst probe is the v2 no-tools probe. The Jev probe is the typed-question probe described in the Jev contract, since Jev takes no free-form prompt and TypeSafe publishes no cutoff. The user accepted Jev with that disclosure gap on Nov 4, 2026, on the grounds that Jev reads only the assembled state and the trace records it; the probe result is reported with every run so a reader can weigh it.

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
| Research-agent model | `claude-opus-4-6`, re-verified at pin time. Nov 4, 2026. |
| Jev | TypeSafe Jev `jev-1.14.0` through the direct System One API, credential in Doppler, called only by the replay engine through the proxy. Alias ids never used. Nov 4, 2026. |
| Harness | Pi through its SDK as the v3 harness implementation under the carried harness contract; homemade loop retained for fixtures; swap is a harness-version change. Nov 4, 2026. |
| Game split | Development 1–10, warm-up 11–20, scored 21–70, holdout 71–82. Nov 4, 2026. |
| Memory cap | 50,000 tokens of retained text in `memory/`; skills uncapped and reported in the first stage. Nov 4, 2026. |
| Content-boundary audit | Automated name check into a human queue, end-of-run sample, breach reported as a confound. Nov 4, 2026. |
| Jev question set and derived action | The four fixed questions and the argmax rule in the Jev contract; part of the harness version. Nov 4, 2026. |
| Jev determinism | Double replay of one development game in the pilot; reproducibility stated as record-level if probabilities differ materially. Nov 4, 2026. |
| Game lines as context | Scheduled-start spread and total in the research agent's session context only. Nov 4, 2026. |
| 2024–25 as evidence | Eligible from the start of the replay, as in v2. Nov 4, 2026. |
| Reflection | Voluntary for every first-stage variant; mandated reflection is a later process value. Nov 4, 2026. |
| Local package validation | Provided, over states from eligible prior games, without calling Jev, costing research compute. Nov 4, 2026. |
| State schema | `state-v1` as tabled; SPO-837 amendments are brief changes. Nov 4, 2026. |
| Decision windows | `windows-v1`: independently marked openers, snapshot after the opener, adjacency rule, between-period windows, unanchored ledger; the restricted estimand is stated wherever a rate is reported. No team-rebound opener: the restored `qualifiers` show that `deadball` marks missed-free-throw dead-ball context, not out-of-bounds stoppages (SPO-839 pin, Nov 5, 2026). Nov 2026. |
| Carried from v2 | Team, season, data contracts, availability conventions, cutoff and release rules, isolation, metering, sandbox form, record, contamination probe, replicate policy, paired bootstrap over games, development games never evidence, harness contract, implementation choices (TypeScript on Node, SQLite plus files, adapters over R2, Docker sandboxes, in-process transport) |
| Repository | v3 is built in the existing repository; prop-task code removed and v2 docs archived by SPO-835. |

## Open decisions and remaining Proposed items

One decision is Open, by design. Everything proposed in the first draft's Open table was accepted on Nov 4, 2026 and is in Resolved decisions. The decision-window definition was adopted as `windows-v1` by the brief change that followed SPO-837. Several contract details remain Proposed: under this brief's rules they are buildable defaults for the first implementation, not requirements, and an implementer may raise a brief change against any of them before scored runs begin. They are listed here so that the accounting is explicit.

| Status | Item | Where | Resolution path |
| --- | --- | --- | --- |
| Open | Budget numbers | Research budget | Set by the pilot procedure: development games on M3 at effort `high` with code execution on, caps at the 90th percentile, re-runs at a smaller and a larger pregame cap, recorded as budget profile v1. |
| Proposed | Package detail: component layout, entry-point signature, manifest fields | The task, Policy package | R3 implements as written; the first hand-written package in gate 2 is the review. |
| Proposed | Trace fields | The task, Feedback trace | R3 implements as written; reviewed with the gate-2 trace. |
| Proposed | Player-selection normalization (scale by k) | Scoring, Player selection | R2 implements as written with a hand-computed fixture; alternatives are a brief change. |
| Proposed | Invalid-answer fallbacks and the 5 % provider-failure flag | Scoring, Invalid outputs and failures | R2 implements as written with a scorer fixture for the per-question rule. |
| Proposed | Statistical predictor form | Scoring, Baselines | R2 fixes the model and documents it. |

The scoring contract R2 builds against is therefore: the timing and selection equations (Agreed), the per-question validation rule in the Jev contract (Agreed), and the two Proposed rows above, which R2 implements as written and covers with fixtures. A later change to any of them before scoring begins is a brief change; after scoring begins it restarts the scored run.

## Implementation projects

Seven projects, each one or more Linear issues in `nba-agent-v2`. The decomposition follows the proposal's plan. P1 through P4 of v2 (data adapters, audit, environment, runner, harness loop) are inputs, not rebuilt.

### R0 Repository reset

Complete (SPO-835). Prop-task code removed, v2 docs archived, entry points rewritten.

### R1 Decision-window feasibility

- Inputs: the pinned play-by-play releases, the data dictionary.
- Outputs: `docs/v2/decision-windows-feasibility.md` with counts for stoppage identification, substitution grouping, lineup completeness, fouls, period boundaries and ordering; a three-game hand audit; a proposed window definition in release fields.
- Acceptance: every question answered with counts; audit disagreements listed; the definition uses only fields in the release.
- Status: SPO-837 report and follow-up merged (PRs #37, #39). Upstream SPO-839 restored the feed's `qualifiers` on events in the `spo-839` releases, pinned here Nov 5, 2026; the report's release update records what they showed and withdraws the team-rebound opener.

### R2 Replay MVP

- Inputs: R1's definition, this brief's state schema, prediction contract and scoring.
- Outputs: the decision dataset builder; `state-v1`; the prediction contract and validation; the scorer; the constant-rate and statistical baselines; window and trace records in SQLite.
- Acceptance: windows on the audited games match the hand check or disagreements are listed; the planted future record never appears in a state; invalid answers are detected per question with reasons; hand-computed scores for a five-window fixture match, including one window with an invalid `entry` answer and valid `substitution` and `exit` answers, which must score the fallback for `entry` only; the statistical predictor is documented.
- Status: SPO-838, open; unblocked by this brief change. R2 builds `windows-v1` against the pinned `spo-839` releases; there is no team-rebound opener to switch on.

### R3 Package, assembler sandbox and Jev

- Inputs: R2; the package contract; the Jev contract.
- Outputs: `freeze_package` and its validation; the assembler sandbox image and per-window execution; the System One provider in the metering proxy and the `jev` role; Jev request construction, validation and the derived-action rule; the generic-Jev baseline; the trace builder; `read_feedback`; the local-validation tool; the Jev typed-question contamination probe.
- Acceptance: a frozen package cannot be modified; the assembler cannot reach the network, the workspace or the host; the same package and state yield the same request; every Jev request and answer is in the record with the versioned model id and token usage; a request over the per-question limit is refused; the trace contains no window after the released game.
- Status: to be filed after R2.

### R4 Memory permissions and reflection

- Inputs: the directory permission model; the memory cap; the content-boundary check.
- Outputs: permission-gated workspace policy per variant; mounts that follow permissions; the memory size meter and cap; the automated boundary check and its human queue; the postgame reflection session; configuration schema supporting every named memory value without implementing second-stage representations.
- Acceptance: a gated-off directory is unlistable, unreadable, unwritable and unmounted; a write over the cap is refused with the size; the check flags a planted player name in `best_practices.md`; M0 retains nothing between games while still reading the previous trace.
- Status: to be filed after R3.

### R5 Pi harness, prompts and pilot

- Inputs: R3, R4; the harness contract; the research-budget procedure.
- Outputs: the Pi harness implementation (in-memory sessions, built-in tools off, environment tools as extension tools, `tool_call` refusal of unknown tools, prompt override, proxy-only model access, history copied to the record); the v3 system and phase prompts and memory-permission instructions; the analyst and Jev contamination probes; the development-games pilot on M3 including the double replay; budget profile v1 proposed.
- Acceptance: the isolation gate tests pass against the Pi harness; a run with a real provider key in the harness environment is impossible by construction; Pi's own storage directories are untouched after a run; changing any prompt, Pi's version or a tool definition changes the harness version; the probes are stored; the pilot observation is written up as a pilot, not evidence.

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
2. **One real game end to end.** A hand-written package through R3 on an audited game; the trace released at 9 a.m.; the assembler sandbox passes the isolation fixture; Jev answers validated, actions derived and scored; generic-Jev baseline runs.
3. **Several chronological games with memory.** M3 and M0 on the development games through R4 and R5 under the Pi harness; M3's memory persists and M0's does not; the boundary check runs; a forced crash mid-game resumes without a duplicate freeze or replay; the previous trace is readable and older traces are not.
4. **Scored comparison.** Open decisions resolved; probes stored; budget profile v1 recorded; M0 through M3, one replicate each, on the scored games; report generated from the record alone; the holdout untouched.

Minimum acceptance checks across all gates:

- Future evidence is unreachable by every agent path, including both sandboxes.
- The assembler never receives the actual decision or anything after the window.
- A frozen package is immutable through retries, crashes and later evaluation.
- Flagged windows and invalid outputs are excluded or scored by rule, never silently repaired.
- Variants share no private memory, and generic memory carries no coach-specific content.
- Failed sessions, flagged windows and unresolved games remain visible in every report.
