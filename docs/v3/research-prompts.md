# Research prompts, memory instructions and probes (SPO-855 / R5b)

This page records the v3 prompt set as built. The pilot and its write-up
(`docs/v3/pilot.md`) follow in the same issue.

## Prompt set `research-v3`

The texts live in `src/harness/prompts.ts`:

- `RESEARCH_SYSTEM_PROMPT_V3`: the task, what a decision window is, the four
  fixed Jev questions and the derived action, the scores, what Jev is and is not,
  the package contract, the `state-v1` fields, feedback, and the evidence, time
  and budget rules.
- `RESEARCH_PHASE_PROMPTS_V3.pregame`: prepare and freeze this game's package.
- `RESEARCH_PHASE_PROMPTS_V3.postgame`: the trace is available; nothing is required.
- `memoryPermissionInstructions(memory)`: one text per variant M0 to M4.

The brief's "Guard against unnecessary process" governs the wording. The texts
state contracts and rules. They give no research checklist, feature list, profile
schema or basketball conclusion, and a test asserts that they contain no Celtics
player name or surname and not the head coach's name.

Things the prompt states because the agent cannot discover them otherwise:

- Jev reads only the assembled request, keeps nothing between windows, and does
  not know who a player id is unless the text says so.
- The assembler has the Python standard library only, no data and no workspace,
  so everything it needs must be inside the package.
- The byte limits of the Agreed context guard, stated as round numbers below the
  real thresholds (30,976 bytes for the state plus one question; 59,904 for the
  whole request).
- `validate_package` uses fixed 2024–25 states before the first game of the
  season is played (SPO-857), and the prompt says those are a check that the
  package runs, not evidence about this season.
- The manifest needs only `stateVersion` and optional `notes`; the environment
  hashes the files (SPO-857). The prompt tells the agent not to compute hashes.
- An unfrozen package, or one that fails on the first window, leaves the whole
  game unscored.
- The period-boundary state: `period` and `clockMs` are the new period's, while
  the lineups, scores and history are the previous period's closing ones. This
  sentence is the exported constant `BETWEEN_PERIODS_STATE_NOTE`, and the replay
  engine's boundary fixture test holds its wording against the built state.
- Recollection of the season is not evidence. This is an instruction, not a
  control; the contamination probes are the measurement.

Dataset facts in the prompt ("50 to 70 windows", "a minority" end in a
substitution) describe the task, as the brief's Sizes paragraph does. Rates the
agent could learn from the data are left for it to compute.

### Memory-permission instructions

Every variant is told about `packages/<game_id>/`, `scratch/`, the `/workspace`
mount and that the previous trace is read through `read_feedback` and not kept.
Beyond that:

| Variant | Told about                                                                       | Cap stated |
| ------- | -------------------------------------------------------------------------------- | ---------- |
| M0      | Nothing persists; no memory directory                                            | No         |
| M1      | `memory/coach_profile.md`, `memory/coach/`                                       | Yes        |
| M2      | `memory/best_practices.md`, `memory/practices/` and the coach-agnostic rule      | Yes        |
| M3      | Both of the above                                                                | Yes        |
| M4      | Both, plus `skills/` (at `/workspace/skills`) under the same coach-agnostic rule | Yes        |

A gated-off directory is described only as absent. The coach-agnostic rule is
the brief's content boundary, and the text says it is audited. A test checks
each variant's text against `memoryVariant`.

### Tool descriptions

Six tool descriptions still described v2 memory modes ("in a stateless run these
tools are refused"), which is false for M0 under v3: packages and scratch are
writable. They now refer to the run's permitted paths. Tool definitions are part
of the harness version, so this changes it for every configuration.

## Harness version and launch rules

`harnessConfig({ promptSet: "research-v3" })` gives identity `pi-research-v3`,
stores the system and phase texts and all five variants' instruction texts under
`harness.prompts`, and sets `memoryInstructions` to the run's own variant. Any
wording change therefore changes the manifest hash for every variant. The
harnesses select texts through `promptTexts(promptSet)`; fixtures keep the
infrastructure texts and their existing identities.

`validateLaunch` now lets a `pilot` start when the harness identity is
`pi-research-v3`. `scored` remains refused until a budget profile is approved.

## Contamination probes

**Analyst.** `scripts/contamination-probe.ts` is the carried no-tools probe. One
item was added on the Celtics' 2025–26 rotation and substitution patterns, and a
player who left the team in the 2025 offseason was dropped from the list of
named players.

**Jev.** `scripts/jev-probe.ts` builds 246 typed true/false statements from the
pinned releases and sends them with an empty state in batches of 40:

| Group                | Facts | What it asks                                                             |
| -------------------- | ----: | ------------------------------------------------------------------------ |
| `result:2025-26`     |    82 | The Celtics won, or lost, a named game in the replay season              |
| `appearance:2025-26` |    82 | A named roster player played, or did not play, in a named game           |
| `result:2024-25`     |    82 | The same result statements for the prior season, as the comparison group |

Whether a statement says "won" or "lost" (or "played" or "did not play") is set
by a hash of the fact id, never by the outcome, so about half of each group is
true whatever the team's record. Appearance facts use only roster players who
played in between 20 % and 80 % of the games they were eligible for, one per game,
chosen by a hash of the game id.

**This balancing does not remove priors.** A model that knows only that the team
is good can put 0.75 on every "won" statement and 0.25 on every "lost" one. On a
team that wins 75 % of its games it then scores accuracy 0.75, Brier 0.1875 and
discrimination 0.25 without knowing a single result. The same holds for a player
who usually plays. Positive discrimination can therefore come from recall of
outcomes or from ordinary inference from team and player priors, and it does not
by itself distinguish them.

The stored record reports, per group:

- The observed accuracy, Brier score and discrimination (mean probability on true
  statements minus on false ones). Uninformed chance is 0.5, 0.25 and 0.
- `baseRateReference`: what an outcome-blind predictor scores if it knows only the
  realized rate of the positive outcome in the group and answers that rate for a
  positive statement and one minus it for a negative one.
- `beyondBaseRate`: observed minus that reference.
- For appearance facts, `subjectRateReference` and `beyondSubjectRate`: the same
  with each player's own realized rate.

The references use realized rates, which no model could know exactly in advance,
so they are generous. They do not cover opponent-strength, home-court or
schedule priors. A result at or below the reference is consistent with priors
alone. A result clearly beyond it is a reason to look closer, not proof of
recall. The 2024–25 group is a comparison, not a control for priors: it shows
how the same statistics look for a season Jev could have been trained on. The
probe is descriptive and cannot prove absence of contamination.

## Revisions after the first pilot game

The first live game (M3, `0022500083`, Nov 6, 2026) cost about $8.83, priced
with the config's placeholder schedule. Reading its 105 model calls showed that
about half worked around gaps in what the agent was told or given. Three were
prompt gaps and are fixed here; the rest are environment fixes in SPO-857.

- **Data reference.** The agent found table and column names by trial and error
  (about 16 calls, repeated in postgame because each session starts with no
  history). The system prompt now lists the per-game tables and their main
  columns, the session tables, which helper reaches which, and how `nba_data`
  behaves. It names columns and tables only. Giving it to every variant also
  removes an unintended advantage: a variant with memory could save the schema,
  while M0 would pay to rediscover it every game.
- **Trace file.** `read_feedback` returns two windows per page; the agent paged
  through 16 of 75 windows and reasoned from that sample. The prompt now says the
  whole trace is a file at `feedback/<game_id>/trace.json`, gives its structure,
  and says to load it in code because it is over a megabyte.
- **Freeze lock.** The agent froze its package and then tried to save notes,
  which was refused, so postgame repeated the pregame analysis. The memory
  instructions now say to save before calling `freeze_package`.
- The prompt also says that code output is added to the conversation and re-read
  on every later step.

Two unrelated fixes were needed for any live run to start: the Jev probe script
closed a proxy endpoint it never opened, and the session source's dictionary
guard still named the superseded `spo-771` transformation although the
dictionary was synced for `spo-839` when those releases were pinned (PR #41).

## Revisions after SPO-857

SPO-857 changed the environment; the prompt was updated to match once it merged:

- The manifest no longer lists hashes, and the prompt says not to compute them.
  The first game spent six calls on hand-computed hashes.
- `workspace_edit` is described with the package tools and in the memory
  instructions, as the way to fix a file without resending it.
- The memory instructions say that `context` and every memory mutation report
  the tokens retained against the cap.
- `validate_package` sample states before the first game are the fixed 2024–25
  states, described as a check that the package runs.
- The data reference says that provenance columns and column descriptions are
  off by default and how to turn them on with `include_metadata`.
- The code-output cap (16,000 bytes, files unaffected) and the feedback summary
  being on the first page only are stated.

## Revisions after the third pilot game

The third run (`pilot-m3-smoke3`, $4.98) showed three prompt gaps, fixed here;
the environment findings from the same run are SPO-860.

- The trace description said `actual` is "{players_out, players_in} or null".
  It is never null: both lists are empty when the coach did not substitute. The
  prompt now says so, and that an excluded window has null `raw`, `validation`
  and `scores`. The agent spent four calls discovering both.
- Substitution events are one row per entering or leaving player (SPO-860
  verified this against the release); the agent had halved its counts.
- Units: `minutes_seconds` is seconds played; `cumulative_minutes_*` is decimal
  minutes. The agent spent three calls on each.
- The coach-agnostic rule for best practices and skills is concrete: surnames
  count, rates and game lessons belong in the coach profile, write the role not
  the name, and flagged text is reviewed by a person. The agent's first
  best-practices file named eight Celtics players and the audit, which matched
  full names only, flagged nothing.

## Revisions after stage 3 of the pilot

Stage 3 (`pilot-m3`, ten M3 development games, $47.78) showed no improvement
across games: timing Brier 0.19 pooled against a 0.22 base rate, exit and
entry worse after game 1 than in it. The record explains why. From game 1 the
assembler wrote its own probability into every criterion ("Sub probability
estimate: 0.06", "Exit estimate: 0.43"), the agent found that Jev returns about
the number it is given and wrote that down as a rule, and every later session
tuned the assembler's lookup table. Jev's timing Brier was 0.190 against 0.195
for the package's own `sub_prob`; by game 10 the state text had shrunk to a
lineup table plus "somewhat unlikely (25% estimate)". The brief (§116) permits
an assembler that asserts the answer and relies on the trace showing it; the
prompt repeated the permission as a tip.

Resending game 1's 66 stored requests with every estimate stripped scored
better on all three questions (timing 0.195 against 0.202, exit 0.215 against
0.231, entry 0.101 against 0.109): Jev briefed with the coach's tendencies out-
reasoned the formula. The same for game 10, whose state carried no tendencies,
collapsed to 0.299 timing: with the number gone there was nothing to reason
from. The generic-Jev baseline, with no briefing at all, is 0.246.

Changes:

- A new passage in the Jev section states what Jev is for, what a briefing
  contains, and that an asserted number becomes the answer and is visible in
  the trace. The package-contract line keeps the brief's rule word for word
  and points at that passage.
- The postgame phase prompt asks the agent to look at the requests Jev
  received, and where they state an estimate that Jev's answers track, to
  improve the briefing rather than the formula. Diagnostics never reach Jev,
  so agreement with an estimate kept only there is not evidence of anchoring
  (review of PR #62).
- The `freeze_package` line says a successful freeze ends the session. In
  eight of ten pregames the agent froze and then tried to write memory; the
  memory instructions already said this, the freeze line now does too.

The trace-side measure (count of asserted estimates and Jev's deviation from
them, per game) is SPO-862 for the environment.

## Revisions after stage 4 of the pilot

Stage 4 (`pilot-m0-10`, ten M0 games) and `pilot-m3b` showed the same
calibration drift in fresh sessions: mean predicted substitution probability
ran from 0.23 to 0.56 against rates of 0.26 to 0.40, because each session's
new wording is read by Jev at a level the agent could only see in the
postgame trace. SPO-863 lets `validate_package` send its sample requests to
Jev (`jev: true`) over a spread of prior-game states. The prompt's tool line
now describes that and says outcomes are never included. The Jev section
says that wording sets a level the agent cannot know in advance and that
validation with Jev is how to see it, with the qualification from the review
of PR #67: the sample is balanced across stoppage kinds, so its mean is not a
game-wide rate; compare like with like, and hold the states fixed to see a
wording effect. A discrepancy is a reason to look, not proof. The
tool-description change is Codex's (PR #65); this is the matching prompt
change.

SPO-865 exposed the decision windows and the ledger of released games as
`decision_windows` and `unanchored_substitutions`. The data reference lists
both with their columns and says the table description states the window
definition. Until then the agent could see the scored windows of one game
only, through the trace, and the pilot's per-stoppage results (worse than the
kind's own rate at timeouts and dead-ball turnovers in every run) followed
from guessing those levels each session.

## Revisions for jev-contract-v2 (SPO-867)

The brief amendment accepted Nov 7, 2026 (PR #71) replaced `count`, `exit`
and `entry` with one set-valued `swap` question over candidate substitutions
the assembler proposes, plus `other`; SPO-866 (PR #73) implemented it. The
pilot's finding behind it: the agent ranked players best of any predictor
but scored worst on the proper player scores, because the single-winner
questions made it write "very unlikely to exit this soon" and "rarely
enters", which Jev reads as about zero, and a quarter of substitution
windows then hit the log-loss clip.

The prompt now:

- Describes the two questions, the candidate list (one to eight equal-size
  sets from the five on the floor and the eligible bench, empty when the
  bench is empty), the environment-built keys, and the action rule (most
  probable listed candidate, `other_argmax` noted).
- Frames the candidate list as the coach's first decision, which moves are
  live, and says it is scored.
- States the set score and the expansion of `other` in one sentence each
  (an unlisted 1-for-1 shares the size-one portion of `other` with about
  fifty others, a 2-for-2 with several hundred), names the hit rate, set
  top-1, candidate count and `other` mass, and says the per-player scores
  are derived for continuity.
- Says what is expensive: a missed move with little mass on `other`, and a
  listed move given near zero that happens. "The hit rate is the number to
  watch first."
- In the Jev section: describe each candidate as a coach would see it
  without asserting a number; "unlikely" means unlikely, not never; the
  description of `other` matters; `validate_package` with `jev: true`
  returns the swap probabilities and derived marginals on the fixed prior
  states.
- Updates the `assemble` return shape (`candidates`, `instructions.swap`,
  `criteria.swap` keyed as the environment builds them) and the trace
  fields (`validation.swap`, `setLogLoss`, `candidateHit`, `setTop1`,
  `candidateCount`, `otherMass`, `assembly.candidates`), and tells the agent
  to read the `candidateHit = 0` windows before changing wording.

Tests assert the new descriptions and the absence of the retired questions.
The tool-description change is Codex's (PR #73); this is the matching prompt
change. The two-game M0 check the issue asks for is a live run and needs the
user's approval of the spend.

## Revisions after stage 6 of the pilot (SPO-868)

The first agent run on `jev-contract-v2` (`pilot-m0-swap`, `docs/v3/pilot.md`)
listed the coach's actual move at 32 % of substitutions but gave `other`
4–5 % of the mass, so every miss scored the clip and the pooled set log loss
(5.32) was below the constant floor (5.02); the same answers with `other` at
0.5 would have scored 4.60. Game 2 did not adjust after game 1's trace
showed the miss rate. The prompt said the missed-move-with-little-`other`
case was expensive but not how much `other` should carry or how to get Jev
to put it there.

The scoring section now gives the rule of thumb: `other` should carry about
the share of moves the list misses; `candidateHitRate` in the trace is the
share caught, so the miss rate is its complement; before any trace, assume the list misses more than
it catches (the pilot's lists caught about a third); a list missing two
thirds with `other` at 0.05 scores worse than listing nothing. The Jev
section says why `other` comes out small (a description like "anything
else" reads as a long shot), how to describe it (as the live option it is,
in words that carry the honest frequency, with the state text saying how
unsettled the situation is), and how to look at it (`validate_package` with
`jev: true`; the samples are a fixed spread, not a game's substitutions, so
their `other` mass is not the miss rate and need not match it; they measure
the effect of wording with the states held fixed, and a few percent on every
sample against a trace that shows most moves missed points at the wording,
while disagreement on a handful of states is a reason to look, not proof).
The review of PR #77 caught both the hit/miss inversion and the sampling
caveat that the first draft dropped. It names the set-level form of "unlikely means
never": a listed candidate at 0.03 or less that happens (four of thirteen
hits in stage 6). Tests assert each of these. The two-game re-check is a
live run and needs the user's approval of the spend.

## Not in this change

No live model call was made. The probes, the pilot, the double replay and the
proposed budget profile are the next step and need the user's approval of the
spend first.
