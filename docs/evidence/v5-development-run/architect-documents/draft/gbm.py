"""League-wide minutes model fitted inside the loop on the previous season's box scores.

Features use only games before each row (per player, per season). The model predicts
conditional minutes quantiles given the player's start/bench role, and P(play | active, bench).
"""
import sys, time
import numpy as np
import pandas as pd

LEVELS = [0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95]
FEATS = ["st", "m5z", "m10z", "p3", "p10", "last", "s_avg", "b_avg", "n_s", "n_b", "sr10", "pr10", "gap",
         "n_play", "std10", "ps_avg", "ps_n", "ps_sr", "team_missing", "n_active", "rest", "tg_idx"]
CFEATS = [f for f in FEATS if f != "st"]


def log(*a):
    print(*a, file=sys.stderr)


def build_features(d):
    """d columns: game_id, team_id, player_id, starter(bool), participation_status, min, played(bool),
    tip, season, inact(bool). Rows with participation_status 'pending' are targets (no update)."""
    d = d.sort_values(["tip", "game_id"]).reset_index(drop=True)
    ps = {}
    seasons = sorted(d["season"].dropna().unique())
    for i, s in enumerate(seasons):
        if i == 0:
            continue
        prev = d[(d.season == seasons[i - 1]) & d.played]
        ps[s] = prev.groupby("player_id").agg(ps_avg=("min", "mean"), ps_n=("min", "size"), ps_sr=("starter", "mean"))
    tg = d[["game_id", "team_id", "tip"]].drop_duplicates(["game_id", "team_id"]).sort_values("tip")
    tg["tg_idx"] = tg.groupby("team_id").cumcount()
    tg["prev_tip"] = tg.groupby("team_id")["tip"].shift(1)
    tg["rest"] = ((tg["tip"] - tg["prev_tip"]).dt.total_seconds() / 86400.0).clip(upper=5).fillna(3)
    d = d.merge(tg[["game_id", "team_id", "tg_idx", "rest"]], on=["game_id", "team_id"], how="left")
    keys = ["m5z", "m10z", "p3", "p10", "last", "s_avg", "b_avg", "n_s", "n_b", "sr10", "pr10", "gap",
            "n_play", "std10", "ps_avg", "ps_n", "ps_sr"]
    F = {k: np.full(len(d), np.nan) for k in keys}
    hist = {}
    pid_a = d["player_id"].values; sea_a = d["season"].values; st_a = d["starter"].values
    stat_a = d["participation_status"].values; min_a = d["min"].values; pl_a = d["played"].values
    for i in range(len(d)):
        key = (pid_a[i], sea_a[i])
        h = hist.get(key)
        if h is None:
            h = {"z": [], "pl": [], "st": [], "sm": [], "bm": [], "lp": None, "plays": 0}
            hist[key] = h
        z = h["z"]; pl = h["pl"]
        if z:
            F["m5z"][i] = np.mean(z[-5:]); F["m10z"][i] = np.mean(z[-10:])
            F["pr10"][i] = np.mean([1.0 if x > 0 else 0.0 for x in z[-10:]])
        if pl:
            F["p3"][i] = np.mean(pl[-3:]); F["p10"][i] = np.mean(pl[-10:]); F["last"][i] = pl[-1]
            if len(pl) >= 3:
                F["std10"][i] = np.std(pl[-10:])
        if h["sm"]:
            F["s_avg"][i] = np.mean(h["sm"][-10:])
        if h["bm"]:
            F["b_avg"][i] = np.mean(h["bm"][-10:])
        F["n_s"][i] = len(h["sm"]); F["n_b"][i] = len(h["bm"])
        if h["st"]:
            F["sr10"][i] = np.mean(h["st"][-10:])
        F["gap"][i] = min(20, len(z) - h["lp"] - 1) if h["lp"] is not None else 20
        F["n_play"][i] = h["plays"]
        g = ps.get(sea_a[i])
        if g is not None and pid_a[i] in g.index:
            F["ps_avg"][i] = g.at[pid_a[i], "ps_avg"]; F["ps_n"][i] = g.at[pid_a[i], "ps_n"]
            F["ps_sr"][i] = g.at[pid_a[i], "ps_sr"]
        if stat_a[i] in ("played", "dnp", "inactive"):
            m = float(min_a[i]) if pl_a[i] else 0.0
            z.append(m)
            if pl_a[i]:
                pl.append(m); h["plays"] += 1; h["lp"] = len(z) - 1
                (h["sm"] if st_a[i] else h["bm"]).append(m)
            h["st"].append(1.0 if (st_a[i] and pl_a[i]) else 0.0)
    for k, v in F.items():
        d[k] = v
    d["m5z0"] = d["m5z"].fillna(0.0)
    d["miss_c"] = d["m5z0"] * d["inact"].astype(float)
    grp = d.groupby(["game_id", "team_id"])
    d["team_missing"] = grp["miss_c"].transform("sum") - d["miss_c"]
    d["n_active"] = grp["inact"].transform(lambda s: float((~s.astype(bool)).sum()))
    d["st"] = d["starter"].astype(float)
    return d


def impute_prev(T):
    """For rows whose player has no appearance yet this season but played last season, fill recent-form
    features from last season's averages; then recompute team missing minutes."""
    T = T.copy()
    k = (T["n_play"].fillna(0) <= 0) & T["ps_n"].notna() & (T["ps_n"] > 0)
    T["_imputed"] = k
    if k.any():
        pa = T.loc[k, "ps_avg"]; sr = T.loc[k, "ps_sr"].fillna(0); pr = (T.loc[k, "ps_n"] / 70.0).clip(upper=1.0)
        for c in ("p3", "p10", "last"):
            T.loc[k, c] = pa
        T.loc[k, "m5z"] = pa * pr; T.loc[k, "m10z"] = pa * pr
        T.loc[k, "pr10"] = pr; T.loc[k, "sr10"] = sr
        T.loc[k, "s_avg"] = np.where(sr >= 0.5, pa, np.nan)
        T.loc[k, "b_avg"] = np.where(sr < 0.5, pa, np.nan)
        T.loc[k, "n_s"] = (10 * sr).round(); T.loc[k, "n_b"] = (10 * (1 - sr)).round()
        T.loc[k, "gap"] = 0.0; T.loc[k, "n_play"] = 10.0
        T["m5z0"] = T["m5z"].fillna(0.0)
        T["miss_c"] = T["m5z0"] * T["inact"].astype(float)
        grp = T.groupby(["game_id", "team_id"])
        T["team_missing"] = grp["miss_c"].transform("sum") - T["miss_c"]
    return T


GAP_EDGES = [0, 1, 2, 3, 5, 8, 13]


def gap_bucket(gap):
    b = 0
    for i, e in enumerate(GAP_EDGES):
        if gap >= e:
            b = i
    return b


def absence_table(tr):
    """Ratio of minutes in the game after an absence of `gap` team games to the player's recent
    played-minutes average, relative to the no-absence ratio; by role (start/bench). Fitted on the
    training season."""
    t = tr[(tr["n_play"] >= 5) & (tr["p10"] >= 10)].copy()
    t["gb"] = t["gap"].fillna(0).map(gap_bucket)
    res = {}
    for role in (0, 1, -1):
        tt = t if role < 0 else t[t["st"] == float(role)]
        base = tt[tt.gb == 0]
        if len(base) < 100:
            continue
        r0 = base["min"].mean() / base["p10"].mean()
        row = {}
        for b in range(1, len(GAP_EDGES)):
            x = tt[tt.gb == b]
            if len(x) >= 25:
                row[str(b)] = [round(float((x["min"].mean() / x["p10"].mean()) / r0), 4), int(len(x))]
        res[str(role)] = row
    return res


LISTED = ("Available", "Probable", "Questionable")


def injury_latest(con, tip):
    """Latest pre-tip official injury report per (game, team), only when that report lists players.
    Returns DataFrame game_id, team_id, player_id, status."""
    t = pd.read_sql("select game_id, team_id, available_at, observed_state from injury_teams", con)
    for c in ("game_id", "team_id"):
        t[c] = t[c].astype(str)
    t["av"] = pd.to_datetime(t["available_at"], utc=True, format="mixed")
    sch = pd.read_sql("select game_id, scheduled_tipoff from schedule", con)
    sch["game_id"] = sch["game_id"].astype(str)
    sch["gtip"] = pd.to_datetime(sch["scheduled_tipoff"], utc=True, format="mixed")
    t = t.merge(sch[["game_id", "gtip"]], on="game_id", how="inner")
    t = t[(t["av"] < t["gtip"]) & (t["av"] < tip)]
    last = t.sort_values("av").groupby(["game_id", "team_id"]).tail(1)
    last = last[last["observed_state"] == "players_listed"]
    p = pd.read_sql("select game_id, team_id, player_id, status, available_at from injury_players "
                    "where player_id is not null", con)
    for c in ("game_id", "team_id", "player_id"):
        p[c] = p[c].astype(str)
    p = p.merge(last[["game_id", "team_id", "available_at"]], on=["game_id", "team_id", "available_at"], how="inner")
    return p[["game_id", "team_id", "player_id", "status"]].drop_duplicates(["game_id", "player_id"])


def listed_table(X, inj):
    """Minutes of players who were on the final pre-game injury report (Available/Probable/Questionable)
    and played, relative to their recent played-minutes average, compared with unlisted players of the same
    role and absence class. Fitted on every completed game before the cutoff that has a report."""
    t = X[X.played & (X["participation_status"] == "played") & (X["n_play"] >= 5) & (X["p10"] >= 10)]
    games = set(inj["game_id"].unique())
    t = t[t.game_id.isin(games)].merge(inj[["game_id", "player_id", "status"]], on=["game_id", "player_id"], how="left")
    t["lst"] = t["status"].isin(LISTED)
    t["gc"] = np.where(t["gap"].fillna(0) >= 1, "1", "0")
    res = {"n_rows": int(len(t)), "n_games": int(t.game_id.nunique())}
    for role in (0, 1):
        tt = t[t["st"] == float(role)]
        row = {}
        for gc in ("0", "1", "all"):
            x = tt if gc == "all" else tt[tt.gc == gc]
            u = x[~x.lst]; l = x[x.lst]
            if len(u) >= 50 and len(l) >= 1:
                ru = u["min"].mean() / u["p10"].mean()
                rl = l["min"].mean() / l["p10"].mean()
                row[gc] = [round(float(rl / ru), 4), int(len(l))]
        res[str(role)] = row
    return res


def margin_proxy(con, ctx, K=8.0, hca=2.5):
    """Pre-game expected |margin| for every team-game from season-to-date point differentials
    (shrunk toward 0) plus home court. Returns (DataFrame game_id, team_id, apm, season) and tonight's
    proxy value."""
    import nba_data
    tb = nba_data.table("team_box_scores", "game_id, team_id, points")
    tb["game_id"] = tb["game_id"].astype(str); tb["team_id"] = tb["team_id"].astype(str)
    sch = pd.read_sql("select game_id, season, home_team_id, away_team_id, scheduled_tipoff from schedule", con)
    for c in ("game_id", "home_team_id", "away_team_id"):
        sch[c] = sch[c].astype(str)
    sch["tip"] = pd.to_datetime(sch["scheduled_tipoff"], utc=True, format="mixed")
    m = tb.merge(tb, on="game_id", suffixes=("", "_o"))
    m = m[m.team_id != m.team_id_o]
    m["diff"] = pd.to_numeric(m["points"], errors="coerce") - pd.to_numeric(m["points_o"], errors="coerce")
    m = m.merge(sch[["game_id", "season", "home_team_id", "tip"]], on="game_id", how="inner").sort_values("tip")
    m["cs"] = m.groupby(["team_id", "season"])["diff"].transform(lambda x: x.shift(1).cumsum()).fillna(0.0)
    m["n"] = m.groupby(["team_id", "season"]).cumcount()
    m["net"] = m["cs"] / (m["n"] + K)
    o = m[["game_id", "team_id", "net"]].rename(columns={"team_id": "team_id_o", "net": "net_o"})
    m = m.merge(o, on=["game_id", "team_id_o"], how="left")
    h = np.where(m["team_id"] == m["home_team_id"], 1.0, -1.0)
    m["apm"] = (m["net"] - m["net_o"].fillna(0.0) + hca * h).abs()
    # tonight
    tonight = None
    try:
        gid = str(ctx["gameId"]); team = str(ctx["teamId"])
        tip = pd.to_datetime(ctx["tip"], utc=True)
        r = sch[sch.game_id == gid]
        if len(r):
            r = r.iloc[0]
            opp = r["away_team_id"] if r["home_team_id"] == team else r["home_team_id"]
            sea = r["season"]
            done = m[(m.season == sea) & (m.tip < tip)]

            def net_of(t):
                x = done[done.team_id == t]["diff"]
                return float(x.sum()) / (len(x) + K)
            hh = 1.0 if r["home_team_id"] == team else -1.0
            tonight = abs(net_of(team) - net_of(opp) + hca * hh)
    except Exception as ex:
        log("tonight proxy fail", repr(ex))
    return m[["game_id", "team_id", "apm", "season"]], tonight


def fit_spread_model(X, tr_season, apm_df):
    """Logistic P(play) for active, low-minute bench players: logit ~ a + b1*logit(recent play rate) + b2*|margin|."""
    from sklearn.linear_model import LogisticRegression
    t = X[(X.season == tr_season) & (~X.inact) & (X.participation_status.isin(["played", "dnp"])) & (~X.starter)]
    t = t[(t["m10z"].fillna(0) < 12) & (t["n_play"].fillna(0) >= 0)]
    t = t.merge(apm_df[["game_id", "team_id", "apm"]], on=["game_id", "team_id"], how="inner")
    t = t[t["apm"].notna()]
    if len(t) < 2000:
        return None
    pr = t["pr10"].fillna(0.3).clip(0.05, 0.95)
    x1 = np.log(pr / (1 - pr))
    Xm = np.column_stack([x1, t["apm"].values])
    lr = LogisticRegression(C=10.0, max_iter=500)
    lr.fit(Xm, t["played"].astype(int).values)
    return {"b": float(lr.coef_[0][1]), "b1": float(lr.coef_[0][0]), "mu": float(t["apm"].mean()), "n": int(len(t))}


def load_all():
    import nba_data
    con = nba_data.session()
    sch = pd.read_sql("select game_id, scheduled_tipoff from schedule", con)
    sch["game_id"] = sch["game_id"].astype(str)
    pgs = nba_data.table("player_game_summary", "game_id, team_id, player_id, starter, participation_status, season")
    pbs = nba_data.table("player_box_scores", "game_id, player_id, minutes_seconds")
    for c in ("game_id", "player_id"):
        pgs[c] = pgs[c].astype(str); pbs[c] = pbs[c].astype(str)
    pgs["team_id"] = pgs["team_id"].astype(str)
    d = pgs.merge(pbs, on=["game_id", "player_id"], how="left").merge(sch, on="game_id", how="left")
    d["min"] = pd.to_numeric(d["minutes_seconds"], errors="coerce").fillna(0) / 60.0
    d["played"] = (d["participation_status"] == "played") & (d["min"] > 0)
    d["starter"] = pd.to_numeric(d["starter"], errors="coerce").fillna(0) > 0
    d["tip"] = pd.to_datetime(d["scheduled_tipoff"], utc=True, format="mixed")
    d = d[d["participation_status"].isin(["played", "dnp", "inactive"])]
    d["inact"] = d["participation_status"] == "inactive"
    return con, sch, d[["game_id", "team_id", "player_id", "starter", "participation_status", "min", "played",
                        "tip", "season", "inact"]].copy()


def fit_and_predict(dall, ctx, roster_inact, hist_games, max_iter=150):
    """Returns dict gameId -> {pid: {"q1": [...], "q0": [...], "pc0": float}} for tonight and history games.
    Trained on the previous season only (so history predictions are out of sample)."""
    from sklearn.ensemble import HistGradientBoostingRegressor, HistGradientBoostingClassifier
    t0 = time.time()
    team = str(ctx["teamId"]); gid = str(ctx["gameId"])
    tip = pd.to_datetime(ctx["tip"], utc=True)
    dall = dall[dall["tip"] < tip]
    seasons = sorted(dall["season"].dropna().unique())
    if len(seasons) == 0:
        return {}
    cur = seasons[-1]
    # if no current-season games are present yet, tonight starts a new season
    sea_tonight = cur
    if (tip - dall["tip"].max()).days > 60:
        y = int(str(cur)[:4]) + 1
        sea_tonight = "%d-%02d" % (y, (y + 1) % 100)
    tr_season = seasons[-2] if sea_tonight == cur and len(seasons) >= 2 else cur
    if sea_tonight != cur:
        tr_season = cur
    rows = pd.DataFrame({"game_id": gid, "team_id": team, "player_id": list(roster_inact.keys()),
                         "starter": False, "participation_status": "pending", "min": 0.0, "played": False,
                         "tip": tip, "season": sea_tonight, "inact": [bool(v) for v in roster_inact.values()]})
    d = pd.concat([dall, rows], ignore_index=True)
    X = build_features(d)
    log("gbm features %.1fs rows %d train_season %s tonight_season %s" % (time.time() - t0, len(X), tr_season, sea_tonight))
    tr = X[(X.season == tr_season) & X.played]
    trc = X[(X.season == tr_season) & (~X.inact) & (X.participation_status.isin(["played", "dnp"])) & (~X.starter)]
    if len(tr) < 2000:
        log("gbm too little training data", len(tr))
        return {}
    want = set([gid]) | set(str(g) for g in hist_games)
    T = X[X.game_id.isin(want) & (X.team_id == team)].copy()
    out = {}
    Q1 = np.zeros((len(T), 7)); Q0 = np.zeros((len(T), 7))
    T1 = T.copy(); T1["st"] = 1.0
    T0 = T.copy(); T0["st"] = 0.0
    models = []
    for j, q in enumerate(LEVELS):
        m = HistGradientBoostingRegressor(loss="quantile", quantile=q, max_iter=max_iter, learning_rate=0.08,
                                          max_leaf_nodes=31, min_samples_leaf=50, random_state=0)
        m.fit(tr[FEATS], tr["min"])
        models.append(m)
        Q1[:, j] = m.predict(T1[FEATS]); Q0[:, j] = m.predict(T0[FEATS])
    Q1 = np.clip(np.sort(Q1, axis=1), 0, 58); Q0 = np.clip(np.sort(Q0, axis=1), 0, 58)
    # previous-season prior: for rows with no current-season appearance, impute recent-form features
    Ti = impute_prev(T)
    Q1i = np.zeros((len(T), 7)); Q0i = np.zeros((len(T), 7))
    Ti1 = Ti.copy(); Ti1["st"] = 1.0
    Ti0 = Ti.copy(); Ti0["st"] = 0.0
    for j, m in enumerate(models):
        Q1i[:, j] = m.predict(Ti1[FEATS]); Q0i[:, j] = m.predict(Ti0[FEATS])
    Q1i = np.clip(np.sort(Q1i, axis=1), 0, 58); Q0i = np.clip(np.sort(Q0i, axis=1), 0, 58)
    n_imp = int(Ti["_imputed"].sum())
    clf = HistGradientBoostingClassifier(max_iter=max_iter, learning_rate=0.08, max_leaf_nodes=31,
                                         min_samples_leaf=50, random_state=0)
    clf.fit(trc[CFEATS], trc["played"].astype(int))
    pc0 = clf.predict_proba(T[CFEATS])[:, 1]
    npl = T["n_play"].fillna(0).values
    gapv = T["gap"].fillna(20).values
    for i, (g, p) in enumerate(zip(T["game_id"].values, T["player_id"].values)):
        out.setdefault(str(g), {})[str(p)] = {"q1": [float(x) for x in Q1[i]], "q0": [float(x) for x in Q0[i]],
                                              "q1i": [float(x) for x in Q1i[i]], "q0i": [float(x) for x in Q0i[i]],
                                              "pc0": float(pc0[i]), "np": float(npl[i]), "gap": float(gapv[i])}
    try:
        out["__abs__"] = absence_table(tr)
        log("absence table", out["__abs__"])
    except Exception as ex:
        log("absence table error", repr(ex))
    try:
        t3 = time.time()
        import nba_data
        con0 = nba_data.session()
        inj = injury_latest(con0, tip)
        mine = inj[(inj.team_id == team) & inj.game_id.isin(want)]
        out["__inj__"] = {}
        for g, p, s in zip(mine.game_id, mine.player_id, mine.status):
            out["__inj__"].setdefault(str(g), {})[str(p)] = str(s)
        out["__lst__"] = listed_table(X[X.participation_status != "pending"], inj)
        seas = X[X.game_id.isin(set(inj.game_id.unique()))].groupby("season").game_id.nunique().to_dict()
        log("listed table", out["__lst__"], "inj games by season", seas, "tonight", out["__inj__"].get(gid),
            "%.1fs" % (time.time() - t3))
    except Exception as ex:
        import traceback
        log("listed table error", repr(ex), traceback.format_exc()[-600:])
    try:
        t2 = time.time()
        import nba_data
        con = nba_data.session()
        apm_df, tonight = margin_proxy(con, ctx)
        sm = fit_spread_model(X, tr_season, apm_df)
        hh = apm_df[(apm_df.team_id == team) & (apm_df.game_id.isin(want))]
        out["__spr__"] = {"model": sm, "proxy_tonight": tonight,
                          "hist": {str(g): float(a) for g, a in zip(hh.game_id, hh.apm)}}
        log("spread model", sm, "proxy_tonight", tonight, "hist", len(hh), "%.1fs" % (time.time() - t2))
    except Exception as ex:
        import traceback
        log("spread model error", repr(ex), traceback.format_exc()[-600:])
    log("gbm done %.1fs train %d clf %d targets %d imputed %d" % (time.time() - t0, len(tr), len(trc), len(T), n_imp))
    return out
