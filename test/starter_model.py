import json
import importlib.util
import tempfile
from pathlib import Path
from train import fit
import unittest
import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from nba_starter import PARAMS, serialize, Trees, History, timestamp, Starter
reference_spec=importlib.util.spec_from_file_location("reference_starter", "/code/reference/nba_starter.py")
reference=importlib.util.module_from_spec(reference_spec)
reference_spec.loader.exec_module(reference)

class StarterTests(unittest.TestCase):
    def test_tree_serialization_matches_sklearn(self):
        rng=np.random.RandomState(1)
        x=rng.normal(size=(400,4)); x[::7,1]=np.nan
        for classes in [1,2,4]:
            y=np.arange(len(x))%classes
            m=HistGradientBoostingClassifier(**PARAMS).fit(x,y)
            spec=serialize(m,["a","b","c","d"])
            encoded=json.dumps(spec,sort_keys=True,allow_nan=False)
            clone=Trees(json.loads(encoded))
            actual=clone.predict([dict(zip(spec["columns"],r)) for r in x[:30]])
            np.testing.assert_allclose(actual,m.predict_proba(x[:30])[:,:len(m.classes_)],rtol=1e-12,atol=1e-12)
            m2=HistGradientBoostingClassifier(**PARAMS).fit(x,y)
            self.assertEqual(encoded,json.dumps(serialize(m2,spec["columns"]),sort_keys=True,allow_nan=False))

    def test_full_refit_filters_future_records_and_is_deterministic(self):
        from nba_starter import BOS
        target=dict(gameId="target",teamId=BOS,scheduledStart="2025-10-22T23:30:00Z")
        players=[str(i) for i in range(10)]
        windows=[]
        for i in range(160):
            k=i%5
            state=dict(gameId="past",sequence=i,period=1,clockMs=720000-i*1000,margin=i%13,
                       stoppage={"kind":"timeout","timeoutTeam":BOS},celtics=players[:5],eligibleBench=players[5:],
                       players=[dict(playerId=p,minutes=i/60,currentStintMinutes=i/60,personalFouls=0,restMs=0) for p in players],
                       history={"substitutions":[]})
            windows.append(dict(exclusions=[],state=state,actual={"players_out":players[:k],"players_in":players[5:5+k]}))
        past=dict(gameId="past",teamId=BOS,season="2024-25",scheduledStart="2025-01-01T23:00:00Z",release="2025-01-02T14:00:00Z",windows=windows)
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/"input.jsonl"
            path.write_text(json.dumps(past)+"\n")
            first=json.dumps(fit(path,target,target["scheduledStart"]),sort_keys=True,allow_nan=False)
            # Deliberately malformed: consulting anything except release fails.
            with path.open("a") as out:
                out.write(json.dumps({"release":target["scheduledStart"],"PLANTED_FUTURE_RECORD":True})+"\n")
                out.write(json.dumps({"release":"2026-01-01T00:00:00Z"})+"\n")
            second=json.dumps(fit(path,target,target["scheduledStart"]),sort_keys=True,allow_nan=False)
            self.assertEqual(first,second)
            optimized=Starter(json.loads(first)); original=reference.Starter(json.loads(first))
            for w in windows[::7]:
                optimized.prepare(w["state"])
                self.assertEqual(json.dumps(optimized.predict(w["state"]),sort_keys=True,allow_nan=False),json.dumps(original.predict(w["state"]),sort_keys=True,allow_nan=False))

    def test_history_releases_not_tips_control_availability(self):
        g=dict(gameId="a",teamId="team",season="2024-25",scheduledStart="2025-01-01T23:00:00Z",release="2025-01-02T14:00:00Z",summary={"players":{"p":[30,[7],True]},"counts":{"timeout":[10,2]}})
        history=History([g])
        before={**g,"gameId":"before","scheduledStart":g["release"]}
        ph,_=history.at(before,["p"])
        self.assertTrue(np.isnan(ph["p"]["avg_min"]))
        after={**g,"gameId":"after","scheduledStart":"2025-01-02T14:00:01Z"}
        ph,_=history.at(after,["p"])
        self.assertEqual(ph["p"]["avg_min"],30)

if __name__=="__main__":unittest.main()
