import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { buildReport, markdown } from "../src/evaluation/report.js";
import { DEFAULT_BOOTSTRAP } from "../src/evaluation/compare.js";
const args = process.argv.slice(2);
const value = (name: string) =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const inputs = args
  .filter((a) => a.startsWith("--record="))
  .map((arg) => {
    const part = arg.slice(9),
      i = part.indexOf("=");
    if (i < 1 || i === part.length - 1)
      throw Error(
        "Use --record=label=/path/to/record.sqlite (or run directory)",
      );
    return { label: part.slice(0, i), path: part.slice(i + 1) };
  });
const out = value("out");
if (!out) throw Error("Pass --out=<report directory>");
const report = buildReport(inputs, {
  resamples: Number(value("resamples") ?? DEFAULT_BOOTSTRAP.resamples),
  seed: Number(value("seed") ?? DEFAULT_BOOTSTRAP.seed),
  revealHoldout: args.includes("--holdout-revealed"),
});
mkdirSync(resolve(out), { recursive: true });
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
writeFileSync(join(out, "report.md"), markdown(report));
console.log(
  JSON.stringify({
    directory: resolve(out),
    runs: report.runs.length,
    comparisons: report.comparisons.length,
  }),
);
