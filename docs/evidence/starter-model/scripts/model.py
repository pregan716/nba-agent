"""Offline player-level hazard model for Celtics substitutions (experiment, not repo code).

Models
  exit:   P(on-court player i leaves at window w)            binary, per (window, on-court player)
  timing: P(any Celtics substitution at w)                    binary, per window
  count:  P(k players move | substitution)                    k in {1,2,3,4+}
  entry:  P(bench player j enters | substitution)             binary, per (sub window, bench player)
Set distribution for jev-contract-v2:
  P(O, I) = P(k) * CB(O | exit weights, k) * CB(I | entry weights, k)
  CB = conditional-Bernoulli: product of odds h/(1-h) normalised over all size-k subsets.
  Top 8 sets (k<=3) are listed; `other` takes the remaining model mass.

Player history features are as-of: computed only from games strictly before the window's game.
"""

import itertools
import json
import math
import sys
from collections import defaultdict

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.impute import SimpleImputer

BOS = "1610612738"
KINDS = ["foul", "timeout", "dead_ball_turnover", "violation", "jump_ball", "between_periods"]
FOUL_LIMIT = {1: 2, 2: 3, 3: 4}
HALF_LIFE = 10.0  # games, for exponentially weighted player history

rows = [json.loads(l) for l in open(".cache/hazard/windows.jsonl")]
# chronological game order across both seasons
games = sorted({(r["scheduledStart"], r["season"], r["index"], r["gameId"]) for r in rows})
order = {g[3]: i for i, g in enumerate(games)}
meta = {g[3]: {"season": g[1], "index": g[2]} for g in games}
by_game = defaultdict(list)
for r in rows:
    by_game[r["gameId"]].append(r["window"])


def period_len(p):
    return 12.0 if p <= 4 else 5.0


def elapsed_game(period, clock_ms):
    before = sum(period_len(q) for q in range(1, period))
    return before + period_len(period) - clock_ms / 60000.0


def usable(w):
    return not w["exclusions"] and w["state"] is not None and w["actual"] is not None


# ---------- per-game player summaries (for as-of history) ----------
game_summary = {}
for gid, ws in by_game.items():
    mins, stints, starters = defaultdict(float), defaultdict(list), set()
    states = [w for w in ws if w["state"]]
    states.sort(key=lambda w: w["state"]["sequence"])
    for w in states:
        for p in w["state"]["players"]:
            mins[p["playerId"]] = max(mins[p["playerId"]], p["minutes"] or 0)
        if w["actual"]:
            cur = {p["playerId"]: p for p in w["state"]["players"]}
            for pid in w["actual"]["players_out"]:
                if pid in cur:
                    stints[pid].append(cur[pid]["currentStintMinutes"] or 0)
    if states:
        s0 = states[0]["state"]
        five = set(s0["celtics"])
        for sub in reversed([x for x in s0["history"]["substitutions"] if x["teamId"] == BOS]):
            five -= set(sub["players_in"])
            five |= set(sub["players_out"])
        starters = five
    game_summary[gid] = {"mins": dict(mins), "stints": dict(stints), "starters": starters}


def history_asof(gid):
    """EW mean of minutes and completed stint length per player over earlier games."""
    t = order[gid]
    acc = defaultdict(lambda: {"w": 0.0, "min": 0.0, "sw": 0.0, "st": 0.0, "n": 0, "start": 0.0})
    for g2, i2 in order.items():
        if i2 >= t:
            continue
        decay = 0.5 ** ((t - i2) / HALF_LIFE)
        s = game_summary[g2]
        for pid, m in s["mins"].items():
            if m <= 0:
                continue
            a = acc[pid]
            a["w"] += decay
            a["min"] += decay * m
            a["n"] += 1
            a["start"] += decay * (pid in s["starters"])
            for st in s["stints"].get(pid, []):
                a["sw"] += decay
                a["st"] += decay * st
    out = {}
    for pid, a in acc.items():
        out[pid] = {
            "avg_min": a["min"] / a["w"] if a["w"] else np.nan,
            "typ_stint": a["st"] / a["sw"] if a["sw"] else np.nan,
            "start_rate": a["start"] / a["w"] if a["w"] else np.nan,
            "games": a["n"],
        }
    return out


HIST = {gid: history_asof(gid) for gid in by_game}


# ---------- features ----------
def window_context(w):
    s = w["state"]
    k = s["stoppage"]["kind"]
    el = elapsed_game(s["period"], s["clockMs"])
    subs = [x for x in s["history"]["substitutions"] if x["teamId"] == BOS]
    same_period = [x for x in subs if x["period"] == s["period"]]
    if subs:
        last = subs[-1]
        since = el - elapsed_game(last["period"], last["clockMs"])
    else:
        since = el
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
        subs_period=float(len(same_period)),
        since_sub=since,
    )
    return ctx


def player_feats(w, pid, hist, starters):
    s = w["state"]
    p = next(x for x in s["players"] if x["playerId"] == pid)
    h = hist.get(pid, {})
    el = elapsed_game(s["period"], s["clockMs"])
    avg = h.get("avg_min", np.nan)
    typ = h.get("typ_stint", np.nan)
    stint = p["currentStintMinutes"] or 0.0
    fouls = p["personalFouls"] or 0
    limit = FOUL_LIMIT.get(s["period"], 5)
    return {
        "stint": stint,
        "minutes": p["minutes"] or 0.0,
        "fouls": float(fouls),
        "foul_trouble": float(fouls >= limit),
        "rest": (p["restMs"] / 60000.0) if p["restMs"] is not None else np.nan,
        "never_played": float((p["minutes"] or 0) == 0),
        "avg_min": avg,
        "typ_stint": typ,
        "stint_ratio": stint / typ if typ and not math.isnan(typ) and typ > 0 else np.nan,
        "pace": (p["minutes"] or 0.0) - avg * el / 48.0 if not math.isnan(avg) else np.nan,
        "start_rate": h.get("start_rate", np.nan),
        "starter": float(pid in starters),
    }


def build(gids):
    exit_rows, time_rows, cnt_rows, entry_rows = [], [], [], []
    for gid in gids:
        hist, starters = HIST[gid], game_summary[gid]["starters"]
        for w in by_game[gid]:
            if not usable(w):
                continue
            s, a = w["state"], w["actual"]
            ctx = window_context(w)
            k = len(a["players_out"])
            pf = {pid: player_feats(w, pid, hist, starters) for pid in s["celtics"]}
            agg = {
                "max_stint": max(f["stint"] for f in pf.values()),
                "max_ratio": np.nanmax([f["stint_ratio"] for f in pf.values()] + [-1]),
                "max_pace": np.nanmax([f["pace"] for f in pf.values()] + [-99]),
                "any_foul_trouble": max(f["foul_trouble"] for f in pf.values()),
                "starters_on": sum(f["starter"] for f in pf.values()),
            }
            time_rows.append({"wid": w["id"], "gid": gid, **ctx, **agg, "y": float(k > 0)})
            if not s["eligibleBench"]:
                continue
            for pid, f in pf.items():
                exit_rows.append({"wid": w["id"], "gid": gid, "pid": pid, **ctx, **f,
                                  "y": float(pid in a["players_out"])})
            if k > 0:
                cnt_rows.append({"wid": w["id"], "gid": gid, **ctx, **agg, "y": min(k, 4)})
                for pid in s["eligibleBench"]:
                    f = player_feats(w, pid, hist, starters)
                    entry_rows.append({"wid": w["id"], "gid": gid, "pid": pid, **ctx, **f, "k": float(k),
                                       "y": float(pid in a["players_in"])})
    return [pd.DataFrame(x) for x in (exit_rows, time_rows, cnt_rows, entry_rows)]


ID = {"wid", "gid", "pid", "y"}


def fit(df, kind, multiclass=False):
    X = df[[c for c in df.columns if c not in ID]]
    y = df["y"].astype(int)
    if kind == "gbm":
        m = HistGradientBoostingClassifier(learning_rate=0.05, max_iter=250, max_depth=4,
                                           min_samples_leaf=40, l2_regularization=1.0, random_state=0)
    else:
        m = make_pipeline(SimpleImputer(strategy="median", add_indicator=True), StandardScaler(),
                          LogisticRegression(C=0.5, max_iter=2000))
    m.fit(X, y)
    m.cols = list(X.columns)
    return m


def proba(m, df):
    return m.predict_proba(df[m.cols])


def cond_bernoulli(weights, k):
    """All size-k subsets with probability ∝ product of odds."""
    ids = list(weights)
    sets = list(itertools.combinations(ids, k))
    vals = np.array([math.prod(weights[i] for i in c) for c in sets])
    tot = vals.sum()
    return {c: v / tot for c, v in zip(sets, vals)} if tot > 0 else {}


def predict_game(gid, models):
    ex, tm, ct, en = build([gid])
    m_exit, m_time, m_cnt, m_entry = models
    p_time = dict(zip(tm["wid"], proba(m_time, tm)[:, 1])) if len(tm) else {}
    out = {}
    hexit = defaultdict(dict)
    if len(ex):
        for wid, pid, h in zip(ex["wid"], ex["pid"], proba(m_exit, ex)[:, 1]):
            hexit[wid][pid] = h
    # entry needs k; score each bench player for k=1..3 later via the k feature
    for w in by_game[gid]:
        if not usable(w):
            continue
        s = w["state"]
        p = float(np.clip(p_time[w["id"]], 0.001, 0.999))
        pred = {"substitution": {"type": "noul", "noul": p}}
        bench = s["eligibleBench"]
        if not bench:
            out[w["id"]] = {**pred, "candidates": [], "swap": None}
            continue
        ctx = window_context(w)
        hist, starters = HIST[gid], game_summary[gid]["starters"]
        pf = {pid: player_feats(w, pid, hist, starters) for pid in s["celtics"]}
        agg = {
            "max_stint": max(f["stint"] for f in pf.values()),
            "max_ratio": np.nanmax([f["stint_ratio"] for f in pf.values()] + [-1]),
            "max_pace": np.nanmax([f["pace"] for f in pf.values()] + [-99]),
            "any_foul_trouble": max(f["foul_trouble"] for f in pf.values()),
            "starters_on": sum(f["starter"] for f in pf.values()),
        }
        pk = proba(m_cnt, pd.DataFrame([{**ctx, **agg}]))[0]
        classes = list(m_cnt.classes_)
        pk = {int(c): pk[i] for i, c in enumerate(classes)}
        sets = {}
        oddx = {pid: max(1e-6, h) / max(1e-6, 1 - h) for pid, h in hexit[w["id"]].items()}
        for k in (1, 2, 3):
            if k > len(bench) or pk.get(k, 0) <= 0:
                continue
            erows = pd.DataFrame([{**ctx, **player_feats(w, pid, hist, starters), "k": float(k)} for pid in bench])
            pe = proba(m_entry, erows)[:, 1]
            oddn = {pid: max(1e-6, q) / max(1e-6, 1 - q) for pid, q in zip(bench, pe)}
            outs, ins = cond_bernoulli(oddx, k), cond_bernoulli(oddn, k)
            for o, po in outs.items():
                for i, pi in ins.items():
                    sets[(o, i)] = pk[k] * po * pi
        top = sorted(sets.items(), key=lambda kv: -kv[1])[:8]
        cands = [{"out": sorted(o), "in": sorted(i)} for (o, i), _ in top]
        probs = {f"out:{','.join(sorted(o))}|in:{','.join(sorted(i))}": v for (o, i), v in top}
        probs["other"] = max(0.0, 1.0 - sum(probs.values()))
        out[w["id"]] = {**pred, "candidates": cands, "swap": {"type": "choice", "probabilities": probs}}
    return out


def train_models(gids, kind):
    ex, tm, ct, en = build(gids)
    return (fit(ex, kind), fit(tm, kind), fit(ct, kind), fit(en, kind))


dev = [g for g in by_game if meta[g]["season"] == "2025-26" and meta[g]["index"] <= 10]
dev.sort(key=lambda g: meta[g]["index"])
prior = [g for g in by_game if meta[g]["season"] == "2024-25"]
warm = [g for g in by_game if meta[g]["season"] == "2025-26" and 11 <= meta[g]["index"] <= 20]

results = {}
for kind in ("gbm", "logit"):
    # rolling: refit before each dev game on everything released before it
    roll = {}
    for g in dev:
        n = meta[g]["index"]
        train = prior + [d for d in dev if meta[d]["index"] < n]
        roll.update(predict_game(g, train_models(train, kind)))
    results[f"{kind}-rolling"] = roll
    frozen = train_models(prior + warm, kind)
    results[f"{kind}-baseline-protocol"] = {k: v for g in dev for k, v in predict_game(g, frozen).items()}
    only_prior = train_models(prior, kind)
    results[f"{kind}-2024-25-only"] = {k: v for g in dev for k, v in predict_game(g, only_prior).items()}
    print(kind, "done", file=sys.stderr)

json.dump(results, open(".cache/hazard/predictions.json", "w"))
print({k: len(v) for k, v in results.items()})
