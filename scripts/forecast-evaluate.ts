import { loadForecastRun } from "../src/evaluation/forecast/records.js";
import { forecastReport } from "../src/evaluation/forecast/report.js";

import { markdown } from "../src/evaluation/forecast/markdown.js";
const args = process.argv.slice(2);
const paths = args.filter((s) => s !== "--json");
if (!paths.length)
  throw Error(
    "Usage: npm run --silent forecast:evaluate -- [--json] RUN_DIRECTORY [MATCHED_RUN_DIRECTORY ...]",
  );
const report = forecastReport(paths.map(loadForecastRun));
console.log(
  args.includes("--json") ? JSON.stringify(report, null, 2) : markdown(report),
);
