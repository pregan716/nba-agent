# Project notes (read first)

## Key facts learned (iteration 1)
- ctx keys: artifacts, feedback, gameId, reference, referenceHistory, roster, scores, spread, teamId, tip, total.
- ctx.roster has `inactive` flag per player = official inactive list at forecast time.
  Historical equivalent: player_game_summary.participation_status == 'inactive'.
- lineups table: starting lineups ~25 min before tip; starterIds ~99.9% accurate. Coverage varies by team:
  team 738 only has its team account as source and MISSES ~40% of games (6/15 in the eval window);
  760/764 have several sources and ~100% coverage. Unseen teams may be either.
- Posts are sparse (a few per game) but sometimes say "X late scratch" / "Y gets the start".
- Reference minutes ranges ~symmetric around median; tier loss sums per game: rotation ~7, fringe ~4.5,
  core ~3.5, deep ~1-2.5.
- Scoring formula verified; model.pinball_minutes reproduces env score.
- archive_read 'summary' is HUGE (~200k chars). The paired ratio vs reference ("againstReference") is at
  the very END: read summary with offset ~200000 (page with next=null). Don't page through the rest.
  sandboxSteps page 1 shows ~12 games of stderr (16k chars).
- data_python: files in /tmp persist between calls, but disk is tiny (pickle of a 50k-row feature frame
  failed with ENOSPC). /tmp/d.pkl (raw player rows) and /tmp/feat.py exist.

## In-sandbox backtest (very useful, free)
main.py builds `recs` from ctx.referenceHistory, reconstructs lineup / inactive history as of each
earlier tip and replays variants, printing BACKTEST/SELECT json to stderr. Test run on
(760:0022500808, 764:0022500803, 738:0022500799) gives ~50 history games per team.

## Results
- Iter 1 FULL run 9d3e391b (v1: lineup+inactive+role shift+redistribute+med blend+qcal, no GBM):
  minutes ratio 0.974 [0.952, 0.996]; fantasy 0.995 [0.986,1.003]; playBrier 0.981 [0.968,0.991];
  no guardrail flag. Backtest had promised ~0.94 -> eval window harder / in-sample optimism.
  Team 738 contributes little (missing lineups; its backtest ~0.99-0.96).
- Iter 2 (this): added gbm.py = league-wide quantile GBM (HistGradientBoosting, 7 quantiles + bench
  play classifier) fitted IN-LOOP on previous season box scores (~7.5s/game). Features: start/bench role,
  zero-filled recent minutes, played-only recent minutes, role-split averages, start/play rates, games
  since last played, team minutes missing from inactive teammates, n_active, rest, team game index.
  Backtest ratios vs ref (738/764/760): base .963/.949/.914; GBM blend w=.25 .958/.930/.907;
  w=.5 .961/.922/.917; w>=.75 worse; GBM alone worse than ref-adjusted. Classifier p_play HURTS (p50, p100) -> off.
  Online choice of w in {0,.25,.5} from the team's own earlier games (online_select, default .25, needs
  10 games and 0.5% margin): honest nested ratio .959/.927/.910 (~1% better than base).
  GBM blend ramps in with player's current-season games played (gbm_ramp=5) so opening night = no GBM.
  Knob sweep around g25 (med_w 0, redistribute .5/0, qcal_k 50/400, width scale, start_bump 4/8):
  all within +-0.5%, inconsistent across teams -> left unchanged.
  Offline: adding current-season rows to GBM training ~no gain (1.366 vs 1.370) -> trained on prev season only.
- Early-season diagnostic (EARLYBT, min_prev=0, test at each team's 13th game: 738:0022500216,
  760:0022500222, 764:0022500235): over first ~12 games ratio vs ref ~0.85 (cur) -- early gains are BIG
  (ref weakest; lineups worth ~8% there: nolineup ~0.93-0.95). GBM without ramp beat ramp5 -> gbm_ramp=0.
  w50 early better on 2/3 teams. Imputing last-season averages as recent form for players without a
  current-season game (gbm_impute) slightly HURT -> off (code kept).
- Predicted lineup (prev game's starters when no announcement) HURT badly in backtest -> off (use_pred_lineup).
- Iter 2 submitted FULL of this version (hypothesis gbm-minutes). Expected ratio ~0.962-0.968
  (about 1% better than run 9d3e391b); gain mainly in rotation/core tiers for team 764.

## Iteration 3 (this one)
- FULL fbfb2fbe (GBM version) result: ratio vs ref 0.972 [0.949, 0.996]; fantasy 0.991 [0.982,1.001];
  playBrier 0.981; no flag. Paired vs 9d3e391b: 0.998 [0.986, 1.011] -> GBM gain NOT visible in full eval
  (backtest promised ~1%). Both full runs ~0.972-0.974.
- Offline (my view): |spread| barely moves starters' minutes (-0.06 min/pt, noise sd 5.5) -> ignore for starters.
  Deep bench (active, bench, recent<8 min) play rate rises with |spread| in dev data (.43 -> .70), but
  with a 2024-25 point-diff proxy the gradient is weaker (.48 -> .60) and the in-sandbox backtest of a
  logit shift HURT slightly on all 3 teams -> spr_w=0 (code kept: gbm.margin_proxy, model.spread_adjust).
- Return from absence (2024-25 league): minutes vs recent played avg -1 (1 missed), -2 (2-4), -3 (5-7),
  -5 (8+); bench hit harder than starters. Added model.absence_adjust (table fitted in-loop on previous
  season, gbm.absence_table), abs_w=1.0 in draft. Backtest gain ~0.2% (2 of 3 teams). NOT yet in a full run.
- Reference conditional median error for played players (median>=8) is about -1.0 min on all teams
  (ref medians too high); qcal partially corrects (lam~0.6).
- Posts sometimes contain starters when the lineups table lacks them (e.g. "X, Y, Z ... are the starters
  tonight", "starting X tonight") -> possible regex/agent parser for teams with missing lineups (small gain).
- Minutes-restriction talk exists in posts/transcripts but is rare and often post-game.
- Ended iteration with CHECK "opening" on fbfb2fbe (to see real early-season performance; final eval
  starts opening night). Expect ratio ~0.88-0.93 (EARLYBT backtest said ~0.85 over first 12 games).

## Iteration 4
- OPENING CHECK 21f83a3f (config fbfb2fbe): minutes ratio 0.885 [0.854, 0.916]; fantasy 0.959 [0.945,0.974];
  playBrier 0.940; no flag, no fallbacks. Early season is where we gain most (lineups + inactive vs weak ref).
- Backtest ratios (~0.92 avg) are better than full-eval ratios (0.972) mainly because the backtest
  history includes early-season games (gains ~15% there); mid-season gain is ~3%.
- Tried injury-report "listed but playing" adjustment (league table: listed starters play ~5.5% below
  their recent avg relative to unlisted; real) -> backtest neutral -> lst_w=0 (closed hypothesis).
  Sandbox injury tables = current season only.
- Real spreads (game_lines, my view) show NO relation between |spread| and starters'/bench minutes error.
- MINSUM diagnostic: reference expected team minutes (sum p_play x median) averages ~244 vs 241 actual,
  per-game sd 6-10; ours ~241 on average. NEW normalize_total (norm_w=1, target 241, cap 4/player):
  better on all 3 teams late (.9572/.9222/.9000 vs .9579/.9243/.9054) and early; norm150 worse.
- Knob recheck (bias, platt, scale, med_w 0/.6, qcal_k 75/300): nothing consistently better. bias clearly worse.
- Archive reading cost: sandboxSteps page of a 3-game test ~ $0.5-0.9; summary pages ~$0.06 each but
  the full-run summary is ~200k chars; the againstReference block is in the LAST page (offset ~186000
  for a 41-game run). Use compare() for paired results instead.
- Submitted FULL of draft = fbfb2fbe + abs_w=1 + norm_w=1 (lst off). Expected: paired vs fbfb2fbe
  ~0.993-0.997 (interval spans 1), overall ratio ~0.966-0.970; gains in R/C tiers; guardrails unchanged.

## Iteration 5 (final): only "nominate" was allowed
- FULL 4abbd0ba (abs+norm): ratio 0.972 [0.949,0.996], fantasy 0.991, playBrier 0.981, no flag.
  Paired vs fbfb2fbe: 0.99993 [0.994,1.006] -> identical. abs/norm add nothing measurable.
- NOMINATED fbfb2fbe: same mid-season score, simpler, and the only config verified on the opening
  stretch (check 21f83a3f: 0.885 [0.854,0.916], no fallbacks) -- final eval starts opening night.

## Next iteration: first steps
A. compare(new full, fbfb2fbe). If not worse, run CHECK "late" on the new full (the honest reading),
   then nominate it if late ratio < 1 with no guardrail flag. If new full is worse by >0.5%, inspect
   per-tier and consider late check on fbfb2fbe instead.
B. Evals used so far: 2 full + 1 check + this full = 4 of 12.

## Older: iteration-3 first steps
0. Read the opening check result (archive_read summary offset ~200000 for againstReference; it is a
   normal run so forecasts/sandboxSteps are readable). Look at games 1-5 per team (opening night with no
   current-season data): any fallbacks/errors? Is our system better there?
1. Then decide: full run of current draft (abs on) -> late check -> nominate. Remaining evals after this: 9.

## Older next steps (iteration 2)
1. Read iterations; get new full run id; compare(new, 9d3e391b) for the paired difference; check guardrails
   (summary offset ~200000 end page).
2. If the gain holds (or neutral), run check "opening" on the better full run: final eval starts opening
   night, where reference is weakest and our history-based parts (qcal, GBM, med) are inactive; the
   opening-night redistribution of -44 min (role shifts add minutes, then taken back) is untested.
3. Then consider the late check before nominating.

## Ideas queue
1. Early season robustness (see above). Possibly GBM prev-season features (ps_avg etc.) are useless now
   because training season has no previous season in data -> at opening the GBM knows only role/team context.
2. Agent reading posts/transcripts for missing lineups (team-account-only teams), late scratches,
   minutes restrictions. Costly; value unclear.
3. Spread -> deep bench garbage time (needs stored spreads in an artifact).
