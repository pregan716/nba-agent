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

| Run id                  | Memory | Games | Code revision | Prompt                      | Cost   | Wall clock | Outcome                                              |
| ----------------------- | ------ | ----- | ------------- | --------------------------- | ------ | ---------- | ---------------------------------------------------- |
| `pilot-m3-smoke`        | M3     | 1     | pre-SPO-857   | first `research-v3`         | $8.83  | —          | completed; six calls spent on manifest hashes        |
| `pilot-m3-smoke2`       | M3     | 1     | —             | —                           | $4.90  | —          | failed: stale assembler image pin (SPO-858, SPO-859) |
| `pilot-m3-smoke3`       | M3     | 1     | `d314c44`     | after SPO-857               | $4.98  | 25 min     | completed                                            |
| `pilot-m3` (stage 3)    | M3     | 10    | `f8ff26e`     | after third smoke           | $47.78 | 4 h 23 min | completed, no halt                                   |
| `pilot-m3b`             | M3     | 5     | `b743e79`     | after PR #62 (Jev briefing) | $25.77 | 2 h 07 min | completed, no halt                                   |
| `pilot-m0` (stage 4)    | M0     | 2     | `b743e79`     | after PR #62                | $6.17  | 34 min     | completed, no halt                                   |
| `pilot-m0-10`           | M0     | 10    | `b743e79`     | after PR #62                | $28.96 | 2 h 46 min | completed, no halt                                   |
| `baselines-dev`         | —      | 10    | `390ecf5`     | baselines mode              | <$0.10 | 4 min      | constant, statistical, generic-Jev                   |
| `pilot-m3-v2` (stage 5) | M3     | 5     | `542907c`     | after SPO-863/865 (PR #67)  | $27.11 | 2 h 11 min | completed, no halt                                   |
| `pilot-m0-v2` (stage 5) | M0     | 5     | `542907c`     | after SPO-863/865 (PR #67)  | $17.88 | 1 h 30 min | completed, no halt                                   |

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

### Re-cut with the SPO-864 metrics

`npm run evaluate` over the same three records (no model calls), after PR #66.
Skill is 1 − Brier / Brier(constant at the game's own rate); higher is better,
0 is no better than the rate. Mid-period excludes between-period windows.

| Run              | Games | Timing | Skill | Mid-period timing | Mid-period skill | Mean p / rate | Reliability | Resolution |
| ---------------- | ----- | ------ | ----- | ----------------- | ---------------- | ------------- | ----------- | ---------- |
| Stage 3 (M3)     | 1–10  | .190   | .131  | .196              | .049             | .34 / .33     | .030        | .058       |
| `pilot-m3b` (M3) | 1–5   | .179   | .178  | .187              | .084             | .41 / .33     | .037        | .074       |
| `pilot-m0-10`    | 1–10  | .204   | .064  | .211              | **−.025**        | .42 / .33     | .038        | .050       |

By stoppage kind, skill against a constant at that kind's own rate (a harder
reference: it already knows that timeouts substitute 57 % of the time and
dead-ball turnovers 12 %):

| Kind               | n   | Rate | Stage 3 | `m3b` | M0   |
| ------------------ | --- | ---- | ------- | ----- | ---- |
| foul               | 380 | .30  | +.01    | +.07  | −.05 |
| timeout            | 68  | .57  | −.23    | −.10  | −.35 |
| dead-ball turnover | 84  | .12  | −.45    | −.98  | −.68 |
| between periods    | 30  | .93  | −.67    | —     | −.76 |

What the re-cut adds to the stage write-ups above:

- **Most of the headline skill is the between-period windows.** Mid-period,
  stage 3 is 0.05 better than a constant and M0 is slightly worse than one.
  The matched M3-versus-M0 difference is the same size on both cuts (0.015
  full, 0.015 mid-period; 90 % interval −0.006 to 0.036 on ten games), so the
  memory signal is not a between-period artefact, but the absolute level of
  skill on the windows that matter is small.
- **No variant beats the per-kind rate except at fouls.** At timeouts and
  dead-ball turnovers every run is worse than knowing the kind's own rate.
  Within a stoppage kind, Jev's briefed judgement is not yet discriminating;
  the decomposition agrees (resolution 0.05–0.07 against an uncertainty of
  0.22). This is the figure the statistical baseline should be compared with
  once the development baselines run exists.
- **Reliability is the M0 cost.** M0's reliability (0.038) is worse than stage
  3's (0.030) and its resolution lower (0.050 against 0.058): it both sits at
  the wrong level and ranks less well. `pilot-m3b` has the best resolution
  (0.074) and the worst level (mean 0.41 against 0.33), which is the pattern
  SPO-863 is meant to fix.
- **Entry: M0 is better than stage 3, not worse.** Entry Brier −0.024 (90 %
  interval −0.053 to 0.007) in M0's favour, entry log loss 2.80 against 3.40,
  MRR equal (0.45). Stage 3's player selection was the lookup table's weakest
  part and M0's briefing, written fresh each game, did better at it.

### Baselines on the development games

`baselines-dev` (Nov 7, 2026; constant, statistical and generic-Jev over the
same 584 scored windows; no research-agent calls). The statistical baseline
is the brief's seven-feature logistic fit on warm-up games 11–20 with
rank-based player marginals.

| Predictor     | Timing | Skill vs constant | Mid-period timing | Mid-period skill | Exit Brier / log loss / MRR | Entry Brier / log loss / MRR |
| ------------- | ------ | ----------------- | ----------------- | ---------------- | --------------------------- | ---------------------------- |
| Constant      | .221   | −.011             | .209              | −.014            | .186 / 1.61 / .40           | .130 / 2.20 / .38            |
| Statistical   | .203   | .070              | .198              | .037             | .210 / 1.73 / .47           | .150 / 2.59 / .22            |
| Generic Jev   | .234   | −.073             | .236              | −.146            | .253 / 1.87 / .46           | .142 / 2.27 / .38            |
| Stage 3 (M3)  | .190   | .131              | .196              | .049             | .382 / 2.67 / .57           | .217 / 3.40 / .46            |
| `pilot-m0-10` | .204   | .064              | .211              | −.025            | .390 / 2.88 / .57           | .193 / 2.80 / .45            |

Paired bootstrap against the statistical baseline (90 % intervals, ten
games): stage 3 is better by 0.013 on all windows [0.007, 0.020] and by
0.002 mid-period [−0.004, 0.010]; M0 is −0.001 [−0.023, 0.020] and −0.013
mid-period [−0.035, 0.009]. The statistical baseline's full-window number is
dragged by between-period windows (0.289 there: the fit does not learn that
breaks are near-certain), which is why its mid-period score is close to the
agent's. On the windows that matter, the stage-3 agent with memory matched a
plain logistic fit and M0 was worse than one.

**Player selection: the agent is overconfident.** On ranking, the briefed
Jev is clearly best (exit MRR .57 against .40–.47, exit top-1 .47 against
.18–.30). On the proper scores it is clearly worst: exit log loss 2.67–2.88
against 1.61 for the uniform distribution and 1.73 for the rank-based one.
The briefing puts confident mass on players who do not move, so the actual
mover is often given a small probability and the squared and log losses are
large. A uniform distribution over the eligible set beats every agent run on
both player Briers. This is the kind of finding the brief's player scores
were meant to surface; the fix is in how the briefing frames the exit and
entry questions, not in Jev.

The M3b-to-M0 comparison is refused by the report (five games against ten);
the pooled numbers for games 1–5 are in the stage 4 table above.

### Stage 5: M3 and M0 re-run with the Jev readout (`pilot-m3-v2`, `pilot-m0-v2`)

Nov 7, 2026, games 1–5, both runs on `542907c` with the same prompt, so the
report compares them directly (`harness_version_differs` is the memory
profile, nothing else). This is the re-run the stage-4 open item asked for:
`validate_package` now returns Jev's answers on a fixed spread of prior
states (SPO-863), the `decision_windows` and `unanchored_substitutions`
tables expose every released prior window (SPO-865), and the Jev section of
the prompt tells the agent how to use both (PR #67).

**The agent used the new tooling in every game.** M0: 15 `validate_package`
calls, all with `jev: true` (3–6 samples), 46 `decision_windows` queries.
M3: 14 calls, 9 with `jev: true`, 53 queries. Neither run queried
`unanchored_substitutions`. The Jev calls are the reason pregame cost rose
(M0 $3.58 per game against $2.90 in `pilot-m0-10`).

| Run (games 1–5)          | Timing | Skill vs constant | Mid-period timing | Mid-period skill | Mean p / rate (mid) | Reliability / resolution | Exit log loss / MRR | Entry log loss / MRR |
| ------------------------ | ------ | ----------------- | ----------------- | ---------------- | ------------------- | ------------------------ | ------------------- | -------------------- |
| `pilot-m0-v2`            | .170   | .223              | .178              | .132             | .317 / .292         | .030 / .078              | 2.71 / .55          | 2.58 / .51           |
| `pilot-m3-v2`            | .183   | .161              | .192              | .063             | .365 / .292         | .023 / .057              | 2.59 / .56          | 2.62 / .45           |
| `pilot-m0-10`, games 1–5 | .176   | —                 | .184              | .111             | .365 / .292         | —                        | —                   | —                    |
| `pilot-m3b`              | .179   | —                 | .187              | .084             | .383 / .292         | —                        | —                   | —                    |
| stage 3, games 1–5       | .179   | —                 | .188              | —                | .267 / .292         | —                        | —                   | —                    |
| statistical, games 1–5   | .197   | —                 | .191              | —                | .232 / .292         | —                        | —                   | —                    |
| constant, games 1–5      | .220   | —                 | .207              | —                | .319 / .292         | —                        | —                   | —                    |

The baseline rows are pooled by hand from `baselines-dev`'s per-game
metrics; the report refuses to attach a ten-game baselines run to a
five-game agent run (`decision_dataset_mismatch`), so there is no bootstrap
interval against the baselines here.

**Memory versus none, matched.** Paired bootstrap, M0 minus M3, 90 %
intervals over games: timing −0.013 [−0.033, −0.001]; mid-period −0.014
[−0.035, −0.002]; exit Brier +0.002 [−0.067, 0.076]; entry Brier +0.006
[−0.037, 0.039]. Stage 4 found the opposite: M3 better than M0 by 0.014
with an interval spanning zero. Two paired five-game comparisons, each
about one noise-width wide and pointing in opposite directions, is the
result: at this sample size memory has no detectable effect on timing,
and the M3 run costs 50 % more per game. Per game, M0-v2 beat M3-v2 in four
of five (0022500128 by 0.061, where M3's mean probability was .545 against
a rate of .385); leaving that game out shrinks the difference to −0.004.
M3's memory finished at 10.2k tokens, a fifth of the cap.

**Calibration.** The readout narrowed the drift but did not remove it.
M0-v2's pooled gap is +0.019 (was +0.063 for the same games in
`pilot-m0-10`), with two games still well off: 0022500106 at .448 against
.271 and 0022500117 at .273 against .355. M3-v2 drifted more, +0.065, with
game 5 at .545 against .385, despite calling `validate_package` with Jev.
By stoppage kind M0-v2 is now calibrated at fouls (.312 against .292, the
only kind with positive skill against its own constant, +.076) and at
timeouts (.542 against .571, skill zero), and still over-predicts dead-ball
turnovers (.191 against .100) and jump balls. The prompt's warning that the
validation mean is not a game-wide rate held: no agent in either run treated
it as one, but seeing Jev's reading of a wording is evidently not enough on
its own to make the agent lower a number it believes.

**Resolution is the limit.** M0-v2 is the best five-game agent run so far
(.170 against .176–.179 for every earlier run on these games), yet the gain
over the previous M0 on the same games is 0.006 pooled with per-game
differences of −.024, −.052, +.027, +.027, −.007, inside the 0.03–0.05
run-to-run noise. Resolution rose to .078 against uncertainty .218 (mid
.057 against .205); reliability is .030. A perfectly calibrated agent with
this resolution would still score about .140, so the remaining headroom is
in telling windows apart, not in the probability scale.

**Player selection is unchanged.** Exit log loss 2.59–2.71 and entry
2.58–2.62 against 1.61 and 2.20 for the uniform distribution; MRR .55–.56
and .45–.51, still the best rankers. The overconfidence found in the
baselines section is a prompt-side problem the new tooling does not touch.

### Stage 6: first run on `jev-contract-v2` (`pilot-m0-swap`)

Nov 7, 2026, M0, games 1–2, on `807adac` after the set-valued swap
contract (brief amendment PR #71, environment PR #73, prompt PR #74). The
first attempt failed every session at start with "Policy tools harness
mismatch": the session recomputed the expected harness without the swap
contract the launcher had pinned (PR #75, one line, $0 spent). The second
attempt ran clean: 8 `validate_package` calls (5 with `jev: true`), 15
`decision_windows` queries, both packages frozen, no invalid questions and
no assembler errors.

| Game       | Subs | Hit rate | Set top-1 | Candidates | `other` mass at subs | Set log loss (clips) | Exit / entry log loss (clips) | Timing |
| ---------- | ---- | -------- | --------- | ---------- | -------------------- | -------------------- | ----------------------------- | ------ |
| 0022500083 | 23   | .30      | 4         | 7.1        | .04                  | 5.40 (15)            | 2.83 / 2.53 (0 / 0)           | .171   |
| 0022500018 | 18   | .33      | 2         | 8.0        | .05                  | 5.21 (9)             | 2.12 / 2.37 (0 / 0)           | .155   |

**The list.** The agent put the coach's actual move on its candidate list
at 32 % of substitutions (13 of 41; singles 10 of 31, doubles 3 of 7, the
two larger moves missed), against 4 % for the hand-written gate-2 package
in PR #73's audit. It filled nearly every slot (mean 7.5 of 8), mostly with
1-for-1s, and still missed two thirds of the 1-for-1s the coach made:
selection, not slot count, is the limit.

**The `other` mass is the failure.** Jev gave `other` 4–5 % while the list
missed 68 % of moves, so each miss scored about 6.9 (the clip). Pooled set
log loss is 5.32 against 5.02 for the constant form (no candidates, `other`
= 1, scored through the size prior) on the same 41 moves: the first agent
run on the new contract is worse than the floor. The same answers with
`other` rescaled to 0.5 would score 4.60, well under the floor. The prompt
says a missed move with little mass on `other` is the expensive case; the
agent still wrote `other` descriptions Jev read as 1–24 %, and game 2 did
not adjust after game 1's trace showed a 30 % hit rate.

**Among listed candidates Jev is near-uniform.** Mean set log loss on hits
is 2.1, about −log(1/8); set top-1 is 6 of 41. The descriptions get moves
onto the list but do not separate them.

**The player-score defect is fixed.** Exit and entry log-loss clips are 0
(23 and 19 of 99 under the four-question contract). Derived exit log loss
2.83 / 2.12 and entry 2.53 / 2.37 against 2.6–2.9 before; these columns are
not comparable across contracts and are reported for orientation only.
Timing .171 / .155 is in line with `pilot-m0-v2` on the same games (.167 /
.147).

**Cost** $4.85 per game, up from $3.58 (more validation and code calls).

What this says: the contract does what it was built to do, which is to
expose the two levers, what is on the list and how much mass goes on
`other`. The second is a prompt problem: the agent should write `other` to
carry its own observed miss rate, which the trace now shows it, and should
read a near-uniform spread over its candidates as descriptions that do not
discriminate. The first is the harder research problem the experiment is
about.

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

- Calibration drift in fresh sessions (stage 4): the agent cannot see how Jev
  reads its wording before the game. SPO-863 lets `validate_package` return
  Jev's answers on a spread of prior-game states (user approved Nov 7, 2026;
  amends the brief's "without calling Jev" decision). Re-run as stage 5: the
  drift narrowed for M0 (+0.019) and not for M3 (+0.065); the M3–M0
  difference reversed sign against stage 4 and memory shows no detectable
  effect on five games.
- Player exit/entry overconfidence (baselines section): resolved by
  `jev-contract-v2` (PR #71, #73, #74); stage 6 shows no clips. Open in its
  place: the agent under-weights `other` (4–5 % against a 68 % miss rate),
  which puts its set score below the constant floor. A prompt change and a
  two-game re-check are the next step.
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
