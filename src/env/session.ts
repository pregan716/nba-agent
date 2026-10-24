import { Temporal } from "@js-temporal/polyfill";
import type { RecordEnvelope } from "../data/contracts.js";
import { injuryIdentityKey, Identities } from "../data/identity.js";
import { agentQuestion, buildQuestionSet } from "../questions/builder.js";
import {
  deepFreeze,
  digest,
  type Game,
  type RunConfig,
} from "../runner/config.js";
import type { EnvironmentFactory, Environment } from "../runner/runner.js";
import {
  PLAYER_REFERENCE_TABLES,
  SessionError,
  TOOL_CAPABILITY,
  TOOL_PHASES,
  type BudgetRemaining,
  type ContextResult,
  type Phase,
  type ToolName,
  type ToolInput,
  type ToolResult,
  type QueryGameHistoryInput,
  type QueryGameHistoryResult,
  type GameHistoryTable,
  type PlayerReferenceTable,
  type ReadScheduleAndInjuriesInput,
  type ReadScheduleAndInjuriesResult,
  type QueryOddsHistoryInput,
  type QueryOddsHistoryResult,
  type Scalar,
  type TeamRef,
} from "./contract.js";
import { validateInput } from "./input.js";
import type { SessionSource } from "./source.js";
import { visible, releasedGame, releaseTime } from "./visibility.js";

const compare = (a: string, b: string) => Temporal.Instant.compare(a, b);
const stable = (a: RecordEnvelope, b: RecordEnvelope) =>
  compare(a.availableAt, b.availableAt) || a.id.localeCompare(b.id);
const isReference = (table: string): table is PlayerReferenceTable =>
  (PLAYER_REFERENCE_TABLES as readonly string[]).includes(table);
const BOS = "1610612738";
const inWindow = (
  at: string,
  input: { from?: string; to?: string },
  cutoff: string,
) =>
  (!input.from || compare(at, input.from) >= 0) &&
  (!input.to ||
    compare(at, compare(input.to, cutoff) < 0 ? input.to : cutoff) < 0);

/** Trusted session, never handed to the harness. Only bound tools cross that boundary. */
export class Session {
  #config: RunConfig;
  #game: Game;
  #phase: Phase;
  #cutoff: string;
  #source: SessionSource;
  #closed = false;
  constructor(
    config: RunConfig,
    game: Game,
    phase: Phase,
    cutoff: string,
    source: SessionSource,
  ) {
    this.#config = deepFreeze(structuredClone(config));
    this.#game = deepFreeze(structuredClone(game));
    this.#phase = phase;
    this.#cutoff = Temporal.Instant.from(cutoff).toString();
    if (
      compare(game.release, releaseTime(game.scheduledStart)) !== 0 ||
      compare(
        cutoff,
        phase === "postgame" ? game.release : game.scheduledStart,
      ) !== 0
    )
      throw new SessionError(
        "cutoff_refused",
        "Cutoff does not match the game phase",
      );
    const configured = config.profile.dataSources.map((d) => ({
      source: d.type,
      release: d.release,
      manifest_sha256: d.manifestSha256,
    }));
    const sort = (vs: typeof configured) =>
      [...vs].sort((a, b) => a.source.localeCompare(b.source));
    if (
      digest(sort(configured)) !== digest(sort(source.versions)) ||
      config.devig.manifestSha256 !== source.layer.manifest.sha256 ||
      config.devig.methodologySha256 !== source.layer.methodology.sha256
    )
      throw Error("Session dataset pins differ from the run configuration");
    // Copy identity and metadata inputs so the creator cannot later alter run identity.
    const identities = new Identities();
    for (const mapping of source.identities.rows())
      identities.add(structuredClone(mapping));
    this.#source = {
      ...source,
      identities,
      versions: deepFreeze(sort(structuredClone(source.versions))),
      teams: deepFreeze(structuredClone(source.teams)),
      layer: deepFreeze(structuredClone(source.layer)),
    };
  }
  #check(name: ToolName, input: unknown) {
    if (this.#closed) throw new SessionError("phase_refused", "Session closed");
    validateInput(name, input);
    if (!TOOL_PHASES[name].includes(this.#phase))
      throw new SessionError("phase_refused", "Tool unavailable in this phase");
    const capability = TOOL_CAPABILITY[name];
    if (
      capability &&
      !this.#config.profile.capabilities.enabled.includes(capability)
    )
      throw new SessionError("capability_disabled", "Capability disabled");
  }
  #eligible(records: RecordEnvelope[]) {
    return records.filter((r) => visible(r, this.#cutoff)).sort(stable);
  }
  #team(id: string): TeamRef {
    const team = this.#source.teams.find((t) => t.team_id === id);
    if (!team) throw Error("Missing pinned team reference");
    return structuredClone(team);
  }
  async #games() {
    return this.#eligible(await this.#source.games());
  }
  async #current() {
    const game = (await this.#games()).find((g) => g.id === this.#game.gameId);
    if (
      !game ||
      compare(game.data.scheduled_tipoff, this.#game.scheduledStart) !== 0 ||
      ![game.data.home_team_id, game.data.away_team_id].includes(BOS)
    )
      throw Error("Session game differs from pinned schedule");
    return game;
  }
  async context(budget: BudgetRemaining): Promise<ContextResult> {
    this.#check("context", {});
    const game = await this.#current(),
      home = game.data.home_team_id === BOS;
    const { horizon, revision, process } = this.#config.profile.memory;
    return {
      team: this.#team(BOS),
      season: "2025-26",
      game: {
        game_id: game.id,
        game_index: this.#game.index + 1,
        opponent: this.#team(
          home ? game.data.away_team_id : game.data.home_team_id,
        ),
        home,
        scheduled_start: this.#game.scheduledStart,
        venue: game.data.venue ?? null,
      },
      phase: this.#phase,
      cutoff: this.#cutoff,
      budget: structuredClone(budget),
      memory: { horizon, revision, process },
      dataset_versions: [...this.#source.versions]
        .sort((a, b) => a.source.localeCompare(b.source))
        .map((d) => ({ ...d })),
    };
  }
  async questions() {
    const game = await this.#current();
    if (
      !visible(
        {
          ...game,
          availableAt: this.#game.scheduledStart,
          availabilityConvention: "odds_requested_at",
        },
        this.#cutoff,
      )
    )
      throw new SessionError("cutoff_refused", "Questions unavailable");
    const mappings = this.#source.identities
      .rows()
      .filter(
        (m) =>
          m.entity === "game" &&
          m.provider === "espn" &&
          m.canonicalId === this.#game.gameId,
      );
    if (mappings.length !== 1)
      throw Error("Missing or ambiguous ESPN game mapping");
    return buildQuestionSet(
      {
        game_id: this.#game.gameId,
        espn_event_id: mappings[0].providerId,
        scheduled_start: this.#game.scheduledStart,
      },
      this.#source.layer,
    );
  }
  async list_questions(
    input: ToolInput<"list_questions">,
    _signal?: AbortSignal,
  ): Promise<ToolResult<"list_questions">> {
    this.#check("list_questions", input);
    const set = await this.questions();
    // The P2 builder selects the exact scheduled-start observation; no provenance escapes.
    return {
      game_id: this.#game.gameId,
      cutoff: this.#cutoff,
      questions: set.questions.map(agentQuestion),
    };
  }
  async query_game_history(
    input: QueryGameHistoryInput,
    _signal?: AbortSignal,
  ): Promise<QueryGameHistoryResult> {
    this.#check("query_game_history", input);
    const ref = isReference(input.table);
    if (
      ref
        ? !!(input.game_id || input.season || input.from || input.to)
        : !(input.game_id || input.team_id || input.player_id)
    )
      throw new SessionError("invalid_input", "Invalid history filters");
    let records: RecordEnvelope[] = [];
    const gameTeams = new Map<string, string[]>(),
      gamePlayers = new Map<string, string[]>(),
      eventPlayers = new Map<string, string[]>();
    const unavailable: QueryGameHistoryResult["unavailable"] = [];
    if (ref)
      records = this.#eligible(
        await this.#source.reference(input.table as PlayerReferenceTable),
      );
    else
      for (const game of (await this.#games()).filter((g) =>
        visible(releasedGame(g), this.#cutoff),
      )) {
        if (
          (input.game_id && game.id !== input.game_id) ||
          (input.season && game.data.season !== input.season) ||
          (input.team_id &&
            ![game.data.home_team_id, game.data.away_team_id].includes(
              input.team_id,
            )) ||
          !inWindow(game.data.scheduled_tipoff, input, this.#cutoff)
        )
          continue;
        gameTeams.set(game.id, [
          game.data.home_team_id,
          game.data.away_team_id,
        ]);
        if (input.player_id) {
          const boxes = await this.#source.history("player_box_scores", game);
          const players = boxes.reason
            ? []
            : this.#eligible(boxes.records).map(
                (b) => b.data.player_id as string,
              );
          if (!players.includes(input.player_id)) continue;
          gamePlayers.set(game.id, players);
        }
        // Coverage is inspected only after game availability; no future gap metadata.
        const batch = await this.#source.history(
          input.table as GameHistoryTable,
          game,
          input.player_id,
        );
        for (const r of this.#eligible(batch.participants ?? [])) {
          const key = `${r.data.game_id}:${r.data.event_id}`;
          eventPlayers.set(key, [
            ...(eventPlayers.get(key) ?? []),
            r.data.player_id,
          ]);
        }
        if (batch.reason)
          unavailable.push({ game_id: game.id, reason: batch.reason });
        else records.push(...this.#eligible(batch.records));
      }
    records = records
      .filter((r) => {
        const d = r.data;
        let teamFields = ref
          ? [d.opening_team_id, d.team_id]
          : [
              d.team_id,
              d.offense_team_id,
              d.defense_team_id,
              d.home_team_id,
              d.away_team_id,
            ];
        let playerFields = [
          d.player_id,
          d.primary_player_id,
          d.secondary_player_id,
          ...(Array.isArray(d.player_ids) ? d.player_ids : []),
          ...(Array.isArray(d.home_player_ids) ? d.home_player_ids : []),
          ...(Array.isArray(d.away_player_ids) ? d.away_player_ids : []),
        ];
        if (!ref && !teamFields.some((v) => v !== undefined))
          teamFields = gameTeams.get(d.game_id) ?? [];
        if (!ref && !playerFields.some((v) => v !== undefined))
          playerFields =
            input.table === "events"
              ? (eventPlayers.get(`${d.game_id}:${d.event_id}`) ?? [])
              : (gamePlayers.get(d.game_id) ?? []);
        return (
          (!input.team_id || teamFields.includes(input.team_id)) &&
          (!input.player_id || playerFields.includes(input.player_id))
        );
      })
      .sort(
        (a, b) =>
          compare(a.availableAt, b.availableAt) ||
          String(a.data.game_id ?? "").localeCompare(
            String(b.data.game_id ?? ""),
          ) ||
          Number(a.data.canonical_sequence ?? a.data.start_sequence ?? 0) -
            Number(b.data.canonical_sequence ?? b.data.start_sequence ?? 0) ||
          a.id.localeCompare(b.id),
      );
    const definitions = await this.#source.columns(input.table, input.season);
    const rows: Record<string, Scalar>[] = records.map((r) => {
      const row: Record<string, Scalar> = {};
      // Only dictionary-defined published columns, never internal envelopes.
      for (const column of definitions)
        if (Object.hasOwn(r.data, column.name)) {
          const value = r.data[column.name];
          row[column.name === "type" ? "kind" : column.name] =
            value === null ||
            ["string", "number", "boolean"].includes(typeof value)
              ? value
              : JSON.stringify(value);
        }
      if (ref && typeof r.data.birth_date === "string") {
        const date = Temporal.Instant.from(this.#cutoff)
          .toZonedDateTimeISO("America/New_York")
          .toPlainDate();
        row.age_on_replay_date = Temporal.PlainDate.from(
          r.data.birth_date,
        ).until(date, { largestUnit: "years" }).years;
      }
      return row;
    });
    const names = new Set(rows.flatMap(Object.keys));
    const columns = definitions
      .filter((c) => names.has(c.name === "type" ? "kind" : c.name))
      .map((c) => ({
        name: c.name === "type" ? "kind" : c.name,
        description:
          c.description + " (Published arrays/maps are JSON-encoded strings.)",
      }));
    if (names.has("age_on_replay_date"))
      columns.push({
        name: "age_on_replay_date",
        description:
          "Completed years of age on the session cutoff's Eastern calendar date.",
      });
    const { cursor, ...query } = input;
    const binding = digest([
      this.#config.runId,
      this.#config.replicateId,
      this.#game.gameId,
      this.#phase,
      this.#cutoff,
      this.#source.versions,
      Object.entries(query).sort(),
    ]);
    let offset = 0;
    if (cursor)
      try {
        const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
        if (
          decoded.binding !== binding ||
          !Number.isSafeInteger(decoded.offset) ||
          decoded.offset < 0 ||
          decoded.offset > rows.length
        )
          throw Error();
        offset = decoded.offset;
      } catch {
        throw new SessionError("invalid_input", "Invalid history cursor");
      }
    const end = Math.min(rows.length, offset + (input.limit ?? 20));
    return {
      table: input.table,
      columns,
      rows: rows.slice(offset, end),
      total: rows.length,
      next_cursor:
        end < rows.length
          ? Buffer.from(JSON.stringify({ binding, offset: end })).toString(
              "base64url",
            )
          : null,
      unavailable: unavailable.sort((a, b) =>
        a.game_id.localeCompare(b.game_id),
      ),
    };
  }
  async read_schedule_and_injuries(
    input: ReadScheduleAndInjuriesInput,
    _signal?: AbortSignal,
  ): Promise<ReadScheduleAndInjuriesResult> {
    this.#check("read_schedule_and_injuries", input);
    const team = input.team_id ?? BOS;
    const games = (await this.#games()).filter(
      (g) =>
        [g.data.home_team_id, g.data.away_team_id].includes(team) &&
        (!input.game_id || input.game_id === g.id),
    );
    const gameIds = new Set(games.map((g) => g.id));
    const snapshots = new Map<string, RecordEnvelope>();
    const matches = (r: RecordEnvelope) =>
      gameIds.has(r.data.game_id) &&
      r.data.team_id === team &&
      inWindow(r.availableAt, input, this.#cutoff);
    for await (const batch of this.#source.injuries("teams"))
      for (const r of this.#eligible(batch).filter(matches)) {
        const key = `${r.data.game_id}:${r.data.team_id}`,
          previous = snapshots.get(key);
        if (!previous || stable(previous, r) < 0) snapshots.set(key, r);
      }
    const injury_reports: ReadScheduleAndInjuriesResult["injury_reports"] = [];
    for await (const batch of this.#source.injuries("players"))
      for (const r of this.#eligible(batch).filter(matches)) {
        const snapshot = snapshots.get(`${r.data.game_id}:${r.data.team_id}`);
        // An absent/latest placeholder cannot carry an earlier player's status forward.
        if (
          !snapshot ||
          snapshot.data.observed_state !== "players_listed" ||
          compare(snapshot.availableAt, r.availableAt) !== 0
        )
          continue;
        let player_id: string | null = null;
        try {
          player_id = this.#source.identities.resolve(
            "player",
            "injury-name",
            injuryIdentityKey(r.data.player_name, team),
            { teamId: team },
          );
        } catch {
          /* Refused/ambiguous joins remain explicit null. */
        }
        injury_reports.push({
          report_time: r.availableAt,
          game_id: r.data.game_id,
          team_id: team,
          player_id,
          player_name: r.data.player_name,
          status: r.data.status,
          reason: r.data.reason ?? null,
        });
      }
    return {
      schedule: games
        .sort(
          (a, b) =>
            compare(a.data.scheduled_tipoff, b.data.scheduled_tipoff) ||
            a.id.localeCompare(b.id),
        )
        .map((g) => ({
          game_id: g.id,
          scheduled_start: Temporal.Instant.from(
            g.data.scheduled_tipoff,
          ).toString(),
          home: this.#team(g.data.home_team_id),
          away: this.#team(g.data.away_team_id),
          venue: g.data.venue ?? null,
        })),
      injury_reports: injury_reports.sort(
        (a, b) =>
          a.game_id.localeCompare(b.game_id) ||
          a.player_name.localeCompare(b.player_name),
      ),
      team_snapshots: [...snapshots.values()].sort(stable).map((r) => ({
        report_time: r.availableAt,
        game_id: r.data.game_id,
        team_id: r.data.team_id,
        state:
          r.data.observed_state === "players_listed"
            ? "listed"
            : r.data.observed_state === "not_yet_submitted"
              ? "not_yet_submitted"
              : "unknown",
      })),
    };
  }
  async query_odds_history(
    input: QueryOddsHistoryInput,
    _signal?: AbortSignal,
  ): Promise<QueryOddsHistoryResult> {
    this.#check("query_odds_history", input);
    const id = input.game_id ?? this.#game.gameId;
    const game = (await this.#games()).find(
      (g) =>
        g.id === id &&
        compare(g.data.scheduled_tipoff, this.#game.scheduledStart) <= 0,
    );
    if (!game) return { observations: [], settlements: [] };
    const profiles = this.#eligible(
      await this.#source.reference("player_profiles"),
    );
    const observations: QueryOddsHistoryResult["observations"] = [];
    for (const r of this.#eligible(await this.#source.odds())) {
      if (
        this.#source.identities.resolve(
          "game",
          "espn",
          r.data.espn_event_id,
        ) !== id
      )
        continue;
      const playerId = this.#source.identities.resolve(
        "player",
        "espn",
        r.data.espn_player_id,
      );
      const stat = String(r.data.prop_type).replace(/^player_/, "");
      if (
        !["points", "rebounds", "assists"].includes(stat) ||
        (input.player_id && playerId !== input.player_id) ||
        (input.stat && stat !== input.stat)
      )
        continue;
      const profile = profiles.find((p) => p.data.player_id === playerId);
      if (!profile) throw Error("Missing static player reference");
      observations.push({
        game_id: id,
        available_at: r.availableAt,
        player: { id: playerId, name: profile.data.full_name },
        stat: stat as "points" | "rebounds" | "assists",
        line: r.data.selected_line,
        p_over: r.data.p_over,
      });
    }
    const settlements: QueryOddsHistoryResult["settlements"] = [];
    if (visible(releasedGame(game), this.#cutoff)) {
      const boxBatch = await this.#source.history("player_box_scores", game),
        summaryBatch = await this.#source.history("player_game_summary", game);
      const boxes = boxBatch.reason ? [] : this.#eligible(boxBatch.records),
        summaries = summaryBatch.reason
          ? []
          : this.#eligible(summaryBatch.records);
      // One settled outcome per distinct offered line, not one per snapshot.
      const lines = new Map(
        observations.map((o) => [`${o.player.id}:${o.stat}:${o.line}`, o]),
      );
      for (const o of lines.values()) {
        const box = boxes.filter((b) => b.data.player_id === o.player.id),
          summary = summaries.filter((s) => s.data.player_id === o.player.id);
        const actual =
          box.length === 1 &&
          Number.isInteger(box[0].data[o.stat]) &&
          box[0].data[o.stat] >= 0
            ? (box[0].data[o.stat] as number)
            : null;
        // P1a Dec 5: partial derived products stay absent; official minutes survive.
        const seconds =
          summary.length === 1
            ? summary[0].data.reconstructed_minutes * 60
            : id === "0022500338" && box.length === 1
              ? box[0].data.minutes_seconds
              : null;
        const outcome =
          seconds === 0
            ? "did_not_play"
            : actual === null ||
                typeof seconds !== "number" ||
                !Number.isFinite(seconds) ||
                seconds < 0
              ? "unresolved"
              : actual === o.line
                ? "push"
                : actual > o.line
                  ? "over"
                  : "under";
        settlements.push({
          game_id: id,
          player: o.player,
          stat: o.stat,
          line: o.line,
          actual,
          outcome,
        });
      }
    }
    return { observations, settlements };
  }
  /** Only runner-controlled phase entry; a Session never advances to a new game's cutoff. */
  async transition(phase: Phase, cutoff: string) {
    if (
      this.#closed ||
      compare(cutoff, this.#cutoff) !== 0 ||
      !(
        phase === this.#phase ||
        (this.#phase === "pregame" && phase === "commit")
      )
    )
      throw new SessionError("phase_refused", "Invalid session transition");
    this.#phase = phase;
  }
  async call<N extends ToolName>(
    name: N,
    input: ToolInput<N>,
    signal: AbortSignal,
  ): Promise<ToolResult<N>> {
    this.#check(name, input);
    const methods = {
      query_game_history: this.query_game_history.bind(this),
      read_schedule_and_injuries: this.read_schedule_and_injuries.bind(this),
      query_odds_history: this.query_odds_history.bind(this),
      list_questions: this.list_questions.bind(this),
    };
    const method = methods[name as keyof typeof methods];
    if (!method)
      throw new SessionError(
        "capability_disabled",
        "Tool implementation is not installed",
      );
    return method(input as never, signal) as Promise<ToolResult<N>>;
  }
  async close() {
    this.#closed = true;
  }
}

/** P3d–f supply their own validation/sandbox hooks; absent hooks fail closed. */
export function sessionEnvironment(
  config: RunConfig,
  source: SessionSource,
  hooks: Partial<Pick<Environment, "validateSubmission" | "execute">> = {},
): EnvironmentFactory {
  return async (context) => {
    const session = new Session(
      config,
      context.game,
      context.phase,
      context.cutoff,
      source,
    );
    return {
      context: (budget) => session.context(budget),
      questions: () => session.questions(),
      transition: (phase, cutoff) => session.transition(phase, cutoff),
      call: (name, input, signal) => {
        validateInput(name, input);
        return session.call(name, input as never, signal);
      },
      validateSubmission:
        hooks.validateSubmission ??
        (async () => {
          throw new SessionError(
            "capability_disabled",
            "Submission validator is not installed",
          );
        }),
      execute:
        hooks.execute ??
        (async () => {
          throw new SessionError(
            "capability_disabled",
            "Code sandbox is not installed",
          );
        }),
      close: () => session.close(),
    };
  };
}
