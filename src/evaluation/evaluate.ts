import { summarizeEstimates } from "../replay/estimates.js";
import { scoreWindow, summarize } from "../replay/scoring.js";
import type { WindowResult } from "../replay/types.js";
import {
  canonical,
  EvaluationError,
  hash,
  type RecordedRun,
} from "./record.js";
import type { Event } from "../runner/record.js";

export const PRIMARY = ["timingBrier", "exitBrier", "entryBrier"] as const;
export type Metric = (typeof PRIMARY)[number];
export type Tag = "development" | "warm-up" | "scored" | "holdout";
export interface GameInfo {
  gameId: string;
  index: number;
  tag: Tag;
  scheduledStart: string | null;
}
export const gameTag = (index: number): Tag =>
  index < 10
    ? "development"
    : index < 20
      ? "warm-up"
      : index < 70
        ? "scored"
        : "holdout";
export const tally = (values: string[]) =>
  Object.fromEntries(
    [...new Set(values)]
      .sort()
      .map((v) => [v, values.filter((x) => x === v).length]),
  );
export function metrics(rows: WindowResult[]) {
  return {
    ...summarize(rows),
    invalidReasons: tally(
      rows.flatMap((r) =>
        Object.entries(r.validation?.questions ?? {}).flatMap(
          ([question, v]) =>
            v.valid ? [] : v.reasons.map((reason) => `${question}:${reason}`),
        ),
      ),
    ),
  };
}
export function unscoredReasons(row?: WindowResult): string[] {
  if (!row) return ["missing_window"];
  return [
    ...row.window.exclusions.map((r) => `excluded:${r}`),
    ...(!row.window.state ? ["missing_state"] : []),
    ...(!row.window.actual ? ["missing_actual"] : []),
    ...(row.failure ? [row.failure] : []),
  ];
}
export function spending(
  events: Event[],
  predictor: string,
  gameIds: string[],
  variant: boolean,
) {
  const selected = new Set(gameIds);
  const replay = events.filter(
    (e) =>
      selected.has(e.scope.split(":")[0]) &&
      e.scope
        .split(":")
        .slice(2)
        .join(":")
        .startsWith(predictor + ":"),
  );
  // Exact call-scope prefix: predictor IDs may themselves contain colons.
  const calls = replay.filter(
    (e) => e.scope.split(":").slice(2).join(":").slice(0, -65) === predictor,
  );
  const researchScopes = new Set(
    gameIds.flatMap((id) => [`${id}:pregame`, `${id}:postgame`]),
  );
  const research = variant
    ? events.filter((e) => researchScopes.has(e.scope))
    : [];
  const charges = research.filter(
    (e) => e.kind === "settlement" && typeof e.data.details?.usd === "number",
  );
  const requests = research.filter((e) => e.kind === "model_request");
  const unknownAnalyst = requests.filter(
    (e) => !charges.some((c) => c.data.id === e.data.reservation),
  ).length;
  const uncertainAnalystErrors = research.filter(
    (e) => e.kind === "model_error",
  ).length;
  const responses = calls.filter((e) => e.kind === "jev_response");
  const errors = calls.filter((e) => e.kind === "jev_error");
  // A resumed call can reuse attempt=0. Match by event order, not just scope
  // and attempt, so one response cannot price an earlier interrupted request.
  const attempts: { response: boolean; timed: boolean }[] = [];
  const latest = new Map<string, { response: boolean; timed: boolean }>();
  for (const e of calls) {
    const key = `${e.scope}:${e.data.attempt}`;
    if (e.kind === "jev_request") {
      const attempt = { response: false, timed: false };
      attempts.push(attempt);
      latest.set(key, attempt);
    } else if (e.kind === "jev_response" || e.kind === "jev_error") {
      const attempt = latest.get(key);
      if (attempt) {
        attempt.response ||= e.kind === "jev_response";
        attempt.timed ||= typeof e.data.latencyMs === "number";
      }
    }
  }
  const pendingJev = attempts.filter((a) => !a.response).length;
  const unknownJev =
    pendingJev + responses.filter((e) => typeof e.data.usd !== "number").length;
  const analystUsd = charges.reduce((n, e) => n + e.data.details.usd, 0);
  const jevUsd = responses.reduce((n, e) => n + (e.data.usd ?? 0), 0);
  const sessions = research.filter((e) => e.kind === "session_end");
  const assembly = calls.filter((e) => e.kind === "policy_assembly");
  const timeEvents = [...responses, ...errors];
  const failedAssembly = calls.some(
    (e) =>
      e.kind === "policy_prediction" &&
      ["assembler_error", "invalid_package"].includes(e.data.failure) &&
      events.some(
        (a) => a.kind === "policy_attempt" && a.data.callScope === e.scope,
      ) &&
      !assembly.some((a) => a.scope === e.scope),
  );
  const missingTime =
    failedAssembly ||
    sessions.some((e) => typeof e.data.elapsedMs !== "number") ||
    timeEvents.some((e) => typeof e.data.latencyMs !== "number") ||
    assembly.some((e) => typeof e.data.computeSeconds !== "number") ||
    research.some(
      (e) =>
        e.kind === "session_start" &&
        !sessions.some(
          (s) => s.scope === e.scope && s.data.attempt === e.data.attempt,
        ),
    ) ||
    attempts.some((a) => !a.timed);
  const sessionSeconds = sessions.reduce(
    (n, e) => n + (e.data.elapsedMs ?? 0) / 1000,
    0,
  );
  const jevSeconds = timeEvents.reduce(
    (n, e) => n + (e.data.latencyMs ?? 0) / 1000,
    0,
  );
  const assemblySeconds = assembly.reduce(
    (n, e) => n + (e.data.computeSeconds ?? 0),
    0,
  );
  return {
    analystUsd,
    jevUsd,
    knownUsd: analystUsd + jevUsd,
    totalUsd:
      unknownAnalyst + unknownJev + uncertainAnalystErrors
        ? null
        : analystUsd + jevUsd,
    unknownAnalystCalls: unknownAnalyst,
    uncertainAnalystErrors,
    unknownJevCalls: unknownJev,
    sessionSeconds,
    jevSeconds,
    assemblySeconds,
    recordedSeconds: missingTime
      ? null
      : sessionSeconds + jevSeconds + assemblySeconds,
    coverage:
      "Recorded session elapsed + Jev attempt latency + successful assembler compute; unmetered baseline CPU and outage time are unavailable.",
  };
}
export interface EvaluatedRun {
  id: string;
  predictor: string;
  variant: boolean;
  source: RecordedRun["source"];
  descriptors: {
    profile: any;
    budget: any;
    harnessVersion: string;
    harness: any;
    purpose: string;
    replicateId: string | null;
    codeRevision: string | null;
    dataset: any;
    state: any;
    jev: any;
    games: GameInfo[];
    selectedGames: string[];
    predictor: any;
  };
  games: {
    game: GameInfo;
    rows: WindowResult[];
    metrics: ReturnType<typeof metrics>;
    cost: ReturnType<typeof spending>;
    complete: boolean;
    invalidPackage: boolean;
  }[];
  totals: ReturnType<typeof metrics>;
  headline: ReturnType<typeof metrics>;
  holdout: ReturnType<typeof metrics>;
  flags: string[];
  invalidPackageGames: string[];
  providerFailureGames: string[];
  cost: ReturnType<typeof spending>;
  memoryDiagnostics: {
    game: GameInfo;
    sessions: any[];
    checkpoints: any[];
    annotation: string;
  }[];
  events: Event[];
}
export function evaluateRecord(
  record: RecordedRun,
  label: string,
  revealHoldout = false,
): EvaluatedRun[] {
  const { manifest: m, events } = record;
  if (!Array.isArray(m.games))
    throw new EvaluationError(
      "missing_game_tags",
      "The record must contain the chronological schedule/indexes; do not infer them from NBA IDs or local files.",
    );
  const games: GameInfo[] = m.games
    .map((g: any) => {
      if (
        !Number.isInteger(g.index) ||
        g.index < 0 ||
        g.index > 81 ||
        typeof g.gameId !== "string"
      )
        throw new EvaluationError("invalid_game_tags", String(g.gameId));
      const tag = gameTag(g.index);
      if (g.split && g.split !== tag)
        throw new EvaluationError("invalid_game_tags", g.gameId);
      return {
        gameId: g.gameId,
        index: g.index,
        tag,
        scheduledStart: g.scheduledStart ?? null,
      };
    })
    .sort((a: GameInfo, b: GameInfo) => a.index - b.index);
  if (
    new Set(games.map((g) => g.gameId)).size !== games.length ||
    new Set(games.map((g) => g.index)).size !== games.length
  )
    throw new EvaluationError("duplicate_game", label);
  const selected: string[] =
    m.config?.replay?.datasets?.map((d: any) => d.gameId) ??
    m.datasets?.map((d: any) => d.gameId) ??
    games.map((g) => g.gameId);
  if (
    new Set(selected).size !== selected.length ||
    selected.some((id) => !games.some((g) => g.gameId === id))
  )
    throw new EvaluationError("unknown_selected_game", label);
  if (
    !revealHoldout &&
    games.some((g) => selected.includes(g.gameId) && g.tag === "holdout")
  )
    throw new EvaluationError("holdout_not_revealed", label);
  const manifests = events
    .filter((e) => e.kind === "replay_manifest")
    .map((e) => e.data);
  if (m.kind === "replay-mvp") manifests.push(m);
  const predictors = new Map<string, any>();
  for (const rm of manifests)
    for (const p of Object.values(rm.predictors ?? {}) as any[])
      predictors.set(p.id, p);
  if (!predictors.size)
    throw new EvaluationError("missing_replay_manifest", label);
  const windowEvents = events.filter((e) => e.kind === "replay_window");
  for (const e of windowEvents) {
    const predictor = e.scope.split(":").slice(2).join(":");
    if (!predictors.has(predictor))
      throw new EvaluationError("unknown_predictor", e.scope);
    if (!selected.includes(e.data.result?.window?.gameId))
      throw new EvaluationError("unselected_window", e.scope);
  }
  return [...predictors]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([predictor, descriptor]) => {
      const variant =
        predictor === "variant" && m.config?.replay?.mode !== "baselines";
      const rows: WindowResult[] = [];
      const seen = new Set<string>();
      for (const e of windowEvents.filter(
        (e) => e.scope.split(":").slice(2).join(":") === predictor,
      )) {
        const stored = e.data.result as WindowResult;
        const key = `${stored.window.gameId}:${stored.window.id}`;
        if (seen.has(key)) throw new EvaluationError("duplicate_window", key);
        seen.add(key);
        const rm = manifests.find(
          (r) =>
            Object.values(r.predictors ?? {}).some(
              (p: any) => p.id === predictor,
            ) &&
            r.datasets.some(
              (d: any) =>
                d.gameId === stored.window.gameId &&
                e.scope === `${d.gameId}:${d.inputHash}:${predictor}`,
            ),
        );
        if (
          !rm ||
          e.data.datasetVersion !== rm.datasetVersion ||
          e.data.releaseManifestSha256 !== rm.releaseManifestSha256 ||
          stored.window.datasetVersion !== rm.datasetVersion
        )
          throw new EvaluationError("window_identity_mismatch", key);
        const declared = m.config?.replay?.datasets?.find(
          (d: any) => d.gameId === stored.window.gameId,
        );
        const stateVersion =
          m.config?.replay?.versions?.state ?? m.harness?.state;
        const jevSettings =
          m.config?.harness?.policy?.jev ?? m.harness?.policy?.jev;
        if (
          stored.window.releaseManifestSha256 !== rm.releaseManifestSha256 ||
          (declared &&
            (declared.version !== rm.datasetVersion ||
              declared.releaseManifestSha256 !== rm.releaseManifestSha256 ||
              !rm.datasets.some(
                (d: any) =>
                  d.gameId === declared.gameId &&
                  d.inputHash === declared.inputHash,
              )))
        )
          throw new EvaluationError("window_identity_mismatch", key);
        if (
          rm.harness.state !== stateVersion ||
          (stored.window.state && stored.window.state.version !== stateVersion)
        )
          throw new EvaluationError("state_schema_mismatch", key);
        if (
          canonical(rm.harness.policy?.jev) !== canonical(jevSettings) ||
          (m.config?.profile?.modelRoles?.jev &&
            m.config.profile.modelRoles.jev !== jevSettings?.model)
        )
          throw new EvaluationError("jev_model_or_settings_mismatch", key);
        const recomputed = scoreWindow(
          stored.window,
          stored.raw,
          stored.failure,
        );
        if (
          canonical(recomputed.scores) !== canonical(stored.scores) ||
          canonical(recomputed.validation) !== canonical(stored.validation)
        )
          throw new EvaluationError("score_mismatch", key);
        rows.push(recomputed);
      }
      const perGame = games
        .filter((g) => selected.includes(g.gameId))
        .map((game) => {
          const rs = rows
            .filter((r) => r.window.gameId === game.gameId)
            .sort(
              (a, b) =>
                a.window.sequence - b.window.sequence ||
                a.window.id.localeCompare(b.window.id),
            );
          const summary = metrics(rs);
          const summaries = events.filter(
            (e) =>
              e.kind === "replay_summary" &&
              e.scope.startsWith(`${game.gameId}:`) &&
              e.scope.split(":").slice(2).join(":") === predictor,
          );
          const complete =
            summaries.length === 1 &&
            canonical(summaries[0].data.summary) ===
              canonical({
                ...summarize(rs),
                ...(Object.hasOwn(
                  summaries[0].data.summary,
                  "assertedEstimates",
                )
                  ? summarizeEstimates(rs, summaries[0].scope, events)
                  : {}),
              });
          return {
            game,
            rows: rs,
            metrics: summary,
            cost: spending(events, predictor, [game.gameId], variant),
            complete,
            invalidPackage:
              rs.some((r) => r.failure === "invalid_package") ||
              (variant &&
                events.some(
                  (e) =>
                    e.kind === "policy_game_end" &&
                    e.scope === game.gameId &&
                    e.data.status === "invalid_package",
                )),
          };
        });
      const replayVersions = m.config?.replay?.versions ?? m.harness;
      const jev =
        m.config?.harness?.policy?.jev ?? m.harness?.policy?.jev ?? null;
      const dataset = selected
        .map((id) => {
          const d =
            m.config?.replay?.datasets?.find((d: any) => d.gameId === id) ??
            m.datasets?.find((d: any) => d.gameId === id);
          return {
            gameId: id,
            version: d?.version ?? m.datasetVersion,
            inputHash: d?.inputHash,
            release: d?.releaseManifestSha256 ?? m.releaseManifestSha256,
          };
        })
        .sort((a, b) => a.gameId.localeCompare(b.gameId));
      if (
        dataset.some((d) => !d.version || !d.inputHash || !d.release) ||
        !replayVersions?.state
      )
        throw new EvaluationError("missing_comparison_identity", label);
      const memory = m.config?.profile?.memory;
      const memoryOn =
        variant &&
        memory &&
        ["coachProfile", "bestPractices", "skills"].some(
          (k) => memory[k]?.read || memory[k]?.create || memory[k]?.revise,
        );
      return {
        id: `${label}:${predictor}`,
        predictor,
        variant,
        source: record.source,
        descriptors: {
          profile: variant
            ? m.config?.profile
            : { ...m.config?.profile, memory: null, baseline: predictor },
          budget: m.config?.budget ?? null,
          harnessVersion: m.harnessVersion ?? hash(m.harness),
          harness: m.config?.harness ?? m.harness,
          purpose: m.config?.purpose ?? "legacy-diagnostic",
          replicateId: m.config?.replicateId ?? null,
          codeRevision: m.config?.codeRevision ?? m.codeRevision ?? null,
          dataset,
          state: replayVersions.state,
          jev,
          games,
          selectedGames: [...selected].sort(),
          predictor: {
            id: predictor,
            perGame: manifests
              .filter((r) =>
                Object.values(r.predictors ?? {}).some(
                  (p: any) => p.id === predictor,
                ),
              )
              .map((r) => ({
                games: r.datasets.map((d: any) => d.gameId),
                descriptor: Object.values(r.predictors).find(
                  (p: any) => p.id === predictor,
                ),
              })),
          },
        },
        games: perGame,
        totals: metrics(rows),
        headline: metrics(
          perGame.filter((g) => g.game.tag === "scored").flatMap((g) => g.rows),
        ),
        holdout: metrics(
          perGame
            .filter((g) => g.game.tag === "holdout")
            .flatMap((g) => g.rows),
        ),
        flags: [
          ...(m.config?.purpose === "fixture"
            ? ["fixture_numbers_not_evidence"]
            : []),
          ...(m.config?.budget?.pilotApproved === false
            ? ["budget_not_pilot_approved"]
            : []),
          ...(/placeholder/i.test(m.config?.budget?.price?.id ?? "")
            ? ["price_profile_unverified"]
            : []),
          ...perGame
            .filter((g) => !g.complete)
            .map((g) => `incomplete_replay:${g.game.gameId}`),
          ...(!jev ? ["jev_identity_unavailable"] : []),
        ],
        invalidPackageGames: perGame
          .filter((g) => g.invalidPackage)
          .map((g) => g.game.gameId),
        providerFailureGames: perGame
          .filter((g) => g.metrics.providerFailureFlag)
          .map((g) => g.game.gameId),
        cost: combineSpending(perGame.map((g) => g.cost)),
        memoryDiagnostics: memoryOn
          ? perGame.map(({ game }) => ({
              game,
              sessions: events
                .filter(
                  (e) =>
                    e.kind === "session_end" &&
                    (e.scope === `${game.gameId}:pregame` ||
                      e.scope === `${game.gameId}:postgame`),
                )
                .map((e) => ({
                  phase: e.scope.split(":")[1],
                  attempt: e.data.attempt,
                  diff: e.data.diff ?? null,
                  beforeMemorySize:
                    events.find(
                      (start) =>
                        start.kind === "session_start" &&
                        start.scope === e.scope &&
                        start.data.attempt === e.data.attempt,
                    )?.data.memorySize ?? null,
                  afterMemorySize: e.data.memorySize ?? null,
                })),
              checkpoints: events
                .filter(
                  (e) =>
                    e.kind === "memory_checkpoint" &&
                    e.data.game === game.gameId,
                )
                .map((e) => e.data),
              annotation: "",
            }))
          : [],
        events,
      };
    });
}

export function combineSpending(costs: ReturnType<typeof spending>[]) {
  const total = spending([], "", [], false);
  for (const cost of costs)
    for (const key of [
      "analystUsd",
      "jevUsd",
      "knownUsd",
      "unknownAnalystCalls",
      "uncertainAnalystErrors",
      "unknownJevCalls",
      "sessionSeconds",
      "jevSeconds",
      "assemblySeconds",
    ] as const)
      total[key] += cost[key];
  total.totalUsd = costs.some((c) => c.totalUsd === null)
    ? null
    : costs.reduce((n, c) => n + c.totalUsd!, 0);
  total.recordedSeconds = costs.some((c) => c.recordedSeconds === null)
    ? null
    : costs.reduce((n, c) => n + c.recordedSeconds!, 0);
  return total;
}
export function costFor(run: EvaluatedRun, gameIds: string[]) {
  return combineSpending(
    run.games.filter((g) => gameIds.includes(g.game.gameId)).map((g) => g.cost),
  );
}
