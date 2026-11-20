import json, sys, time, math
import numpy as np
import pandas as pd

LEVELS = [0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95]
STATS = ["minutes", "points", "rebounds", "assists", "fantasy_points"]

DEFAULT_P = {
    "use_inactive": True,
    "use_lineup": True,
    "starter_pplay": 0.995,
    "starter_pstart": 0.99,
    "nonstarter_pstart": 0.005,
    "benched_regular_pplay_mult": 1.0,   # usual starter (ref p_start>=.5) missing from a full lineup
    "role_shift": True,
    "start_bump": 6.0,
    "shrink_k": 2.0,
    "redistribute": 1.0,
    "med_w": 0.3,
    "use_qcal": True,
    "qcal_k": 150.0,
    "gbm_w": 0.25,
    "gbm_pw": 0.0,
    "gbm_ramp": 0.0,
}


def log(*a):
    print(*a, file=sys.stderr)


def to_ts(x):
    return pd.to_datetime(x, utc=True, format="mixed")


# ---------------------------------------------------------------- data

def load_data(ctx):
    """Load this season's player game rows (all teams) and the session handle."""
    import nba_data
    con = nba_data.session()
    sch = pd.read_sql("select game_id, season, scheduled_tipoff from schedule", con)
    sch["game_id"] = sch["game_id"].astype(str)
    sch["tip"] = to_ts(sch["scheduled_tipoff"])
    season = None
    cur = sch[sch.game_id == str(ctx["gameId"])]
    if len(cur):
        season = cur.iloc[0]["season"]
    pgs = nba_data.table("player_game_summary", "game_id, team_id, player_id, starter, participation_status, season")
    pgs["game_id"] = pgs["game_id"].astype(str)
    if season is not None:
        pgs = pgs[pgs["season"] == season]
    pbs = nba_data.table("player_box_scores", "game_id, player_id, minutes_seconds")
    pbs["game_id"] = pbs["game_id"].astype(str)
    pbs["player_id"] = pbs["player_id"].astype(str)
    pgs["player_id"] = pgs["player_id"].astype(str)
    pgs["team_id"] = pgs["team_id"].astype(str)
    d = pgs.merge(pbs, on=["game_id", "player_id"], how="left")
    d["min"] = pd.to_numeric(d["minutes_seconds"], errors="coerce").fillna(0) / 60.0
    d["played"] = (d["participation_status"] == "played") & (d["min"] > 0)
    d["starter"] = pd.to_numeric(d["starter"], errors="coerce").fillna(0) > 0
    d = d.merge(sch[["game_id", "tip"]], on="game_id", how="left")
    return con, sch, d


def get_lineup(con, game_id, team_id, tip):
    try:
        q = pd.read_sql(
            "select available_at, starterIds from lineups where game_id=? and team_id=?",
            con, params=(str(game_id), str(team_id)))
    except Exception as ex:
        log("lineup query fail", ex)
        return None
    if not len(q):
        return None
    q["av"] = to_ts(q["available_at"])
    q = q[q["av"] < to_ts(tip)]
    if not len(q):
        return None
    row = q.sort_values("av").iloc[-1]
    try:
        ids = json.loads(row["starterIds"])
    except Exception:
        return None
    matched = [str(x) for x in ids if x]
    return {"ids": matched, "n_names": len(ids)}


def injury_status(con, game_id, team_id):
    out = {}
    try:
        t = pd.read_sql("select available_at, observed_state from injury_teams where game_id=? and team_id=?",
                        con, params=(str(game_id), str(team_id)))
        if not len(t):
            return out
        t = t.sort_values("available_at")
        last = t.iloc[-1]
        if last["observed_state"] != "players_listed":
            return out
        p = pd.read_sql("select player_id, status from injury_players where game_id=? and team_id=? and available_at=?",
                        con, params=(str(game_id), str(team_id), last["available_at"]))
        for _, r in p.iterrows():
            if r["player_id"]:
                out[str(r["player_id"])] = r["status"]
    except Exception as ex:
        log("injury fail", ex)
    return out


def player_hist(d, pid, tip, n_recent=12):
    """Recent appearance minutes split by role, before tip."""
    hp = d[(d.player_id == pid) & (d.tip < tip)].sort_values("tip")
    h = hp[hp.played].tail(n_recent)
    s = h[h.starter]["min"].values
    b = h[~h.starter]["min"].values
    act = hp[hp.participation_status != "inactive"].tail(10)
    actb = act[~act.starter]
    return {
        "ns": len(s), "ms": float(np.median(s)) if len(s) else None,
        "nb": len(b), "mb": float(np.median(b)) if len(b) else None,
        "n_act": int(len(act)), "act_play": float(act.played.mean()) if len(act) else None,
        "n_actb": int(len(actb)), "actb_play": float(actb.played.mean()) if len(actb) else None,
    }


# ---------------------------------------------------------------- scoring

def cond_quantile(q, u, is_fp=False):
    lv = [0.0] + LEVELS + [1.0]
    lo = q[0] - (q[1] - q[0]) if is_fp else 0.0
    if not is_fp:
        lo = min(0.0, q[0])
    vals = [lo] + list(q) + [q[6] + (q[6] - q[5])]
    return float(np.interp(u, lv, vals))


def full_quantile(p, q, t):
    if p <= 0:
        return 0.0
    a = 1.0 - p
    if t <= a:
        return 0.0
    u = (t - a) / p
    return cond_quantile(q, u)


def pinball_minutes(p, q, y):
    tot = 0.0
    for t in LEVELS:
        x = full_quantile(p, q, t)
        tot += t * (y - x) if y >= x else (1 - t) * (x - y)
    return tot / len(LEVELS)


# ---------------------------------------------------------------- adjust

def shift_q(q, delta, lo=0.0, hi=58.0):
    out = [min(hi, max(lo, v + delta)) for v in q]
    for i in range(1, len(out)):
        if out[i] < out[i - 1]:
            out[i] = out[i - 1]
    return out


def resolve_lineup(info, P):
    lu = info.get("__lineup__") if P.get("use_lineup", True) else None
    if lu is not None:
        return lu, False
    if P.get("use_pred_lineup") and info.get("__pred_lineup__"):
        return info["__pred_lineup__"], True
    return None, False


def adjust(ref_players, info, P, notes=None):
    """ref_players: list of reference entries. info: dict pid -> features + 'lineup' key.
    Returns new list of entries (deep-copied)."""
    lineup, pred = resolve_lineup(info, P)
    full_lineup = lineup is not None and len(lineup["ids"]) >= 5
    some_lineup = lineup is not None and len(lineup["ids"]) >= 3
    starters = set(lineup["ids"]) if lineup else set()
    out = []
    ref_exp = 0.0
    new_exp = 0.0
    changed = {}
    for e in ref_players:
        pid = str(e["playerId"])
        f = info.get(pid, {})
        n = {k: (list(v) if isinstance(v, list) else v) for k, v in e.items()}
        pp, ps = float(e["p_play"]), float(e["p_start"])
        mq = list(e["minutes"])
        m0 = mq[3]
        ref_exp += pp * m0
        tag = []
        if P["use_inactive"] and f.get("inactive"):
            pp, ps = 0.0, 0.0
            tag.append("inactive")
        elif some_lineup:
            shift_ok = P["role_shift"] and (not pred or P.get("pred_shift", True))
            if pid in starters:
                if ps < 0.8 and shift_ok:
                    h = f.get("hist") or {}
                    k = P["shrink_k"]
                    prior = m0 + P["start_bump"] * (1 - ps)
                    if h.get("ns", 0) > 0 and h.get("ms") is not None:
                        w = h["ns"] / (h["ns"] + k)
                        tgt = w * h["ms"] + (1 - w) * prior
                    else:
                        tgt = prior
                    mq = shift_q(mq, tgt - m0)
                    tag.append("start_shift%.1f" % (tgt - m0))
                if pred:
                    pp = max(pp, P.get("pred_pplay", 0.97))
                    ps = max(ps, P.get("pred_pstart", 0.85))
                    tag.append("pred_starter")
                else:
                    pp = max(pp, P["starter_pplay"])
                    ps = P["starter_pstart"]
                    tag.append("starter")
            else:
                if full_lineup:
                    if ps >= 0.5 and pp > 0:
                        pp = pp * P["benched_regular_pplay_mult"]
                        tag.append("benched_regular")
                        if shift_ok:
                            h = f.get("hist") or {}
                            k = P["shrink_k"]
                            prior = m0 - P["start_bump"] * ps
                            if h.get("nb", 0) > 0 and h.get("mb") is not None:
                                w = h["nb"] / (h["nb"] + k)
                                tgt = w * h["mb"] + (1 - w) * prior
                            else:
                                tgt = prior
                            mq = shift_q(mq, tgt - m0)
                    ps = min(ps, P.get("pred_nonstarter_pstart", 0.1) if pred else P["nonstarter_pstart"])
                else:
                    ps = min(ps, 0.3)
        mw = P.get("med_w", 0.0)
        if mw > 0 and pp > 0 and not f.get("inactive"):
            h = f.get("hist") or {}
            is_s = (pid in starters) if some_lineup else (ps >= 0.5)
            nn, mm = (h.get("ns", 0), h.get("ms")) if is_s else (h.get("nb", 0), h.get("mb"))
            if nn and mm is not None:
                w = mw * nn / (nn + 3.0)
                dlt = w * (mm - mq[3])
                mq = shift_q(mq, dlt)
                if abs(dlt) > 0.5:
                    tag.append("med%.1f" % dlt)
        aw = P.get("active_w", 0.0)
        if aw > 0 and not f.get("inactive") and pid not in starters and 0.0 < pp < 0.98 and f.get("inactive") is not None:
            h = f.get("hist") or {}
            na = h.get("n_act", 0) or 0
            ap = h.get("act_play")
            k0 = P.get("active_k", 2.0)
            prate = ((na * ap if ap is not None else 0.0) + k0 * 0.6) / (na + k0)
            pm = P.get("active_a", 0.22) + P.get("active_b", 0.70) * prate
            pp = (1 - aw) * pp + aw * pm
            tag.append("active_p%.2f" % pp)
        ps = min(ps, pp)
        n["p_play"], n["p_start"], n["minutes"] = pp, ps, mq
        new_exp += pp * mq[3]
        if tag:
            changed[pid] = tag
        out.append(n)
    # redistribute freed minutes to likely players
    freed = ref_exp - new_exp
    if P["redistribute"] > 0 and abs(freed) > 1.0:
        recv = [n for n in out if n["p_play"] >= 0.6 and n["minutes"][3] >= 8]
        tot = sum(n["minutes"][3] * n["p_play"] for n in recv)
        if tot > 0:
            amt = P["redistribute"] * freed
            for n in recv:
                share = amt * n["minutes"][3] * n["p_play"] / tot
                share = max(-6.0, min(6.0, share))
                n["minutes"] = shift_q(n["minutes"], share / max(n["p_play"], 0.5))
    if notes is not None:
        notes["changed"] = changed
        notes["freed"] = round(freed, 2)
    return out


def scale_production(ref_players, players, damp=0.8):
    """Scale points/rebounds/assists/fantasy ranges by the change in median minutes."""
    refmap = {str(e["playerId"]): e for e in ref_players}
    out = []
    for n in players:
        e = refmap.get(str(n["playerId"]))
        n = dict(n)
        if e is not None:
            m0 = e["minutes"][3]
            m1 = n["minutes"][3]
            if m0 > 1.0 and abs(m1 - m0) > 0.25:
                r = 1.0 + damp * (m1 / m0 - 1.0)
                r = min(1.6, max(0.6, r))
                for s in ("points", "rebounds", "assists", "fantasy_points"):
                    lo = -10.0 if s == "fantasy_points" else 0.0
                    q = [max(lo, v * r) for v in e[s]]
                    for i in range(1, 7):
                        if q[i] < q[i - 1]:
                            q[i] = q[i - 1]
                    n[s] = q
        out.append(n)
    return out


# ---------------------------------------------------------------- online calibration

def cond_pinball(q, y):
    tot = 0.0
    for t, x in zip(LEVELS, q):
        tot += t * (y - x) if y >= x else (1 - t) * (x - y)
    return tot / len(LEVELS)


def scale_q(q, s, lo=0.0, hi=58.0):
    m = q[3]
    out = [min(hi, max(lo, m + s * (v - m))) for v in q]
    for i in range(1, 7):
        if out[i] < out[i - 1]:
            out[i] = out[i - 1]
    return out


def fit_calib(prev, P):
    """prev: list of games, each a list of (entry_after_stage1, played(bool), actual_minutes).
    Returns calibration dict."""
    cal = {"bias": {}, "scale": 1.0, "platt": None, "n_obs": 0}
    if not prev:
        return cal
    # per-player bias from last N played games
    N = P.get("bias_n", 6)
    k = P.get("bias_k", 4.0)
    per = {}
    for g in prev:
        for e, pl, y in g:
            if pl and e["p_play"] > 0:
                per.setdefault(str(e["playerId"]), []).append(y - e["minutes"][3])
    for pid, errs in per.items():
        errs = errs[-N:]
        n = len(errs)
        cal["bias"][pid] = float(np.mean(errs)) * n / (n + k)
    # width scale on played obs (recent window), separately for confirmed starters and others
    cal["scale_grp"] = {}
    for grp in ("S", "B"):
        obs = []
        for g in prev[-P.get("scale_window", 25):]:
            for e, pl, y in g:
                eg = "S" if e["p_start"] >= 0.9 else "B"
                if pl and e["p_play"] > 0.3 and eg == grp:
                    obs.append((e["minutes"], y))
        cal["n_obs"] += len(obs)
        if len(obs) >= 40:
            best, bs = None, 1.0
            for s in [0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.35]:
                L = sum(cond_pinball(scale_q(q, s), y) for q, y in obs)
                if best is None or L < best:
                    best, bs = L, s
            cal["scale_grp"][grp] = bs
    cal["scale"] = cal["scale_grp"].get("B", 1.0)
    # per-level quantile offsets (conformal-style), by group
    cal["qoff"] = {}
    for grp in ("S", "B"):
        rows = []
        for g in prev[-P.get("qcal_window", 25):]:
            for e, pl, y in g:
                eg = "S" if e["p_start"] >= 0.9 else "B"
                if pl and e["p_play"] > 0.3 and eg == grp:
                    rows.append([y - v for v in e["minutes"]])
        if len(rows) >= 40:
            R = np.array(rows)
            lam = len(rows) / (len(rows) + P.get("qcal_k", 150.0))
            offs = [float(np.quantile(R[:, i], LEVELS[i])) * lam for i in range(7)]
            cal["qoff"][grp] = offs
    # platt on uncertain p_play
    xs, ys = [], []
    for g in prev[-P.get("platt_window", 30):]:
        for e, pl, y in g:
            p = e["p_play"]
            if 0.02 < p < 0.98:
                xs.append(math.log(p / (1 - p)))
                ys.append(1.0 if pl else 0.0)
    if len(xs) >= 40:
        x = np.array(xs); yv = np.array(ys)
        a, b = 0.0, 1.0
        lam = 2.0
        for _ in range(25):
            z = a + b * x
            pr = 1 / (1 + np.exp(-z))
            w = pr * (1 - pr) + 1e-6
            ga = np.sum(pr - yv) + lam * a
            gb = np.sum((pr - yv) * x) + lam * (b - 1)
            haa = np.sum(w) + lam
            hbb = np.sum(w * x * x) + lam
            hab = np.sum(w * x)
            det = haa * hbb - hab * hab
            if det <= 0:
                break
            da = (hbb * ga - hab * gb) / det
            db = (haa * gb - hab * ga) / det
            a -= da; b -= db
        cal["platt"] = (float(a), float(b))
    return cal


def apply_calib(players, cal, P):
    out = []
    for e in players:
        n = dict(e)
        pid = str(e["playerId"])
        mq = list(e["minutes"])
        if P.get("use_bias") and pid in cal["bias"] and e["p_play"] > 0:
            mq = shift_q(mq, cal["bias"][pid])
        if P.get("use_qcal"):
            grp = "S" if e["p_start"] >= 0.9 else "B"
            offs = cal.get("qoff", {}).get(grp)
            if offs and e["p_play"] > 0:
                mq = [min(58.0, max(0.0, v + o)) for v, o in zip(mq, offs)]
                for i in range(1, 7):
                    if mq[i] < mq[i - 1]:
                        mq[i] = mq[i - 1]
        if P.get("use_scale"):
            grp = "S" if e["p_start"] >= 0.9 else "B"
            s = cal.get("scale_grp", {}).get(grp, 1.0)
            if P.get("scale_shrink"):
                s = 1.0 + P["scale_shrink"] * (s - 1.0)
            if s != 1.0:
                mq = scale_q(mq, s)
        n["minutes"] = mq
        p = e["p_play"]
        if P.get("use_platt") and cal["platt"] and 0.02 < p < 0.98:
            a, b = cal["platt"]
            z = a + b * math.log(p / (1 - p))
            n["p_play"] = float(min(0.98, max(0.02, 1 / (1 + math.exp(-z)))))
            n["p_start"] = min(n["p_start"], n["p_play"])
        out.append(n)
    return out


# ---------------------------------------------------------------- build info

def build_info(con, d, ctx_like, team_id, game_id, tip, roster_inactive):
    info = {}
    info["__lineup__"] = get_lineup(con, game_id, team_id, tip)
    tip_ts = to_ts(tip)
    # predicted lineup: starters of the team's previous game, if all are active tonight
    try:
        prev = d[(d.team_id == str(team_id)) & (d.tip < tip_ts)]
        if len(prev):
            last_gid = prev.sort_values("tip").iloc[-1]["game_id"]
            st = prev[(prev.game_id == last_gid) & prev.starter]["player_id"].astype(str).tolist()
            st = [p for p in st if p in roster_inactive and not roster_inactive[p]]
            if len(st) == 5:
                info["__pred_lineup__"] = {"ids": st, "n_names": 5, "predicted": True}
    except Exception as ex:
        log("pred lineup fail", repr(ex))
    for pid, inact in roster_inactive.items():
        info[pid] = {"inactive": inact, "hist": player_hist(d, pid, tip_ts)}
    return info


# ---------------------------------------------------------------- validation

def valid_forecast(fc, roster_ids):
    try:
        if fc.get("version") != "forecast-v1":
            return False
        ids = [str(p["playerId"]) for p in fc["players"]]
        if sorted(ids) != sorted(roster_ids) or len(set(ids)) != len(ids):
            return False
        for p in fc["players"]:
            pp, ps = p["p_play"], p["p_start"]
            if not (0 <= pp <= 1 and 0 <= ps <= 1 and ps <= pp + 1e-12):
                return False
            for s in STATS:
                q = p[s]
                if len(q) != 7 or any((not isinstance(v, (int, float))) or math.isnan(v) or math.isinf(v) for v in q):
                    return False
                if any(q[i] > q[i + 1] for i in range(6)):
                    return False
                if s == "minutes" and (q[0] < 0 or q[6] > 58):
                    return False
                if s in ("points", "rebounds", "assists") and q[0] < 0:
                    return False
                if s == "fantasy_points" and q[0] < -10:
                    return False
        return True
    except Exception:
        return False


# ---------------------------------------------------------------- backtest

def history_records(ctx, con, d):
    """For each usable earlier game: (refp, info, actual dict, played dict)."""
    sch = pd.read_sql("select game_id, scheduled_tipoff from schedule", con)
    tips = dict(zip(sch.game_id.astype(str), sch.scheduled_tipoff))
    team = str(ctx["teamId"])
    recs = []
    for g in (ctx.get("referenceHistory") or []):
        errs = g.get("errors") or []
        if not errs:
            continue
        gid = str(g["gameId"])
        tip = tips.get(gid)
        if tip is None:
            continue
        actual = {str(r["playerId"]): (r["actual"]["minutes"] if r["played"] else 0.0) for r in errs}
        played = {str(r["playerId"]): bool(r["played"]) for r in errs}
        refp = g["forecast"]["players"]
        gst = d[d.game_id == gid].set_index("player_id")["participation_status"].to_dict()
        rid = {str(p["playerId"]): (gst.get(str(p["playerId"])) == "inactive") for p in refp}
        info = build_info(con, d, None, team, gid, tip, rid)
        info["__gid__"] = gid
        info["__n_inact__"] = sum(1 for v in rid.values() if v)
        recs.append((refp, info, actual, played))
    return recs


def stage1_obs(players, actual, played):
    return [(e, played.get(str(e["playerId"]), False), actual.get(str(e["playerId"]), 0.0)) for e in players]


def gbm_blend(players, info, P, notes=None):
    """Blend conditional minutes quantiles toward the league-wide GBM, and optionally p_play for
    active bench players toward the GBM classifier."""
    w = P.get("gbm_w", 0.0)
    wp = P.get("gbm_pw", 0.0)
    gb = info.get("__gbm__") or {}
    if (w <= 0 and wp <= 0) or not gb:
        return players
    lineup, pred = resolve_lineup(info, P)
    some = lineup is not None and len(lineup["ids"]) >= 3 and not pred
    starters = set(lineup["ids"]) if (lineup and not pred) else set()
    n_inact = info.get("__n_inact__", 0)
    out = []
    nb = 0
    for e in players:
        pid = str(e["playerId"])
        g = gb.get(pid)
        if g is None or e["p_play"] <= 0:
            out.append(e)
            continue
        n = dict(e)
        if some:
            s = 1.0 if pid in starters else 0.0
        else:
            s = min(1.0, max(0.0, e["p_start"] / max(e["p_play"], 1e-6)))
        if P.get("gbm_impute") and "q1i" in g:
            gq = [s * a + (1 - s) * b for a, b in zip(g["q1i"], g["q0i"])]
        else:
            gq = [s * a + (1 - s) * b for a, b in zip(g["q1"], g["q0"])]
        ramp = P.get("gbm_ramp", 0.0)
        we = w * (min(1.0, g.get("np", 0.0) / ramp) if ramp > 0 else 1.0)
        if we > 0:
            mq = [min(58.0, max(0.0, (1 - we) * a + we * b)) for a, b in zip(e["minutes"], gq)]
            for i in range(1, 7):
                if mq[i] < mq[i - 1]:
                    mq[i] = mq[i - 1]
            n["minutes"] = mq
            nb += 1
        if wp > 0 and some and n_inact > 0 and pid not in starters and 0.0 < e["p_play"] < 0.99:
            pp = (1 - wp) * e["p_play"] + wp * min(0.99, max(0.01, g["pc0"]))
            n["p_play"] = pp
            n["p_start"] = min(n["p_start"], pp)
        out.append(n)
    if notes is not None:
        notes["gbm_blended"] = nb
    return out


def full_forecast(refp, info, P, prev_obs, notes=None):
    s1 = adjust(refp, info, P, notes)
    s1 = gbm_blend(s1, info, P, notes)
    if P.get("use_bias") or P.get("use_scale") or P.get("use_platt") or P.get("use_qcal"):
        cal = fit_calib(prev_obs, P)
        if notes is not None:
            notes["cal"] = {"scale": cal["scale"], "platt": cal["platt"], "n_obs": cal["n_obs"],
                            "bias": {k: round(v, 2) for k, v in cal["bias"].items() if abs(v) > 0.5}}
        return s1, apply_calib(s1, cal, P)
    return s1, s1


def tier_of(e):
    x = e["p_play"] * e["minutes"][3]
    return "D" if x < 5 else ("F" if x < 15 else ("R" if x < 28 else "C"))


def backtest(recs, variants, min_prev=5, tier_variants=("base",)):
    res = {name: [] for name in variants}
    ref_l = []
    obs = {name: [] for name in variants}
    tiers = {}
    for i, (refp, info, actual, played) in enumerate(recs):
        rl = np.mean([pinball_minutes(p["p_play"], p["minutes"], actual.get(str(p["playerId"]), 0.0)) for p in refp])
        score = i >= min_prev
        if score:
            ref_l.append(rl)
            for p in refp:
                t = tier_of(p)
                tiers.setdefault("ref", {}).setdefault(t, 0.0)
                tiers["ref"][t] += pinball_minutes(p["p_play"], p["minutes"], actual.get(str(p["playerId"]), 0.0))
        for name, P in variants.items():
            s1, new = full_forecast(refp, info, P, obs[name])
            obs[name].append(stage1_obs(s1, actual, played))
            if score:
                res[name].append(np.mean([pinball_minutes(p["p_play"], p["minutes"], actual.get(str(p["playerId"]), 0.0)) for p in new]))
                if name in tier_variants:
                    for p0, p in zip(refp, new):
                        t = tier_of(p0)
                        tiers.setdefault(name, {}).setdefault(t, 0.0)
                        tiers[name][t] += pinball_minutes(p["p_play"], p["minutes"], actual.get(str(p["playerId"]), 0.0))
    summ = {"n": len(ref_l), "ref": round(float(np.mean(ref_l)), 4) if ref_l else None}
    for name in variants:
        if res[name]:
            summ[name] = round(float(np.mean(res[name]) / np.mean(ref_l)), 4)
    n = max(1, len(ref_l))
    summ["tiers"] = {k: {t: round(v / n, 2) for t, v in sorted(d.items())} for k, d in tiers.items()}
    summ["_per"] = {name: list(map(float, res[name])) for name in variants}
    summ["_ref"] = list(map(float, ref_l))
    return summ


def online_select(per, ref_l, names, default, min_games=10, margin=0.005):
    """Pick a variant using only games before each point. Returns (choice_now, honest_ratio)."""
    def pick(upto):
        if upto < min_games:
            return default
        means = {nm: float(np.mean(per[nm][:upto])) for nm in names}
        best = min(means, key=means.get)
        if means[best] < means[default] * (1 - margin):
            return best
        return default
    n = len(ref_l)
    sel = [per[pick(i)][i] for i in range(n)]
    ratio = float(np.mean(sel) / np.mean(ref_l)) if n else None
    return pick(n), ratio
