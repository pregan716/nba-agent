import { referenceRuns, withReferences } from "./references.js";
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
  options: Bootstrap & {
    revealHoldout?: boolean;
    baselines?: ReportInput[];
  } = DEFAULT_BOOTSTRAP,
) {
  validateBootstrap(options);
  inputs = [...inputs, ...(options.baselines ?? [])];
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
  const enriched = runs.map((run) => {
    const references = run.variant ? referenceRuns(run, runs) : [];
    const rows = run.games.flatMap((g) => g.rows);
    return {
      ...run,
      games: run.games.map((g) => ({
        ...g,
        metrics: withReferences(g.rows, references),
      })),
      totals: withReferences(rows, references),
      headline: withReferences(
        run.games.filter((g) => g.game.tag === "scored").flatMap((g) => g.rows),
        references,
      ),
      holdout: withReferences(
        run.games
          .filter((g) => g.game.tag === "holdout")
          .flatMap((g) => g.rows),
        references,
      ),
    };
  });
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
    runs: enriched.map((r) => ({
      id: r.id,
      scores: Object.fromEntries(
        (
          [
            ...PRIMARY,
            "timingSkillVsConstant",
            "timingSkillVsStatistical",
          ] as const
        ).map((metric) => [
          metric,
          r.games.find((g) => g.game.gameId === game.gameId)!.metrics[metric],
        ]),
      ),
      midPeriod: r.games.find((g) => g.game.gameId === game.gameId)!.metrics
        .midPeriod,
      baselines: r.games.find((g) => g.game.gameId === game.gameId)!.metrics
        .baselines,
    })),
  }));
  return {
    version: "evaluation-v2",
    bootstrap: { resamples: options.resamples, seed: options.seed },
    holdoutRevealed: !!options.revealHoldout,
    notices: [
      "Fixture and development numbers are diagnostics, not evidence or claims of learning.",
      "Headline uses scored games 21–70 only; warm-up and development are excluded. Revealed holdout is separate.",
      "All primary differences are right minus left; lower losses are better. Score/cost ratios are loss per unit, not causal returns.",
      "Provider-failure flags disclose affected games; unscored windows are dropped pairwise, not silently assigned a score.",
    ],
    runs: enriched.map(({ events, ...r }) => r),
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
const displayMetrics = [
  "setLogLoss",
  "candidateHitRate",
  "setTop1",
  "meanCandidates",
  "otherMass",
  "timingBrier",
  "timingSkillVsConstant",
  "timingSkillVsStatistical",
  "meanPredicted",
  "observedRate",
  "timingLogLoss",
  "exitBrier",
  "entryBrier",
  "exitTop1",
  "entryTop1",
  "exitTopK",
  "entryTopK",
  "exitLogLoss",
  "entryLogLoss",
  "exitMRR",
  "entryMRR",
  "exitLogLossClips",
  "entryLogLossClips",
];
function metricTable(m: EvaluationReport["runs"][number]["totals"]) {
  const lines = [
    "\n| Scope | Metric | Scored / substitutions | Run | constant | statistical | generic-jev |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  const groups = [
    ["full", m],
    ["midPeriod", m.midPeriod],
    ...Object.entries(m.byStoppage),
  ] as const;
  for (const [scope, value] of groups) {
    const get = (v: any, key: string) =>
      key.startsWith("decomposition.")
        ? v?.brierDecomposition?.[key.slice(14)]
        : v?.[key];
    for (const key of [
      ...displayMetrics,
      "decomposition.reliability",
      "decomposition.resolution",
      "decomposition.uncertainty",
      "decomposition.binningError",
    ]) {
      const cells = [
        value,
        ...["constant", "statistical", "generic-jev"].map(
          (name) => value.baselines[name]?.metrics,
        ),
      ];
      lines.push(
        `| ${cell(scope)} | ${key} | ${value.scored}/${value.actualSubstitutions} | ${cells.map((v) => number(get(v, key))).join(" | ")} |`,
      );
    }
  }
  lines.push(
    `\nStatistical reference: ${cell(m.timingSkillVsStatisticalReason ?? "available")}. Baseline availability: ${Object.entries(
      m.baselines,
    )
      .map(([name, b]) => `${name}: ${b.reason ?? b.runId}`)
      .map(cell)
      .join("; ")}.`,
  );
  return lines.join("\n");
}
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
    );
    for (const g of run.games)
      out.push(
        `\n#### ${cell(g.game.gameId)} — game ${g.game.index + 1}, ${g.game.tag}`,
        `Scored/eligible: ${g.metrics.scored}/${g.metrics.eligible}; provider flag: ${g.metrics.providerFailureFlag}; complete: ${g.complete}; USD: ${number(g.cost.totalUsd)}; recorded seconds: ${number(g.cost.recordedSeconds)}.`,
        metricTable(g.metrics),
      );
    out.push(
      "\n### Headline (scored games only)",
      metricTable(run.headline),
      json(run.headline),
      "\n### All reported games: diagnostics and counts",
      metricTable(run.totals),
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
    for (const [section, c] of Object.entries(pair).flatMap(([section, c]) =>
      c
        ? ([
            [section, c],
            [section + " midPeriod", c.midPeriod],
          ] as const)
        : [],
    )) {
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
        "\n| Timing diagnostic | Left | Right |",
        "| --- | --- | --- |",
        ...(
          ["timingSkillVsConstant", "meanPredicted", "observedRate"] as const
        ).map(
          (key) =>
            `| ${key} | ${number(c.metrics.left[key])} | ${number(c.metrics.right[key])} |`,
        ),
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
    "Y-axis: timing skill (higher is better); raw Brier remains the headline metric. Decomposition uses within-game deciles pooled by scored windows; signed binning error is Brier minus reliability plus resolution minus uncertainty.",
    "\n| Game | Index (1-based) | Tag | Run | Timing skill vs constant | Timing skill vs statistical | Mid-period skill vs constant | constant skill | statistical skill | generic-jev skill |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const point of report.learningCurves)
    for (const run of point.runs)
      out.push(
        `| ${cell(point.game.gameId)} | ${point.game.index + 1} | ${point.game.tag} | ${cell(run.id)} | ${number(run.scores.timingSkillVsConstant)} | ${number(run.scores.timingSkillVsStatistical)} | ${number(run.midPeriod.timingSkillVsConstant)} | ${["constant", "statistical", "generic-jev"].map((name) => number(run.baselines[name]?.metrics?.timingSkillVsConstant)).join(" | ")} |`,
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
