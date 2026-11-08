"""Checks: (1) calibration via recency weights or as-of team-rate features, (2) league pooling.
All variants: boosted trees, rolling refit before each development game (games 1-10),
training on 2024-25 (+ league when enabled) and 2025-26 Celtics games before the target game.
Player and team history features are as-of (strictly earlier games), EW-decayed by date."""

import itertools
import json
import math
import sys
from bisect import bisect_left
from collections import defaultdict
from datetime import datetime

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier

BOS = "1610612738"
KINDS = ["foul", "timeout", "dead_ball_turnover", "violation", "jump_ball", "between_periods"]
FOUL_LIMIT = {1: 2, 2: 3, 3: 4}
HALF_LIFE_DAYS = 21.0
SHRINK = 20.0  # pseudo-windows toward the league rate for team-rate features


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() / 86400.0


games = {}  # gid -> meta
by_game = defaultdict(list)
for path, league in ((".cache/hazard/windows.jsonl", False), (".cache/hazard/windows-league.jsonl", True)):
    for line in open(path):
        r = json.loads(line)
        gid = r["gameId"]
        if gid not in games:
            games[gid] = {
                "season": r["season"],
                "index": r.get("index"),
                "team": r.get("team", BOS),
                "t": ts(r["scheduledStart"]),
                "league": league,
            }
        by_game[gid].append(r["window"])
print("games", len(games), file=sys.stderr)


def period_len(p):
    return 12.0 if p <= 4 else 5.0


def elapsed_game(period, clock_ms):
    return sum(period_len(q) for q in range(1, period)) + period_len(period) - clock_ms / 60000.0


def usable(w):
    return not w["exclusions"] and w["state"] is not None and w["actual"] is not None


# ---------- per-game summaries ----------
player_log = defaultdict(list)  # pid -> [(t, mins, [stints], started)]
team_log = defaultdict(list)  # team -> [(t, {kind: (n, subs)})]
starters_of = {}
kind_total = defaultdict(lambda: [0, 0])
for gid, ws in by_game.items():
    g = games[gid]
    mins, stints = defaultdict(float), defaultdict(list)
    kc = defaultdict(lambda: [0, 0])
    states = sorted([w for w in ws if w["state"]], key=lambda w: w["state"]["sequence"])
    for w in states:
        for p in w["state"]["players"]:
            mins[p["playerId"]] = max(mins[p["playerId"]], p["minutes"] or 0)
        if usable(w):
            k = w["state"]["stoppage"]["kind"]
            y = len(w["actual"]["players_out"]) > 0
            kc[k][0] += 1
            kc[k][1] += y
            if g["season"] == "2024-25":
                kind_total[k][0] += 1
                kind_total[k][1] += y
            cur = {p["playerId"]: p for p in w["state"]["players"]}
            for pid in w["actual"]["players_out"]:
                if pid in cur:
                    stints[pid].append(cur[pid]["currentStintMinutes"] or 0)
    five = set()
    if states:
        s0 = states[0]["state"]
        five = set(s0["celtics"])
        for sub in reversed([x for x in s0["history"]["substitutions"] if x["teamId"] == BOS]):
            five -= set(sub["players_in"])
            five |= set(sub["players_out"])
    starters_of[gid] = five
    for pid, m in mins.items():
        if m > 0:
            player_log[pid].append((g["t"], m, stints.get(pid, []), pid in five))
    team_log[g["team"]].append((g["t"], dict(kc)))
for v in player_log.values():
    v.sort(key=lambda x: x[0])
for v in team_log.values():
    v.sort(key=lambda x: x[0])
LEAGUE_RATE = {k: s / n for k, (n, s) in kind_total.items()}
LEAGUE_ALL = sum(s for n, s in kind_total.values()) / sum(n for n, s in kind_total.values())


def player_hist(pid, t):
    log = player_log.get(pid, [])
    end = bisect_left([x[0] for x in log], t)
    w = mn = sw = st = sr = 0.0
    for tt, m, sts, started in log[:end]:
        d = 0.5 ** ((t - tt) / HALF_LIFE_DAYS)
        w += d
        mn += d * m
        sr += d * started
        for x in sts:
            sw += d
            st += d * x
    return {
        "avg_min": mn / w if w else np.nan,
        "typ_stint": st / sw if sw else np.nan,
        "start_rate": sr / w if w else np.nan,
    }


def team_hist(team, t):
    log = team_log.get(team, [])
    end = bisect_left([x[0] for x in log], t)
    acc = defaultdict(lambda: [0.0, 0.0])
    for tt, kc in log[:end]:
        d = 0.5 ** ((t - tt) / HALF_LIFE_DAYS)
        for k, (n, s) in kc.items():
            acc[k][0] += d * n
            acc[k][1] += d * s
    out = {k: (acc[k][1] + SHRINK * LEAGUE_RATE.get(k, LEAGUE_ALL)) / (acc[k][0] + SHRINK) for k in KINDS}
    n_all = sum(a[0] for a in acc.values())
    s_all = sum(a[1] for a in acc.values())
    out["all"] = (s_all + SHRINK * LEAGUE_ALL) / (n_all + SHRINK)
    return out


PH, TH = {}, {}
for gid, g in games.items():
    pids = {p["playerId"] for w in by_game[gid] if w["state"] for p in w["state"]["players"]}
    PH[gid] = {pid: player_hist(pid, g["t"]) for pid in pids}
    TH[gid] = team_hist(g["team"], g["t"])
print("history done", file=sys.stderr)


def window_context(w, gid):
    s = w["state"]
    k = s["stoppage"]["kind"]
    el = elapsed_game(s["period"], s["clockMs"])
    subs = [x for x in s["history"]["substitutions"] if x["teamId"] == BOS]
    since = el - elapsed_game(subs[-1]["period"], subs[-1]["clockMs"]) if subs else el
    th = TH[gid]
    ctx = {f"k_{x}": float(k == x) for x in KINDS}
    ctx.update(
        period=float(min(s["period"], 5)),
        clock_min=s["clockMs"] / 60000.0,
        elapsed=el,
        abs_margin=abs(s["margin"]),
        margin=float(s["margin"]),
        late_close=float(s["period"] >= 4 and s["clockMs"] < 300000 and abs(s["margin"]) <= 8),
        blowout=float(s["period"] >= 4 and abs(s["margin"]) >= 18),
        timeout_ours=float(k == "timeout" and s["stoppage"]["timeoutTeam"] == BOS),
        subs_period=float(len([x for x in subs if x["period"] == s["period"]])),
        since_sub=since,
        team_rate=th["all"],
        team_kind_rate=th.get(k, LEAGUE_ALL),
        is_bos=float(games[gid]["team"] == BOS),
    )
    return ctx


def player_feats(w, pid, gid):
    s = w["state"]
    p = next(x for x in s["players"] if x["playerId"] == pid)
    h = PH[gid].get(pid, {})
    el = elapsed_game(s["period"], s["clockMs"])
    avg, typ = h.get("avg_min", np.nan), h.get("typ_stint", np.nan)
    stint, fouls = p["currentStintMinutes"] or 0.0, p["personalFouls"] or 0
    return {
        "stint": stint,
        "minutes": p["minutes"] or 0.0,
        "fouls": float(fouls),
        "foul_trouble": float(fouls >= FOUL_LIMIT.get(s["period"], 5)),
        "rest": (p["restMs"] / 60000.0) if p["restMs"] is not None else np.nan,
        "never_played": float((p["minutes"] or 0) == 0),
        "avg_min": avg,
        "typ_stint": typ,
        "stint_ratio": stint / typ if typ and not math.isnan(typ) and typ > 0 else np.nan,
        "pace": (p["minutes"] or 0.0) - avg * el / 48.0 if not math.isnan(avg) else np.nan,
        "start_rate": h.get("start_rate", np.nan),
        "starter": float(pid in starters_of[gid]),
    }


def aggregates(pf):
    return {
        "max_stint": max(f["stint"] for f in pf.values()),
        "max_ratio": np.nanmax([f["stint_ratio"] for f in pf.values()] + [-1]),
        "max_pace": np.nanmax([f["pace"] for f in pf.values()] + [-99]),
        "any_foul_trouble": max(f["foul_trouble"] for f in pf.values()),
        "starters_on": sum(f["starter"] for f in pf.values()),
    }


def build_all():
    ex, tm, ct, en = [], [], [], []
    for gid in by_game:
        for w in by_game[gid]:
            if not usable(w):
                continue
            s, a = w["state"], w["actual"]
            ctx = window_context(w, gid)
            k = len(a["players_out"])
            pf = {pid: player_feats(w, pid, gid) for pid in s["celtics"]}
            agg = aggregates(pf)
            tm.append({"wid": w["id"], "gid": gid, **ctx, **agg, "y": float(k > 0)})
            if not s["eligibleBench"]:
                continue
            for pid, f in pf.items():
                ex.append({"wid": w["id"], "gid": gid, "pid": pid, **ctx, **f, "y": float(pid in a["players_out"])})
            if k > 0:
                ct.append({"wid": w["id"], "gid": gid, **ctx, **agg, "y": min(k, 4)})
                for pid in s["eligibleBench"]:
                    en.append({"wid": w["id"], "gid": gid, "pid": pid, **ctx, **player_feats(w, pid, gid),
                               "k": float(k), "y": float(pid in a["players_in"])})
    return [pd.DataFrame(x) for x in (ex, tm, ct, en)]


EX, TM, CT, EN = build_all()
print("rows", len(EX), len(TM), len(CT), len(EN), file=sys.stderr)
ID = {"wid", "gid", "pid", "y"}


def fit(df, drop, weight_fn):
    cols = [c for c in df.columns if c not in ID and c not in drop]
    m = HistGradientBoostingClassifier(learning_rate=0.05, max_iter=250, max_depth=4, min_samples_leaf=40,
                                       l2_regularization=1.0, random_state=0)
    m.fit(df[cols], df["y"].astype(int), sample_weight=df["gid"].map(weight_fn).values)
    m.cols = cols
    return m


def cond_bernoulli(weights, k):
    sets = list(itertools.combinations(list(weights), k))
    vals = np.array([math.prod(weights[i] for i in c) for c in sets])
    tot = vals.sum()
    return {c: v / tot for c, v in zip(sets, vals)} if tot > 0 else {}


def predict_game(gid, models):
    m_exit, m_time, m_cnt, m_entry = models
    tm = TM[TM.gid == gid]
    ex = EX[EX.gid == gid]
    p_time = dict(zip(tm["wid"], m_time.predict_proba(tm[m_time.cols])[:, 1]))
    hexit = defaultdict(dict)
    for wid, pid, h in zip(ex["wid"], ex["pid"], m_exit.predict_proba(ex[m_exit.cols])[:, 1]):
        hexit[wid][pid] = h
    out = {}
    for w in by_game[gid]:
        if not usable(w):
            continue
        s = w["state"]
        pred = {"substitution": {"type": "noul", "noul": float(np.clip(p_time[w["id"]], 0.001, 0.999))}}
        bench = s["eligibleBench"]
        if not bench:
            out[w["id"]] = {**pred, "candidates": [], "swap": None}
            continue
        ctx = window_context(w, gid)
        pf = {pid: player_feats(w, pid, gid) for pid in s["celtics"]}
        pkr = m_cnt.predict_proba(pd.DataFrame([{**ctx, **aggregates(pf)}])[m_cnt.cols])[0]
        pk = {int(c): pkr[i] for i, c in enumerate(m_cnt.classes_)}
        oddx = {pid: max(1e-6, h) / max(1e-6, 1 - h) for pid, h in hexit[w["id"]].items()}
        sets = {}
        for k in (1, 2, 3):
            if k > len(bench) or pk.get(k, 0) <= 0:
                continue
            er = pd.DataFrame([{**ctx, **player_feats(w, pid, gid), "k": float(k)} for pid in bench])
            pe = m_entry.predict_proba(er[m_entry.cols])[:, 1]
            oddn = {pid: max(1e-6, q) / max(1e-6, 1 - q) for pid, q in zip(bench, pe)}
            for o, po in cond_bernoulli(oddx, k).items():
                for i, pi in cond_bernoulli(oddn, k).items():
                    sets[(o, i)] = pk[k] * po * pi
        top = sorted(sets.items(), key=lambda kv: -kv[1])[:8]
        probs = {f"out:{','.join(sorted(o))}|in:{','.join(sorted(i))}": v for (o, i), v in top}
        probs["other"] = max(0.0, 1.0 - sum(probs.values()))
        out[w["id"]] = {**pred, "candidates": [{"out": sorted(o), "in": sorted(i)} for (o, i), _ in top],
                        "swap": {"type": "choice", "probabilities": probs}}
    return out


dev = sorted([g for g, m in games.items() if m["season"] == "2025-26" and m["index"] <= 10],
             key=lambda g: games[g]["index"])
celtics_prior = [g for g, m in games.items() if m["season"] == "2024-25" and not m["league"]]
league_prior = [g for g, m in games.items() if m["league"]]
TEAM_FEATS = {"team_rate", "team_kind_rate"}

VARIANTS = {
    "A-celtics": dict(league=False, drop=TEAM_FEATS | {"is_bos"}, w=lambda g: 1.0),
    "B-celtics-recent3": dict(league=False, drop=TEAM_FEATS | {"is_bos"},
                              w=lambda g: 3.0 if games[g]["season"] == "2025-26" else 1.0),
    "C-celtics-teamrate": dict(league=False, drop={"is_bos"}, w=lambda g: 1.0),
    "D-league-teamrate": dict(league=True, drop=set(), w=lambda g: 1.0),
    "E-league-teamrate-bos5": dict(league=True, drop=set(),
                                   w=lambda g: 1.0 if games[g]["league"] else 5.0),
}
only = sys.argv[1:] or list(VARIANTS)
results = {}
for name in only:
    v = VARIANTS[name]
    preds = {}
    for g in dev:
        n = games[g]["index"]
        train = set(celtics_prior + (league_prior if v["league"] else []) +
                    [d for d in dev if games[d]["index"] < n])
        models = tuple(fit(df[df.gid.isin(train)], v["drop"], v["w"]) for df in (EX, TM, CT, EN))
        preds.update(predict_game(g, models))
    results[name] = preds
    print(name, "done", file=sys.stderr)
json.dump(results, open(".cache/hazard/predictions2.json", "w"))
