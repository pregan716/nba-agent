import type { forecastReport } from "./report.js";
type Report = ReturnType<typeof forecastReport>;
const format = (x: number | null) =>
  x === null ? "—" : Number(x.toFixed(4)).toString();
export function markdown(report: Report) {
  const lines = ["# Forecast evaluation", ""];
  for (const r of report.records)
    lines.push(
      `- ${r.arm}, ${r.replicate} · flagged games ${r.flagged.join(", ") || "none"} · excluded games ${r.excluded.map((g) => g.id + " (" + g.reason + ")").join(", ") || "none"}`,
    );
  for (const [title, view] of [
    ["Including flagged games", report.withFlagged],
    ["Excluding flagged games", report.withoutFlagged],
  ] as const) {
    lines.push("", `## ${title} (${view.games.length} games)`);
    for (const r of view.againstReference) {
      const cost = r.spend.analyst;
      lines.push(
        "",
        `### ${r.arm} vs reference · ${r.replicate}`,
        "",
        `Analyst spend $ ${format(cost.usd)} and ${format(cost.wallClockMs / 1000)} seconds. Reference spend is unmetered.`,
        "",
        "| Score | Analyst | Reference | Difference (90% interval) |",
        "|---|---:|---:|---:|",
      );
      for (const key of [
        "minutes.pinball",
        "points.pinball",
        "rebounds.pinball",
        "assists.pinball",
        "fantasy_points.pinball",
        "playBrier",
        "market.brier",
        "market.consensusBrier",
        "market.blendMinusMarketOnly",
        "big.baseRate",
        "big.hitRate",
        "big.voidRate",
        "big.hitRateWithoutVoids",
        "big.brier",
        "ceiling.hitRate",
        "ceiling.brier",
        "ceiling.voidRate",
      ]) {
        const m = r.metrics["all/" + key];
        if (!m) continue;
        const fraction = (v: typeof m.left) =>
          format(v.mean) +
          (key === "big.hitRate" ||
          key.endsWith("voidRate") ||
          key === "ceiling.hitRate"
            ? ` (${format(v.sum)}/${format(v.weight)})`
            : "");
        lines.push(
          `| ${key} | ${fraction(m.left)} | ${fraction(m.right)} | ${format(m.delta)} [${m.interval90.map(format).join(", ")}] |`,
        );
        if (key === "market.blendMinusMarketOnly")
          lines.push(
            `| Held-out blend change, 90% interval | ${m.left.interval90.map(format).join(" to ")} | ${m.right.interval90.map(format).join(" to ")} | |`,
          );
      }
    }
    if (view.pooled) {
      lines.push(
        "",
        "### Full memory minus no memory",
        "",
        "| Score | Difference | 90% interval | After omitting five influential games |",
        "|---|---:|---:|---:|",
      );
      for (const [name, m] of Object.entries(view.pooled.metrics)) {
        if (
          !name.startsWith("all/") ||
          !(
            name.endsWith("pinball") ||
            name.endsWith("playBrier") ||
            name.endsWith("hitRate") ||
            name.endsWith("blendMinusMarketOnly")
          )
        )
          continue;
        lines.push(
          `| ${name.slice(4)} | ${format(m.delta)} | ${m.interval90.map(format).join(" to ")} | ${format(m.withoutFive)} |`,
        );
      }
      for (const c of view.pooled.spend)
        lines.push(
          "",
          `${c.replicate} spend difference $ ${format(c.deltaUsd)}, time difference ${format(c.deltaWallClockMs / 1000)} seconds.`,
        );
    }
  }
  lines.push(
    "",
    "The JSON report includes tier splits, game-by-game learning curves, replicate spread, influence and score denominators.",
  );
  return lines.join("\n");
}
