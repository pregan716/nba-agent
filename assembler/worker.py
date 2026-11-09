"""One fresh interpreter per invocation; only the package and state cross in."""
import contextlib
import importlib.util
import json
import random
import sys

if "--batch" in sys.argv:
    import runpy
    runpy.run_path("/opt/batch.py", run_name="__main__")
    sys.exit(0)

random.seed(0)
message = json.load(sys.stdin)
with contextlib.redirect_stdout(sys.stderr):
    spec = importlib.util.spec_from_file_location("policy", "/package/assemble.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not callable(getattr(module, "assemble", None)):
        raise ValueError("assemble entry point missing")
    result = {"loaded": True} if message["mode"] == "load" else module.assemble(message["state"])
print(json.dumps(result, sort_keys=True, separators=(",", ":"), allow_nan=False))
