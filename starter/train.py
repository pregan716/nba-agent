"""Trusted training entrypoint. All rows come from the SPO-870 cutoff loader."""
import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np
import sklearn
from sklearn.ensemble import HistGradientBoostingClassifier
from nba_starter import VERSION, PARAMS, BOS, History, features, summary, usable, serialize, timestamp


def games(path, cutoff):
    with open(path) as source:
        for line in source:
            game=json.loads(line)
            if timestamp(game["release"]) < timestamp(cutoff):
                yield game


def fit(path, target, cutoff):
    if np.__version__!="2.2.6" or sklearn.__version__!="1.6.1":
        raise ValueError("Unpinned starter libraries")
    metadata=[]; counts=[0,0,0,0]; example=None
    for game in games(path,cutoff):
        if game["gameId"]==target["gameId"]: raise ValueError("Target game in training")
        metadata.append({k:v for k,v in game.items() if k!="windows"} | {"summary":summary(game)})
        for w in game["windows"]:
            if not usable(w): continue
            example=example or (w["state"],metadata[-1])
            counts[1]+=1
            if not w["state"]["eligibleBench"]: continue
            counts[0]+=len(w["state"]["celtics"])
            if w["actual"]["players_out"]:
                counts[2]+=1; counts[3]+=len(w["state"]["eligibleBench"])
    if not example or min(counts)==0: raise ValueError("Insufficient starter training data")
    history=History(metadata)
    ctx,pf,agg=features(*example,history)
    player=next(iter(pf.values()))
    columns=[list(ctx)+list(player),list(ctx)+list(agg),list(ctx)+list(agg),list(ctx)+list(player)+["k"]]
    matrices=[np.empty((n,len(c)),dtype=np.float64) for n,c in zip(counts,columns)]
    labels=[np.empty(n,dtype=np.int64) for n in counts]
    weights=[np.empty(n,dtype=np.float64) for n in counts]
    offsets=[0]*4
    def add(i,row,y,weight):
        j=offsets[i];matrices[i][j]=[row[c] for c in columns[i]];labels[i][j]=y;weights[i][j]=weight;offsets[i]+=1
    for game in games(path,cutoff):
        weight=5. if game["teamId"]==BOS else 1.
        for w in game["windows"]:
            if not usable(w):continue
            s,a=w["state"],w["actual"]; k=len(a["players_out"])
            ctx,pf,agg=features(s,game,history)
            add(1,{**ctx,**agg},int(k>0),weight)
            if not s["eligibleBench"]:continue
            for pid in s["celtics"]:add(0,{**ctx,**pf[pid]},int(pid in a["players_out"]),weight)
            if k:
                add(2,{**ctx,**agg},min(k,4),weight)
                for pid in s["eligibleBench"]:add(3,{**ctx,**pf[pid],"k":float(k)},int(pid in a["players_in"]),weight)
    models=[]
    for i in range(4):
        m=HistGradientBoostingClassifier(**PARAMS)
        m.fit(matrices[i],labels[i],sample_weight=weights[i])
        models.append(serialize(m,columns[i]))
        print(json.dumps({"part":i,"rows":counts[i],"iterations":m.n_iter_}),file=sys.stderr,flush=True)
    return {"version":VERSION,"cutoff":cutoff,"target":target,"parameters":PARAMS,
            "libraries":{"numpy":np.__version__,"scikit-learn":sklearn.__version__},
            "rows":counts,"models":models,"history":metadata}


if __name__=="__main__":
    request=json.loads(Path(sys.argv[2]).read_text())
    start=time.monotonic()
    artifact=fit(sys.argv[1],request["target"],request["cutoff"])
    text=json.dumps(artifact,sort_keys=True,separators=(",",":"),allow_nan=False)
    Path(sys.argv[3]).write_text(text+"\n")
    print(json.dumps({"hash":hashlib.sha256((text+"\n").encode()).hexdigest(),"seconds":time.monotonic()-start,"rows":artifact["rows"]}),flush=True)
