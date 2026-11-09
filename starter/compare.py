"""Offline acceptance only: exact optimized/reference API parity on real states."""
import json
import sys
from pathlib import Path
from nba_starter import Starter
from reference.nba_starter import Starter as Reference

artifact = json.loads(Path(sys.argv[1]).read_text())
optimized, reference = Starter(artifact), Reference(artifact)
count = 0
with open(sys.argv[2]) as states, open(sys.argv[3], "w") as output:
    for line in states:
        state = json.loads(line)
        optimized.prepare(state)
        a, b = optimized.predict(state), reference.predict(state)
        if json.dumps(a, sort_keys=True, separators=(",", ":"), allow_nan=False) != json.dumps(b, sort_keys=True, separators=(",", ":"), allow_nan=False):
            raise ValueError(f"Prediction mismatch: {state['gameId']} {state['sequence']}")
        output.write(json.dumps({"prediction": b["prediction"], "candidates": b["candidates"]}, sort_keys=True, separators=(",", ":"), allow_nan=False)+"\n")
        count += 1
print(json.dumps({"byteIdenticalStates": count}))
