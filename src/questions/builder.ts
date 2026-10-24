import { createHash } from "node:crypto";
import type { OddsAdapter } from "../data/adapters.js";
import type { Row } from "../data/contracts.js";
import type { Identities } from "../data/identity.js";
import type { ObjectRef } from "../data/store.js";
import { instant } from "../data/time.js";

const STATS = {
  player_points: "points",
  player_rebounds: "rebounds",
  player_assists: "assists",
} as const;
export type Stat = (typeof STATS)[keyof typeof STATS];
export type ExclusionStatus =
  "no_quotes" | "dfs_only" | "no_complete_sportsbook_pair";
const EXCLUSIONS: readonly string[] = [
  "no_quotes",
  "dfs_only",
  "no_complete_sportsbook_pair",
];
const statFor = (prop: string): Stat | undefined =>
  Object.hasOwn(STATS, prop) ? STATS[prop as keyof typeof STATS] : undefined;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const rowKey = (r: Row) =>
  JSON.stringify([
    r.espn_event_id,
    instant(r.requested_at),
    r.espn_player_id,
    r.prop_type,
  ]);
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error(message);
}

export interface QuestionGame {
  game_id: string;
  espn_event_id: string;
  scheduled_start: string;
}
export interface Player {
  id: string;
  name: string;
}
export interface QuestionProvenance {
  layer_manifest: ObjectRef;
  manifest_sha256: string;
  methodology: ObjectRef;
  methodology_sha256: string;
  consensus_object: ObjectRef;
  book_lines_object: ObjectRef;
  summary_object: ObjectRef;
  // Exact published fields, including both timestamps, contributors, dispersion,
  // identity inference, change flags, rejected pairs, method and update range.
  consensus_row: Row;
  // Accepted pairs at the published selected line; includes raw two-sided prices.
  contributing_pairs: Row[];
}
export interface QuestionRecord {
  question_id: string;
  game_id: string;
  player: Player;
  stat: Stat;
  selected_line: number;
  p_over: number;
  p_under: number;
  provenance: QuestionProvenance;
}
export interface QuestionExclusion {
  game_id: string;
  espn_player_id: string;
  player_name: string;
  stat: Stat;
  status: ExclusionStatus;
  requested_at: string;
  manifest_sha256: string;
  methodology_sha256: string;
  consensus_object: ObjectRef;
  consensus_row: Row;
}
export interface QuestionSet {
  schema_version: 1;
  game: QuestionGame;
  questions: QuestionRecord[];
  exclusions: QuestionExclusion[];
}
export interface AgentQuestion {
  question_id: string;
  player: Player;
  stat: Stat;
  line: number;
  p_over: number;
}
export interface QuestionLayer {
  manifest: ObjectRef;
  methodology: ObjectRef;
  consensus: ObjectRef;
  bookLines: ObjectRef;
  summaryRef: ObjectRef;
  rows: Row[];
  pairs: Row[];
  summary: Row;
  playerIds: Record<string, string>;
}

// I/O boundary: every object is read through the P1 hash-verifying release.
// This trusted loader is never an agent tool; its result contains full-season data.
export async function loadQuestionLayer(
  odds: OddsAdapter,
  identities: Identities,
): Promise<QuestionLayer> {
  const object = (suffix: string) => {
    const refs = [...odds.release.objects.values()].filter((r) =>
      r.key.endsWith(`/${suffix}`),
    );
    requireValue(
      refs.length === 1,
      `Expected one ${suffix} in consensus release`,
    );
    return refs[0];
  };
  const consensus = object("consensus.ndjson.gz"),
    methodology = object("methodology.json"),
    bookLines = object("book-lines.ndjson.gz"),
    summaryRef = object("summary.json");
  const rows = await odds.auditRows();
  const pairs = await odds.release.rows(bookLines.key);
  const summary = JSON.parse(
    (await odds.release.bytes(summaryRef.key)).toString(),
  );
  const playerIds: Record<string, string> = {};
  for (const row of rows)
    if (statFor(row.prop_type))
      playerIds[row.espn_player_id] = identities.resolve(
        "player",
        "espn",
        row.espn_player_id,
      );
  const layer = {
    manifest: odds.release.root,
    methodology,
    consensus,
    bookLines,
    summaryRef,
    rows,
    pairs,
    summary,
    playerIds,
  };
  validateLayerSummary(layer);
  return freeze(structuredClone(layer));
}

// Published summary has aggregate counts, not per-game counts. Compare every
// published count relevant to construction, and separately expose per-game counts.
export function validateLayerSummary(layer: QuestionLayer): void {
  const s = layer.summary,
    rows = layer.rows;
  const count = (predicate: (r: Row) => boolean) =>
    rows.filter(predicate).length;
  const expect = (actual: number, expected: unknown, label: string) =>
    requireValue(
      Number.isInteger(expected) && actual === expected,
      `Consensus summary mismatch: ${label}`,
    );
  expect(rows.length, s.rows, "rows");
  expect(new Set(rows.map((r) => r.espn_event_id)).size, s.games, "games");
  expect(
    count((r) => r.status === "ok"),
    s.usableQuotes,
    "usableQuotes",
  );
  for (const status of new Set([
    ...rows.map((r) => r.status),
    ...Object.keys(s.statusCounts ?? {}),
  ]))
    expect(
      count((r) => r.status === status),
      s.statusCounts?.[status] ?? 0,
      `status ${status}`,
    );
  for (const kind of new Set([
    ...rows.filter((r) => r.status === "ok").map((r) => r.snapshot_kind),
    ...Object.keys(s.usableBySnapshotKind ?? {}),
  ]))
    expect(
      count((r) => r.status === "ok" && r.snapshot_kind === kind),
      s.usableBySnapshotKind?.[kind] ?? 0,
      `snapshot ${kind}`,
    );
  for (const prop of new Set([
    ...rows.filter((r) => r.status === "ok").map((r) => r.prop_type),
    ...Object.keys(s.usableByProp ?? {}),
  ]))
    expect(
      count((r) => r.status === "ok" && r.prop_type === prop),
      s.usableByProp?.[prop] ?? 0,
      `prop ${prop}`,
    );
}

/** Pure, deterministic construction. No consensus recomputation or source writes. */
export function buildQuestionSet(
  game: QuestionGame,
  layer: QuestionLayer,
): QuestionSet {
  requireValue(
    game.game_id && game.espn_event_id,
    "Game requires canonical and ESPN IDs",
  );
  const cutoff = instant(game.scheduled_start);
  for (const ref of [
    layer.manifest,
    layer.methodology,
    layer.consensus,
    layer.bookLines,
    layer.summaryRef,
  ])
    requireValue(
      /^[a-f0-9]{64}$/.test(ref.sha256),
      "Missing pinned source hash",
    );
  const rows = layer.rows.filter(
    (r) =>
      r.espn_event_id === game.espn_event_id &&
      r.snapshot_kind === "scheduled_start" &&
      statFor(r.prop_type),
  );
  requireValue(rows.length > 0, `No cutoff rows for game ${game.game_id}`);
  const questions: QuestionRecord[] = [],
    exclusions: QuestionExclusion[] = [],
    seen = new Set<string>(),
    canonicalSeen = new Set<string>();
  for (const row of [...rows].sort((a, b) => compare(rowKey(a), rowKey(b)))) {
    requireValue(
      instant(row.requested_at) === cutoff &&
        instant(row.scheduled_start) === cutoff,
      `Cutoff mismatch for ${game.game_id}`,
    );
    const key = rowKey(row),
      stat = statFor(row.prop_type)!;
    requireValue(!seen.has(key), `Duplicate cutoff row: ${key}`);
    seen.add(key);
    requireValue(
      typeof row.espn_player_id === "string" &&
        row.espn_player_id.length > 0 &&
        typeof row.player_name === "string" &&
        row.player_name.length > 0,
      "Missing player identity",
    );
    if (row.status !== "ok") {
      requireValue(
        EXCLUSIONS.includes(row.status),
        `Unknown consensus status: ${row.status}`,
      );
      exclusions.push({
        game_id: game.game_id,
        espn_player_id: row.espn_player_id,
        player_name: row.player_name,
        stat,
        status: row.status,
        requested_at: cutoff,
        manifest_sha256: layer.manifest.sha256,
        methodology_sha256: layer.methodology.sha256,
        consensus_object: layer.consensus,
        consensus_row: row,
      });
      continue;
    }
    requireValue(
      Number.isFinite(row.selected_line),
      `Invalid selected line: ${key}`,
    );
    requireValue(
      [row.p_over, row.p_under].every(
        (p) => typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1,
      ) && Math.abs(row.p_over + row.p_under - 1) <= 1e-9,
      `Invalid complementary probabilities: ${key}`,
    );
    const playerId = layer.playerIds[row.espn_player_id];
    requireValue(
      typeof playerId === "string" && playerId.length > 0,
      `Unmapped ESPN player: ${row.espn_player_id}`,
    );
    const canonicalKey = JSON.stringify([playerId, stat]);
    requireValue(
      !canonicalSeen.has(canonicalKey),
      `Duplicate canonical player/stat: ${canonicalKey}`,
    );
    canonicalSeen.add(canonicalKey);
    requireValue(
      Array.isArray(row.contributing_books) &&
        row.contributing_books.length > 0 &&
        new Set(row.contributing_books).size ===
          row.contributing_books.length &&
        row.contributing_book_count === row.contributing_books.length,
      `Invalid contributor list: ${key}`,
    );
    const contributing = layer.pairs.filter(
      (p) =>
        p.espn_event_id === row.espn_event_id &&
        p.espn_player_id === row.espn_player_id &&
        p.prop_type === row.prop_type &&
        instant(p.requested_at) === cutoff &&
        p.line === row.selected_line,
    );
    requireValue(
      contributing.length === row.contributing_book_count &&
        new Set(contributing.map((p) => p.bookmaker)).size ===
          contributing.length &&
        contributing.every(
          (p) =>
            row.contributing_books.includes(p.bookmaker) &&
            p.contributes_to_consensus === true &&
            Number.isFinite(p.over_price) &&
            p.over_price !== 0 &&
            Number.isFinite(p.under_price) &&
            p.under_price !== 0,
        ),
      `Missing or conflicting contributor evidence: ${key}`,
    );
    const question_id = `q1_${hash([layer.manifest.sha256, layer.methodology.sha256, game.game_id, game.espn_event_id, cutoff, playerId, stat, row.selected_line])}`;
    questions.push({
      question_id,
      game_id: game.game_id,
      player: { id: playerId, name: row.player_name },
      stat,
      selected_line: row.selected_line,
      p_over: row.p_over,
      p_under: row.p_under,
      provenance: {
        layer_manifest: layer.manifest,
        manifest_sha256: layer.manifest.sha256,
        methodology: layer.methodology,
        methodology_sha256: layer.methodology.sha256,
        consensus_object: layer.consensus,
        book_lines_object: layer.bookLines,
        summary_object: layer.summaryRef,
        consensus_row: row,
        contributing_pairs: [...contributing].sort((a, b) =>
          compare(a.bookmaker, b.bookmaker),
        ),
      },
    });
  }
  return freeze(
    structuredClone({
      schema_version: 1,
      game: { ...game, scheduled_start: cutoff },
      questions,
      exclusions,
    }),
  );
}

// Explicit allowlist. Never spread an environment record into the agent view.
export function agentQuestion(question: QuestionRecord): AgentQuestion {
  return freeze({
    question_id: question.question_id,
    player: { id: question.player.id, name: question.player.name },
    stat: question.stat,
    line: question.selected_line,
    p_over: question.p_over,
  });
}
