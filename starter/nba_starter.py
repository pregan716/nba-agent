"""Versioned environment starter: deterministic fit and read-only predict(state).

Reference: model2.py variant E. HistGradientBoosting trees are serialized as
canonical JSON, not pickle. History is filtered by release before the state's
scheduled start, including when this API is used for in-sample backtests.
"""
import itertools
import json
import math
import os
from collections import defaultdict
from datetime import datetime
from pathlib import Path

import numpy as np

BOS = "1610612738"
KINDS = ["foul", "timeout", "dead_ball_turnover", "violation", "jump_ball", "between_periods"]
VERSION = "starter-hgb-e-v1"
PARAMS = dict(learning_rate=0.05, max_iter=250, max_depth=4, min_samples_leaf=40,
              l2_regularization=1.0, random_state=0)
HALF_LIFE = 21.0
SHRINK = 20.0


def timestamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() / 86400.0


def elapsed(period, clock):
    return sum(12 if p <= 4 else 5 for p in range(1, period)) + (12 if period <= 4 else 5) - clock / 60000.0


def starters(state, team):
    five = set(state["celtics"])
    for sub in reversed([s for s in state["history"]["substitutions"] if s["teamId"] == team]):
        five.difference_update(sub["players_in"])
        five.update(sub["players_out"])
    return five


def usable(w):
    return not w["exclusions"] and w["state"] is not None and w["actual"] is not None


def summary(game):
    minutes, stints, counts = defaultdict(float), defaultdict(list), defaultdict(lambda: [0, 0])
    states = sorted([w for w in game["windows"] if w["state"]], key=lambda w: w["state"]["sequence"])
    for w in states:
        s = w["state"]
        players = {p["playerId"]: p for p in s["players"]}
        for pid, p in players.items():
            minutes[pid] = max(minutes[pid], p["minutes"] or 0)
        if usable(w):
            kind = s["stoppage"]["kind"]
            counts[kind][0] += 1
            counts[kind][1] += bool(w["actual"]["players_out"])
            for pid in w["actual"]["players_out"]:
                if pid in players:
                    stints[pid].append(players[pid]["currentStintMinutes"] or 0)
    five = starters(states[0]["state"], game["teamId"]) if states else set()
    return {"players": {pid: [m, stints[pid], pid in five] for pid, m in sorted(minutes.items()) if m > 0}, "counts": dict(counts)}


class History:
    def __init__(self, games):
        self.games = games
        self.players, self.teams = defaultdict(list), defaultdict(list)
        total = defaultdict(lambda: [0, 0])
        for g in games:
            t, released = timestamp(g["scheduledStart"]), timestamp(g["release"])
            for pid, values in g["summary"]["players"].items():
                self.players[pid].append((t, released, values))
            self.teams[g["teamId"]].append((t, released, g["summary"]["counts"]))
            if g["season"] == "2024-25":
                for k, (n, y) in g["summary"]["counts"].items():
                    total[k][0] += n
                    total[k][1] += y
        self.all_rate = sum(v[1] for v in total.values()) / max(1, sum(v[0] for v in total.values()))
        self.rates = {k: y/n for k, (n, y) in total.items() if n}
        self.cache = {}

    def at(self, game, pids):
        t = timestamp(game["scheduledStart"])
        key = (game["gameId"], game["teamId"])
        if key not in self.cache:
            acc = defaultdict(lambda: [0., 0.])
            for tt, released, counts in self.teams[game["teamId"]]:
                if released >= t:
                    continue
                decay = 0.5 ** ((t-tt)/HALF_LIFE)
                for k, (n, y) in counts.items():
                    acc[k][0] += decay*n
                    acc[k][1] += decay*y
            rates = {k: (acc[k][1]+SHRINK*self.rates.get(k,self.all_rate))/(acc[k][0]+SHRINK) for k in KINDS}
            rates["all"] = (sum(v[1] for v in acc.values())+SHRINK*self.all_rate)/(sum(v[0] for v in acc.values())+SHRINK)
            self.cache[key] = ({}, rates)
        ph, th = self.cache[key]
        for pid in pids:
            if pid in ph:
                continue
            weight = mins = sw = st = sr = 0.
            for tt, released, (m, sts, started) in self.players[pid]:
                if released >= t:
                    continue
                d = 0.5 ** ((t-tt)/HALF_LIFE)
                weight += d; mins += d*m; sr += d*started
                sw += d*len(sts); st += d*sum(sts)
            ph[pid] = {"avg_min": mins/weight if weight else np.nan,
                       "typ_stint": st/sw if sw else np.nan,
                       "start_rate": sr/weight if weight else np.nan}
        return ph, th


def features(state, game, history):
    ph, th = history.at(game, [p["playerId"] for p in state["players"]])
    team, kind = game["teamId"], state["stoppage"]["kind"]
    period, clock = state["period"], state["clockMs"]
    el = elapsed(period, clock)
    subs = [s for s in state["history"]["substitutions"] if s["teamId"] == team]
    ctx = {f"k_{k}": float(kind == k) for k in KINDS}
    ctx.update(period=float(min(period,5)), clock_min=clock/60000., elapsed=el,
               abs_margin=abs(state["margin"]), margin=float(state["margin"]),
               late_close=float(period>=4 and clock<300000 and abs(state["margin"])<=8),
               blowout=float(period>=4 and abs(state["margin"])>=18),
               timeout_ours=float(kind=="timeout" and state["stoppage"]["timeoutTeam"]==team),
               subs_period=float(sum(s["period"]==period for s in subs)),
               since_sub=el-elapsed(subs[-1]["period"],subs[-1]["clockMs"]) if subs else el,
               team_rate=th["all"], team_kind_rate=th.get(kind,history.all_rate), is_bos=float(team==BOS))
    five = starters(state,team)
    pf = {}
    for p in state["players"]:
        pid=p["playerId"]; h=ph[pid]; avg=h["avg_min"]; typ=h["typ_stint"]
        stint=p["currentStintMinutes"] or 0.; fouls=p["personalFouls"] or 0
        pf[pid]=dict(stint=stint,minutes=p["minutes"] or 0.,fouls=float(fouls),
          foul_trouble=float(fouls>={1:2,2:3,3:4}.get(period,5)),
          rest=p["restMs"]/60000. if p["restMs"] is not None else np.nan,
          never_played=float((p["minutes"] or 0)==0),avg_min=avg,typ_stint=typ,
          stint_ratio=stint/typ if typ>0 else np.nan,
          pace=(p["minutes"] or 0.)-avg*el/48. if not math.isnan(avg) else np.nan,
          start_rate=h["start_rate"],starter=float(pid in five))
    floor=[pf[pid] for pid in state["celtics"]]
    agg=dict(max_stint=max(f["stint"] for f in floor),
             max_ratio=max([-1]+[f["stint_ratio"] for f in floor if not math.isnan(f["stint_ratio"])]),
             max_pace=max([-99]+[f["pace"] for f in floor if not math.isnan(f["pace"])]),
             any_foul_trouble=max(f["foul_trouble"] for f in floor),starters_on=sum(f["starter"] for f in floor))
    return ctx,pf,agg


def serialize(model, columns):
    def scalar(v):
        # Native numeric thresholds can be infinite; JSON strings round-trip via
        # the pinned structured float dtype without losing their semantics.
        return str(v) if isinstance(v, float) and not math.isfinite(v) else v
    return {"columns":columns,"classes":model.classes_.tolist(),"baseline":model._baseline_prediction.tolist(),
            "trees":[[[[scalar(v) for v in node] for node in p.nodes.tolist()] for p in iteration] for iteration in model._predictors]}


class Trees:
    def __init__(self, spec):
        from sklearn.ensemble._hist_gradient_boosting.predictor import TreePredictor
        from sklearn.ensemble._hist_gradient_boosting.common import PREDICTOR_RECORD_DTYPE
        self.spec=spec
        self.trees=[[TreePredictor(np.array([tuple(n) for n in nodes],dtype=PREDICTOR_RECORD_DTYPE),
                                   np.zeros((0,8),dtype=np.uint32),np.zeros((0,8),dtype=np.uint32)) for nodes in iteration] for iteration in spec["trees"]]
    def raw(self, rows):
        x=np.array([[r[c] for c in self.spec["columns"]] for r in rows],dtype=np.float64)
        raw=np.tile(np.array(self.spec["baseline"],dtype=float),(len(rows),1))
        for iteration in self.trees:
            for k,tree in enumerate(iteration):
                raw[:,k]+=tree.predict(x,np.zeros((0,8),dtype=np.uint32),np.zeros(x.shape[1],dtype=np.uint32),1)
        return raw
    def probabilities(self, raw):
        if len(self.spec["classes"])==1:
            return np.ones((len(raw),1))
        if raw.shape[1]==1:
            p=1/(1+np.exp(-raw[:,0])); return np.column_stack((1-p,p))
        e=np.exp(raw-np.max(raw,axis=1,keepdims=True));return e/e.sum(axis=1,keepdims=True)
    def predict(self, rows):
        return self.probabilities(self.raw(rows))
    def positive(self,rows):
        p=self.predict(rows)
        return p[:,self.spec["classes"].index(1)] if 1 in self.spec["classes"] else np.zeros(len(rows))


def conditional(weights,k):
    values={ids:math.prod(weights[i] for i in ids) for ids in itertools.combinations(weights,k)}
    total=sum(values.values())
    return {ids:v/total for ids,v in values.items()} if total else {}


def clean(value):
    if isinstance(value,dict): return {k:clean(v) for k,v in value.items()}
    if isinstance(value,(list,tuple)): return [clean(v) for v in value]
    if isinstance(value,(float,np.floating)): return float(value) if math.isfinite(value) else None
    return value


class Starter:
    def __init__(self, artifact):
        if artifact["version"]!=VERSION: raise ValueError("Starter version mismatch")
        self.artifact=artifact; self.history=History(artifact["history"])
        self.games={g["gameId"]:g for g in artifact["history"] if g["teamId"]==BOS}
        self.games[artifact["target"]["gameId"]]=artifact["target"]
        self.models=[Trees(spec) for spec in artifact["models"]]
    def prepare(self, state):
        # Called only by the trusted supervisor, before forking. This depends on
        # artifact history and roster IDs, never package code or later states.
        self.history.at(self.games[state["gameId"]], [p["playerId"] for p in state["players"]])
    def predict(self,state):
        game=self.games[state["gameId"]]
        ctx,pf,agg=features(state,game,self.history)
        exit_model,timing,count,entry=self.models
        pt=float(np.clip(timing.positive([{**ctx,**agg}])[0],.001,.999))
        exits=dict(zip(state["celtics"],exit_model.positive([{**ctx,**pf[p]} for p in state["celtics"]])))
        pk=dict(zip(count.spec["classes"],count.predict([{**ctx,**agg}])[0]))
        bench=state["eligibleBench"]; entries={}; sets={}
        odds=lambda probs:{p:max(1e-6,q)/max(1e-6,1-q) for p,q in probs.items()}
        sizes=[k for k in (1,2,3) if k<=len(bench) and pk.get(k,0)>0]
        entry_raw=entry.raw([{**ctx,**pf[p],"k":float(k)} for k in sizes for p in bench]) if sizes else None
        for index,k in enumerate(sizes):
            # Keep each probability transform's original shape, preserving exact
            # floating-point output while traversing the entry trees only once.
            probs=entry.probabilities(entry_raw[index*len(bench):(index+1)*len(bench)])
            positive=probs[:,entry.spec["classes"].index(1)] if 1 in entry.spec["classes"] else np.zeros(len(bench))
            pe=dict(zip(bench,positive))
            entries[str(k)]={p:float(q) for p,q in pe.items()}
            for out,po in conditional(odds(exits),k).items():
                for ins,pi in conditional(odds(pe),k).items():
                    key="out:"+",".join(sorted(out))+"|in:"+",".join(sorted(ins))
                    sets[key] = float(pk[k]*po*pi)
        top=sorted(sets,key=lambda key:(-sets[key],key))[:8]
        candidates=[{"out":key.split("|in:")[0][4:].split(","),"in":key.split("|in:")[1].split(",")} for key in top]
        prediction={"substitution":{"type":"noul","noul":pt}}
        if bench:
            prediction["swap"]={"type":"choice","probabilities":{**{key:sets[key] for key in top},"other":max(0.,1-sum(sets[key] for key in top))}}
        return clean({"prediction":prediction,"candidates":candidates,"exit":exits,"timing":pt,
                      "size":{str(k):float(p) for k,p in pk.items()},"entry":entries,
                      "sets":sets,"other":max(0.,1-sum(sets.values())),
                      "features":{"context":ctx,"players":pf,"aggregates":agg}})


_loaded=None

def load(path="/starter/model.json"):
    global _loaded
    if _loaded is None:
        _loaded=Starter(json.loads(Path(path).read_text()))
    return _loaded


def predict(state):
    return load().predict(state)
