import {
  BOS,
  BOX_FIELDS,
  STATE_VERSION,
  type BoxField,
  type ObservableState,
  type ReplayInput,
  type Substitution,
} from "./types.js";
import type { Row } from "../data/contracts.js";
export const elapsed = (period: number, clock: number) =>
  (period <= 4 ? (period - 1) * 720000 : 2880000 + (period - 5) * 300000) +
  (period <= 4 ? 720000 : 300000) -
  clock;
export const five = (v: unknown): v is string[] =>
  Array.isArray(v) &&
  v.length === 5 &&
  v.every((p) => typeof p === "string") &&
  new Set(v).size === 5;
export const personalFoul = (e: Row) =>
  e.type === "foul" &&
  !/technical|defensive 3 second|delay of game/i.test(
    [e.subtype, e.foul_type, e.description].join(" "),
  );
export function validatePregame(input: ReplayInput): void {
  const p = input.pregame,
    cutoff = Date.parse(input.game.scheduledStart);
  if (
    p.gameId !== input.game.gameId ||
    p.scheduledStart !== input.game.scheduledStart ||
    !Number.isFinite(cutoff)
  )
    throw Error("Pregame/game mismatch");
  const dates = [
    ...p.roster.map((r) => r.availableAt),
    p.injuryReport.availableAt,
    ...(p.announcedStarters ? [p.announcedStarters.availableAt] : []),
  ];
  if (
    dates.some(
      (d) => !Number.isFinite(Date.parse(d)) || Date.parse(d) >= cutoff,
    )
  )
    throw Error("Pregame evidence must be strictly before scheduled start");
  if (
    p.roster.length < 5 ||
    new Set(p.roster.map((r) => r.playerId)).size !== p.roster.length
  )
    throw Error("Invalid frozen roster");
  if (
    p.injuryReport.players.some(
      (r) => !p.roster.some((p) => p.playerId === r.playerId),
    )
  )
    throw Error("Injury identity absent from roster");
  if (
    p.announcedStarters &&
    (!five(p.announcedStarters.players) ||
      p.announcedStarters.players.some(
        (id) => !p.roster.some((r) => r.playerId === id),
      ))
  )
    throw Error("Invalid announced starters");
}
export function substitutionBlocks(events: Row[]): Row[][] {
  const result: Row[][] = [];
  for (const e of events) {
    const last = result.at(-1);
    if (e.type !== "substitution") continue;
    if (
      last &&
      last.at(-1)!.canonical_sequence + 1 === e.canonical_sequence &&
      last[0].period === e.period &&
      last[0].clock_remaining_ms === e.clock_remaining_ms
    )
      last.push(e);
    else result.push([e]);
  }
  return result;
}
export function actionFor(block: Row[], participants: Row[], teamId = BOS) {
  const ids = new Set(
    block.filter((e) => e.team_id === teamId).map((e) => e.event_id),
  );
  return {
    players_out: participants
      .filter((p) => ids.has(p.event_id) && p.role === "sub_out")
      .map((p) => p.player_id)
      .sort(),
    players_in: participants
      .filter((p) => ids.has(p.event_id) && p.role === "sub_in")
      .map((p) => p.player_id)
      .sort(),
  };
}
/** Projection boundary: no spread of source rows, current outcome, final box, or later event. */
export function buildState(
  input: ReplayInput,
  events: Row[],
  cutoff: number,
  period: number,
  clockMs: number,
  kind: string,
  snapshot: Row,
  before: boolean,
  nullFields: BoxField[],
): { state: ObservableState | null; reasons: string[] } {
  const home = input.game.homeTeamId === BOS,
    own = home ? "home" : "away",
    other = home ? "away" : "home";
  const suffix = before ? "before" : "after",
    celtics = snapshot[`${own}_lineup_${suffix}`],
    opponent = snapshot[`${other}_lineup_${suffix}`];
  const reasons: string[] = [];
  if (!five(celtics) || !five(opponent))
    return { state: null, reasons: ["unknown_lineup"] };
  const homeScore = snapshot[`home_score_${suffix}`],
    awayScore = snapshot[`away_score_${suffix}`];
  if (!Number.isInteger(homeScore) || !Number.isInteger(awayScore))
    return { state: null, reasons: ["unknown_score"] };
  const roster = input.pregame.roster.map((r) => r.playerId).sort();
  if (celtics.some((p) => !roster.includes(p)))
    return { state: null, reasons: ["lineup_outside_frozen_roster"] };
  const prefix = events.filter((e) => e.canonical_sequence < cutoff);
  const parts = new Map<string, Row[]>();
  for (const p of input.participants) {
    const a = parts.get(p.event_id) ?? [];
    a.push(p);
    parts.set(p.event_id, a);
  }
  const minutes = new Map(roster.map((id) => [id, 0])),
    stintStart = new Map<string, number>(),
    lastExit = new Map<string, number>();
  const fouls = new Map(roster.map((id) => [id, 0])),
    ejected = new Set<string>();
  const boxes = new Map(
    roster.map((id) => [
      id,
      Object.fromEntries(BOX_FIELDS.map((k) => [k, 0])) as Record<
        BoxField,
        number | null
      >,
    ]),
  );
  const history: Substitution[] = [],
    timeouts: ObservableState["history"]["timeouts"] = [];
  let floor: string[] = [],
    lastTime = 0;
  const integrate = (t: number) => {
    if (t < lastTime) {
      reasons.push("nonmonotone_clock");
      return;
    }
    for (const id of floor)
      if (minutes.has(id)) minutes.set(id, minutes.get(id)! + t - lastTime);
    lastTime = t;
  };
  const setFloor = (next: unknown, t: number, reset = false) => {
    if (!five(next)) {
      reasons.push("unknown_prefix_lineup");
      return;
    }
    for (const id of floor)
      if (!next.includes(id)) {
        lastExit.set(id, t);
        stintStart.delete(id);
      }
    for (const id of next)
      if (reset || !floor.includes(id)) stintStart.set(id, t);
    floor = [...next];
  };
  const blocks = substitutionBlocks(events),
    ends = new Map(blocks.map((b) => [b.at(-1)!.canonical_sequence, b]));
  const add = (e: Row, role: string, key: BoxField, value: number) => {
    for (const id of new Set(
      (parts.get(e.event_id) ?? [])
        .filter((p) => p.role === role && p.team_id === BOS)
        .map((p) => p.player_id),
    )) {
      const box = boxes.get(id);
      if (box) box[key] = (box[key] ?? 0) + value;
    }
  };
  for (const e of prefix) {
    const t = elapsed(e.period, e.clock_remaining_ms);
    integrate(t);
    if (e.type === "period_start") {
      setFloor(e[`${own}_lineup_after`], t, true);
    } else if (e.type === "substitution" && ends.has(e.canonical_sequence)) {
      const block = ends.get(e.canonical_sequence)!;
      setFloor(e[`${own}_lineup_after`], t);
      for (const teamId of new Set(block.map((e) => e.team_id))) {
        const a = actionFor(block, input.participants, teamId);
        history.push({
          ...a,
          teamId,
          sequence: block[0].canonical_sequence,
          period: e.period,
          clockMs: e.clock_remaining_ms,
          windowId: `${input.game.gameId}:sub:${block[0].canonical_sequence}`,
        });
      }
    }
    if (e.type === "timeout")
      timeouts.push({
        sequence: e.canonical_sequence,
        teamId: e.team_id ?? null,
      });
    if (personalFoul(e))
      for (const p of parts.get(e.event_id) ?? [])
        if (p.role === "fouler" && fouls.has(p.player_id))
          fouls.set(p.player_id, fouls.get(p.player_id)! + 1);
    if (e.type === "ejection")
      for (const p of parts.get(e.event_id) ?? [])
        if (p.team_id === BOS) ejected.add(p.player_id);
    if (e.type === "field_goal") {
      add(e, "shooter", "field_goals_attempted", 1);
      if (e.shot_value === 3) add(e, "shooter", "three_pointers_attempted", 1);
      if (e.shot_result === "made") {
        add(e, "shooter", "field_goals_made", 1);
        if (e.shot_value === 3) add(e, "shooter", "three_pointers_made", 1);
        add(e, "shooter", "points", e.points_credited ?? e.shot_value);
        add(e, "assister", "assists", 1);
      }
    }
    if (e.type === "free_throw") {
      add(e, "shooter", "free_throws_attempted", 1);
      if (e.shot_result === "made") {
        add(e, "shooter", "free_throws_made", 1);
        add(e, "shooter", "points", 1);
      }
    }
    if (e.type === "rebound") {
      add(e, "rebounder", "rebounds", 1);
      if (e.rebound_type === "offensive" || e.rebound_type === "defensive")
        add(e, "rebounder", `${e.rebound_type}_rebounds` as BoxField, 1);
    }
    if (e.type === "steal") add(e, "stealer", "steals", 1);
    if (e.type === "block") add(e, "blocker", "blocks", 1);
    if (e.type === "turnover") add(e, "turnover_player", "turnovers", 1);
  }
  // Opening-clock rows belong to the net boundary action, not a second history entry.
  for (const start of prefix.filter(
    (e) => e.type === "period_start" && e.period > 1,
  )) {
    const previous = prefix
      .filter((e) => e.type === "period_end" && e.period === start.period - 1)
      .at(-1);
    const openingRows = prefix.filter(
      (e) =>
        e.period === start.period &&
        e.clock_remaining_ms === start.clock_remaining_ms &&
        (e.type === "period_start" || e.type === "substitution"),
    );
    const last = openingRows.at(-1)!;
    for (let i = history.length - 1; i >= 0; i--)
      if (
        history[i].period === start.period &&
        history[i].clockMs === start.clock_remaining_ms
      )
        history.splice(i, 1);
    if (previous)
      for (const [side, teamId] of [
        ["home", input.game.homeTeamId],
        ["away", input.game.awayTeamId],
      ]) {
        const a = previous[`${side}_lineup_after`],
          b = last[`${side}_lineup_after`];
        if (five(a) && five(b) && a.some((id) => !b.includes(id)))
          history.push({
            windowId: `${input.game.gameId}:period:${start.period}`,
            sequence: start.canonical_sequence,
            period: start.period,
            clockMs: start.clock_remaining_ms,
            teamId,
            players_out: a.filter((id) => !b.includes(id)).sort(),
            players_in: b.filter((id) => !a.includes(id)).sort(),
          });
      }
  }
  history.sort(
    (a, b) => a.sequence - b.sequence || a.teamId.localeCompare(b.teamId),
  );
  // At a between-period decision the five remains the prior period's five;
  // elapsed game time includes neither the break nor the next period's action.
  const now = elapsed(period, clockMs);
  integrate(now);
  if (!floor.length) reasons.push("missing_initial_lineup");
  if (floor.length && [...floor].sort().join() !== [...celtics].sort().join())
    reasons.push("prefix_lineup_mismatch");
  for (const b of blocks)
    if (
      b[0].canonical_sequence < cutoff &&
      b.at(-1)!.canonical_sequence >= cutoff
    )
      reasons.push("incomplete_opponent_batch");
  const injury = input.pregame.injuryReport;
  const out = new Set(
    injury.state === "listed"
      ? injury.players
          .filter((p) => p.status.toLowerCase() === "out")
          .map((p) => p.playerId)
      : [],
  );
  const flags = [
    ...(injury.state === "unknown" ? ["availability_unknown"] : []),
    ...(nullFields.length ? ["unqualified_running_box_score"] : []),
  ];
  const last = prefix.at(-1);
  const ftMatch =
    last?.type === "foul"
      ? /\((?:[^()]*)\b(\d) FT\)/.exec(last.description ?? "")
      : null;
  const pending = ftMatch
    ? true
    : last?.type === "free_throw" &&
        typeof last.free_throw_number === "number" &&
        typeof last.free_throw_total === "number"
      ? last.free_throw_number < last.free_throw_total
      : null;
  const state: ObservableState = {
    version: STATE_VERSION,
    gameId: input.game.gameId,
    sequence: cutoff,
    period,
    periodType: period <= 4 ? "regulation" : "overtime",
    clockMs,
    homeScore,
    awayScore,
    margin: home ? homeScore - awayScore : awayScore - homeScore,
    stoppage: {
      kind,
      timeoutTeam:
        kind !== "jump_ball" && last?.type === "timeout"
          ? (last.team_id ?? null)
          : null,
      freeThrowsPending: kind === "jump_ball" ? null : pending,
    },
    celtics: [...celtics].sort(),
    opponent: [...opponent].sort(),
    eligibleBench: roster.filter(
      (p) =>
        !celtics.includes(p) &&
        !out.has(p) &&
        !ejected.has(p) &&
        (fouls.get(p) ?? 0) < 6,
    ),
    players: roster.map((playerId) => {
      const box = { ...boxes.get(playerId)! };
      for (const k of nullFields) box[k] = null;
      return {
        playerId,
        minutes: minutes.get(playerId)! / 60000,
        currentStintMinutes: celtics.includes(playerId)
          ? (now - (stintStart.get(playerId) ?? now)) / 60000
          : 0,
        restMs: celtics.includes(playerId)
          ? 0
          : lastExit.has(playerId)
            ? now - lastExit.get(playerId)!
            : null,
        personalFouls: fouls.get(playerId)!,
        box,
      };
    }),
    history: { substitutions: history, timeouts },
    pregame: {
      injuryState: injury.state,
      injuries: injury.players.map((p) => ({
        playerId: p.playerId,
        status: p.status,
      })),
      announcedStarters: input.pregame.announcedStarters
        ? [...input.pregame.announcedStarters.players]
        : null,
    },
    flags,
  };
  return { state, reasons: [...new Set(reasons)] };
}
