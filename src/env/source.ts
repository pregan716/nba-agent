import { readFile } from "node:fs/promises";
import type { Corpus } from "../data/corpus.js";
import type { RecordEnvelope } from "../data/contracts.js";
import { Identities } from "../data/identity.js";
import type { QuestionLayer } from "../questions/builder.js";
import type {
  ColumnDefinition,
  DatasetVersion,
  GameHistoryTable,
  HistoryTable,
  PlayerReferenceTable,
  TeamRef,
} from "./contract.js";

export interface HistoryBatch {
  records: RecordEnvelope[];
  reason: string | null;
  participants?: RecordEnvelope[];
}
/** Trusted P1 port. Every envelope is still filtered by Session after this port returns. */
export interface SessionSource {
  versions: DatasetVersion[];
  layer: QuestionLayer;
  identities: Identities;
  teams: TeamRef[];
  games(): Promise<RecordEnvelope[]>;
  history(
    table: GameHistoryTable,
    game: RecordEnvelope,
    playerId?: string,
  ): Promise<HistoryBatch>;
  reference(table: PlayerReferenceTable): Promise<RecordEnvelope[]>;
  columns(table: HistoryTable, season?: string): Promise<ColumnDefinition[]>;
  injuries(kind: "teams" | "players"): AsyncIterable<RecordEnvelope[]>;
  odds(): Promise<RecordEnvelope[]>;
}
export const HISTORY_TABLE: Record<GameHistoryTable, string> = {
  games: "games",
  player_box_scores: "player_box_scores",
  team_box_scores: "team_box_scores",
  team_period_scores: "team_period_scores",
  events: "events",
  lineup_stints: "v_team_lineup_stints",
  player_stints: "v_player_stints",
  matchup_stints: "v_matchup_stints",
  player_game_summary: "v_player_game_summary",
  team_game_summary: "v_team_game_summary",
  possessions: "v_possessions",
};

export function dictionary(
  markdown: string,
  table: string,
): ColumnDefinition[] {
  const section = markdown
    .split(/^## /m)
    .find((s) => s.split("\n")[0].trim() === table);
  if (!section) throw Error(`Missing dictionary table: ${table}`);
  return section
    .split("\n")
    .filter((line) => /^\| `[^`]+` \|/.test(line))
    .map((line) => {
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((s) => s.trim());
      return { name: cells[0].replaceAll("`", ""), description: cells.at(-1)! };
    });
}
const abbreviations = [
  "ATL",
  "BOS",
  "CLE",
  "NOP",
  "CHI",
  "DAL",
  "DEN",
  "GSW",
  "HOU",
  "LAC",
  "LAL",
  "MIA",
  "MIL",
  "MIN",
  "BKN",
  "NYK",
  "ORL",
  "IND",
  "PHI",
  "PHX",
  "POR",
  "SAC",
  "SAS",
  "OKC",
  "TOR",
  "UTA",
  "MEM",
  "WAS",
  "DET",
  "CHA",
];

/** Bridge over the pinned corpus; no reads from raw/ or archive/ trees. */
export async function corpusSource(
  corpus: Corpus,
  layer: QuestionLayer,
  identities: Identities,
): Promise<SessionSource> {
  const pbpDictionary = await readFile(
    new URL("../../config/dictionaries/pbp-0.1.0.md", import.meta.url),
    "utf8",
  );
  const playerDictionary = (
    await corpus.players.release.bytes(
      corpus.players.release.manifest.prefix + "data-dictionary.md",
    )
  ).toString();
  const teams = (await corpus.pbp.release.table("teams")).flatMap(({ row }) => {
    const abbreviation = abbreviations[Number(row.team_id) - 1610612737];
    return abbreviation
      ? [{ team_id: String(row.team_id), abbreviation, name: String(row.name) }]
      : [];
  });
  for (const adapter of [corpus.pbp, corpus.priorPbp]) {
    if (
      adapter.release.manifest.release.transformation_version !==
      "6695e0b18ce83046602f0c016623414af8a95add"
    )
      throw Error(
        "PBP dictionary must be reviewed for this transformation version",
      );
  }
  return {
    layer,
    identities,
    teams,
    versions: [
      ...Object.entries(corpus.pins.sources).map(([source, ref]) => ({
        source,
        release: ref.key,
        manifest_sha256: ref.sha256,
      })),
      {
        source: "transcriptIndex",
        release: corpus.pins.transcriptIndex.repositoryCommit,
        manifest_sha256: corpus.pins.transcriptIndex.sha256,
      },
      ...Object.entries(corpus.pins.transcriptManifests).map(
        ([source, ref]) => ({
          source: `transcript:${source}`,
          release: ref.key,
          manifest_sha256: ref.sha256,
        }),
      ),
    ],
    async games() {
      return [
        ...(await corpus.priorPbp.games()),
        ...(await corpus.pbp.games()),
      ];
    },
    async history(table, game, playerId) {
      const adapter =
        game.data.season === "2024-25" ? corpus.priorPbp : corpus.pbp;
      if (table === "games") return { records: [game], reason: null };
      const records = await adapter.records(HISTORY_TABLE[table], game.id);
      return {
        records,
        participants:
          playerId && table === "events"
            ? await adapter.records("event_participants", game.id)
            : undefined,
        reason:
          adapter.exclusions.find(
            (e) => e.source === HISTORY_TABLE[table] && e.id === game.id,
          )?.reason ?? null,
      };
    },
    reference: (table) => corpus.players.records(table),
    async columns(table) {
      return table in HISTORY_TABLE
        ? dictionary(pbpDictionary, HISTORY_TABLE[table as GameHistoryTable])
        : dictionary(playerDictionary, table);
    },
    injuries: (kind) => corpus.injuries.partitions(kind),
    odds: () => corpus.odds.records(),
  };
}
