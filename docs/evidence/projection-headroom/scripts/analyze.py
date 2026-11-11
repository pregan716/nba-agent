"""Offline headroom check (SPO-878). No agent, no model calls.

How good is a plain statistical projection of Celtics minutes and production in
2025-26, how much better is the prop market, and where are the misses?

Run export.ts first, then from the repository root:
  uv run --with pandas --with numpy --with scikit-learn \
    python docs/evidence/projection-headroom/scripts/analyze.py

Holdout rule: every row from a 2025-26 game that tips at or after the Celtics'
71st game is dropped straight after loading, before anything is computed. That
covers Celtics games 71-82, for both teams, and the rest of the league in that
period. export.ts already withholds those rows; the filter here is the second
guard. --plant-holdout adds fabricated rows for the held-out Celtics games
before the filter; the results file must come out byte-identical:

  ... analyze.py --plant-holdout --out /tmp/planted.json
  cmp /tmp/planted.json docs/evidence/projection-headroom/results.json

Results are written to docs/evidence/projection-headroom/results.json.
"""
import argparse, json, re, unicodedata
from collections import defaultdict
from math import erf, sqrt

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.metrics import roc_auc_score

args = argparse.ArgumentParser()
args.add_argument("--cache", default=".cache/projection-headroom")
args.add_argument("--out", default="docs/evidence/projection-headroom/results.json")
args.add_argument("--plant-holdout", action="store_true")
args.add_argument("--baseline-props", help="Export the original pregame big-over probabilities and outcomes for the evaluator parity check")
args = args.parse_args()
H, OUT = args.cache, args.out
BOS = "1610612738"
SEASONS = ("2024-25", "2025-26")
LAST_SCORED_GAME = 70
rng = np.random.default_rng(20261110)
R = {}  # results


def note(key, value, text=None):
    R[key] = value
    print(text if text is not None else f"{key}: {value}")


# ---------- load ----------
games = pd.concat([pd.DataFrame(json.load(open(f"{H}/games-{s}.json"))) for s in SEASONS])
games["tip"] = pd.to_datetime(games.scheduled_tipoff, utc=True)
# The Celtics schedule (no outcomes) fixes the holdout before any result is read.
bg = games[(games.season == "2025-26") & ((games.home_team_id == BOS) | (games.away_team_id == BOS))].sort_values("tip").reset_index(drop=True)
bg["idx"] = np.arange(1, len(bg) + 1)
holdout_start = bg[bg.idx == LAST_SCORED_GAME + 1].tip.iloc[0]
withheld = set(games[(games.season == "2025-26") & (games.tip >= holdout_start)].game_id)
held_celtics = list(bg[bg.idx > LAST_SCORED_GAME].game_id)
bg = bg[bg.idx <= LAST_SCORED_GAME].reset_index(drop=True)

BOX = "game_id player_id team_id sec pts reb ast stl blk tov fg3m".split()
SUMMARY = "game_id player_id team_id starter status".split()
box = pd.concat([pd.DataFrame([json.loads(l) for l in open(f"{H}/player_box_scores-{s}.jsonl")], columns=BOX) for s in SEASONS])
summary = pd.concat([pd.DataFrame([json.loads(l) for l in open(f"{H}/v_player_game_summary-{s}.jsonl")], columns=SUMMARY) for s in SEASONS])
injury_rows = json.load(open(f"{H}/injuries-bos.json"))
props = pd.DataFrame(json.load(open(f"{H}/props.json")), columns="game_id player_id stat line p_over".split())
if args.plant_holdout:  # fabricated held-out rows; the filter below must remove every trace
    players = list(box[box.team_id == BOS].player_id.unique()[:10])
    for g in held_celtics:
        box = pd.concat([box, pd.DataFrame([[g, p, BOS, 2880, 99, 99, 99, 9, 9, 9, 9] for p in players], columns=BOX)])
        summary = pd.concat([summary, pd.DataFrame([[g, p, BOS, i < 5, "active"] for i, p in enumerate(players)], columns=SUMMARY)])
        props = pd.concat([props, pd.DataFrame([[g, p, "points", 0.5, 0.5] for p in players], columns=props.columns)])
        injury_rows = injury_rows + [dict(injury_rows[0], game_id=g, availableAt="2025-10-01T00:00:00Z", status="Out")]
before = len(box), len(summary), len(props), len(injury_rows)
box, summary, props = (d[~d.game_id.isin(withheld)].reset_index(drop=True) for d in (box, summary, props))
injury_rows = [r for r in injury_rows if r["game_id"] not in withheld]
print("holdout rows dropped (box, summary, props, injuries):", [b - a for b, a in zip(before, (len(box), len(summary), len(props), len(injury_rows)))])
df = box.merge(summary, on=["game_id", "player_id", "team_id"], how="left").merge(games[["game_id", "season", "tip"]], on="game_id")
for col in "sec pts reb ast".split():
    df[col] = pd.to_numeric(df[col]).fillna(0.0)
df["min"] = df.sec / 60
df["played"] = (df["min"] > 0).astype(int)
df["starter"] = df.starter.fillna(False).astype(int)
df["inactive"] = ((df.status == "inactive") & (df.played == 0)).astype(int)
df = df.sort_values(["tip", "game_id", "team_id", "player_id"]).reset_index(drop=True)

# ---------- Celtics schedule and the last pregame injury report ----------
game_index, game_tip = dict(zip(bg.game_id, bg.idx)), dict(zip(bg.game_id, bg.tip))


def norm(name):
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[^a-z ]", "", s.replace("-", " "))
    return " ".join(w for w in s.split() if w not in ("jr", "sr", "ii", "iii", "iv"))


names = dict(json.load(open(f"{H}/names.json")))
celtics_ids = set(df[(df.team_id == BOS) & (df.season == "2025-26")].player_id)
name_to_id = {norm(names[p]): p for p in celtics_ids if p in names}
reports = defaultdict(list)
for row in injury_rows:
    g = row["game_id"]
    if g in game_tip and pd.Timestamp(row["availableAt"]) < game_tip[g] and row["status"] != "NOT YET SUBMITTED":
        reports[g].append((pd.Timestamp(row["availableAt"]), row))
listed_out, unmatched, no_report = defaultdict(set), set(), []
for g in bg.game_id:
    if not reports[g]:
        no_report.append(g)
        continue
    last = max(t for t, _ in reports[g])
    for t, row in reports[g]:
        if t != last or not row.get("player_name"):
            continue
        parts = row["player_name"].split(",")
        pid = name_to_id.get(norm(parts[1] + " " + parts[0]) if len(parts) == 2 else norm(row["player_name"]))
        if not pid:
            unmatched.add(row["player_name"])
        elif row["status"] in ("Out", "Doubtful"):
            listed_out[g].add(pid)
note("injury_games_without_pregame_report", no_report)
note("injury_unmatched_names", sorted(unmatched))

# ---------- as-of player features (state before each game, then update) ----------
DECAY_MIN, DECAY_RATE, DECAY_PLAY = 0.80, 0.95, 0.85
LEAGUE_RATE = {"pts": 0.47, "reb": 0.18, "ast": 0.11}
PSEUDO_MIN = 60.0
FEATURES = "ew_min ew_play ew_start n_played last_min miss_streak n_team r_pts r_reb r_ast rate_w".split()
state, feat = {}, np.full((len(df), len(FEATURES)), np.nan)
for i, (pid, tid, mn, pl, sta, ina, pts, reb, ast) in enumerate(df[["player_id", "team_id", "min", "played", "starter", "inactive", "pts", "reb", "ast"]].to_numpy()):
    s = state.get(pid)
    if s is None:
        s = state[pid] = dict(wm=0.0, sm=0.0, wp=0.0, sp=0.0, ss=0.0, rm=0.0, rp=0.0, rr=0.0, ra=0.0, n=0, last=np.nan, miss=0, team=None, nteam=0)
    same = s["team"] == tid
    feat[i] = [
        s["sm"] / s["wm"] if s["wm"] else np.nan,
        s["sp"] / s["wp"] if s["wp"] else np.nan,
        s["ss"] / s["wm"] if s["wm"] else np.nan,
        s["n"], s["last"], s["miss"], s["nteam"] if same else 0,
        (s["rp"] + PSEUDO_MIN * LEAGUE_RATE["pts"]) / (s["rm"] + PSEUDO_MIN),
        (s["rr"] + PSEUDO_MIN * LEAGUE_RATE["reb"]) / (s["rm"] + PSEUDO_MIN),
        (s["ra"] + PSEUDO_MIN * LEAGUE_RATE["ast"]) / (s["rm"] + PSEUDO_MIN),
        s["rm"],
    ]
    if not same:
        s["team"], s["nteam"] = tid, 0
    if ina:
        s["miss"] += 1
        continue
    s["wp"] = s["wp"] * DECAY_PLAY + 1
    s["sp"] = s["sp"] * DECAY_PLAY + pl
    if pl:
        s["wm"] = s["wm"] * DECAY_MIN + 1
        s["sm"] = s["sm"] * DECAY_MIN + mn
        s["ss"] = s["ss"] * DECAY_MIN + sta
        for key, value in (("rm", mn), ("rp", pts), ("rr", reb), ("ra", ast)):
            s[key] = s[key] * DECAY_RATE + value
        s["n"] += 1
        s["last"] = mn
        s["miss"] = 0
        s["nteam"] += 1
for j, col in enumerate(FEATURES):
    df[col] = feat[:, j]
df["ew_exp"] = df.ew_min.fillna(0) * df.ew_play.fillna(0.5)


def team_features(d, out_col, suffix):
    """Minutes redistributed over the players not known to be out."""
    d = d.copy()
    d["_e"] = np.where(d[out_col] == 1, 0.0, d.ew_exp)
    by_team = d.groupby(["game_id", "team_id"])
    total = by_team["_e"].transform("sum")
    d["share240" + suffix] = np.where(total > 0, d["_e"] / total * 240, 0.0)
    d["out_min" + suffix] = (d.ew_exp * d[out_col]).groupby([d.game_id, d.team_id]).transform("sum")
    d["rank" + suffix] = by_team["_e"].rank(ascending=False, method="first")
    return d.drop(columns="_e")


df = team_features(df, "inactive", "")
BASE = ["ew_min", "ew_play", "ew_start", "n_played", "last_min", "miss_streak", "n_team", "ew_exp", "share240", "out_min", "rank"]

# ---------- the plain model: fit once on every team's 2024-25 games ----------
train = df[(df.season == "2024-25") & (df.inactive == 0)]
HGB = dict(max_iter=300, learning_rate=0.05, max_depth=5, min_samples_leaf=40, random_state=1)
play_model = HistGradientBoostingClassifier(**HGB).fit(train[BASE], train.played)
minutes_model = HistGradientBoostingRegressor(**HGB).fit(train[train.played == 1][BASE], train[train.played == 1]["min"])
minutes_model_starter = HistGradientBoostingRegressor(**HGB).fit(train[train.played == 1][BASE + ["starter"]], train[train.played == 1]["min"])


def project(d, out_col, suffix, starters=False, active=False):
    """(expected minutes, minutes given the player plays), scaled to 240 per team-game."""
    X = d[BASE].copy()
    if suffix:
        for col in ("share240", "out_min", "rank"):
            X[col] = d[col + suffix]
    if starters:
        cond = minutes_model_starter.predict(X.assign(starter=d.starter))
        p = np.where(d.starter == 1, 1.0, play_model.predict_proba(X)[:, 1])
    else:
        cond, p = minutes_model.predict(X), play_model.predict_proba(X)[:, 1]
    if active:
        p = d.played.to_numpy().astype(float)
    expected = np.where(d[out_col].to_numpy() == 1, 0.0, p) * cond
    total = pd.Series(expected).groupby([d.game_id.to_numpy(), d.team_id.to_numpy()]).transform("sum").to_numpy()
    scale = np.where(total > 0, 240 / total, 1.0)
    return np.minimum(expected * scale, 46), np.clip(cond * scale, 1, 46)


league = df[(df.season == "2025-26") & (df.team_id != BOS)].copy()
league["model"], _ = project(league, "inactive", "")
avail = league.inactive == 0
note(
    "league_2025_26_minutes_mae",
    {"model": float((league.model - league["min"]).abs()[avail].mean()), "recent_minutes_redistributed": float((league.share240 - league["min"]).abs()[avail].mean())},
)

# ---------- Celtics minutes ----------
c = df[(df.team_id == BOS) & (df.season == "2025-26")].copy()
c["idx"] = c.game_id.map(game_index)
assert c.idx.notna().all() and c.idx.max() <= LAST_SCORED_GAME
c["out_pre"] = [int(p in listed_out[g]) for g, p in zip(c.game_id, c.player_id)]
c["out_all"] = np.maximum(c.out_pre, c.inactive)  # the release marks some injured players dnp, not inactive
c = team_features(team_features(c, "out_pre", "_pre"), "out_all", "_all")
c["naive"] = np.where(c.out_pre == 1, 0, c.share240_pre)
c["base"], c["base_c"] = project(c, "out_pre", "_pre")
c["inact"], c["inact_c"] = project(c, "out_all", "_all")
c["start"], c["start_c"] = project(c, "out_all", "_all", starters=True)
c["active"], c["active_c"] = project(c, "out_all", "_all", starters=True, active=True)

# A change game: the starting five, or the set of absent rotation players, differs
# from the previous game. Retrospective label, used only to split results.
change, prev = {}, None
for g in bg.game_id:
    d = df[(df.game_id == g) & (df.team_id == BOS)]
    key = (frozenset(d[d.starter == 1].player_id), frozenset(d[(d.inactive == 1) & (d.ew_exp >= 12)].player_id))
    change[g] = prev is None or key != prev
    prev = key
c["change"] = c.game_id.map(change)
per_game_change = c.groupby("game_id").change.first()


def boot(per_game, n=5000):
    v = per_game.to_numpy()
    means = [v[rng.integers(0, len(v), len(v))].mean() for _ in range(n)]
    return [float(x) for x in np.percentile(means, [5, 95])]


def boot_pooled(total, count, n=5000):
    """Interval for a mean over props: resample games, divide summed loss by summed prop count."""
    t, k, draws = total.to_numpy(), count.to_numpy(), []
    for _ in range(n):
        i = rng.integers(0, len(t), len(t))
        draws.append(t[i].sum() / k[i].sum())
    return [float(x) for x in np.percentile(draws, [5, 95])]


def misplaced(col, sub=None):
    d = c if sub is None else c[c.change == sub]
    return (d[col] - d["min"]).abs().groupby(d.game_id).sum() / 2


rotation = c[(c.played == 1) | (c.base >= 8)]
LABELS = [
    ("naive", "Recent minutes, redistributed for injury-report outs"),
    ("base", "Plain model, injury report known (the baseline)"),
    ("inact", "  + true inactive list known"),
    ("start", "  + actual starters known"),
    ("active", "  + who actually played known"),
]
print(f"\nCeltics games scored: {c.game_id.nunique()} (1-{LAST_SCORED_GAME}); change games {int(per_game_change.sum())}")
print("MINUTES: misplaced minutes per game (half the summed absolute error over the roster)")
print("%-52s %6s %7s %7s  %s" % ("projection", "all", "change", "stable", "MAE per rotation player"))
R["minutes"] = {}
for col, label in LABELS:
    row = dict(all=float(misplaced(col).mean()), change=float(misplaced(col, True).mean()), stable=float(misplaced(col, False).mean()), rotation_mae=float((rotation[col] - rotation["min"]).abs().mean()))
    R["minutes"][col] = row
    print("%-52s %6.1f %7.1f %7.1f  %.2f" % (label, row["all"], row["change"], row["stable"], row["rotation_mae"]))
gap = misplaced("base") - misplaced("active")
note("minutes_baseline_minus_active", {"mean": float(gap.mean()), "interval90": boot(gap)})
note("minutes_baseline_per_game_sd", float(misplaced("base").std()))
note("games", {"scored": int(c.game_id.nunique()), "change": int(per_game_change.sum())})
err = (rotation.base - rotation["min"]).abs()
note("rotation_player_games_off_by", {"10_or_more": float((err >= 10).mean()), "6_or_more": float((err >= 6).mean())})
c["tier"] = pd.cut(c.ew_exp, [-1, 5, 15, 26, 60], labels=["deep bench (<5)", "fringe (5-15)", "rotation (15-26)", "core (26+)"])
available = c[c.out_pre == 0].assign(abs_err=lambda d: (d.base - d["min"]).abs())
tiers = available.groupby("tier", observed=True).agg(player_games=("abs_err", "size"), mae=("abs_err", "mean"), total=("abs_err", "sum"), played=("played", "mean"))
tiers["share_of_error"] = tiers.total / tiers.total.sum()
print(tiers.drop(columns="total").round(2))
R["minutes_by_tier"] = tiers.drop(columns="total").round(4).to_dict("index")

# ---------- production against the prop market at scheduled tip ----------
STAT = {"points": ("pts", "r_pts"), "rebounds": ("reb", "r_reb"), "assists": ("ast", "r_ast")}
# `offered` is every prop with a consensus at the scheduled-start snapshot: the pregame
# candidate pool. `m` is the subset where the player played, for scores given that he plays.
offered = props.merge(c, on=["game_id", "player_id"], how="left", indicator=True)
note("props_offered", {"all": int(len(offered)), "player_not_on_game_roster": int((offered._merge != "both").sum())})
offered = offered[offered._merge == "both"].drop(columns="_merge").sort_values(["game_id", "player_id", "stat"]).reset_index(drop=True)
offered["actual"] = [row[STAT[s][0]] for s, (_, row) in zip(offered.stat, offered.iterrows())]
offered["rate"] = [row[STAT[s][1]] for s, (_, row) in zip(offered.stat, offered.iterrows())]
# Spread of a stat around its expectation, from 2024-25: Var = phi * mean.
phi, t = {}, df[(df.season == "2024-25") & (df.played == 1) & (df.rate_w > 200)]
for s, (actual_col, rate_col) in STAT.items():
    mu = t[rate_col] * t["min"]
    phi[s] = float((((t[actual_col] - mu) ** 2) / np.maximum(mu, 0.5)).mean())
note("dispersion_phi", phi)


def prob_at_least(mu, threshold, stat):
    z = (threshold - mu) / np.sqrt(np.maximum(mu, 0.3) * stat.map(phi))
    return 1 - 0.5 * (1 + np.vectorize(erf)(z / sqrt(2)))


offered["sd_line"] = np.sqrt(offered.line * offered.stat.map(phi))
# Pregame chance of playing under each variant (the two oracles know who played).
safe = lambda a, b: np.clip(np.where(offered[b] > 0, offered[a] / offered[b], 0.0), 0, 1)
P_PLAY = {"base": safe("base", "base_c"), "start": safe("start", "start_c"), "active": offered.played.to_numpy().astype(float), "oracle": offered.played.to_numpy().astype(float)}
m = offered[offered.played == 1].reset_index(drop=True)
m["y"] = (m.actual > m.line).astype(int)
VARIANTS = [("base", "base_c", "Baseline: projected minutes x recent per-minute rate"), ("start", "start_c", "  knowing the actual starters"), ("active", "active_c", "  knowing starters and who played"), ("oracle", "min", "  with the minutes actually played")]
for tag, minutes_col, _ in VARIANTS:
    m["mu_" + tag] = m.rate * m[minutes_col]
    m["po_" + tag] = prob_at_least(m["mu_" + tag], m.line, m.stat)
    m["b_" + tag] = (m["po_" + tag] - m.y) ** 2
m["b_market"] = (m.p_over - m.y) ** 2
print(f"\nPRODUCTION against the market: {len(m)} props over {m.game_id.nunique()} games (player played)")
print("%-56s %7s %7s %7s %6s %6s" % ("forecast", "Brier", "change", "stable", "MAE", "side"))
R["production"] = {"props": int(len(m))}


def production_row(tag, label, center):
    side = None if center is None else float(((center > m.line).astype(int) == m.y).mean())
    row = dict(brier=float(m["b_" + tag].mean()), change=float(m[m.change]["b_" + tag].mean()), stable=float(m[~m.change]["b_" + tag].mean()), mae=float((m.actual - (m.line if center is None else center)).abs().mean()), right_side=side)
    R["production"][tag] = row
    print("%-56s %7.4f %7.4f %7.4f %6.2f %6s" % (label, row["brier"], row["change"], row["stable"], row["mae"], "" if side is None else "%.1f%%" % (100 * side)))


production_row("market", "Market consensus", None)
for tag, _, label in VARIANTS:
    production_row(tag, label, m["mu_" + tag])
for tag in ("base", "oracle"):
    diff = (m["b_" + tag] - m.b_market).groupby(m.game_id)
    note(f"brier_{tag}_minus_market", {"mean": float((m["b_" + tag] - m.b_market).mean()), "interval90": boot_pooled(diff.sum(), diff.size())})
R["production_by_stat"] = {s: {k: float(d[k].mean()) for k in ("b_market", "b_base", "b_oracle")} | {"n": int(len(d))} for s, d in m.groupby("stat")}
m["min_err"] = m["min"] - m.base_c

# ---------- big overs: at least one standard deviation over the line ----------
# The event is pregame and unconditional: the player plays and clears line + SD. The three
# picks per game are frozen from every prop offered, before anyone knows who played. A
# pick on a player who then sits is a void: it is never replaced and counts as a miss.
m["big"] = (m.actual >= m.line + m.sd_line).astype(int)
offered["big"] = ((offered.played == 1) & (offered.actual >= offered.line + offered.sd_line)).astype(int)
big = {
    "offered": int(len(offered)),
    "offered_player_did_not_play": int((offered.played == 0).sum()),
    "base_rate_offered": float(offered.big.mean()),
    "base_rate_played": float(m.big.mean()),
    "per_game": float(m.big.sum() / m.game_id.nunique()),
    "market_p_over_auc_played": float(roc_auc_score(m.big, m.p_over)),
}
print(f"\nBIG OVERS: {big['offered']} props offered, {big['offered_player_did_not_play']} on players who sat; base rate {big['base_rate_offered']:.3f} of offered, {big['base_rate_played']:.3f} of played")
for tag, minutes_col, label in VARIANTS:
    given_play = prob_at_least(offered.rate * offered[minutes_col], offered.line + offered.sd_line, offered.stat)
    ranked = offered.assign(score=P_PLAY[tag] * given_play).sort_values(["score", "player_id", "stat"], ascending=[False, True, True], kind="mergesort")
    if tag == "base" and args.baseline_props:
        ranked[["game_id", "player_id", "stat", "line", "actual", "played", "score"]].to_json(args.baseline_props, orient="records", double_precision=15)
    picks = ranked.groupby("game_id").head(3)
    voids = int((picks.played == 0).sum())
    big[tag] = {
        "auc_played": float(roc_auc_score(m.big, prob_at_least(m["mu_" + tag], m.line + m.sd_line, m.stat))),
        "picks": int(len(picks)),
        "void_picks": voids,
        "top3_hit_rate": float(picks.big.mean()),
        "top3_hit_rate_excluding_voids": float(picks[picks.played == 1].big.mean()),
    }
    print("%-56s picks %d, void %d, hit %.3f (excluding voids %.3f)" % (label, len(picks), voids, big[tag]["top3_hit_rate"], big[tag]["top3_hit_rate_excluding_voids"]))
big["minutes_above_projection"] = {"big_overs": float(m[m.big == 1].min_err.mean()), "others": float(m[m.big == 0].min_err.mean()), "big_overs_with_4_or_more": float((m[m.big == 1].min_err >= 4).mean())}
R["big_overs"] = big
print("minutes above projection:", big["minutes_above_projection"])

# Fantasy points under the brief's proposed weights can be negative.
played = c[c.played == 1].merge(box[["game_id", "player_id", "stl", "blk", "tov", "fg3m"]], on=["game_id", "player_id"], suffixes=("", "_b"))
for col in "stl blk tov fg3m".split():
    played[col] = pd.to_numeric(played[col]).fillna(0)
doubles = sum((played[k] >= 10).astype(int) for k in "pts reb ast stl blk".split())
fp = played.pts + 0.5 * played.fg3m + 1.25 * played.reb + 1.5 * played.ast + 2 * played.stl + 2 * played.blk - 0.5 * played.tov + 1.5 * (doubles >= 2) + 3 * (doubles >= 3)
note("fantasy_points_played", {"player_games": int(len(fp)), "negative": int((fp < 0).sum()), "min": float(fp.min())})

json.dump(R, open(OUT, "w"), indent=1, sort_keys=True)
print("\nwrote", OUT)
