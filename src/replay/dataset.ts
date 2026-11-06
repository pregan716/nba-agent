import { digest } from "../runner/config.js";
import type { Row } from "../data/contracts.js";
import {
  BOS,
  BOX_FIELDS,
  WINDOW_VERSION,
  type BoxField,
  type DecisionDataset,
  type ReplayInput,
  type Window,
} from "./types.js";
import {
  actionFor,
  buildState,
  elapsed,
  five,
  personalFoul,
  substitutionBlocks,
  validatePregame,
} from "./state.js";
import { validateAction } from "./contract.js";
const DEAD = new Set([
  "out-of-bounds",
  "offensive foul",
  "shot clock",
  "traveling",
  "backcourt",
  "3-second-violation",
  "offensive goaltending",
  "5-second-violation",
  "discontinued dribble",
  "double dribble",
  "offensive-kicked-ball",
  "8-second-violation",
  "jumpball violation",
]);
export function opener(e: Row): string | null {
  if (e.type === "timeout" && e.subtype === "full") return "timeout";
  if (e.type === "foul" && ["personal", "offensive"].includes(e.subtype))
    return "foul";
  if (e.type === "turnover" && DEAD.has(e.subtype)) return "dead_ball_turnover";
  if (e.type === "violation" && e.subtype !== "delay-of-game")
    return "violation";
  if (e.type === "jump_ball" && e.clock_remaining_ms !== opening(e.period))
    return "jump_ball";
  // Team rebounds never open a window: even deadball denotes free-throw context,
  // not independent evidence of a substitution-eligible stoppage.
  return null;
}
const opening = (period: number) => (period <= 4 ? 720000 : 300000);
const inPeriod = (b: Row[]) =>
  b[0].clock_remaining_ms > 0 && b[0].clock_remaining_ms < opening(b[0].period);
const ownSubs = (b: Row[]) =>
  b.filter((e) => e.type === "substitution" && e.team_id === BOS);
const span = (b: Row[]): [number, number] => [
  b[0].canonical_sequence,
  b.at(-1)!.canonical_sequence,
];
function mechanism(b: Row[], previous: Row[]) {
  if (b.some((e) => ["foul", "ejection"].includes(e.type)))
    return "technical_foul_or_ejection";
  if (b.some((e) => ["violation", "timeout"].includes(e.type)))
    return "delay_of_game_or_challenge";
  if (b.some((e) => e.type === "rebound" && e.description?.startsWith("TEAM ")))
    return "team_rebound_without_independent_stoppage";
  if (b.every((e) => e.type === "substitution")) {
    const p = previous.at(-1);
    return p?.type === "field_goal" && p.shot_result === "made"
      ? "substitution_only_after_made_basket"
      : p?.type === "rebound"
        ? "substitution_only_after_rebound"
        : "other_substitution_only";
  }
  if (b.some((e) => e.type === "jump_ball")) return "jump_ball";
  if (b.some((e) => e.type === "rebound")) return "player_rebound";
  if (b.some((e) => e.type === "field_goal" && e.shot_result === "made"))
    return "same_bucket_made_basket";
  return "other";
}
/** Label construction can see the outcome; buildState is the separate prefix projection. */
export function buildDataset(input: ReplayInput): DecisionDataset {
  validatePregame(input);
  const events = input.events
    .filter(
      (e) => e.game_id === input.game.gameId && e.validity === "effective",
    )
    .sort((a, b) => a.canonical_sequence - b.canonical_sequence);
  if (
    !events.length ||
    events.some(
      (e, i) =>
        !Number.isInteger(e.canonical_sequence) ||
        (i > 0 && e.canonical_sequence === events[i - 1].canonical_sequence) ||
        !Number.isInteger(e.period) ||
        e.period < 1 ||
        !Number.isInteger(e.clock_remaining_ms) ||
        e.clock_remaining_ms < 0 ||
        e.clock_remaining_ms > opening(e.period),
    )
  )
    throw Error("Invalid canonical event order or clock");
  const buckets: Row[][] = [];
  for (const e of events) {
    const b = buckets.at(-1);
    if (
      b &&
      b[0].period === e.period &&
      b[0].clock_remaining_ms === e.clock_remaining_ms
    )
      b.push(e);
    else buckets.push([e]);
  }
  const version = `${WINDOW_VERSION}:${input.release.sha256}`;
  const result: DecisionDataset = {
    celticsHome: input.game.homeTeamId === BOS,
    version,
    windowVersion: WINDOW_VERSION,
    release: input.release,
    gameId: input.game.gameId,
    inputHash: digest(input),
    windows: [],
    ledger: [],
    diagnostics: {
      candidates: 0,
      positiveCandidates: 0,
      celticsSubstitutionBuckets: 0,
      adjacencyBuckets: 0,
      unanchoredBuckets: 0,
    },
  };
  const candidates = new Set(
    buckets.flatMap((b, i) =>
      inPeriod(b) && b.some((e) => opener(e)) ? [i] : [],
    ),
  );
  const attached = new Map<number, number[]>();
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    if (!inPeriod(b) || !ownSubs(b).length) continue;
    result.diagnostics.celticsSubstitutionBuckets++;
    if (candidates.has(i)) continue;
    const previous = buckets[i - 1] ?? [],
      gap = previous[0]?.clock_remaining_ms - b[0].clock_remaining_ms;
    if (
      candidates.has(i - 1) &&
      previous[0].period === b[0].period &&
      gap > 0 &&
      gap <= 2000
    ) {
      attached.set(i - 1, [...(attached.get(i - 1) ?? []), i]);
      result.diagnostics.adjacencyBuckets++;
    } else {
      result.diagnostics.unanchoredBuckets++;
      for (const block of substitutionBlocks(b).filter(
        (b) => ownSubs(b).length,
      ))
        result.ledger.push({
          gameId: input.game.gameId,
          releaseManifestSha256: input.release.sha256,
          datasetVersion: version,
          span: span(block),
          reason: "unanchored_substitution",
          mechanism: mechanism(b, previous),
        });
    }
  }
  const common: string[] = [];
  for (const product of ["lineups", "stints", "normalization"])
    if (
      input.coverage.find(
        (c) => c.game_id === input.game.gameId && c.product === product,
      )?.quality_status !== "valid"
    )
      common.push(`invalid_${product}`);
  const summary = input.coverage.find(
    (c) => c.game_id === input.game.gameId && c.product === "summaries",
  );
  const issues = input.issues.filter((i) => i.game_id === input.game.gameId);
  const findings = issues.filter((i) => i.product === "summaries");
  const parsedFindings = findings.map((i) => {
    if (i.code !== "summary_field_limitations" || typeof i.message !== "string")
      return null;
    // Published format: view_name: statistic:status, statistic:status.
    // Parse the entire finding, not just the state fields we happen to know.
    const match = /^\s*[a-z][a-z0-9_]*:\s+(.+?)\s*$/.exec(i.message);
    if (!match) return null;
    const fields = match[1]
      .split(",")
      .map((item) => /^\s*([a-z][a-z0-9_]*):([a-z][a-z0-9_]*)\s*$/.exec(item));
    return fields.every((field) => field !== null)
      ? fields.map((field) => field![1])
      : null;
  });
  const namedDefects =
    parsedFindings.length > 0 &&
    parsedFindings.every((fields) => fields !== null);
  const affected = new Set(parsedFindings.flatMap((fields) => fields ?? []));
  const nullFields: BoxField[] =
    summary?.quality_status === "partial"
      ? BOX_FIELDS.filter((field) => affected.has(field))
      : [];
  if (
    summary?.quality_status !== "valid" &&
    !(summary?.quality_status === "partial" && namedDefects)
  )
    common.push("unqualified_summary");
  const stints = input.stints.filter((s) => s.game_id === input.game.gameId);
  // Qualification is label-side only: never expose a stint's future end or cumulative exit values.
  for (const team of [input.game.homeTeamId, input.game.awayTeamId]) {
    const ss = stints.filter((s) => s.team_id === team),
      end = events.at(-1)!;
    if (
      !ss.length ||
      ss.some(
        (s) =>
          s.quality_status !== "valid" ||
          ![
            s.duration_ms,
            s.period,
            s.start_clock_ms,
            s.end_clock_ms,
            s.start_sequence,
            s.end_sequence,
          ].every(Number.isFinite) ||
          s.duration_ms < 0 ||
          s.start_sequence > s.end_sequence,
      ) ||
      Math.abs(
        ss.reduce((n, s) => n + s.duration_ms, 0) -
          5 * elapsed(end.period, end.clock_remaining_ms),
      ) > 1
    )
      common.push("unreconciled_stints");
  }
  const finalize = (w: Window, rows: Row[]) => {
    w.exclusions.push(...common);
    if (
      rows.some(
        (e) =>
          e.quality_status !== "valid" ||
          e.order_repair_reason ||
          (e.ordering_status &&
            e.ordering_status !== "valid" &&
            e.ordering_status !== "resolved"),
      )
    )
      w.exclusions.push("unresolved_or_repaired_order");
    for (const issue of issues)
      if (
        ["lineups", "stints", "normalization"].includes(issue.product) &&
        (issue.severity === "error" ||
          /order|reconcil|unknown.*lineup|incomplete.*lineup/.test(
            issue.code,
          )) &&
        (issue.start_sequence == null || issue.start_sequence <= w.span[1]) &&
        (issue.end_sequence == null || issue.end_sequence >= w.span[0])
      )
        w.exclusions.push(`quality:${issue.code}`);
    if (w.state)
      for (const player of w.state.players) {
        const now = elapsed(w.state.period, w.state.clockMs);
        const expected =
          stints
            .filter((s) => s.team_id === BOS && s.player_id === player.playerId)
            .reduce(
              (sum, s) =>
                sum +
                Math.max(
                  0,
                  Math.min(now, elapsed(s.period, s.end_clock_ms)) -
                    elapsed(s.period, s.start_clock_ms),
                ),
              0,
            ) / 60000;
        if (
          !Number.isFinite(expected) ||
          Math.abs(expected - player.minutes) > 1e-8
        )
          w.exclusions.push("unreconciled_player_minutes");
        const entries = stints.filter(
          (s) =>
            s.team_id === BOS &&
            s.player_id === player.playerId &&
            s.start_sequence < w.sequence,
        );
        for (const entry of entries) {
          if (entry.personal_fouls_entry == null) continue;
          const foulCount = events.filter(
            (e) =>
              e.canonical_sequence < entry.start_sequence &&
              personalFoul(e) &&
              input.participants.some(
                (p) =>
                  p.event_id === e.event_id &&
                  p.player_id === player.playerId &&
                  p.role === "fouler",
              ),
          ).length;
          if (foulCount !== entry.personal_fouls_entry)
            w.exclusions.push("unreconciled_personal_fouls");
        }
      }
    if (w.state && w.actual)
      w.exclusions.push(
        ...validateAction(w.actual, w.state).reasons.map((r) => `actual:${r}`),
      );
    if (
      w.exclusions.some((r) =>
        [
          "multiple_whistles",
          "ambiguous_equal_clock_run",
          "multiple_celtics_blocks",
          "exit_reentry",
          "incomplete_opponent_batch",
          "unreconciled_substitution_batch",
          "interrupted_jump_ball_substitutions",
        ].includes(r),
      )
    )
      w.exclusions.push("ambiguous_stoppage");
    if (w.exclusions.includes("marker_after_decision")) w.state = null;
    w.exclusions = [...new Set(w.exclusions)].sort();
    for (const reason of w.exclusions)
      result.ledger.push({
        gameId: w.gameId,
        releaseManifestSha256: input.release.sha256,
        datasetVersion: version,
        span: w.span,
        reason,
        mechanism: w.kind,
      });
    result.windows.push(w);
  };
  for (const i of candidates) {
    const b = buckets[i],
      extra = (attached.get(i) ?? []).flatMap((j) => buckets[j]),
      rows = [...b, ...extra];
    const markers = b.filter((e) => opener(e)),
      marker = markers.find((e) => e.type === "jump_ball") ?? markers[0],
      retrospective = marker.type === "jump_ball";
    const snapshot = retrospective
        ? b.find((e) => e.type === "substitution" || e.type === "jump_ball")!
        : marker,
      cutoff = snapshot.canonical_sequence + (retrospective ? 0 : 1);
    const { state, reasons } = buildState(
      input,
      events,
      cutoff,
      b[0].period,
      b[0].clock_remaining_ms,
      opener(marker)!,
      snapshot,
      retrospective,
      nullFields,
    );
    const outcomeRows = retrospective
      ? rows.filter((e) => e.canonical_sequence >= cutoff)
      : rows;
    const blocks = substitutionBlocks(outcomeRows),
      own = blocks.filter((b) => ownSubs(b).length),
      actual = actionFor(own.flat(), input.participants);
    const w: Window = {
      id: `${input.game.gameId}:in:${b[0].canonical_sequence}`,
      gameId: input.game.gameId,
      releaseManifestSha256: input.release.sha256,
      datasetVersion: version,
      kind: "in_period",
      sequence: cutoff,
      span: span(rows),
      state,
      actual,
      exclusions: reasons,
      adjacentSubstitutionBuckets: attached.get(i)?.length ?? 0,
    };
    if (
      !retrospective &&
      ownSubs(b).some((e) => e.canonical_sequence < marker.canonical_sequence)
    )
      w.exclusions.push("marker_after_decision");
    if (
      retrospective &&
      snapshot.type === "substitution" &&
      b.some(
        (e) =>
          e.canonical_sequence >= cutoff &&
          e.canonical_sequence < marker.canonical_sequence &&
          e.type !== "substitution",
      )
    )
      w.exclusions.push("interrupted_jump_ball_substitutions");
    if (own.length > 1) w.exclusions.push("multiple_celtics_blocks");
    if (actual.players_in.some((p) => actual.players_out.includes(p)))
      w.exclusions.push("exit_reentry");
    // Offensive-foul + offensive-turnover is one whistle. Every other second opener is ambiguous.
    const independent = markers.filter(
      (e) =>
        !(
          e.type === "turnover" &&
          e.subtype === "offensive foul" &&
          markers.some((f) => f.type === "foul" && f.subtype === "offensive")
        ),
    );
    if (
      independent.length > 1 ||
      rows.some(
        (e) =>
          e.canonical_sequence > marker.canonical_sequence &&
          !markers.includes(e) &&
          ["foul", "violation", "ejection"].includes(e.type),
      )
    )
      w.exclusions.push("multiple_whistles");
    if (
      rows.some(
        (e) =>
          e.canonical_sequence > marker.canonical_sequence &&
          (e.type === "timeout" ||
            ["field_goal", "steal", "block"].includes(e.type) ||
            (e.type === "turnover" && !opener(e)) ||
            e.type === "jump_ball" ||
            (e.type === "rebound" &&
              !opener(e) &&
              input.participants.some(
                (p) => p.event_id === e.event_id && p.role === "rebounder",
              ))),
      )
    )
      w.exclusions.push("ambiguous_equal_clock_run");
    for (const block of blocks) {
      for (const team of new Set(block.map((e) => e.team_id))) {
        const a = actionFor(block, input.participants, team);
        const side = team === input.game.homeTeamId ? "home" : "away",
          before = block[0][`${side}_lineup_before`],
          after = block.at(-1)![`${side}_lineup_after`];
        if (
          !five(before) ||
          !five(after) ||
          a.players_out.some((p) => !before.includes(p)) ||
          a.players_in.some((p) => before.includes(p)) ||
          JSON.stringify(
            [
              ...before.filter((p) => !a.players_out.includes(p)),
              ...a.players_in,
            ].sort(),
          ) !== JSON.stringify([...after].sort())
        )
          w.exclusions.push("unreconciled_substitution_batch");
        if (
          !a.players_in.length ||
          a.players_in.length !== a.players_out.length ||
          new Set(a.players_in).size !== a.players_in.length ||
          new Set(a.players_out).size !== a.players_out.length
        )
          w.exclusions.push("incomplete_opponent_batch");
      }
    }
    finalize(w, rows);
    result.diagnostics.candidates++;
    if (own.length) result.diagnostics.positiveCandidates++;
  }
  // One transition per subsequent period. Opening-clock substitutions are part of this outcome.
  for (const b of buckets.filter(
    (b) => b[0].period > 1 && b.some((e) => e.type === "period_start"),
  )) {
    const first = b[0],
      prior = events
        .filter((e) => e.period === first.period - 1 && e.type === "period_end")
        .at(-1),
      start = b.find((e) => e.type === "period_start")!;
    const own = input.game.homeTeamId === BOS ? "home" : "away",
      next = b
        .filter((e) => e.type === "period_start" || e.type === "substitution")
        .at(-1)!;
    const built = prior
      ? buildState(
          input,
          events,
          first.canonical_sequence,
          first.period,
          opening(first.period),
          "between_periods",
          prior,
          false,
          nullFields,
        )
      : { state: null, reasons: ["missing_prior_period_end"] };
    const before = prior?.[`${own}_lineup_after`],
      after = next[`${own}_lineup_after`];
    const actual =
      five(before) && five(after)
        ? {
            players_out: before.filter((p) => !after.includes(p)).sort(),
            players_in: after.filter((p) => !before.includes(p)).sort(),
          }
        : null;
    finalize(
      {
        id: `${input.game.gameId}:period:${first.period}`,
        gameId: input.game.gameId,
        releaseManifestSha256: input.release.sha256,
        datasetVersion: version,
        kind: "between_periods",
        sequence: first.canonical_sequence,
        span: [
          prior?.canonical_sequence ?? start.canonical_sequence,
          b.at(-1)!.canonical_sequence,
        ],
        state: built.state,
        actual,
        exclusions: [
          ...built.reasons,
          ...(!actual ? ["unknown_boundary_lineup"] : []),
        ],
        adjacentSubstitutionBuckets: 0,
      },
      b,
    );
  }
  result.windows.sort(
    (a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id),
  );
  for (const w of result.windows)
    for (const sub of w.state?.history.substitutions ?? []) {
      const parent = result.windows.find(
        (p) =>
          p.kind === "in_period" &&
          sub.sequence >= p.span[0] &&
          sub.sequence <= p.span[1],
      );
      if (parent) sub.windowId = parent.id;
    }
  return result;
}
