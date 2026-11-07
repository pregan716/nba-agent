# Development-games pilot (SPO-855)

The pilot ran the v3 system end to end on the development games (games 1–10 of
the Celtics' 2025-26 season) to learn what a game costs, whether the agent
operates as intended, how Jev behaves, and what the research budget should be.
Everything below is computed from the run records under `.cache/pilot/`; the
scripts that produced the numbers are noted where they are not plain SQL over
`record.sqlite`. Prices are the placeholder schedule
`placeholder-verify-before-pilot` (input $5, output $25, cache read $0.50,
cache write $6.25 per million tokens) and must be re-costed against the real
price list before any budget claim is final.

## Runs

| Run id               | Memory | Games | Code revision | Prompt                      | Cost   | Wall clock | Outcome                                              |
| -------------------- | ------ | ----- | ------------- | --------------------------- | ------ | ---------- | ---------------------------------------------------- |
| `pilot-m3-smoke`     | M3     | 1     | pre-SPO-857   | first `research-v3`         | $8.83  | —          | completed; six calls spent on manifest hashes        |
| `pilot-m3-smoke2`    | M3     | 1     | —             | —                           | $4.90  | —          | failed: stale assembler image pin (SPO-858, SPO-859) |
| `pilot-m3-smoke3`    | M3     | 1     | `d314c44`     | after SPO-857               | $4.98  | 25 min     | completed                                            |
| `pilot-m3` (stage 3) | M3     | 10    | `f8ff26e`     | after third smoke           | $47.78 | 4 h 23 min | completed, no halt                                   |
| `pilot-m3b`          | M3     | 5     | `b743e79`     | after PR #62 (Jev briefing) | $25.77 | 2 h 07 min | completed, no halt                                   |
| `pilot-m0` (stage 4) | M0     | 2     | `b743e79`     | after PR #62                | $6.17  | 34 min     | completed, no halt                                   |
| `pilot-m0-10`        | M0     | 10    | `b743e79`     | after PR #62                | $28.96 | 2 h 46 min | completed, no halt                                   |

All runs: Jev `jev-1.14.0`, analyst `claude-opus-4-6` at effort `high` with
adaptive thinking, Pi harness with prompt caching (`ephemeral-5m`) and
compaction off, dataset `windows-v2` on release `04fbacd3…`, state `state-v1`,
memory cap 50,000 tokens, caps `development-limits-not-a-budget-profile`
(pregame 3,000,000 weighted tokens / 900 s compute / 300 tool calls / 3 h;
postgame 1,500,000 / 600 s / 150 / 2 h). No session reached a cap.

## Cost and time per game

Fifteen M3 games (stage 3 and `pilot-m3b`), per phase. Weighted tokens count
cache reads at 0.1.

|                     | Pregame median | Pregame p90 | Pregame max | Postgame median | Postgame p90 | Postgame max |
| ------------------- | -------------- | ----------- | ----------- | --------------- | ------------ | ------------ |
| Weighted tokens     | 254k           | 327k        | 434k        | 370k            | 579k         | 585k         |
| Sandbox compute (s) | 10             | 50          | 59          | 24              | 59           | 73           |
| Tool calls          | 36             | 42          | 46          | 49              | 68           | 68           |
| Wall clock (min)    | 10             | 14          | 22          | 14              | 18           | 19           |
| USD (placeholder)   | 2.0            | 3.0         | 3.7         | 3.0             | 4.0          | 4.0          |

A game costs about $5 and 25 minutes. Cache reads dominate the token count
(stage 3: 4.4M–10.5M cache-read tokens per game against ~70k uncached input);
cost is therefore roughly context size × number of calls, and the cheapest
saving is fewer calls, not shorter answers. The full design, five variants on
50 scored games plus 10 warm-up games, projects to about $1,500 at these prices.

### Proposed budget profile v1

Following the brief's pilot procedure (caps at the 90th percentile of the
development games on M3), rounded up:

|                   | Pregame                                    | Postgame |
| ----------------- | ------------------------------------------ | -------- |
| Weighted tokens   | 400,000                                    | 650,000  |
| Sandbox compute   | 120 s                                      | 120 s    |
| Tool calls        | 60                                         | 80       |
| Wall clock        | 30 min                                     | 30 min   |
| Memory cap        | 50,000 tokens (unchanged; peak use 11,555) |          |
| Cache-read weight | 0.1                                        |          |

The procedure also calls for re-runs at a smaller and a larger pregame cap
before the numbers are recorded; those have not been run (two further M3
runs of a few games each, about $10–15 each). The wall-clock ceiling is
generous on purpose: it guards against a hung provider, not against work.
This profile is Proposed; the numbers are Open in the brief.

## Did the agent operate as intended?

Mostly. Across the pilot the agent used the tools as designed (code execution
over the game data, evidence search, package validation, freeze) and wasted
roughly 7 calls per pregame and 10 per postgame on avoidable discovery; each
smoke run fixed the prompt gaps it exposed (see `research-prompts.md`). Two
findings mattered more than the rest.

**The agent replaced Jev with a lookup table.** In stage 3 the assembler wrote
its own probability into every criterion from game 1 ("Sub probability
estimate: 0.06", "Exit estimate: 0.43"); the agent observed that Jev returns
about the number it is given and recorded that as a rule; every later session
tuned the table. Jev's timing Brier was 0.190 against 0.195 for the package's
own `sub_prob` (script `pkg-vs-jev.mts`). By game 10 the state text had shrunk
to a lineup table plus "somewhat unlikely (25% estimate)". The brief (§116)
permits this and relies on the trace showing it; nothing summarised it.
Resending game 1's 66 requests with every estimate stripped scored better on
all three questions (timing 0.195 vs 0.202, exit 0.215 vs 0.231, entry 0.101
vs 0.109); game 10 stripped collapsed to 0.299 because its state carried
nothing to reason from. PR #62 revised the prompt (what Jev is for, that an
asserted number becomes the answer); SPO-862 added `assertedEstimates` and
`jevAgreementWithDiagnostics` to the trace summary.

**Coach-specific facts leak into best practices.** With full-name matching
the audit flagged nothing in the smoke runs while `best_practices.md` named
eight Celtics players. With surname matching (SPO-860) stage 3 flagged 157
passages over nine games, all in M2 files, all queued for human review as the
brief specifies. The revised rule text ("surnames included", write the role not
the name) reduced but did not stop it: `pilot-m3b` flagged 0, 1, 12, 0 and 15.
Whether flag-only is enough for the scored run is an open question for the
user.

Smaller points: in 8 of 10 stage-3 pregames the agent froze the package and
then tried to write memory (refused; one wasted call each; prompt now says a
freeze ends the session, and `pilot-m3b` had none). One `read_feedback` call
without `game_id`. Edits with non-unique `old_text` twice. No invalid Jev
answers, no package failures, no provider failures in any run.

## Scores

Timing is the Brier score of the substitution probability over scored windows;
the base-rate column is the Brier of a constant prediction at the game's own
substitution rate, p(1−p). Exit and entry are the player-selection losses at
windows where the coach substituted.

### Stage 3 (`pilot-m3`, old prompt)

| Game       | Scored | Subs | Base rate | Timing   | Exit     | Entry    | Exit top-1 |
| ---------- | ------ | ---- | --------- | -------- | -------- | -------- | ---------- |
| 0022500083 | 66     | 23   | .227      | .202     | .231     | .109     | .52        |
| 0022500018 | 64     | 18   | .202      | .151     | .364     | .255     | .56        |
| 0022500106 | 59     | 16   | .197      | .133     | .626     | .305     | .19        |
| 0022500117 | 62     | 22   | .230      | .216     | .320     | .196     | .64        |
| 0022500128 | 52     | 20   | .237      | .195     | .475     | .146     | .45        |
| 0022500021 | 52     | 20   | .237      | .219     | .274     | .226     | .45        |
| 0022500146 | 59     | 20   | .224      | .215     | .442     | .213     | .45        |
| 0022500158 | 53     | 21   | .240      | .239     | .389     | .260     | .48        |
| 0022500174 | 58     | 15   | .192      | .186     | .461     | .234     | .40        |
| 0022500028 | 59     | 17   | .205      | .151     | .332     | .272     | .53        |
| pooled     | 584    | 192  | .221      | **.190** | **.382** | **.217** |            |

Timing beat the base rate in every game but by 0.001–0.064 with no trend; exit
and entry were worse after game 1 than in it. A 17-feature logistic regression
on the same 584 windows, fit leave-one-game-out (`logit.py`), scores 0.187:
the agent's hand-tuned table had reached what a plain fit on state-v1 features
reaches, in game 1, and memory did not move it.

### `pilot-m3b` (revised prompt), same first five games

| Game       | Base rate | Timing (stage 3) | Timing (m3b) | Exit (m3b)  | Entry (m3b) |
| ---------- | --------- | ---------------- | ------------ | ----------- | ----------- |
| 0022500083 | .227      | .202             | **.252**     | .238        | .119        |
| 0022500018 | .202      | .151             | .155         | .297        | .191        |
| 0022500106 | .197      | .133             | .152         | .524        | .195        |
| 0022500117 | .230      | .216             | **.175**     | .404        | .209        |
| 0022500128 | .237      | .195             | **.154**     | .517        | .166        |
| pooled     |           | .179             | .179         | .388 (.388) | .174 (.194) |

Pooled over the five games the runs are equal on timing and exit and `m3b` is
better on entry. The trajectories differ. Briefed without a number to copy,
Jev over-predicted in game 1 (mean 0.54 against a 0.35 rate: "prime
substitution territory"). The margin over the base rate then grew every game,
.047 → .045 → .055 → .083, where stage 3 over the same games went .051 → .064
→ .014 → .042. `assertedEstimates` was 0 in all five games. The memory the
agent wrote is about how to brief Jev (`coach/framing_lessons.md`: per-elapsed
wording for foul windows, "don't use 'increasingly likely' — Jev reads it as
~0.73, actual ~0.38", count framing at period breaks), which is the kind of
knowledge the design expects to compound. Five games cannot establish a trend;
the scored run can.

Exit is unchanged at about 0.39 with top-1 near 50%, and entry top-1 is poor
(0.06–0.40). This is a briefing-content problem (who replaces whom), not an
anchoring one; the agent has begun a sub-pairs note.

### Stage 4 (M0 over the ten development games)

M0 persists nothing: each pregame starts with an empty workspace and only the
previous game's trace. `pilot-m0` ran the first two games; `pilot-m0-10` ran
all ten as a fresh run id, so games 1 and 2 were run twice under the same
configuration. Prompt and code revision are those of `pilot-m3b`; stage 3 used
the old prompt, so the M0 to stage-3 comparison confounds memory with prompt.

| Game       | Base rate | M0 timing | M0 (2-game run) | M3b timing | Stage 3 timing | M0 exit / entry | M0 mean p / actual |
| ---------- | --------- | --------- | --------------- | ---------- | -------------- | --------------- | ------------------ |
| 0022500083 | .227      | .191      | .203            | .252       | .202           | .277 / .119     | .41 / .35          |
| 0022500018 | .202      | .199      | .170            | .155       | .151           | .401 / .172     | .46 / .28          |
| 0022500106 | .198      | .152      |                 | .152       | .133           | .616 / .200     | .23 / .27          |
| 0022500117 | .229      | .172      |                 | .175       | .216           | .334 / .195     | .40 / .35          |
| 0022500128 | .237      | .162      |                 | .154       | .195           | .532 / .222     | .45 / .38          |
| 0022500021 | .237      | .213      |                 |            | .219           | .280 / .176     | .37 / .38          |
| 0022500146 | .224      | **.270**  |                 |            | .215           | .459 / .157     | .56 / .34          |
| 0022500158 | .239      | **.239**  |                 |            | .239           | .466 / .190     | .29 / .40          |
| 0022500174 | .192      | **.268**  |                 |            | .186           | .345 / .196     | .54 / .26          |
| 0022500028 | .205      | .181      |                 |            | .151           | .222 / .336     | .44 / .29          |

Pooled (weighted by scored windows; subset comparisons use the same games):

| Comparison                     | Games | M0 timing | Other timing | M0 exit | Other exit | M0 entry | Other entry |
| ------------------------------ | ----- | --------- | ------------ | ------- | ---------- | -------- | ----------- |
| M0 vs `pilot-m3b`, same prompt | 1–5   | .176      | .179         | .419    | .388       | .179     | .174        |
| M0 vs `pilot-m3b`, same prompt | 2–5   | .172      | .159         | .461    | .434       | .198     | .191        |
| M0 vs stage 3, prompt differs  | 1–10  | .204      | .190         | .390    | .382       | .193     | .217        |
| M0 vs stage 3, prompt differs  | 6–10  | .235      | .201         | .360    | .377       | .208     | .240        |

What this does and does not show:

- **Noise.** Games 1 and 2 run twice under the same configuration differ by
  0.012 and 0.029 on timing; M0 game 1 against `pilot-m3b` game 1 (also the
  same configuration) by 0.05. Per game, the M0 minus stage-3 timing difference
  has a standard deviation of 0.04. The research agent's own run-to-run
  variation is about 0.03–0.05 per game, four to five times the Jev replay
  noise. Nothing in a single game's number is a memory effect.
- **Memory, same prompt (games 2–5).** M3b is 0.013 better on timing and about
  equal on exit and entry. Over four games the standard error of that
  difference is about 0.02; the sign is right and the size is not established.
- **Memory, all ten games.** Stage 3 is 0.014 better on timing (paired mean
  difference 0.014, standard error 0.013) and 0.024 better on entry; exit is
  equal. The gap is concentrated in games 6–10 (0.034 on timing), where M0 had
  no profile to carry and stage 3 had five games of one. Three M0 games (7, 8, 9) scored at or below the base rate; no stage-3 game did. This is the shape
  a memory effect would have, and ten games with one replicate cannot separate
  it from the prompt change or from noise.
- **Calibration.** M0's mean predicted substitution probability ranged from
  0.23 to 0.56 against actual rates of 0.26 to 0.40; the two games below base
  rate over-predicted by 0.22 and 0.28. Each fresh session writes its own
  wording for the stoppage types and Jev reads that wording at a level the
  agent cannot see until postgame, and M0 cannot carry the correction forward.
  `pilot-m3b` wrote exactly that correction to memory (`coach/framing_lessons.md`)
  but still ran at 0.54 and 0.48 in two of its five games, so memory has not
  yet fixed calibration either. Stage 3's lookup table was well calibrated
  (0.24–0.42) because the numbers Jev echoed were fitted rates.
- **Detectability.** Pooled over 50 scored games, agent-level noise of 0.04 per
  game shrinks to about 0.006 on a paired mean, so a variant gap of 0.015 or
  more is detectable with one replicate and a gap of about 0.01 needs two.
  The effect sizes seen here (0.013–0.034) sit at that threshold.

`assertedEstimates` was nonzero in two M0 games (59 and 53): the instructions
carried static tendency rates ("fouls: moderate chance (~35%)", "between
periods: ~87%"), which the recall-biased detector counts. These are briefing
content, not per-window answers, and Jev's mean absolute difference from the
diagnostics estimate was 0.6 in both games, so they were not echoed. No M0
game built a per-window lookup table under the revised prompt.

M0 costs less than M3: $2.90 per game (pregame median $2.0, postgame $1.0) and
17 minutes, against $4.78 and 26 minutes for M3. No tool was refused and no
boundary-audit flag was raised (M0 has nothing to audit); one transient API
connection error in game 2's pregame was retried. In `pilot-m0` the agent had
called `read_feedback` in the first pregame, where no trace exists yet (one
refused call); a note in the M0 instructions would save that call.

## Jev

**Determinism (double replay, Agreed Nov 4, 2026).** Game 0022500083's 66
stored requests were resent unchanged (`double-replay.mts`); the assembler is
already run twice per window and checked, so this isolates Jev. Jev is not
deterministic: timing probability identical in 29/66 windows, mean |Δ| 0.010,
p90 0.02, max 0.06, no window crossed 0.5; player probabilities mean max |Δ|
0.067, p90 0.11, max 0.22; exit top choice changed in 3 windows, entry in 4.
Per the brief, reproducibility is stated as **record-level only**. Timing noise
is small against the gaps between variants we hope to see; player-selection
noise is not, which argues for pooled comparisons over the 50 scored games
rather than per-game ones.

**Anchoring.** Jev returns approximately any probability asserted in the text
it reads (above). The generic-Jev baseline, with no briefing, scores 0.246 on
timing, worse than the base rate; briefed from game 1's state without numbers
it scores 0.195. The gap between those is the coach knowledge the package
carries, which is what the memory experiment measures.

**Request shape.** Requests are 2.5–3.5 KB, well under the limits. Jev latency
~300 ms. Jev cost is negligible at the placeholder rate ($0.004–0.007 per
game).

**Exit framing.** The agent's exit instruction asks "which player is most
likely to leave", a single-player framing that scores badly at multi-player
substitutions (a 3-for-3 at a period start scored 1.14). Ten games of feedback
did not change it. Whether the environment should fix the framing is a design
question for the user.

## Open items arising

- Budget profile v1 is Proposed above; the smaller- and larger-cap re-runs the
  brief asks for have not been run.
- Price schedule is a placeholder.
- Flag-only boundary audit versus refusal for the scored run.
- Exit question framing.
- `state-v1` does not say which team shoots pending free throws; a `state-v2`
  could add it. Deferred past the pilot.
- `jevAgreementWithDiagnostics` fired once in `pilot-m3b` on a diagnostics key
  that is not a probability (0.47 over 44 windows in game 2); the detector's
  key match should be tightened before the number is relied on.

## Scripts

Scratch scripts, not in the repo: `cost.sh` (per-scope settlement sums),
`budget.sh` (per-phase distributions), `dump3.mts` (ordered call dump),
`jev3b.mts` (request/response per scored window), `pkg-vs-jev.mts`
(package estimate vs Jev Brier), `logit.py` (leave-one-game-out logistic),
`double-replay.mts`, `strip-replay.mts` (estimates removed, resent, scored).
