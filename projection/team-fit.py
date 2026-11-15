"""Run the pinned v4 fitter for the requested team's roster."""
import json
import sys

import fit

data = json.load(sys.stdin)
# The original fitter's source bytes participate in every historical model hash.
# Its only team-specific operation selects the target team's features at forecast time.
fit.BOS = data["teamId"]
json.dump(fit.forecast(data), sys.stdout, allow_nan=False)
