import { ExclusionLog } from "./exclusions.js";
import { Temporal } from "@js-temporal/polyfill";
import type {
  Convention,
  Exclusion,
  RecordEnvelope,
  Row,
} from "./contracts.js";
import { STATIC_AT } from "./contracts.js";
import type { ObjectRef, VerifiedStore } from "./store.js";
import { Release, jsonLines } from "./release.js";
import {
  instant,
  laterEasternReading,
  nextMorning,
  easternDayEnd,
} from "./time.js";

export const pick = (row: Row, fields: string[]): Row =>
  Object.fromEntries(
    fields
      .filter((key) => row[key] !== undefined)
      .map((key) => [key, row[key]]),
  );
const timestamp = (value: unknown): string | null =>
  value == null
    ? null
    : instant(value instanceof Date ? value.toISOString() : value);
function envelope(
  source: string,
  id: string,
  data: Row,
  ref: ObjectRef,
  manifestSha256: string,
  at: string,
  convention: Convention,
  times: { event?: unknown; collected?: unknown; revision?: unknown } = {},
): RecordEnvelope {
  if (!id) throw Error(`Missing record identity: ${source}`);
  return {
    id,
    source,
    availableAt: instant(at),
    availabilityConvention: convention,
    eventTime: timestamp(times.event),
    collectedAt: timestamp(times.collected),
    revisionTime: timestamp(times.revision),
    provenance: { object: ref, manifestSha256 },
    data,
  };
}
export class OddsAdapter {
  constructor(readonly release: Release) {}
  async auditRows(): Promise<Row[]> {
    const key = [...this.release.objects.keys()].find((k) =>
      k.endsWith("/consensus.ndjson.gz"),
    );
    if (!key) throw Error("Consensus object missing");
    // A changed methodology is a distinct data-source/de-vig version even if rows match.
    await this.release.bytes(
      key.replace("consensus.ndjson.gz", "methodology.json"),
    );
    return this.release.rows(key);
  }
  async records(): Promise<RecordEnvelope[]> {
    const key = [...this.release.objects.keys()].find((k) =>
      k.endsWith("/consensus.ndjson.gz"),
    )!;
    return (await this.auditRows())
      .filter((r) => r.status === "ok")
      .map((row) =>
        envelope(
          "odds",
          [
            row.espn_event_id,
            row.requested_at,
            row.espn_player_id,
            row.prop_type,
          ].join(":"),
          pick(row, [
            "espn_event_id",
            "espn_player_id",
            "prop_type",
            "selected_line",
            "p_over",
          ]),
          this.release.ref(key),
          this.release.root.sha256,
          row.requested_at,
          "odds_requested_at",
          { event: row.scheduled_start },
        ),
      );
  }
  version() {
    const methodology = [...this.release.objects.values()].find((r) =>
      r.key.endsWith("/methodology.json"),
    );
    if (!methodology) throw Error("Methodology missing");
    return {
      name: "odds",
      manifest: this.release.root,
      methodologySha256: methodology.sha256,
    };
  }
}
const PRODUCTS: Record<string, string> = {
  events: "normalization",
  event_participants: "normalization",
  game_periods: "normalization",
  game_players: "normalization",
  player_box_scores: "normalization",
  team_box_scores: "normalization",
  team_period_scores: "normalization",
  v_events_enriched: "normalization",
  lineup_states: "lineups",
  v_team_lineup_stints: "stints",
  v_player_stints: "stints",
  v_matchup_stints: "stints",
  matchup_stint_bridges: "stints",
  v_player_game_summary: "summaries",
  v_team_game_summary: "summaries",
  raw_possessions: "possessions",
  v_possessions: "possessions",
  possession_event_ownership: "possessions",
  v_possession_matchup_segments: "possessions",
};
export class PlayByPlayAdapter {
  private cachedGames?: RecordEnvelope[];
  private cachedCoverage?: Row[];
  private cachedGameIndex?: Row;
  private exclusionLog = new ExclusionLog();
  get exclusions(): Exclusion[] {
    return this.exclusionLog.values();
  }
  constructor(readonly release: Release) {}
  async games(): Promise<RecordEnvelope[]> {
    this.cachedGames ??= (
      await this.release.table("games", "regular_season")
    ).map(({ row, ref }) =>
      envelope(
        "schedule",
        row.game_id,
        pick(row, [
          "game_id",
          "season",
          "phase",
          "home_team_id",
          "away_team_id",
          "scheduled_tipoff",
          "venue",
          "neutral_site",
          // Trusted resolution metadata. P3's public schedule projection omits
          // status; history and resolution expose it only after game release.
          "status",
        ]),
        ref,
        this.release.root.sha256,
        STATIC_AT,
        "schedule_static",
        { event: row.scheduled_tipoff },
      ),
    );
    return structuredClone(this.cachedGames);
  }
  async coverage(): Promise<Row[]> {
    this.cachedCoverage ??= jsonLines(
      await this.release.bytes(
        this.release.manifest.object_prefix + "coverage.jsonl",
      ),
    );
    return structuredClone(this.cachedCoverage);
  }
  /** Export a table in partition order, decoding each verified object only once. */
  async *exportRecords(table: string, games: RecordEnvelope[]) {
    if (!games.length) return;
    if (!PRODUCTS[table]) throw Error(`Table is not replay evidence: ${table}`);
    if (!this.cachedCoverage) await this.coverage();
    const allowed = new Map(games.map((game) => [game.id, game]));
    const releases = new Map(
      games.map((game) => [
        game.id,
        nextMorning(
          Temporal.Instant.from(timestamp(game.data.scheduled_tipoff)!)
            .toZonedDateTimeISO("America/New_York")
            .toPlainDate()
            .toString(),
        ),
      ]),
    );
    const rowsByGame = new Map<string, RecordEnvelope[]>();
    const reasons = new Map<string, string>();
    for (const game of games) {
      const coverage = this.cachedCoverage!.find(
        (r) => r.game_id === game.id && r.product === PRODUCTS[table],
      );
      if (coverage?.quality_status !== "valid") {
        reasons.set(
          game.id,
          coverage?.missing_reason ?? `Product ${PRODUCTS[table]} is not valid`,
        );
        allowed.delete(game.id);
      }
    }
    const m = this.release.manifest;
    this.cachedGameIndex ??= JSON.parse(
      (await this.release.bytes(m.object_prefix + m.game_index)).toString(),
    );
    const index = this.cachedGameIndex!.tables[table] ?? {};
    for (const name of Object.keys(index))
      if (!m.tables[table].includes(name))
        throw Error("Game index references an unlisted table file");
    for (const name of m.tables[table] as string[]) {
      if (
        !index[name]?.some((entry: unknown[]) =>
          allowed.has(entry[0] as string),
        )
      )
        continue;
      const key = m.object_prefix + name;
      for (const [i, row] of (await this.release.rows(key)).entries()) {
        const game = allowed.get(row.game_id);
        if (!game) continue;
        const records = rowsByGame.get(game.id) ?? [];
        records.push(
          envelope(
            table,
            `${game.id}:${name}:${i}`,
            row,
            this.release.ref(key),
            this.release.root.sha256,
            releases.get(game.id)!,
            "game_next_morning_eastern",
            {
              event: row.event_time,
              collected: row.retrieved_at,
              revision: row.source_updated_at,
            },
          ),
        );
        rowsByGame.set(game.id, records);
      }
      // Published files contain whole games. Yield at the partition boundary so
      // the exporter retains only one decoded partition, not the whole season.
      for (const [gameId, records] of rowsByGame)
        yield { gameId, records, reason: null };
      rowsByGame.clear();
    }
    for (const [gameId, reason] of reasons)
      yield { gameId, records: [], reason };
  }
  async records(table: string, gameId: string): Promise<RecordEnvelope[]> {
    const product = PRODUCTS[table];
    if (!product) throw Error(`Table is not replay evidence: ${table}`);
    // Public accessors return defensive copies; internal lookups can reuse the
    // trusted snapshots instead of cloning the full season for every game.
    if (!this.cachedGames) await this.games();
    const game = this.cachedGames!.find((r) => r.id === gameId);
    if (!game) throw Error(`Not a regular-season game: ${gameId}`);
    if (!this.cachedCoverage) await this.coverage();
    const coverage = this.cachedCoverage!.find(
      (r) => r.game_id === gameId && r.product === product,
    );
    if (coverage?.quality_status !== "valid") {
      this.exclusionLog.add({
        source: table,
        id: gameId,
        reason: coverage?.missing_reason ?? `Product ${product} is not valid`,
      });
      return [];
    }
    const m = this.release.manifest;
    this.cachedGameIndex ??= JSON.parse(
      (await this.release.bytes(m.object_prefix + m.game_index)).toString(),
    );
    const index = this.cachedGameIndex!;
    const files = index.tables[table] ?? {};
    for (const name of Object.keys(files))
      if (!m.tables[table].includes(name))
        throw Error("Game index references an unlisted table file");
    const date = Temporal.Instant.from(timestamp(game.data.scheduled_tipoff)!)
      .toZonedDateTimeISO("America/New_York")
      .toPlainDate()
      .toString();
    const result: RecordEnvelope[] = [];
    for (const name of m.tables[table] as string[]) {
      if (!files[name]?.some((entry: unknown[]) => entry[0] === gameId))
        continue;
      const key = m.object_prefix + name;
      for (const [i, row] of (await this.release.rows(key)).entries()) {
        if (row.game_id !== gameId) continue;
        result.push(
          envelope(
            table,
            `${gameId}:${name}:${i}`,
            row,
            this.release.ref(key),
            this.release.root.sha256,
            nextMorning(date),
            "game_next_morning_eastern",
            {
              event: row.event_time,
              collected: row.retrieved_at,
              revision: row.source_updated_at,
            },
          ),
        );
      }
    }
    return result;
  }
}
export function injuryObservation(
  row: Row,
  ref: ObjectRef,
  manifestSha256: string,
): RecordEnvelope | null {
  if (
    row.phase !== "regular_season" ||
    !row.game_id ||
    (row.game_link_status && row.game_link_status !== "matched")
  )
    return null;
  // The brief models availability from the printed time, not the source
  // available_at / availability_basis (which describe unverified delivery).
  const ambiguous =
    row.report_timestamp_utc == null && row.timestamp_ambiguous === true;
  const at = ambiguous
    ? laterEasternReading(
        row.report_timestamp_et.replace(/(?:Z|[+-]\d\d:\d\d)$/, ""),
      )
    : timestamp(row.report_timestamp_utc);
  if (!at)
    throw Error(`Injury report has no usable timestamp: ${row.record_id}`);
  // Deliberate allowlist: retrospective interpretations and evidence cannot leak.
  const data = pick(row, [
    "record_id",
    "game_id",
    "team_id",
    "player_name",
    "status",
    "reason",
    "observed_state",
    "player_count",
    "report_timestamp_et",
    "pdf_sha256",
    "raw_pdf_key",
    "raw_key",
    "page",
    "row_number",
  ]);
  return envelope(
    "injuries",
    row.record_id,
    data,
    ref,
    manifestSha256,
    at,
    ambiguous ? "injury_dst_later_reading" : "injury_printed_report",
  );
}
export class InjuryAdapter {
  private exclusionLog = new ExclusionLog();
  get exclusions(): Exclusion[] {
    return this.exclusionLog.values();
  }
  constructor(readonly release: Release) {}
  async *partitions(
    kind: "teams" | "players" = "teams",
  ): AsyncGenerator<RecordEnvelope[]> {
    for (const part of this.release.manifest[
      kind === "teams" ? "team_snapshot_partitions" : "partitions"
    ]) {
      const ref = this.release.ref(part.key),
        records: RecordEnvelope[] = [];
      for (const row of await this.release.rows(part.key)) {
        const record = injuryObservation(row, ref, this.release.root.sha256);
        if (record) records.push(record);
        else
          this.exclusionLog.add(
            {
              source: "injuries",
              id: row.record_id,
              reason: "Unmatched or non-regular-season observation",
            },
            kind,
          );
      }
      yield records;
    }
  }
}
const PLAYER_TABLES = [
  "player_profiles",
  "player_reference",
  "player_season_stats",
  "player_2024_25_summary",
  "player_career_summary",
  "player_identity_exceptions",
];
export class PlayerReferenceAdapter {
  constructor(readonly release: Release) {}
  async records(table = "player_profiles"): Promise<RecordEnvelope[]> {
    if (!PLAYER_TABLES.includes(table))
      throw Error("Only published player-reference tables are accessible");
    return (await this.release.table(table)).map(({ row, ref }, i) =>
      envelope(
        "player-reference",
        `${table}:${row.player_id}:${i}`,
        row,
        ref,
        this.release.root.sha256,
        STATIC_AT,
        "opening_reference_static",
      ),
    );
  }
  async coverage(): Promise<Row> {
    return JSON.parse(
      (
        await this.release.bytes(this.release.manifest.coverage_report)
      ).toString(),
    );
  }
}
export function postAvailability(post: Row): string | null {
  if (post.versionPublishedAt) return instant(post.versionPublishedAt);
  if (
    post.versionId === `x:${post.postId}` &&
    post.editHistoryIds?.[0] === post.postId
  )
    return instant(post.publishedAt);
  return null;
}
export class BeatPostsAdapter {
  private exclusionLog = new ExclusionLog();
  get exclusions(): Exclusion[] {
    return this.exclusionLog.values();
  }
  constructor(readonly release: Release) {}
  async auditRows(): Promise<Row[]> {
    return this.release.rows(this.release.manifest.rows.objectKey);
  }
  async records(): Promise<RecordEnvelope[]> {
    const result: RecordEnvelope[] = [],
      ref = this.release.ref(this.release.manifest.rows.objectKey);
    for (const row of await this.auditRows()) {
      const post = row.post,
        id = [post.accountId, post.postId, post.versionId].join(":");
      if (row.relevance.relevant !== true) {
        this.exclusionLog.add({
          source: "posts",
          id,
          reason: "Not labelled NBA-related",
        });
        continue;
      }
      const at = postAvailability(post);
      if (!at) {
        this.exclusionLog.add({
          source: "posts",
          id,
          reason: "Unknown version publication time",
        });
        continue;
      }
      result.push(
        envelope(
          "posts",
          id,
          pick(post, [
            "accountId",
            "postId",
            "versionId",
            "text",
            "publishedAt",
            "versionPublishedAt",
            "references",
            "editHistoryIds",
          ]),
          ref,
          this.release.root.sha256,
          at,
          "post_version_publication",
          { collected: post.retrievedAt, revision: post.versionPublishedAt },
        ),
      );
    }
    return result;
  }
}
export function selectLineups(rows: Row[]): Row[] {
  const groups = Map.groupBy(
    rows.filter((r) => r.phase === "regular"),
    (r) => r.gameId,
  );
  return [...groups.values()].map((group) => {
    const preferred = group.filter((r) => r.preferredForGame === true);
    if (preferred.length === 1) return preferred[0];
    if (preferred.length > 1) throw Error("Ambiguous preferred lineup");
    // Celtics archive has two identical March 2 announcements, without a preferred
    // flag. The first publication of the identical five is the conservative choice.
    if (group.some((r) => "preferredForGame" in r))
      throw Error("Missing preferred lineup");
    const signature = (r: Row) => JSON.stringify([...r.startingLineup].sort());
    if (group.some((r) => signature(r) !== signature(group[0])))
      throw Error("Conflicting announcements without a preferred selection");
    return [...group].sort(
      (a, b) => Date.parse(a.postedAt) - Date.parse(b.postedAt),
    )[0];
  });
}
export class LineupsAdapter {
  constructor(
    readonly root: ObjectRef,
    private store: VerifiedStore,
    readonly side: "celtics" | "opponent",
  ) {}
  async auditRows(): Promise<Row[]> {
    return (await this.store.json(this.root)).rows;
  }
  async records(): Promise<RecordEnvelope[]> {
    return selectLineups(await this.auditRows()).map((row) =>
      envelope(
        "lineups",
        `${this.side}:${row.gameId}:${row.postId}`,
        {
          ...pick(row, [
            "gameId",
            "postId",
            "postedAt",
            "startingLineup",
            "url",
            "text",
            "team",
            "source",
          ]),
          side: this.side,
        },
        this.root,
        this.root.sha256,
        row.postedAt,
        "lineup_announcement",
      ),
    );
  }
}
export function transcriptAvailability(
  row: Row,
): { at: string; convention: Convention } | null {
  if (row.cutoff_requires_review) return null;
  if (row.is_livestream)
    return { at: instant(row.stream_ended_at), convention: "livestream_end" };
  if (row.published_at_precision === "day")
    return {
      at: easternDayEnd(row.publicationDay),
      convention: "video_eastern_day_end",
    };
  if (row.published_at_precision !== "second")
    throw Error("Unsupported transcript publication precision");
  return { at: instant(row.published_at), convention: "video_publication" };
}
export class TranscriptsAdapter {
  private exclusionLog = new ExclusionLog();
  get exclusions(): Exclusion[] {
    return this.exclusionLog.values();
  }
  constructor(
    private index: Row[],
    private manifests: Record<string, ObjectRef>,
    private store: VerifiedStore,
  ) {}
  async records(): Promise<RecordEnvelope[]> {
    const result: RecordEnvelope[] = [];
    for (const entry of this.index) {
      const availability = transcriptAvailability(entry);
      if (!availability) {
        this.exclusionLog.add({
          source: "transcripts",
          id: entry.mediaId,
          reason: "Publication requires review",
        });
        continue;
      }
      const root = this.manifests[entry.manifestKey];
      if (!root) throw Error("Unpinned transcript manifest");
      const manifest = await this.store.json(root);
      const ref = (r: Row): ObjectRef => ({
        bucket: "sports-transcription",
        key: r.key.startsWith("dev/") ? r.key : "dev/" + r.key,
        sha256: r.sha256,
        bytes: r.bytes,
      });
      const publication = entry.published_at_provenance;
      if (publication?.source_artifact)
        await this.store.read(ref(publication.source_artifact));
      if (publication?.raw_evidence)
        await this.store.read(ref(publication.raw_evidence));
      const normalizedRef = ref(manifest.run.normalized);
      const normalized = await this.store.json(normalizedRef);
      // jsonSha256 in the season index hashes the upstream local export wrapper,
      // not the normalized artifact. Artifact hashes come from the pinned manifest.
      if (
        manifest.media.id !== entry.mediaId ||
        manifest.run.id !== entry.runId
      )
        throw Error("Index and transcript identity disagree");
      const readable = (
        await this.store.read(ref(manifest.artifacts.readable))
      ).toString();
      result.push(
        envelope(
          "transcripts",
          `${entry.mediaId}:${entry.runId}`,
          {
            mediaId: entry.mediaId,
            runId: entry.runId,
            title: entry.title,
            url: entry.url,
            published_at: entry.published_at,
            stream_ended_at: entry.stream_ended_at,
            readable,
            readable_ref: ref(manifest.artifacts.readable),
            normalized,
          },
          normalizedRef,
          root.sha256,
          availability.at,
          availability.convention,
          {
            collected: manifest.createdAt,
            event:
              manifest.media?.eventTime?.precision === "second"
                ? manifest.media.eventTime.value
                : null,
          },
        ),
      );
    }
    return result;
  }
}
