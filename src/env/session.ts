import { logSkill } from "../evaluation/scoring.js";
import { DockerSandbox } from "./sandbox.js";
import {
  projectHistory,
  mountGameShards,
  writeSessionExport,
  type ExportBatch,
} from "./export.js";
import { Workspace, WorkspacePolicy } from "./workspace.js";
import { Lifecycle, type LifecyclePhase } from "./lifecycle.js";
import {
  resolveOutcome,
  resolveFrozen,
  type ResolutionInput,
  type QuestionScorer,
  type RecordedGame,
} from "./results.js";
import { validateSubmission } from "./submission.js";
import { EvidenceIndex } from "./evidence.js";
import { Temporal } from "@js-temporal/polyfill";
import type { RecordEnvelope } from "../data/contracts.js";
import { Identities } from "../data/identity.js";
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
  #workspace?: Workspace;
  #lifecycle: Lifecycle;
  #evidenceIndex?: Promise<EvidenceIndex>;
  constructor(
    config: RunConfig,
    game: Game,
    phase: Phase,
    cutoff: string,
    source: SessionSource,
    private records: () => RecordedGame[] = () => [],
    private scorer: QuestionScorer = logSkill,
    workspacePath?: string,
    runRoot?: string,
  ) {
    this.#config = deepFreeze(structuredClone(config));
    this.#game = deepFreeze(structuredClone(game));
    this.#phase = phase;
    this.#cutoff = Temporal.Instant.from(cutoff).toString();
    this.#lifecycle = new Lifecycle(this.#game, phase, cutoff);
    if (workspacePath && !runRoot)
      throw Error("Workspace requires the run root");
    if (workspacePath)
      this.#workspace = new Workspace(
        workspacePath,
        new WorkspacePolicy(this.#config.profile.memory, () =>
          this.#closed ? "closed" : this.#phase,
        ),
        runRoot!,
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
    return this.#eligible(await this.#source.games()).map((game) => {
      if (visible(releasedGame(game), this.#cutoff)) return game;
      // Status is outcome-time metadata, not part of the static schedule.
      // Copy before stripping: SessionSource may share cached rows across sessions.
      const data = { ...game.data };
      delete data.status;
      return { ...game, data };
    });
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
    const { horizon, revision, process, windowGames } =
      this.#config.profile.memory;
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
      capabilities: [...this.#config.profile.capabilities.enabled].sort(),
      memory: {
        horizon,
        revision,
        process,
        ...(windowGames === undefined ? {} : { window_games: windowGames }),
      },
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
  async #evidence() {
    this.#evidenceIndex ??= (async () => {
      const games = new Map((await this.#games()).map((g) => [g.id, g]));
      const records: RecordEnvelope[] = [];
      for (const source of ["posts", "transcripts", "lineups"] as const) {
        for (const r of this.#eligible(await this.#source.evidence(source))) {
          if (r.source !== source) throw Error("Evidence source mismatch");
          if (source === "lineups") {
            const id = this.#source.identities.resolve(
              "game",
              "espn",
              r.data.gameId,
            );
            const game = games.get(id);
            if (!game || !visible(r, game.data.scheduled_tipoff)) continue;
          }
          records.push(r);
        }
      }
      return new EvidenceIndex(
        records,
        this.#source.identities,
        this.#eligible(await this.#source.reference("player_profiles")),
      );
    })().catch((error) => {
      this.#evidenceIndex = undefined;
      throw error;
    });
    return this.#evidenceIndex;
  }
  async list_evidence(
    input: ToolInput<"list_evidence">,
    _signal?: AbortSignal,
  ): Promise<ToolResult<"list_evidence">> {
    this.#check("list_evidence", input);
    let from = input.from;
    if (!from) {
      if (this.#phase === "postgame") from = this.#game.scheduledStart;
      else
        from = (await this.#games())
          .filter(
            (g) =>
              [g.data.home_team_id, g.data.away_team_id].includes(BOS) &&
              compare(g.data.scheduled_tipoff, this.#game.scheduledStart) < 0,
          )
          .map((g) => g.data.scheduled_tipoff as string)
          .sort(compare)
          .at(-1);
    }
    return (await this.#evidence()).list(
      { ...input, from },
      digest([
        this.#config.runId,
        this.#config.replicateId,
        this.#game.gameId,
        this.#phase,
        this.#source.versions,
      ]),
      this.#cutoff,
    );
  }
  async search_evidence(
    input: ToolInput<"search_evidence">,
    _signal?: AbortSignal,
  ): Promise<ToolResult<"search_evidence">> {
    this.#check("search_evidence", input);
    const index = await this.#evidence();
    return index.search(
      input,
      digest([
        this.#config.runId,
        this.#config.replicateId,
        this.#game.gameId,
        this.#phase,
        this.#source.versions,
      ]),
      this.#cutoff,
    );
  }
  async fetch_evidence(
    input: ToolInput<"fetch_evidence">,
    _signal?: AbortSignal,
  ): Promise<ToolResult<"fetch_evidence">> {
    this.#check("fetch_evidence", input);
    return (await this.#evidence()).fetch(input.evidence_id);
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
        // These published tables carry their own canonical player_id. Loading
        // official boxes first repeats the same partition scan for every game.
        if (
          input.player_id &&
          ![
            "player_box_scores",
            "player_stints",
            "player_game_summary",
          ].includes(input.table)
        ) {
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
    const rows = records.map((r) =>
      projectHistory(r, definitions, ref ? this.#cutoff : undefined),
    );
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
    return this.#scheduleAndInjuries(input, input.team_id ?? BOS);
  }
  async #scheduleAndInjuries(
    input: ReadScheduleAndInjuriesInput,
    team?: string,
  ): Promise<ReadScheduleAndInjuriesResult> {
    const games = (await this.#games()).filter(
      (g) =>
        (!team || [g.data.home_team_id, g.data.away_team_id].includes(team)) &&
        (!input.game_id || input.game_id === g.id),
    );
    const gameIds = new Set(games.map((g) => g.id));
    const gameTeams = new Map(
      games.map((g) => [g.id, [g.data.home_team_id, g.data.away_team_id]]),
    );
    const knownTeams = new Set(this.#source.teams.map((t) => t.team_id));
    const snapshots = new Map<string, RecordEnvelope>();
    const matches = (r: RecordEnvelope) =>
      gameIds.has(r.data.game_id) &&
      (team
        ? r.data.team_id === team
        : knownTeams.has(r.data.team_id) &&
          !!gameTeams.get(r.data.game_id)?.includes(r.data.team_id)) &&
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
            r.data.player_name,
            { teamId: r.data.team_id },
          );
        } catch {
          /* Refused/ambiguous joins remain explicit null. */
        }
        injury_reports.push({
          report_time: r.availableAt,
          game_id: r.data.game_id,
          team_id: r.data.team_id,
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
    return this.#oddsHistory(input);
  }
  async #oddsHistory(
    input: QueryOddsHistoryInput,
    known?: {
      games: RecordEnvelope[];
      profiles: RecordEnvelope[];
      odds: RecordEnvelope[];
      history?: { boxes: RecordEnvelope[]; summaries: RecordEnvelope[] };
    },
  ): Promise<QueryOddsHistoryResult> {
    const id = input.game_id ?? this.#game.gameId;
    const game = (known?.games ?? (await this.#games())).find(
      (g) =>
        g.id === id &&
        compare(g.data.scheduled_tipoff, this.#game.scheduledStart) <= 0,
    );
    if (!game) return { observations: [], settlements: [] };
    const profiles =
      known?.profiles ??
      this.#eligible(await this.#source.reference("player_profiles"));
    const observations: QueryOddsHistoryResult["observations"] = [];
    for (const r of known?.odds ?? this.#eligible(await this.#source.odds())) {
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
      let history = known?.history;
      if (!history) {
        const boxBatch = await this.#source.history("player_box_scores", game);
        const summaryBatch = await this.#source.history(
          "player_game_summary",
          game,
        );
        history = {
          boxes: boxBatch.reason ? [] : this.#eligible(boxBatch.records),
          summaries: summaryBatch.reason
            ? []
            : this.#eligible(summaryBatch.records),
        };
      }
      const { boxes, summaries } = history;
      // One settled outcome per distinct offered line, not one per snapshot.
      const lines = new Map(
        observations.map((o) => [`${o.player.id}:${o.stat}:${o.line}`, o]),
      );
      for (const o of lines.values()) {
        const { actual, outcome } = resolveOutcome(
          id,
          o.player.id,
          o.stat,
          o.line,
          boxes,
          summaries,
        );
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
  async validateSubmission(value: unknown) {
    if (this.#closed || this.#phase !== "commit")
      throw new SessionError(
        "phase_refused",
        "Submit only before reveal, during commit",
      );
    return validateSubmission(value, await this.questions());
  }
  /** Trusted runner hook, never part of the model tool surface. */
  async resolutionInput(gameId: string): Promise<ResolutionInput> {
    const game = (await this.#games()).find((g) => g.id === gameId);
    if (!game || !visible(releasedGame(game), this.#cutoff))
      throw new SessionError("cutoff_refused", "Outcome data is not released");
    const box = await this.#source.history("player_box_scores", game);
    const summary = await this.#source.history("player_game_summary", game);
    return {
      gameId,
      status: String(game.data.status ?? ""),
      boxes: this.#eligible(box.records),
      summaries: this.#eligible(summary.records),
      boxReason: box.reason,
      summaryReason: summary.reason,
    };
  }

  async read_released_results(
    input: ToolInput<"read_released_results">,
  ): Promise<ToolResult<"read_released_results">> {
    this.#check("read_released_results", input);
    const games: ToolResult<"read_released_results">["games"] = [];
    const schedule = await this.#games();
    for (const record of this.records()) {
      const game = schedule.find((g) => g.id === record.questions.game.game_id);
      if (
        !game ||
        (input.game_id && game.id !== input.game_id) ||
        !visible(releasedGame(game), this.#cutoff)
      )
        continue;
      const resolution =
        record.resolution ?? (await this.resolutionInput(game.id));
      const questions = record.questions.questions.map((q) => {
        const resolved = resolveFrozen(
          resolution,
          q.player.id,
          q.stat,
          q.selected_line,
        );
        const p =
          record.submission?.answers.find(
            (a) => a.question_id === q.question_id,
          )?.p_over ?? null;
        return {
          question_id: q.question_id,
          player: { ...q.player },
          stat: q.stat,
          line: q.selected_line,
          market_p_over: q.p_over,
          agent_p_over: p,
          ...resolved,
          score:
            p === null || !["over", "under"].includes(resolved.outcome)
              ? null
              : this.scorer({
                  ...resolved,
                  agent_p_over: p,
                  market_p_over: q.p_over,
                }),
        };
      });
      games.push({
        game_id: game.id,
        released_at: releaseTime(game.data.scheduled_tipoff),
        questions,
      });
    }
    return {
      games: games.sort(
        (a, b) =>
          compare(a.released_at, b.released_at) ||
          a.game_id.localeCompare(b.game_id),
      ),
    };
  }
  /** Runner-only clock advancement; never included in the agent tool surface. */
  async transition(phase: LifecyclePhase, cutoff: string) {
    if (this.#closed) throw new SessionError("phase_refused", "Session closed");
    this.#lifecycle.advance(phase, cutoff);
    if (phase === "checkpoint") {
      this.#closed = true;
      return;
    }
    if (phase === "initialize")
      throw new SessionError("phase_refused", "Already initialized");
    this.#phase = phase;
    this.#cutoff = this.#lifecycle.cutoff;
    this.#evidenceIndex = undefined;
  }
  async call<N extends ToolName>(
    name: N,
    input: ToolInput<N>,
    signal: AbortSignal,
  ): Promise<ToolResult<N>> {
    this.#check(name, input);
    if (name.startsWith("workspace_")) {
      if (!this.#workspace)
        throw new SessionError(
          "capability_disabled",
          "Workspace is not installed",
        );
      const args = input as { path?: string; content?: string };
      const w = this.#workspace;
      const result =
        name === "workspace_list"
          ? w.list(args.path)
          : name === "workspace_read"
            ? w.read(args.path!)
            : w.mutate(
                name.slice(10) as "write" | "append" | "delete",
                args.path!,
                Buffer.from(args.content ?? "", "utf8"),
              );
      return result as ToolResult<N>;
    }
    const methods = {
      read_released_results: this.read_released_results.bind(this),
      search_evidence: this.search_evidence.bind(this),
      list_evidence: this.list_evidence.bind(this),
      fetch_evidence: this.fetch_evidence.bind(this),
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
  async assertCodeAllowed(program: string) {
    this.#check("execute_code", { program });
  }
  async exportTo(directory: string, signal: AbortSignal) {
    this.#check("execute_code", { program: "pass" });
    if (this.#config.profile.capabilities.enabled.includes("game_history")) {
      const games = (await this.#games()).filter((game) =>
        visible(releasedGame(game), this.#cutoff),
      );
      await mountGameShards(
        directory,
        this.#source,
        games,
        this.#cutoff,
        signal,
      );
    }
    return writeSessionExport(directory, this.#exportBatches(signal), signal);
  }
  async *#exportBatches(signal: AbortSignal): AsyncGenerator<ExportBatch> {
    const enabled = this.#config.profile.capabilities.enabled;
    const games = await this.#games();
    yield {
      table: "session",
      rows: [
        {
          game_id: this.#game.gameId,
          phase: this.#phase,
          cutoff: this.#cutoff,
          dataset_versions: this.#source.versions,
        },
      ],
    };
    yield {
      table: "questions",
      rows: (await this.list_questions({})).questions,
    };
    if (enabled.includes("game_history")) {
      for (const table of PLAYER_REFERENCE_TABLES) {
        const definitions = await this.#source.columns(table);
        yield {
          table,
          rows: this.#eligible(await this.#source.reference(table)).map((r) =>
            projectHistory(r, definitions, this.#cutoff),
          ),
          columns: definitions.map((c) =>
            c.name === "type" ? "kind" : c.name,
          ),
        };
      }
    }
    if (enabled.includes("game_history")) {
      const result = await this.#scheduleAndInjuries({});
      yield { table: "injuries", rows: result.injury_reports };
      yield { table: "injury_team_snapshots", rows: result.team_snapshots };
      yield { table: "schedule", rows: result.schedule };
    }
    if (enabled.includes("odds_history")) {
      yield { table: "odds_history", rows: [] };
      yield { table: "odds_settlements", rows: [] };
      const oddsByGame = new Map<string, RecordEnvelope[]>();
      for (const r of this.#eligible(await this.#source.odds())) {
        const id = this.#source.identities.resolve(
          "game",
          "espn",
          r.data.espn_event_id,
        );
        const rows = oddsByGame.get(id) ?? [];
        rows.push(r);
        oddsByGame.set(id, rows);
      }
      const profiles = this.#eligible(
        await this.#source.reference("player_profiles"),
      );
      const settlementHistory = new Map<
        string,
        { boxes: RecordEnvelope[]; summaries: RecordEnvelope[] }
      >();
      const released = games.filter(
        (g) =>
          oddsByGame.has(g.id) &&
          visible(releasedGame(g), this.#cutoff) &&
          compare(g.data.scheduled_tipoff, this.#game.scheduledStart) <= 0,
      );
      for (const game of released)
        settlementHistory.set(game.id, { boxes: [], summaries: [] });
      for (const table of [
        "player_box_scores",
        "player_game_summary",
      ] as const) {
        async function* individual(source: SessionSource) {
          for (const game of released)
            yield { gameId: game.id, ...(await source.history(table, game)) };
        }
        for await (const batch of this.#source.exportHistory?.(
          table,
          released,
        ) ?? individual(this.#source)) {
          signal.throwIfAborted();
          const entry = settlementHistory.get(batch.gameId);
          if (!entry)
            throw Error("Settlement adapter returned an unselected game");
          if (!batch.reason)
            entry[table === "player_box_scores" ? "boxes" : "summaries"].push(
              ...this.#eligible(batch.records),
            );
        }
      }
      for (const game of games.filter((g) => oddsByGame.has(g.id))) {
        signal.throwIfAborted();
        const result = await this.#oddsHistory(
          { game_id: game.id },
          {
            games,
            profiles,
            odds: oddsByGame.get(game.id)!,
            history: settlementHistory.get(game.id),
          },
        );
        yield { table: "odds_history", rows: result.observations };
        yield { table: "odds_settlements", rows: result.settlements };
      }
    }
    if (enabled.includes("search_and_fetch")) {
      const evidence = (await this.#evidence()).all();
      yield { table: "evidence", rows: evidence };
      for (const source of ["posts", "transcripts", "lineups"] as const)
        yield {
          table: source,
          rows: evidence.filter((e) => e.source === source),
        };
    }
    const released = await this.read_released_results({});
    yield {
      table: "released_results",
      rows: released.games.flatMap((g) =>
        g.questions.map((q) => ({
          game_id: g.game_id,
          released_at: g.released_at,
          ...q,
        })),
      ),
    };
  }
  /** Trusted P3f integration; all calls use the same service and live policy as tools. */
  workspaceForSandbox() {
    const w = this.#workspace;
    if (!w || !this.#config.profile.capabilities.enabled.includes("workspace"))
      return undefined;
    return Object.freeze({
      authorize: w.authorize.bind(w),
      mkdir: w.mkdir.bind(w),
      list: w.list.bind(w),
      readBytes: w.readBytes.bind(w),
      mutate: w.mutate.bind(w),
    });
  }
  workspaceChanges() {
    return this.#workspace?.changes() ?? [];
  }
  async close() {
    this.#closed = true;
  }
}

/** Trusted adapter: durable records stay behind the tool boundary. */
export function sessionEnvironment(
  config: RunConfig,
  source: SessionSource,
  hooks: Partial<Pick<Environment, "validateSubmission" | "execute">> & {
    scorer?: QuestionScorer;
  } = {},
): EnvironmentFactory {
  return async (context, trusted) => {
    const session = new Session(
      config,
      context.game,
      context.phase,
      context.cutoff,
      source,
      trusted.results,
      hooks.scorer,
      trusted.workspace,
      trusted.root,
    );
    let sandbox: DockerSandbox | undefined;
    return {
      workspace: session.workspaceForSandbox(),
      workspaceChanges: () => session.workspaceChanges(),
      context: (budget) => session.context(budget),
      questions: () => session.questions(),
      resolutionInput: () => session.resolutionInput(context.game.gameId),
      transition: (phase, cutoff) => session.transition(phase, cutoff),
      call: (name, input, signal) => {
        validateInput(name, input);
        return session.call(name, input as never, signal);
      },
      validateSubmission:
        hooks.validateSubmission ??
        ((value) => session.validateSubmission(value)),
      execute:
        hooks.execute ??
        (async (program, limits, signal) => {
          // Check the current phase before lazy export/container creation on every call.
          await session.assertCodeAllowed(program);
          sandbox ??= new DockerSandbox(
            config,
            (directory, abort) => session.exportTo(directory, abort),
            session.workspaceForSandbox(),
            trusted.root,
          );
          return sandbox.execute(program, limits, signal);
        }),
      close: async () => {
        await session.close();
        await sandbox?.close();
      },
    };
  };
}
