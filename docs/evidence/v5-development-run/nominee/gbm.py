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
    for i, (g, p) in enumerate(zip(T["game_id"].values, T["player_id"].values)):
        out.setdefault(str(g), {})[str(p)] = {"q1": [float(x) for x in Q1[i]], "q0": [float(x) for x in Q0[i]],
                                              "q1i": [float(x) for x in Q1i[i]], "q0i": [float(x) for x in Q0i[i]],
                                              "pc0": float(pc0[i]), "np": float(npl[i])}
    log("gbm done %.1fs train %d clf %d targets %d imputed %d" % (time.time() - t0, len(tr), len(trc), len(T), n_imp))
    return out
