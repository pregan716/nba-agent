import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { digest, type Manifest } from "../runner/config.js";
import type { Event } from "../runner/record.js";
import { readBlob } from "../runner/blobs.js";
import { cost, type Usage } from "../runner/budget.js";
import type { QuestionSet } from "../questions/builder.js";
import type { SubmitInput } from "../env/contract.js";
import { resolveFrozen, type ResolutionInput } from "../env/results.js";
import { logSkill, brierSkill } from "./scoring.js";

export interface ScoredQuestion {
  gameId: string;
  gameIndex: number;
  questionId: string;
  player: string;
  stat: string;
  line: number;
  p: number | null;
  q: number;
  actual: number | null;
  outcome: string;
  reason: string | null;
  skill: number | null;
  brier: number | null;
}
const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
export function aggregate(rows: ScoredQuestion[]) {
  const scored = rows.filter((r) => r.skill !== null);
  return {
    questions: rows.length,
    scored: scored.length,
    skill: mean(scored.map((r) => r.skill!)),
    brier: mean(scored.map((r) => r.brier!)),
    deviations: [0.05, 0.1].map((threshold) => {
      const selected = scored.filter(
        (r) => Math.abs(r.p! - r.q) + 1e-12 >= threshold,
      );
      return {
        threshold,
        count: selected.length,
        rate: scored.length ? selected.length / scored.length : null,
        hitRate: mean(
          selected.map((r) => Number(r.p! > r.q === (r.outcome === "over"))),
        ),
      };
    }),
    calibration: Array.from({ length: 10 }, (_, decile) => {
      const selected = scored.filter(
        (r) => Math.min(9, Math.floor(r.p! * 10)) === decile,
      );
      return {
        lower: decile / 10,
        upper: (decile + 1) / 10,
        count: selected.length,
        probability: mean(selected.map((r) => r.p!)),
        observed: mean(selected.map((r) => Number(r.outcome === "over"))),
      };
    }),
  };
}
function breakdown(rows: ScoredQuestion[], key: (r: ScoredQuestion) => string) {
  return Object.fromEntries(
    [...new Set(rows.map(key))]
      .sort()
      .map((k) => [k, aggregate(rows.filter((r) => key(r) === k))]),
  );
}
function resources(events: Event[], manifest: Manifest) {
  const usage: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    reasoning: 0,
  };
  let unknownReasoning = false,
    usd = 0,
    computeSeconds = 0,
    unconfirmedTokens = 0;
  for (const event of events.filter((e) => e.kind === "model_response")) {
    const u: Usage = event.data.usage;
    for (const k of [
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "cacheWrite5m",
      "cacheWrite1h",
    ] as const)
      usage[k] += u[k];
    if (u.reasoning === null) unknownReasoning = true;
    else usage.reasoning! += u.reasoning;
    usd += cost(u, manifest.config.budget.price);
  }
  if (unknownReasoning) usage.reasoning = null;
  for (const e of events.filter((e) => e.kind === "reservation")) {
    const settled = events.find(
      (s) => s.kind === "settlement" && s.data.id === e.data.id,
    );
    computeSeconds += settled ? settled.data.compute : e.data.compute;
    if (!settled) unconfirmedTokens += e.data.tokens;
  }
  const wallSeconds = events
    .filter((e) => e.kind === "session_end")
    .reduce((n, e) => n + e.data.elapsedMs / 1000, 0);
  // Stage timings use each attempt's observed duration; never charge downtime on resume.
  let researchSeconds = 0,
    commitSeconds = 0,
    postgameSeconds = 0;
  for (const end of events.filter((e) => e.kind === "session_end")) {
    const start = events.find(
      (e) =>
        e.kind === "session_start" &&
        e.scope === end.scope &&
        e.data.attempt === end.data.attempt,
    );
    const seconds = end.data.elapsedMs / 1000;
    if (end.scope.endsWith(":postgame")) {
      postgameSeconds += seconds;
      continue;
    }
    const commit = events.find(
      (e) =>
        e.kind === "commit" &&
        e.scope === end.scope &&
        (!start || e.seq > start.seq) &&
        e.seq < end.seq,
    );
    const research =
      commit && start
        ? Math.min(
            seconds,
            Math.max(0, (Date.parse(commit.at) - Date.parse(start.at)) / 1000),
          )
        : seconds;
    researchSeconds += research;
    commitSeconds += seconds - research;
  }
  let toolWallSeconds = 0;
  for (const start of events.filter((e) => e.kind === "tool_start")) {
    const nextStart = events.find(
      (e) =>
        e.scope === start.scope && e.kind === "tool_start" && e.seq > start.seq,
    );
    const end = events.find(
      (e) =>
        e.scope === start.scope &&
        (e.kind === "tool_result" || e.kind === "tool_error") &&
        e.seq > start.seq &&
        (!nextStart || e.seq < nextStart.seq),
    );
    if (end)
      toolWallSeconds += Math.max(
        0,
        (Date.parse(end.at) - Date.parse(start.at)) / 1000,
      );
  }
  return {
    toolWallSeconds,
    usage,
    usd,
    unconfirmedTokens,
    spendComplete: unconfirmedTokens === 0,
    computeSeconds,
    wallSeconds,
    researchSeconds,
    commitSeconds,
    postgameSeconds,
  };
}
export function evaluate(events: Event[]) {
  const manifest = events.find((e) => e.kind === "manifest")?.data as
    Manifest | undefined;
  if (!manifest) throw Error("Missing run manifest");
  const rows: ScoredQuestion[] = [];
  for (const e of events.filter((e) => e.kind === "questions")) {
    const set = e.data as QuestionSet;
    const game = manifest.games.find((g) => g.gameId === set.game.game_id);
    if (!game) throw Error("Question game missing from manifest");
    const input = events.find(
      (r) => r.kind === "resolution_input" && r.scope === game.gameId,
    )?.data as ResolutionInput | undefined;
    const submission = events.find(
      (r) => r.kind === "submission" && r.scope === game.gameId,
    )?.data.value.submission as SubmitInput | undefined;
    const phase = events.find(
      (r) => r.kind === "phase_end" && r.scope === `${game.gameId}:pregame`,
    );
    for (const q of set.questions) {
      const resolved = input
        ? resolveFrozen(input, q.player.id, q.stat, q.selected_line)
        : { actual: null, outcome: "unresolved" };
      const p =
        submission?.answers.find((a) => a.question_id === q.question_id)
          ?.p_over ?? null;
      const reason = !["over", "under"].includes(resolved.outcome)
        ? resolved.outcome === "unresolved"
          ? `unresolved: ${input?.boxReason ?? input?.summaryReason ?? (input ? "missing or conflicting official stat or participation" : "outcome data not captured")}`
          : resolved.outcome
        : phase?.data.status !== "completed"
          ? `pregame ${phase?.data.status ?? "unfinished"}`
          : p === null
            ? "missing submission"
            : manifest.config.purpose === "scored" && game.development
              ? "development game"
              : null;
      rows.push({
        gameId: game.gameId,
        gameIndex: game.index + 1,
        questionId: q.question_id,
        player: q.player.id,
        stat: q.stat,
        line: q.selected_line,
        p,
        q: q.p_over,
        ...resolved,
        reason,
        skill: reason
          ? null
          : logSkill({
              ...resolved,
              outcome: resolved.outcome as "over" | "under",
              agent_p_over: p!,
              market_p_over: q.p_over,
            }),
        brier: reason
          ? null
          : brierSkill(p!, q.p_over, Number(resolved.outcome === "over")),
      });
    }
  }
  const totals = aggregate(rows),
    totalCost = resources(events, manifest);
  const stages = (scope: string) => {
    const scoped = events.filter((e) => e.scope === scope);
    const totals = resources(scoped, manifest);
    const commit = scoped.find((e) => e.kind === "commit");
    return Object.fromEntries(
      ["research", "commit"].map((stage) => {
        const subset = scoped.filter((e) =>
          stage === "research"
            ? !commit || e.seq < commit.seq
            : commit && e.seq >= commit.seq,
        );
        return [
          stage,
          {
            ...resources(subset, manifest),
            wallSeconds:
              stage === "research"
                ? totals.researchSeconds
                : totals.commitSeconds,
          },
        ];
      }),
    );
  };
  const byGame = Object.fromEntries(
    manifest.games.map((g) => [
      g.gameId,
      {
        scores: aggregate(rows.filter((r) => r.gameId === g.gameId)),
        cost: resources(
          events.filter(
            (e) => e.scope === g.gameId || e.scope.startsWith(`${g.gameId}:`),
          ),
          manifest,
        ),
        stages: stages(`${g.gameId}:pregame`),
        phases: Object.fromEntries(
          ["pregame", "postgame"].map((phase) => [
            phase,
            resources(
              events.filter((e) => e.scope === `${g.gameId}:${phase}`),
              manifest,
            ),
          ]),
        ),
      },
    ]),
  );
  return {
    schemaVersion: 1,
    runId: manifest.config.runId,
    replicateId: manifest.config.replicateId,
    profile: manifest.config.profile,
    scoreConvention:
      "market log loss minus agent log loss (positive is better)",
    budget: manifest.config.budget,
    harnessVersion: manifest.harnessVersion,
    devig: manifest.config.devig,
    purpose: manifest.config.purpose,
    contaminationProbe: manifest.config.contaminationProbe,
    totals,
    cost: totalCost,
    efficiency: {
      skillPerDollar:
        totalCost.usd && totals.skill !== null
          ? totals.skill / totalCost.usd
          : null,
      skillPerSecond:
        totalCost.wallSeconds && totals.skill !== null
          ? totals.skill / totalCost.wallSeconds
          : null,
    },
    rows,
    byGame,
    byStat: breakdown(rows, (r) => r.stat),
    byPlayer: breakdown(rows, (r) => r.player),
    bySeasonThird: breakdown(rows, (r) =>
      String(
        Math.min(
          3,
          Math.floor(((r.gameIndex - 1) * 3) / manifest.games.length) + 1,
        ),
      ),
    ),
    failedSessions: events
      .filter((e) => e.kind === "session_end" && e.data.status !== "completed")
      .map((e) => ({ scope: e.scope, ...e.data })),
    exclusions: events
      .filter((e) => e.kind === "questions")
      .flatMap((e) => (e.data as QuestionSet).exclusions),
    unscored: rows.filter((r) => r.reason !== null),
    learning:
      manifest.config.profile.memory.horizon === "stateless"
        ? null
        : {
            status: "requires evidence review",
            categories: ["stale beliefs", "useful transfer", "repeated errors"],
            // Preserve the evidence without asserting that textual similarity proves learning.
            sessions: events
              .filter((e) => e.kind === "session_end")
              .map((e) => ({
                seq: e.seq,
                scope: e.scope,
                before: e.data.before,
                after: e.data.after,
                diff: e.data.diff,
              })),
            annotations: events
              .filter((e) => e.kind === "learning_annotation")
              .map((e) => e.data),
          },
  };
}
export type Report = ReturnType<typeof evaluate>;

/** Offline read: no constructor that creates/migrates a record, and no source adapters. */
export function readReport(root: string) {
  const db = new DatabaseSync(join(root, "record.sqlite"), { readOnly: true });
  try {
    let previous = "genesis";
    const events = db
      .prepare("SELECT * FROM events ORDER BY seq")
      .all()
      .map((row) => {
        if (
          row.previous !== previous ||
          row.hash !==
            digest([row.kind, row.scope, row.data, row.previous, row.at])
        )
          throw Error("Record hash chain mismatch");
        previous = row.hash as string;
        return {
          ...row,
          data: JSON.parse(row.data as string),
        } as unknown as Event;
      });
    const report = evaluate(events);
    const workspace = Object.fromEntries(
      [
        ...new Set(
          (report.learning?.sessions.flatMap((s) => [
            ...Object.values(s.before.files),
            ...Object.values(s.after.files),
          ]) as string[]) ?? [],
        ),
      ]
        .sort()
        .map((hash) => [hash, readBlob(root, hash).toString("utf8")]),
    );
    return { ...report, workspace };
  } finally {
    db.close();
  }
}
