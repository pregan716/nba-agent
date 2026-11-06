import {
  compareRuns,
  DEFAULT_BOOTSTRAP,
  replicateSpread,
  validateBootstrap,
  type Bootstrap,
} from "./compare.js";
import { evaluateRecord, PRIMARY, type EvaluatedRun } from "./evaluate.js";
import { readRecord, EvaluationError } from "./record.js";
export interface ReportInput {
  label: string;
  path: string;
}
export function buildReport(
  inputs: ReportInput[],
  options: Bootstrap & { revealHoldout?: boolean } = DEFAULT_BOOTSTRAP,
) {
  validateBootstrap(options);
  if (inputs.some((i) => !i.label.trim()))
    throw new EvaluationError("input_labels", "Labels cannot be empty");
  if (
    !inputs.length ||
    new Set(inputs.map((i) => i.label)).size !== inputs.length
  )
    throw new EvaluationError(
      "input_labels",
      "Supply distinct nonempty run labels",
    );
  const runs = inputs.flatMap((input) =>
    evaluateRecord(readRecord(input.path), input.label, options.revealHoldout),
  );
  if (
    new Set(runs.map((r) => `${r.source.path}:${r.predictor}`)).size !==
    runs.length
  )
    throw new EvaluationError(
      "duplicate_record",
      "Same predictor supplied twice",
    );
  const comparisons = [];
  for (let i = 0; i < runs.length; i++)
    for (let j = i + 1; j < runs.length; j++) {
      const a = runs[i],
        b = runs[j];
      comparisons.push({
        headline: compareRuns(
          a,
          b,
          options,
          a.games
            .filter((g) => g.game.tag === "scored")
            .map((g) => g.game.gameId),
        ),
        diagnostic: compareRuns(
          a,
          b,
          options,
          a.games
            .filter((g) => g.game.tag !== "holdout")
            .map((g) => g.game.gameId),
        ),
        ...(options.revealHoldout
          ? {
              holdout: compareRuns(
                a,
                b,
                options,
                a.games
                  .filter((g) => g.game.tag === "holdout")
                  .map((g) => g.game.gameId),
              ),
            }
          : {}),
      });
    }
  const common = runs[0].games
    .map((g) => g.game)
    .filter((g) =>
      runs.every((r) =>
        r.games.some(
          (x) =>
            x.game.gameId === g.gameId &&
            x.game.index === g.index &&
            x.game.tag === g.tag,
        ),
      ),
    );
  const learningCurves = common.map((game) => ({
    game,
    runs: runs.map((r) => ({
      id: r.id,
      scores: Object.fromEntries(
        PRIMARY.map((metric) => [
          metric,
          r.games.find((g) => g.game.gameId === game.gameId)!.metrics[metric],
        ]),
      ),
    })),
  }));
  return {
    version: "evaluation-v1",
    bootstrap: { resamples: options.resamples, seed: options.seed },
    holdoutRevealed: !!options.revealHoldout,
    notices: [
      "Fixture and development numbers are diagnostics, not evidence or claims of learning.",
      "Headline uses scored games 21–70 only; warm-up and development are excluded. Revealed holdout is separate.",
      "All primary differences are right minus left; lower losses are better. Score/cost ratios are loss per unit, not causal returns.",
      "Provider-failure flags disclose affected games; unscored windows are dropped pairwise, not silently assigned a score.",
    ],
    runs: runs.map(({ events, ...r }) => r),
    comparisons,
    learningCurves,
    learningCurveOmissions: runs.map((r) => ({
      id: r.id,
      gameIds: r.games
        .filter((g) => !common.some((c) => c.gameId === g.game.gameId))
        .map((g) => g.game.gameId),
    })),
    replicateSpread: replicateSpread(runs),
  };
}
export type EvaluationReport = ReturnType<typeof buildReport>;
const cell = (x: unknown) =>
  String(x ?? "—")
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]/g, " ");
const number = (x: unknown) =>
  typeof x === "number"
    ? Number.isInteger(x)
      ? String(x)
      : x.toPrecision(7)
    : "—";
const json = (x: unknown) =>
  "```json\n" +
  JSON.stringify(x, null, 2).replace(/```/g, "\\u0060\\u0060\\u0060") +
  "\n```";
export function markdown(report: EvaluationReport) {
  const out = [
    "# Experiment record report",
    ...report.notices.map((n) => `\n${n}`),
    `\nBootstrap: ${report.bootstrap.resamples} resamples; seed ${report.bootstrap.seed}; paired game resampling; 90% percentile intervals.\nHoldout revealed: ${report.holdoutRevealed}.`,
  ];
  for (const run of report.runs) {
    out.push(
      `\n## ${cell(run.id)}`,
      `Source: ${cell(run.source.path)}; record SHA-256: ${run.source.sha256}; last event: ${run.source.lastEventHash}.`,
      `Flags: ${run.flags.map(cell).join(", ") || "none"}.`,
      "\n### Descriptors and run profile",
      json(run.descriptors),
      "\n### Scores by game",
      "\n| Game | Index (1-based) | Tag | Brier | Exit | Entry | Log loss | Scored / eligible | Provider flag | Complete | USD | Recorded seconds |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const g of run.games)
      out.push(
        `| ${cell(g.game.gameId)} | ${g.game.index + 1} | ${g.game.tag} | ${number(g.metrics.timingBrier)} | ${number(g.metrics.exitBrier)} | ${number(g.metrics.entryBrier)} | ${number(g.metrics.timingLogLoss)} | ${g.metrics.scored}/${g.metrics.eligible} | ${g.metrics.providerFailureFlag} | ${g.complete} | ${number(g.cost.totalUsd)} | ${number(g.cost.recordedSeconds)} |`,
      );
    out.push(
      "\n### Headline (scored games only)",
      json(run.headline),
      "\n### All reported games: diagnostics and counts",
      json({
        metrics: run.totals,
        invalidPackageGames: run.invalidPackageGames,
        providerFailureGames: run.providerFailureGames,
        cost: run.cost,
      }),
    );
    if (report.holdoutRevealed)
      out.push("\n### Revealed holdout (separate)", json(run.holdout));
    if (run.memoryDiagnostics.length)
      out.push(
        "\n### Learning diagnostic slots (human annotations left blank)",
        json(run.memoryDiagnostics),
      );
  }
  out.push("\n## Matched comparisons");
  for (const pair of report.comparisons)
    for (const [section, c] of Object.entries(pair)) {
      if (!c) continue;
      out.push(
        `\n### ${cell(c.left)} → ${cell(c.right)}: ${section}`,
        `Status: ${c.status}. Flags: ${c.flags.join(", ") || "none"}. Axes differing: ${c.differingAxes.join(", ") || "none"}.`,
      );
      if (c.status === "refused") {
        out.push(`Refused: ${c.reasons.join(", ")}.`);
        continue;
      }
      out.push(
        "Marginal metrics use (left loss − right loss) / (right cost − left cost); time is converted to hours. Zero or unknown deltas are undefined. Negative deltas describe savings, not added spend.",
        `Matched windows: ${c.matchedWindows}; matched games: ${c.matchedGames}; dropped: ${c.dropped.count}.`,
        json(c.dropped),
        "\n| Primary loss | Left | Right | Difference | 90% interval | Left USD / seconds | Right USD / seconds | Left loss/USD / loss/second | Right loss/USD / loss/second |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      );
      for (const metric of PRIMARY) {
        const s = c.scores[metric];
        out.push(
          `| ${metric} | ${number(s.left)} | ${number(s.right)} | ${number(s.difference)} | ${s.interval90.map(number).join(" to ")} | ${number(s.cost.left.totalUsd)} / ${number(s.cost.left.recordedSeconds)} | ${number(s.cost.right.totalUsd)} / ${number(s.cost.right.recordedSeconds)} | ${number(s.efficiency.left.scorePerUsd)} / ${number(s.efficiency.left.scorePerRecordedSecond)} | ${number(s.efficiency.right.scorePerUsd)} / ${number(s.efficiency.right.scorePerRecordedSecond)} |`,
        );
        out.push(
          `\n${metric} marginal cost/time (null means undefined):`,
          json(s.marginal),
        );
        out.push(
          `\n${metric} sensitivity (five largest leave-one-game-out shifts):`,
          json(s.sensitivity),
        );
      }
    }
  out.push(
    "\n## Learning curves on common games",
    "\n| Game | Index (1-based) | Tag | Run | Timing Brier | Exit Brier | Entry Brier |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const point of report.learningCurves)
    for (const run of point.runs)
      out.push(
        `| ${cell(point.game.gameId)} | ${point.game.index + 1} | ${point.game.tag} | ${cell(run.id)} | ${number(run.scores.timingBrier)} | ${number(run.scores.exitBrier)} | ${number(run.scores.entryBrier)} |`,
      );
  out.push(
    "\nLearning-curve omissions:",
    json(report.learningCurveOmissions),
    "\n## Within-variant replicate spread",
    json(report.replicateSpread),
    "\nFull precision per-window results, every aggregate, costs, bootstrap settings and annotation slots are in report.json. Rounded table displays do not change JSON values.",
  );
  return out.join("\n") + "\n";
}
