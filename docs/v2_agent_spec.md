# Celtics Coaching Policy Agent — Experiment Specification

**Status:** Proposed; revised November 4, 2026  
**Initial scope:** Boston Celtics; chronological historical-game replay, with full-game simulation as a downstream evaluation  
**Core research question:** Which types of accumulated knowledge and memory management help an autonomous research agent become better at encoding a coach's substitution tendencies into a decision policy?

## 1. Objective

Build an expert agent that studies the Celtics and, **before every game**, prepares a game-specific, executable prompting system for a fast, inexpensive decision model ("Jev"). At actual substitution-eligible moments in a historical replay, Jev predicts whether the Celtics coach substituted, and which players entered or exited. Compare predictions with the coach's actual decisions.

The agent produces two **pregame artifacts in every experimental variant**:

1. **Prompt components:** Instructions, examples, and context about expected rotations, lineup preferences, player roles, matchups, and exceptions.
2. **Deterministic assembly code:** Code that reads the current observable game state, derives features, chooses or parameterizes components, and constructs the prompt Jev receives.

After a game, the agent receives a detailed performance trace and can reflect on its decisions. **The primary experimental manipulation is what the agent may preserve between games**, not whether it must use static prompts or dynamic code. Some variants can maintain a coach profile, general best-practices guidance, reusable skills, or other memory. Others cannot.

The agent's task is to predict **what the coach would do**, not prescribe what the coach should do. The main outcome is out-of-sample substitution-prediction quality. In a later simulation experiment, measure whether the learned policy improves player-minutes distributions and rotation realism.

**Design principle:** Hold the task, tools, data availability, pregame deliverables, Jev interface, and evaluation constant; vary the persistent knowledge available to the research agent.

## 2. System architecture

### 2.1 Research agent: pregame preparation

Available pregame inputs, subject to a strict historical cutoff:

- Prior Celtics and opponent play-by-play, lineup and substitution histories, player minutes and stints, fouls, and game context.
- Rosters, schedule, known injuries and availability, starting-lineup reports, and opponent context known before tipoff.
- Timestamped coach press conferences, beat reporting, and other permitted historical text.
- Research, data-query, code-writing, and sandboxed testing tools.
- The **same immediately preceding game's replay feedback** for all variants; plus only those persistent memory artifacts permitted by the assigned ablation.

The research agent freely chooses what to investigate and how to encode its findings. Before tipoff it writes a **frozen policy package** with prompt components, deterministic assembly code, and configuration. The package is versioned and never changed during that game's replay.

### 2.2 Deterministic prompt assembler

At each legal decision window, the evaluator supplies the observable state to the frozen assembly program. The program can compute derived features, select and order prompt components, and assemble Jev's input. For example, it can consider score differential, game clock, current lineups, accumulated minutes, stint lengths, fouls, player box scores **so far**, and substitutions **so far**.

```text
build_prompt(frozen_pregame_package, observable_game_state)
    -> { prompt, diagnostics }
```

The assembler is deterministic and sandboxed: no future data, internet, new LLM calls, hidden evaluation labels, or file mutations. It must not directly produce the final substitution action; **Jev is the action decision-maker**. Diagnostics identify the components selected and features computed.

### 2.3 Jev and prediction contract

Jev receives the assembled prompt and returns:

```text
{
  p_any_substitution,
  p_exit_by_player,            // conditional on a substitution
  p_entry_by_player,           // conditional on a substitution
  proposed_action: {
    players_out: [...],
    players_in: [...]
  }
}
```

An empty action means no substitution. The evaluator validates roster eligibility, equal incoming/outgoing counts, and five-player lineup legality. Player-level entry/exit probabilities are marginal scores, not a joint distribution over every multi-player action.

Use the **same Jev version, output schema, inference settings, state schema, and validation rules** across all research-agent ablations.

### 2.4 Independent evaluation harness

The harness—not the research agent—controls data access, chronological cutoffs, legal decision windows, replay construction, scores, baselines, and withholding/release of outcomes. It logs complete policy artifacts and decision traces. Agent-written code and skills run in a restricted sandbox and cannot edit the harness.

## 3. Chronological replay and reflection loop

### 3.1 Decision dataset

Reconstruct every reliably identifiable substitution-eligible window in each held-out Celtics game, **including windows where no substitution occurred**. Combine simultaneous substitutions into one decision; evaluate between-period lineup changes separately. Exclude or flag ambiguous ordering and eligibility.

The decision state includes only observations available **before** that substitution decision: quarter, clock, score, stoppage type, lineups, eligible bench, minutes and stints to date, fouls, contemporaneous box scores, prior substitutions, and known availability or opponent behavior. A later substitution during the same stoppage is not a permissible feature if it was not yet observable.

### 3.2 Per-game procedure

1. **Pregame:** Give each variant the same public/history inputs, immediately prior replay feedback, and its authorized persistent memory. It researches and freezes its prompt components and assembly code.
2. **Replay:** At every eligible window, reconstruct the real observable state, run the assembler, collect Jev's probabilities and proposed action, and score against the actual coach decision.
3. **Reset:** For the next decision, return to the **actual** historical state. Do not let earlier hypothetical substitutions alter subsequent replay states.
4. **Feedback:** Release the completed game's detailed replay trace after its evaluation: policy/code versions; selected components at each window; the actual assembled prompts and Jev outputs; the observed decisions; and scores, errors, and failure categories.
5. **Reflection:** Give the agent a bounded reflection opportunity. It may update only memory artifacts allowed by its assigned ablation. The newly written memories are accessible beginning with the **next** pregame preparation.

All variants receive the same feedback format and reflection opportunity. The feedback is an observation, **not itself a durable memory artifact**. A variant with no persistent memory can inspect and critique it but cannot retain notes or modified skills across games.

### 3.3 Data schedule and release policy

Use a strictly chronological, *prequential* evaluation: predict Game N with only information available before Game N, score it, then release its feedback before preparing for Game N+1. An illustrative pilot uses the first ~20 games as historical warm-up, followed by a scored rolling sequence. The exact warm-up and evaluation windows should be fixed before running comparisons.

Reserve an **untouched final chronological holdout** for confirmation. Either freeze learning throughout that holdout or use a prespecified sequential reveal protocol; do not repeatedly tune experimental choices against it. Preserve all intermediate policy versions, memory snapshots, and cutoffs. Repeat complete runs where feasible to assess stochastic variability.

## 4. Memory and artifact contracts

Keep **ephemeral per-game artifacts** separate from **persistent cross-game knowledge**.

| Artifact | Purpose | Persistence |
|---|---|---|
| Pregame policy package | Components and deterministic code Jev uses in one game | Frozen for that game; retained for audit, not automatically reusable by the next-game agent |
| Replay feedback | What was assembled, what Jev predicted, what happened, and evaluation diagnostics | Previous game's trace supplied to every variant; older traces not retained as private memory unless an ablation permits it |
| **Coach profile** | Reusable hypotheses, evidence, and conclusions about this coach/team's behavior | Only when coach-memory capability is enabled |
| **Best-practices document** | General techniques for researching, coding, and prompting effective substitution policies | Only when procedural-memory capability is enabled |
| **Custom skills** | Reusable agent-authored workflows, code, helpers, and instructions for doing the research/policy-authoring task | Only when skill-memory capability is enabled |

Examples of persistent workspace structure (capability-gated):

```text
memory/
  coach_profile.md
  best_practices.md
skills/
  ... agent-authored, sandboxed skill files ...
packages/<game_id>/
  components/
  assemble.py
  manifest.json
feedback/<game_id>/
  replay_trace.jsonl
  scores.json
```

Ablations control what the agent can **read, create, and revise** between games. Disallowed memory directories are not exposed to that run. The agent may inspect the prior game via the common feedback channel, but may not smuggle a durable coach profile into best practices or embed team-specific historical labels in generic skills. Define light, auditable content boundaries so the categories remain interpretable without prescribing how the agent reasons.

For a fair comparison, enforce common preparation/reflection budgets and common access to original timestamped historical sources. Track actual tool calls, tokens, context size, memory size, execution time, and cost. Cap total retained text-memory tokens comparably across variants and report usage; separately account for executable skill size and cost.

## 5. First-stage ablations — which categories of knowledge matter?

The first stage tests **memory permissions**, not static versus dynamic prompting. **Every variant** may create sophisticated pregame prompt components, deterministic features, and assembly code. Every variant receives the same immediate prior-game feedback and can reflect on it. What differs is what survives to the next game.

### 5.1 Primary 2 × 2 experiment: coach knowledge × best practices

| Variant | Persistent coach profile | Persistent best practices | Persistent custom skills | Research question |
|---|:---:|:---:|:---:|---|
| **M0 — Feedback only** | No | No | No | How well can the agent prepare afresh and use the last replay's critique without long-term memory? |
| **M1 — Coach profile** | Yes | No | No | Does accumulating team/coach-specific knowledge help? |
| **M2 — Best practices** | No | Yes | No | Does learning *how to research and build the policy* help without retained coach-specific conclusions? |
| **M3 — Both** | Yes | Yes | No | Are domain and procedural knowledge complementary? |

**Coach profile:** A versioned, editable record of observations, hypotheses, evidence, exceptions, and uncertainty about the Celtics coach's rotations and substitutions. In this stage, **do not force a particular schema**; free-form representation is the baseline for later representation ablations.

**Best practices:** General, reusable guidance about which analyses to run, how to prepare components, how to structure assembly code, what errors to watch for, and how to interrogate replay feedback. This document must stay **coach-agnostic**; it cannot serve as a disguised Celtics knowledge store.

**M0:** May review the previous replay and prepare an improved package for the current game, but receives no persistent self-authored coaching or procedural notes from earlier games. This is a **no-persistent-memory** baseline, not a no-feedback or no-history-data baseline.

Analyze M1−M0 (coach knowledge), M2−M0 (procedural knowledge), and the **interaction** represented by M3 versus M1 and M2. Keep the four variants independent, with separately evolved memory states, rather than having them share findings after each game.

### 5.2 Follow-up first-stage experiment: custom skills

Once the primary 2 × 2 results are available, test whether persistent **executable/procedural skills** create additional value. At minimum:

- **M3:** Coach profile + best practices, no persistent custom skills.
- **M4:** Identical permissions plus the ability to create, edit, and reuse custom skills after each replay.

If resources allow, also add skills to M0 or M1/M2 to test whether skills substitute for or interact with document memory. Do not assume that skills are valuable only when both documents exist.

Custom skills can contain reusable data-analysis utilities, prompt-construction routines, code templates, diagnostic checks, and research workflows. Distinguish these durable skills from the **per-game assembly code, which every variant already writes**. Skill creation and revisions occur in the postgame reflection step; skills are loaded only in subsequent pregame runs, in a sandbox with fixed APIs. They cannot read withheld data or modify evaluation logic.

**First-stage decision point:** Identify whether any persistent-memory capability improves out-of-sample predictive performance, how the effects interact, and whether any gains justify their research and maintenance cost. Select promising conditions for stage two; keep M0 and relevant simpler controls as reference points.

## 6. Second-stage ablations — representation and management

Run these **after** first-stage results, not all at once. Hold the enabled *categories* of memory and the policy-authoring interface as constant as possible while varying how memory is represented, updated, or accessed. Prioritize hypotheses suggested by observed first-stage failure modes.

### 6.1 Memory representation (early second stage)

| Priority | Ablation | Contrasts / question |
|---|---|---|
| **1. Episodic memory** | Synthesized coach profile vs. stored game/decision examples vs. both | Does the agent benefit more from remembering **specific situations** or abstracting **general tendencies**? |
| **2. Structured hypotheses** | Free-form coach profile vs. explicit hypothesis ledger | Does tracking predictions, evidence for/against, confidence, conditions, and retired beliefs improve the reliability of learning? |
| **3. Player-specific profiles** | Coach-level knowledge vs. coach + separate player/rotation profiles | Does explicit organization by player/lineup improve relevance and prediction quality? |

An **episode** may include the observed state, actual coach action, Jev's predicted probabilities, assembled component IDs, and the subsequent error analysis. Preserve provenance and timestamps; do not give any variant episodes from future games. When comparing episodic and synthesized memory, control for memory/context budget and, where useful, permit a combined condition to test complementarity.

A **structured hypothesis ledger** is a *representation* ablation, not a requirement imposed during the first stage. Records might contain a claim, applicable conditions, supporting and contradicting evidence, calibrated confidence, predictive consequences, last update, and status (provisional/confirmed/retired). Judge its utility downstream, not by number of entries or elegance of prose.

**Player profiles** may store substitution/rotation tendencies for individual players, lineup pairings, and availability-dependent behavior. Compare against a coach profile with the same underlying historical access to isolate the value of organization.

### 6.2 Memory management (later second stage; trigger when memory grows)

| Ablation | Conditions to compare | Question |
|---|---|---|
| **Consolidation and forgetting** | Append-only vs. continuous revision/retirement vs. periodic consolidation (e.g., every 5–10 games) | Can the agent remove stale, redundant, or contradicted knowledge while preserving predictive value? |
| **Retrieval versus always-available memory** | Include the permitted memory in pregame context vs. agent-selective retrieval from the same store | Can the agent surface more relevant knowledge under context constraints? |

Defer these until the agent has accumulated enough memory for context pressure, conflicting evidence, or changing rotations to matter. Equalize available source knowledge and approximate **context/token budgets**; otherwise any retrieval advantage may simply reflect access to more total information.

Measure adaptation to changed injuries, roles, and rotations, not merely average scores. Consolidation/forgetting policies must never erase the archived memory snapshots needed to reproduce past evaluations.

### 6.3 Generalization / transfer (final extension)

After an agent has learned on the Celtics, initialize a **new team's** agent with the Celtics agent's **coach-agnostic best practices and/or skills**, but **without its Celtics coach profile or team-specific episodes**. Compare against a fresh agent with the same compute and data access.

Test whether transferred procedural knowledge accelerates learning of the new team's substitution behavior. Report the **learning curve** and performance at fixed game/compute budgets; explicitly check for negative transfer.

### 6.4 Sequencing and interaction policy

1. **First stage:** M0–M3 factorial → M4 skills comparison (plus targeted skill interactions if useful).
2. **Second stage, representation:** Episodic versus synthesized knowledge → structured hypotheses → player profiles; retain combined conditions when complementarity is plausible.
3. **Second stage, management:** Consolidation/forgetting → selective retrieval, once accumulation creates a genuine need.
4. **Extension:** Transfer general-purpose procedural knowledge and skills to another team.

Do **not** blindly stack each winner onto the next experiment. Preserve factorial controls and revisit important interactions (for example, episodes may be most helpful alongside a hypothesis ledger). Later experiments are **conditional on earlier results**, rather than prerequisites for the initial replay MVP.

## 7. Evaluation and analysis

### 7.1 Replay metrics

**Primary metrics, reported separately:**

1. **Substitution timing:** Brier score for `p_any_substitution` across *all* eligible windows; report calibration, log loss if numerically stable, and precision/recall as diagnostics. Raw accuracy is inadequate because no-substitution may dominate.
2. **Player selection:** Conditional entry/exit probability scores **at windows where the real coach substituted**, regardless of whether Jev predicted a substitution. Use a consistent normalization over eligible players/windows, and report top-choice accuracy.

**Secondary metrics:** Exact multi-player action match, partial action overlap, false positive substitution rate, performance by quarter/score/fouls/availability, invalid outputs, latency, total research compute, skill/runtime costs, and memory token footprint.

### 7.2 Learning and causal attribution

The key result is whether a memory variant's replay predictions improve **over chronological games relative to M0 and other variants**. Show per-game performance and learning curves, not just an end-of-season average. Compare performance at equal cumulative games and under comparable agent-compute budgets.

Use identical replay windows and external data across variants. Evaluate differences **paired by game**, estimate uncertainty with game-level clustered/bootstrap methods, and report the number of games, eligible decisions, and actual substitutions. Multiple independently seeded runs help separate genuine gains from agent variability.

Important controls:

- **No future leakage:** Historical source timestamps, decision-event ordering, frozen pregame policy, and postgame-only feedback release.
- **No memory leakage across variants:** Separate workspace and run identity for each condition; archived traces do not become private memory by accident.
- **Comparable resources:** Equal model/tool access and preparation/reflection limits; log realized consumption. Hold memory limits and context limits consistent with the comparison's purpose.
- **No contamination between categories:** Coach-specific findings belong in coach/episodic/player memory, not a supposedly generic best-practices or skill file.
- **No optimizing the holdout:** Develop on the rolling sequence; use a prespecified untouched final block for confirmation.
- **No reward for verbosity:** Score downstream predictions and efficiency, not how persuasive the coach hypotheses sound.

Ablation effects are incremental **predictive value under this harness**; they do not automatically prove the agent has learned human-like basketball expertise. Negative results are informative, especially when a richer memory system costs more and performs no better.

### 7.3 Conventional benchmarks

Keep a **conventional statistical substitution predictor** and **generic Jev prompt** as external competitiveness benchmarks. They should use the same observable information and held-out replay windows. They are **not** the primary ablation dimensions; the main experimental comparisons isolate the effect of permitted knowledge accumulation among agents using the same per-game artifact-authoring process.

## 8. Downstream evaluation — full-game simulation

When replay performance provides a promising signal, replace the simulator's conventional rotation controller with the frozen Jev prompting/decision procedure. At eligible windows, pass the **simulated** state to the same assembler and let Jev choose or sample a legal substitution action. Do not independently sample entry/exit marginals as if they formed a coherent joint action distribution.

Compare policies from relevant memory variants against generic Jev and a conventional controller in matched simulation batches, with identical pregame inputs and common random seeds where feasible.

Evaluate:

- **Player-minutes distributions:** CRPS or another proper distribution score, mean-minutes error, and prediction interval coverage.
- **Rotation realism:** Stint lengths, lineup usage, substitution counts/timing, and coherent player management.
- **Cost and robustness:** Simulation runtime, Jev calls, invalid actions, and variation across game contexts.

Keep **replay substitution accuracy** and **simulation minutes accuracy** separate: a better one-step coach imitation policy may not yield better free-running rotations or minutes forecasts.

## 9. Implementation plan

1. **Replay MVP:** Reconstruct legal windows, actual Celtics substitutions, and observable game states for a small audited sample; implement decision contract and scores.
2. **Agent package and audit trail:** Build frozen per-game prompt components/assembly code, sandbox execution, Jev integration, and complete trace capture, including which components surfaced at each opportunity.
3. **Reflection and memory permissions:** Implement postgame feedback delivery, isolated agent workspaces, permission-gated coach/best-practices/skills stores, memory snapshots, and version hashes. Support all proposed memory categories in the configuration schema **without implementing every later-stage memory system yet**.
4. **First-stage factorial:** Run M0–M3 chronologically with equal budgets, plus statistical/generic benchmarks; examine performance and learning curves.
5. **First-stage skills test:** Run M3 versus M4, and targeted further skill interactions if warranted; confirm promising effects on untouched games.
6. **Second-stage memory research:** Episodic and structured knowledge experiments, then player-specific organization; postpone consolidation and retrieval until there is enough accumulated memory to test them meaningfully.
7. **External validation:** Test procedural transfer to another NBA team; integrate strongest policies into full-game simulation to evaluate downstream player-minutes distributions.

## 10. Research outcomes

The central claim is **not** that a more elaborate policy prompt necessarily works better. It is that certain forms of *accumulated and managed knowledge* may help an autonomous research agent progressively improve another model's predictions of a real, specialized decision-maker.

The project should answer, in order:

1. **Does persistent memory help at all, beyond recent replay feedback and access to historical data?**
2. **Is coach-specific, procedural, or executable knowledge most useful—and do they interact?**
3. **How should useful knowledge be represented, consolidated, forgotten, and retrieved?**
4. **Can general-purpose research/policy-authoring knowledge transfer to a new team?**
5. **Do the resulting gains translate from one-step replay into better free-running simulation and minutes projections?**

That makes Celtics substitution prediction a reproducible evaluation environment for a broader investigation: **how an autonomous agent learns to become better at its job across repeated episodes.**
