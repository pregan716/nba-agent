import { parseArgs } from "node:util";
import { loadForecastRun } from "../src/evaluation/forecast/records.js";
import { forecastReport } from "../src/evaluation/forecast/report.js";

import { markdown } from "../src/evaluation/forecast/markdown.js";
const { positionals: paths, values } = parseArgs({
  allowPositionals: true,
  options: { json: { type: "boolean" }, games: { type: "string" } },
});
const match = /^(\d+)-(\d+)$/.exec(values.games ?? "");
if (values.games !== undefined && !match)
  throw Error("--games requires an inclusive range such as 11-20");
const range = match
  ? { first: Number(match[1]), last: Number(match[2]) }
  : undefined;
if (!paths.length)
  throw Error(
    "Usage: npm run --silent forecast:evaluate -- [--json] [--games FIRST-LAST] RUN_DIRECTORY [MATCHED_RUN_DIRECTORY ...]",
  );
const report = forecastReport(
  paths.map((path) => loadForecastRun(path, range)),
);
console.log(values.json ? JSON.stringify(report, null, 2) : markdown(report));
