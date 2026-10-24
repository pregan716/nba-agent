import { readReport } from "../src/evaluation/report.js";
import { compare, replicateSpread } from "../src/evaluation/compare.js";
const roots = process.argv.slice(2);
if (!roots.length)
  throw Error("Usage: npm run report -- RUN_DIRECTORY [RUN_DIRECTORY ...]");
const runs = roots.map(readReport);
const comparisons = runs.flatMap((a, i) =>
  runs.slice(i + 1).map((b) => compare(a, b)),
);
const spread = replicateSpread(runs);
console.log(
  JSON.stringify(
    {
      runs,
      comparisons,
      replicateSpread: spread,
      interpretation:
        "Compare paired differences with within-configuration replicate spread before making a learning claim. Workspace examples require evidence review; annotations are observations, not causal proof.",
    },
    null,
    2,
  ),
);
