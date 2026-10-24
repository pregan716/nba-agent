import {
  STATIC_AT,
  type RecordEnvelope,
  type Convention,
} from "../../../src/data/contracts.js";
import { Identities } from "../../../src/data/identity.js";
import type { SessionSource } from "../../../src/env/source.js";
import { releaseTime } from "../../../src/env/visibility.js";
import { fixtureConfig } from "../runner/support.js";
import type { QuestionLayer } from "../../../src/questions/builder.js";

export const cutoff = "2025-11-02T23:00:00Z",
  before = "2025-11-02T22:59:59Z",
  future = "2025-11-02T23:00:01Z";
export const BOS = "1610612738",
  OPP = "1610612752";
const ref = {
  bucket: "sports-nba-data" as const,
  key: "fixture",
  sha256: "a".repeat(64),
};
export function envelope(
  id: string,
  source: string,
  availableAt: string,
  availabilityConvention: Convention,
  data: Record<string, unknown>,
): RecordEnvelope {
  return {
    id,
    source,
    availableAt,
    availabilityConvention,
    data,
    eventTime: null,
    collectedAt: null,
    revisionTime: null,
    provenance: { object: ref, manifestSha256: ref.sha256 },
  };
}
/** Shared adversarial corpus for P3b–f. Future payloads must never affect visible output. */
export function fixtureCorpus(includeFuture = true) {
  const config = fixtureConfig("session-fixture");
  config.profile.capabilities.enabled = [
    "game_history",
    "odds_history",
    "search_and_fetch",
    "workspace",
    "code_execution",
  ];
  config.profile.dataSources = [
    { type: "fixture", release: "fixture-v1", manifestSha256: ref.sha256 },
  ];
  const game = {
    gameId: "current",
    scheduledStart: cutoff,
    index: 1,
    development: true,
    release: releaseTime(cutoff),
  };
  const ids = new Identities();
  for (const id of ["prior", "current", "future", "0022500338"])
    ids.add({
      entity: "game",
      provider: "espn",
      providerId: id,
      canonicalId: id,
      basis: "fixture",
      evidence: [ref],
    });
  ids.add({
    entity: "player",
    provider: "espn",
    providerId: "espn-player",
    canonicalId: "player",
    basis: "fixture",
    evidence: [ref],
  });
  ids.add({
    entity: "player",
    provider: "injury-name",
    providerId: "Player, Fixture",
    canonicalId: "player",
    basis: "fixture",
    evidence: [ref],
  });
  const schedule = [
    ["prior", "2025-10-31T23:00:00Z"],
    ["current", cutoff],
    ["future", "2025-11-04T23:00:00Z"],
    ["0022500338", "2025-12-06T00:30:00Z"],
  ].map(([id, at]) =>
    envelope(id, "schedule", STATIC_AT, "schedule_static", {
      game_id: id,
      season: "2025-26",
      home_team_id: BOS,
      away_team_id: OPP,
      scheduled_tipoff: at,
      venue: "Fixture Arena",
    }),
  );
  const records: Record<string, RecordEnvelope[]> = {};
  for (const source of [
    "posts",
    "transcripts",
    "lineups",
    "injuries",
    "odds",
    "events",
  ]) {
    const convention = {
      posts: "post_version_publication",
      transcripts: "video_publication",
      lineups: "lineup_announcement",
      injuries: "injury_printed_report",
      odds: "odds_requested_at",
      events: "game_next_morning_eastern",
    }[source] as Convention;
    records[source] = [before, cutoff, ...(includeFuture ? [future] : [])].map(
      (at, i) =>
        envelope(`${source}-${i}`, source, at, convention, {
          title: i === 2 ? "FUTURE_SECRET" : "visible",
          text: i === 2 ? "FUTURE_SECRET" : "visible",
          game_id: "current",
          team_id: BOS,
          player_id: "player",
          player_name: "Player, Fixture",
          status: "Questionable",
          reason: "Fixture reason",
          observed_state: "players_listed",
          espn_event_id: "current",
          espn_player_id: "espn-player",
          prop_type: "player_points",
          selected_line: 10.5,
          p_over: 0.5,
          points: 11,
        }),
    );
  }
  const profiles = [
    envelope(
      "profile",
      "player-reference",
      STATIC_AT,
      "opening_reference_static",
      {
        player_id: "player",
        full_name: "Fixture Player",
        opening_team_id: BOS,
        birth_date: "2000-11-03",
        age_at_cutoff: 24,
      },
    ),
  ];
  const row = {
    espn_event_id: "current",
    espn_player_id: "espn-player",
    player_name: "Fixture Player",
    prop_type: "player_points",
    snapshot_kind: "scheduled_start",
    requested_at: cutoff,
    scheduled_start: cutoff,
    status: "ok",
    selected_line: 10.5,
    p_over: 0.5,
    p_under: 0.5,
    contributing_books: ["fixture"],
    contributing_book_count: 1,
  };
  const layer: QuestionLayer = {
    manifest: ref,
    methodology: ref,
    consensus: ref,
    bookLines: ref,
    summaryRef: ref,
    rows: [row],
    pairs: [
      {
        ...row,
        bookmaker: "fixture",
        line: 10.5,
        over_price: -110,
        under_price: -110,
        contributes_to_consensus: true,
      },
    ],
    summary: {},
    playerIds: { "espn-player": "player" },
  };
  const history: Record<string, RecordEnvelope[]> = {};
  for (const g of schedule)
    for (const table of ["events", "player_box_scores", "player_game_summary"])
      history[`${g.id}:${table}`] = [0, 1].map((i) =>
        envelope(
          `${g.id}:${table}:${i}`,
          table,
          releaseTime(g.data.scheduled_tipoff),
          "game_next_morning_eastern",
          {
            game_id: g.id,
            player_id: i ? "other" : "player",
            team_id: BOS,
            points: 11,
            minutes_seconds: 60,
            reconstructed_minutes: 1,
            description: g.id === "future" ? "FUTURE_SECRET" : `row-${i}`,
            type: "shot",
          },
        ),
      );
  // A future row in an otherwise eligible partition must not enter counts/pages.
  if (includeFuture)
    history["prior:events"].push(
      envelope(
        "planted-future",
        "events",
        future,
        "game_next_morning_eastern",
        {
          game_id: "prior",
          player_id: "player",
          team_id: BOS,
          description: "FUTURE_SECRET",
        },
      ),
    );
  const reasons: Record<string, string> = {
    "0022500338:player_game_summary": "Published summaries are partial",
  };
  const source: SessionSource = {
    versions: [
      { source: "fixture", release: "fixture-v1", manifest_sha256: ref.sha256 },
    ],
    layer,
    identities: ids,
    teams: [
      { team_id: BOS, abbreviation: "BOS", name: "Boston Celtics" },
      { team_id: OPP, abbreviation: "NYK", name: "New York Knicks" },
    ],
    async games() {
      return schedule;
    },
    async history(table, g) {
      return {
        records: table === "games" ? [g] : (history[`${g.id}:${table}`] ?? []),
        reason: reasons[`${g.id}:${table}`] ?? null,
      };
    },
    async reference() {
      return profiles;
    },
    async columns() {
      return [
        "game_id",
        "player_id",
        "team_id",
        "points",
        "minutes_seconds",
        "reconstructed_minutes",
        "description",
        "type",
        "full_name",
        "opening_team_id",
        "birth_date",
        "age_at_cutoff",
      ].map((name) => ({
        name,
        description: `Published definition of ${name}`,
      }));
    },
    async *injuries() {
      yield records.injuries;
    },
    async odds() {
      return records.odds;
    },
  };
  return {
    config,
    game,
    source,
    records,
    history,
    reasons,
    profiles,
    schedule,
  };
}
