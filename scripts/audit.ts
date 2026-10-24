import { mkdir, readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { openCorpus } from "../src/data/corpus.js";
import { DopplerStore, sha256 } from "../src/data/store.js";
import {
  Identities,
  injuryPlayerName,
  NameResolutionError,
  normalizeName,
} from "../src/data/identity.js";
import { instant, nextMorning } from "../src/data/time.js";
import { Temporal } from "@js-temporal/polyfill";
import type { Row, RecordEnvelope } from "../src/data/contracts.js";
import {
  auditKey,
  checkConsensus,
  nearCutoff,
  outcome,
  sample,
} from "../src/audit/checks.js";
const BOS = "1610612738",
  seed = "SPO-777-v1";
const utc = (v: any) => instant(v instanceof Date ? v.toISOString() : v);
const eastDate = (v: any) =>
  Temporal.Instant.from(utc(v))
    .toZonedDateTimeISO("America/New_York")
    .toPlainDate()
    .toString();
const raw = new DopplerStore();
try {
  const c = await openCorpus(raw, process.cwd(), ".cache/objects");
  // Audit-only memoization of immutable verified table decodes. Each of 82
  // adapter calls otherwise decodes the same season partition again. The adapter
  // still performs its normal per-game coverage filtering and envelope projection.
  const readRows = c.pbp.release.rows.bind(c.pbp.release);
  const decoded = new Map<string, Promise<Row[]>>();
  c.pbp.release.rows = (key: string) => {
    if (!/\/tables\/(player_box_scores|v_player_game_summary)\//.test(key))
      return readRows(key);
    if (!decoded.has(key)) decoded.set(key, readRows(key));
    return decoded.get(key)!;
  };
  const write = async (name: string, value: unknown) =>
    writeFile(
      `docs/evidence/audit/${name}.json`,
      JSON.stringify(value, null, 2) + "\n",
    );
  await mkdir("docs/evidence/audit", { recursive: true });
  const odds = await c.odds.auditRows(),
    coverage = await c.pbp.coverage();
  const oddsRef = [...c.odds.release.objects.values()].find((r) =>
    r.key.endsWith("consensus.ndjson.gz"),
  )!;
  const games = (await c.pbp.games()).filter(
    (g) => g.data.home_team_id === BOS || g.data.away_team_id === BOS,
  );
  const ids = new Identities();
  const mappings = JSON.parse(await readFile("config/identities.json", "utf8"));
  for (const mapping of mappings) ids.add(mapping);
  const exceptions = await c.players.records("player_identity_exceptions");
  for (const r of exceptions)
    ids.excludeNameCandidate("player", r.data.player_id);
  const profiles = await c.players.records();
  for (const p of profiles)
    ids.addName("player", p.data.full_name, p.data.player_id);
  const pbpPlayers = await c.pbp.release.table("players");
  for (const adapter of [c.pbp, c.priorPbp])
    for (const { row } of await adapter.release.table("players"))
      ids.addName("player", row.name, row.player_id);
  const join = (name: string) => {
    try {
      return { id: ids.byName("player", name) };
    } catch (e) {
      if (!(e instanceof NameResolutionError)) throw e;
      return { id: null, problem: e.kind, candidates: e.candidates };
    }
  };
  const own = await c.celticsLineups.records(),
    opponent = await c.opponentLineups.records();
  const lineups = [...own, ...opponent];
  const posts = await c.posts.records(),
    postRows = await c.posts.auditRows(),
    transcripts = await c.transcripts.records();
  const scheduleKey = [...c.oddsArchive.objects.keys()].find((k) =>
    k.endsWith("schedule-response.json.gz"),
  )!;
  const espnJson = async (key: string) =>
    JSON.parse(
      JSON.parse(gunzipSync(await c.oddsArchive.bytes(key)).toString()).rawBody,
    );
  const schedule = await espnJson(scheduleKey);
  const gameMap = new Map(games.map((g) => [g.id, g]));
  const scheduleRows = games
    .map((g) => {
      const espnId = mappings.find(
        (m: Row) =>
          m.entity === "game" &&
          m.provider === "espn" &&
          m.canonicalId === g.id,
      )?.providerId;
      const event = schedule.events.find((e: Row) => e.id === espnId);
      const cutoffRows = odds.filter(
        (r) =>
          r.espn_event_id === espnId && r.snapshot_kind === "scheduled_start",
      );
      const requested = [
        ...new Set(cutoffRows.map((r) => utc(r.requested_at))),
      ];
      const starts = [
        ...new Set(cutoffRows.map((r) => utc(r.scheduled_start))),
      ];
      const nba = utc(g.data.scheduled_tipoff),
        espn = event ? utc(event.date) : null;
      return {
        gameId: g.id,
        espnId,
        nba,
        espn,
        requested,
        starts,
        cutoff: nba,
        rows: cutoffRows.length,
        agrees:
          !!event &&
          requested.length === 1 &&
          requested[0] === nba &&
          espn === nba &&
          starts.length === 1 &&
          starts[0] === nba,
        evidence: [
          g.provenance.object,
          c.oddsArchive.ref(scheduleKey),
          oddsRef,
        ],
      };
    })
    .sort((a, b) => a.cutoff.localeCompare(b.cutoff));
  if (games.length !== 82) throw Error("Expected 82 games");
  await write("schedule", scheduleRows);
  const byEspn = new Map(scheduleRows.map((g) => [g.espnId, g]));
  // Group boundary records by source object/time/cutoff, retaining every record ID.
  const boundary = new Map<string, Row>(),
    sourceCounts: Record<string, number> = {};
  function boundaryRecord(r: RecordEnvelope, source = r.source) {
    sourceCounts[source] = (sourceCounts[source] ?? 0) + 1;
    for (const g of scheduleRows)
      if (nearCutoff(r.availableAt, g.cutoff)) {
        const key = JSON.stringify([
          source,
          r.provenance.object.sha256,
          r.availableAt,
          g.gameId,
        ]);
        let group = boundary.get(key);
        if (!group) {
          group = {
            source,
            gameId: g.gameId,
            cutoff: g.cutoff,
            availableAt: r.availableAt,
            deltaSeconds:
              (Date.parse(r.availableAt) - Date.parse(g.cutoff)) / 1000,
            convention: r.availabilityConvention,
            object: r.provenance.object,
            ids: [],
          };
          boundary.set(key, group);
        }
        group.ids.push(r.id);
      }
  }
  for (const r of await c.odds.records()) boundaryRecord(r);
  for (const r of [
    ...posts,
    ...transcripts,
    ...lineups,
    ...(await c.pbp.games()),
  ])
    boundaryRecord(r);
  for (const table of [
    "player_profiles",
    "player_reference",
    "player_season_stats",
    "player_2024_25_summary",
    "player_career_summary",
    "player_identity_exceptions",
  ])
    for (const r of await c.players.records(table))
      boundaryRecord(r, `player-reference:${table}`);
  const injuryNames = new Map<string, Row>(),
    finalInjuries = new Map<string, RecordEnvelope>();
  console.log(
    "Auditing injury identities, final printed reports, and cutoff boundaries",
  );
  for (const kind of ["teams", "players"] as const)
    for await (const partition of c.injuries.partitions(kind))
      for (const r of partition) {
        boundaryRecord(r, `injuries:${kind}`);
        const g = gameMap.get(r.data.game_id);
        if (
          kind === "teams" &&
          g &&
          (r.data.team_id === g.data.home_team_id ||
            r.data.team_id === g.data.away_team_id) &&
          Date.parse(r.availableAt) < Date.parse(utc(g.data.scheduled_tipoff))
        ) {
          const key = `${g.id}:${r.data.team_id}`,
            prev = finalInjuries.get(key);
          if (!prev || Date.parse(r.availableAt) > Date.parse(prev.availableAt))
            finalInjuries.set(key, r);
        }
        if (kind === "players" && r.data.player_name) {
          const name = r.data.player_name;
          let match = injuryNames.get(name);
          if (!match) {
            match = {
              name,
              ...join(injuryPlayerName(name)),
              count: 0,
              gameIds: new Set<string>(),
              teams: new Set<string>(),
              evidence: r.provenance.object,
            };
            injuryNames.set(name, match);
          }
          match.count++;
          match.teams.add(r.data.team_id);
          if (g) match.gameIds.add(g.id);
        }
      }
  const injuryIdentities: Row[] = [...injuryNames.values()]
    .map((r): Row => ({
      ...r,
      gameIds: [...r.gameIds].sort(),
      teams: [...r.teams].sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const propped = [
    ...new Map(odds.map((r) => [r.espn_player_id, r])).values(),
  ].map((r) => {
    const matched = join(r.player_name),
      id = matched.id;
    return {
      name: r.player_name,
      espnId: r.espn_player_id,
      ...matched,
      storedId: ids.resolve("player", "espn", r.espn_player_id),
      pbp: pbpPlayers
        .filter((p) => p.row.player_id === id)
        .map((p) => ({ name: p.row.name, evidence: p.ref })),
      reference: profiles
        .filter((p) => p.data.player_id === id)
        .map((p) => ({
          name: p.data.full_name,
          evidence: p.provenance.object,
        })),
      injuries: injuryIdentities
        .filter((n) => n.id === id)
        .map((n) => ({ name: n.name, count: n.count, evidence: n.evidence })),
      lineups: lineups.flatMap((l) =>
        l.data.startingLineup
          .filter((n: string) => join(n).id === id)
          .map((n: string) => ({
            name: n,
            gameId: l.data.gameId,
            side: l.data.side,
          })),
      ),
      oddsEvidence: oddsRef,
    };
  });
  const lineupNames = [
    ...new Set<string>(lineups.flatMap((r) => r.data.startingLineup)),
  ]
    .sort()
    .map((name) => ({
      name,
      ...join(name),
      occurrences: lineups
        .filter((l) => l.data.startingLineup.includes(name))
        .map((l) => ({
          id: l.id,
          gameId: l.data.gameId,
          side: l.data.side,
          object: l.provenance.object,
        })),
    }));
  const rawLineupNames = [];
  for (const adapter of [c.celticsLineups, c.opponentLineups]) {
    const rawRows = await adapter.auditRows();
    for (const name of [
      ...new Set<string>(rawRows.flatMap((r) => r.startingLineup)),
    ].sort())
      rawLineupNames.push({
        name,
        side: adapter.side,
        ...join(name),
        object: adapter.root,
        occurrences: rawRows
          .filter((r) => r.startingLineup.includes(name))
          .map((r) => ({
            gameId: r.gameId,
            postId: r.postId,
            phase: r.phase,
            preferred: r.preferredForGame ?? null,
          })),
      });
  }
  await write("identity", {
    propped,
    lineupNames,
    rawLineupNames,
    injuryNames: injuryIdentities,
    candidateProfiles: profiles
      .filter((p) =>
        /dillon jones|jaylin williams|hansen|yang/i.test(p.data.full_name),
      )
      .map((p) => ({
        id: p.data.player_id,
        name: p.data.full_name,
        birthDate: p.data.birth_date,
        openingTeamId: p.data.opening_team_id,
        object: p.provenance.object,
      })),
  });
  const lineupTimes = lineups.map((r) => {
    const g = byEspn.get(r.data.gameId)!;
    const minutes = (Date.parse(r.availableAt) - Date.parse(g.cutoff)) / 60000;
    return {
      id: r.id,
      gameId: g.gameId,
      side: r.data.side,
      at: r.availableAt,
      cutoff: g.cutoff,
      minutes,
      plausible: minutes >= -180 && minutes < 0,
      classification:
        minutes >= 0
          ? "convention_error"
          : minutes < -180
            ? "data_error"
            : null,
      url: r.data.url,
      object: r.provenance.object,
    };
  });
  const finalReports = scheduleRows.flatMap((g) =>
    [
      gameMap.get(g.gameId)!.data.home_team_id,
      gameMap.get(g.gameId)!.data.away_team_id,
    ].map((teamId) => {
      const r = finalInjuries.get(`${g.gameId}:${teamId}`);
      return {
        gameId: g.gameId,
        teamId,
        cutoff: g.cutoff,
        id: r?.id ?? null,
        printedAt: r?.availableAt ?? null,
        minutesBefore: r
          ? (Date.parse(g.cutoff) - Date.parse(r.availableAt)) / 60000
          : null,
        state: r?.data.observed_state ?? null,
        object: r?.provenance.object ?? null,
        pdfSha256: r?.data.pdf_sha256 ?? null,
      };
    }),
  );
  // Associate title-qualified media to nearest scheduled Celtics game across ALL phases,
  // without conditioning on before/after. Keep candidate + delta for manual review.
  const allGames = (await c.pbp.release.table("games")).filter(
    (g) => g.row.home_team_id === BOS || g.row.away_team_id === BOS,
  );
  const transcriptTimes = transcripts
    .filter((r) => /pre[ -]?game|post[ -]?game|postgane/i.test(r.data.title))
    .map((r) => {
      const kind = /pre[ -]?game/i.test(r.data.title) ? "pregame" : "postgame";
      const candidates = [...allGames].sort(
        (a, b) =>
          Math.abs(
            Date.parse(utc(a.row.scheduled_tipoff)) -
              Date.parse(r.data.published_at),
          ) -
          Math.abs(
            Date.parse(utc(b.row.scheduled_tipoff)) -
              Date.parse(r.data.published_at),
          ),
      );
      const g = candidates[0],
        hours =
          (Date.parse(r.data.published_at) -
            Date.parse(utc(g.row.scheduled_tipoff))) /
          3600000;
      return {
        id: r.id,
        title: r.data.title,
        url: r.data.url,
        publishedAt: r.data.published_at,
        availableAt: r.availableAt,
        candidateGameId: g.row.game_id,
        phase: g.row.phase,
        scheduledStart: utc(g.row.scheduled_tipoff),
        hours,
        plausible:
          Math.abs(hours) <= 24 && (kind === "pregame" ? hours < 0 : hours > 0),
        kind,
        object: r.provenance.object,
        gameObject: g.ref,
      };
    });
  const postWindow = {
    start: "2025-09-29T04:00:00Z",
    endExclusive: "2026-04-13T04:00:00Z",
  };
  const postViolations = postRows
    .filter(
      (r) =>
        Date.parse(r.post.publishedAt) < Date.parse(postWindow.start) ||
        Date.parse(r.post.publishedAt) >= Date.parse(postWindow.endExclusive),
    )
    .map((r) => ({ id: r.post.postId, publishedAt: r.post.publishedAt }));
  await write("timestamps", {
    lineupTimes,
    finalReports,
    transcriptTimes,
    postWindow,
    postCount: postRows.length,
    postViolations,
  });
  console.log("Checking all 82 official box scores and participation evidence");
  const resolution: Row[] = [],
    espnBoxes = new Map<string, Row>();
  for (const [i, g] of scheduleRows.entries()) {
    const boxes = await c.pbp.records("player_box_scores", g.gameId),
      summaries = await c.pbp.records("v_player_game_summary", g.gameId);
    const status = coverage.find(
      (r) => r.game_id === g.gameId && r.product === "summaries",
    )?.quality_status;
    const key = [...c.oddsArchive.objects.keys()].find((k) =>
      k.endsWith(`/game=${g.espnId}/boxscore-response.json.gz`),
    )!;
    if (g.gameId === "0022500338")
      await write("dec5-fallback", {
        gameId: g.gameId,
        summaryStatus: status,
        servedSummaryRows: summaries.length,
        boxRows: boxes.length,
        players: boxes.map((b) => ({
          id: b.data.player_id,
          teamId: b.data.team_id,
          seconds: b.data.minutes_seconds,
          points: b.data.points,
          rebounds: b.data.rebounds,
          assists: b.data.assists,
          didNotPlay: b.data.minutes_seconds === 0,
          object: b.provenance.object,
        })),
      });
    const espn = await espnJson(key);
    espnBoxes.set(g.espnId, { data: espn, ref: c.oddsArchive.ref(key) });
    const athletes = espn.boxscore.players.flatMap((t: Row) =>
      t.statistics.flatMap((s: Row) =>
        s.athletes.map((a: Row) => ({
          ...a,
          labels: s.labels,
          teamId: t.team.id,
        })),
      ),
    );
    const playerRows = [
      ...new Map(
        odds
          .filter((r) => r.espn_event_id === g.espnId)
          .map((r) => [r.espn_player_id, r]),
      ).values(),
    ];
    for (const r of playerRows) {
      const id = ids.resolve("player", "espn", r.espn_player_id),
        bs = boxes.filter((b) => b.data.player_id === id),
        ss = summaries.filter((b) => b.data.player_id === id);
      const box = bs[0],
        summary = ss[0],
        ea = athletes.filter((a: Row) => a.athlete.id === r.espn_player_id);
      const seconds =
        status === "partial"
          ? (box?.data.minutes_seconds ?? null)
          : summary && typeof summary.data.reconstructed_minutes === "number"
            ? summary.data.reconstructed_minutes * 60
            : null;
      const absenceConfirmed =
        !box && ea.length === 1 && ea[0].didNotPlay === true;
      const actual = box
        ? {
            points: box.data.points,
            rebounds: box.data.rebounds,
            assists: box.data.assists,
          }
        : null;
      const issues: string[] = [];
      if (bs.length > 1 || ss.length > 1) issues.push("duplicate player row");
      if (!box && !absenceConfirmed)
        issues.push(
          "missing official box score without explicit DNP corroboration",
        );
      if (seconds === null && !absenceConfirmed)
        issues.push("missing participation evidence");
      if (
        actual &&
        Object.values(actual).some((v) => !Number.isInteger(v) || v < 0)
      )
        issues.push("invalid official stat");
      if (ea.length > 1) issues.push("duplicate ESPN athlete");
      if (
        ea.length === 1 &&
        normalizeName(ea[0].athlete.displayName) !==
          normalizeName(r.player_name)
      )
        issues.push("ESPN/name identity disagreement");
      if (ea.length === 1 && ea[0].teamId !== "2")
        issues.push("propped ESPN athlete not on Celtics");
      if (box && box.data.team_id !== BOS)
        issues.push("propped player not on Celtics in box score");
      if (
        summary &&
        box &&
        (seconds === 0) !== (box.data.minutes_seconds === 0)
      )
        issues.push("participation disagreement");
      resolution.push({
        gameId: g.gameId,
        espnId: g.espnId,
        playerId: id,
        espnPlayerId: r.espn_player_id,
        name: r.player_name,
        actual,
        seconds: absenceConfirmed ? 0 : seconds,
        participationBasis:
          status === "partial"
            ? "box_score_minutes_fallback"
            : absenceConfirmed
              ? "ESPN_explicit_DNP_box_absence"
              : "pbp_reconstructed_minutes",
        boxMinutes: box?.data.minutes_seconds ?? null,
        summaryStatus: status,
        espnPresent: ea.length,
        espnName: ea[0]?.athlete.displayName ?? null,
        espnDidNotPlay: ea[0]?.didNotPlay ?? null,
        issues,
        evidence: {
          box: box?.provenance.object ?? null,
          summary: summary?.provenance.object ?? null,
          espn: c.oddsArchive.ref(key),
        },
      });
    }
    if (i % 10 === 0) console.log(`Verified ${i + 1}/82 games`);
  }
  await write("resolution", resolution);
  const pairsKey = [...c.odds.release.objects.keys()].find((k) =>
    k.endsWith("book-lines.ndjson.gz"),
  )!;
  const pairs = Map.groupBy(await c.odds.release.rows(pairsKey), auditKey);
  const consensusSample = sample(
    odds.filter((r) => r.status === "ok"),
    50,
    `${seed}:consensus`,
    auditKey,
  ).map((r) => checkConsensus(r, pairs.get(auditKey(r)) ?? []));
  await write("consensus-sample", {
    seed: `${seed}:consensus`,
    population: odds.filter((r) => r.status === "ok").length,
    evidence: [oddsRef, c.odds.release.ref(pairsKey)],
    rows: consensusSample,
  });
  const cutoffOdds = odds.filter(
    (r) => r.status === "ok" && r.snapshot_kind === "scheduled_start",
  );
  const outcomeSample = sample(
    cutoffOdds,
    50,
    `${seed}:outcomes`,
    auditKey,
  ).map((r) => {
    const g = byEspn.get(r.espn_event_id)!,
      res = resolution.find(
        (b) =>
          b.espnId === r.espn_event_id && b.espnPlayerId === r.espn_player_id,
      )!;
    const e = espnBoxes.get(r.espn_event_id)!;
    const athletes = e.data.boxscore.players.flatMap((t: Row) =>
      t.statistics.flatMap((s: Row) =>
        s.athletes.map((a: Row) => ({ ...a, labels: s.labels })),
      ),
    );
    const matches = athletes.filter(
        (a: Row) => a.athlete.id === r.espn_player_id,
      ),
      a = matches[0];
    const label: Record<string, string> = {
      player_points: "PTS",
      player_rebounds: "REB",
      player_assists: "AST",
    };
    const value = a?.stats[a.labels.indexOf(label[r.prop_type])];
    const stat =
      value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
    const actual = res.actual?.[r.prop_type.replace("player_", "")] ?? null;
    const officialOutcome = outcome(actual, r.selected_line, res.seconds);
    const secondOutcome =
      a?.didNotPlay === true
        ? "did_not_play"
        : outcome(stat, r.selected_line, a?.didNotPlay === false ? 1 : null);
    return {
      key: auditKey(r),
      gameId: g.gameId,
      name: r.player_name,
      prop: r.prop_type,
      line: r.selected_line,
      actual,
      espnActual: stat,
      officialOutcome,
      espnOutcome: secondOutcome,
      agrees:
        matches.length === 1 &&
        officialOutcome !== "unresolved" &&
        officialOutcome === secondOutcome &&
        (officialOutcome === "did_not_play" || actual === stat),
      evidence: res.evidence,
    };
  });
  await write("outcome-sample", {
    seed: `${seed}:outcomes`,
    population: cutoffOdds.length,
    rows: outcomeSample,
  });
  // PBP records share a game-level next-morning timestamp for every table. Check
  // every regular-season game's timestamp in both releases; expand tables only if
  // one intersects a cutoff (none in these pinned schedules).
  const pbpBoundaryTimes: Row[] = [];
  for (const [name, adapter] of [
    ["2024-25", c.priorPbp],
    ["2025-26", c.pbp],
  ] as const) {
    const gs = await adapter.games();
    for (const g of gs) {
      const at = nextMorning(eastDate(g.data.scheduled_tipoff));
      for (const cutoff of scheduleRows)
        if (nearCutoff(at, cutoff.cutoff))
          pbpBoundaryTimes.push({
            release: name,
            gameId: g.id,
            at,
            cutoffGame: cutoff.gameId,
          });
    }
  }
  if (pbpBoundaryTimes.length)
    throw Error(
      "PBP boundary intersects cutoff: expand table records before publishing audit",
    );
  const boundaryRows = [...boundary.values()].sort((a, b) =>
    JSON.stringify([
      a.gameId,
      a.source,
      a.availableAt,
      a.object.key,
    ]).localeCompare(
      JSON.stringify([b.gameId, b.source, b.availableAt, b.object.key]),
    ),
  );
  await writeFile(
    "docs/evidence/audit/boundary-records.jsonl",
    boundaryRows
      .map((r) => JSON.stringify({ ...r, ids: r.ids.sort() }))
      .join("\n") + "\n",
  );
  const boundaryCounts: Record<string, number> = {};
  for (const r of boundaryRows)
    boundaryCounts[r.source] = (boundaryCounts[r.source] ?? 0) + r.ids.length;
  const selectedTranscripts = sample(
    transcripts,
    20,
    `${seed}:transcripts`,
    (r) => r.id,
  );
  const labelled = postRows.filter((r) => r.relevance.relevant === true);
  const selectedPosts = sample(
    labelled,
    50,
    `${seed}:posts`,
    (r) => `${r.post.accountId}:${r.post.postId}:${r.post.versionId}`,
  );
  await write("content-sample", {
    seed,
    transcriptPopulation: transcripts.length,
    postPopulation: labelled.length,
    transcripts: selectedTranscripts.map((r) => ({
      id: r.id,
      title: r.data.title,
      url: r.data.url,
      object: r.provenance.object,
      textSha256: sha256(Buffer.from(r.data.readable)),
    })),
    posts: selectedPosts.map((r) => ({
      id: `${r.post.accountId}:${r.post.postId}:${r.post.versionId}`,
      text: r.post.text,
      retainedContext: r.post.references.map((ref: Row) => ({
        id: ref.postId,
        type: ref.type,
        text:
          postRows.find((p) => p.post.postId === ref.postId)?.post.text ?? null,
      })),
      url: `https://x.com/i/status/${r.post.postId}`,
      object: c.posts.release.ref(c.posts.release.manifest.rows.objectKey),
    })),
  });
  await mkdir(".cache/audit-content", { recursive: true });
  for (const [i, r] of selectedTranscripts.entries())
    await writeFile(
      `.cache/audit-content/${String(i + 1).padStart(2, "0")}.txt`,
      `${r.id}\n${r.data.title}\n${r.data.url}\n\n${r.data.readable}`,
    );
  await write("summary", {
    schemaVersion: 1,
    seed,
    versions: c.versions,
    mappingSha256: sha256(await readFile("config/identities.json")),
    schedule: {
      games: games.length,
      disagreements: scheduleRows.filter((r) => !r.agrees).length,
    },
    identities: {
      propped: propped.length,
      lineupNames: lineupNames.length,
      injuryNames: injuryNames.size,
      unresolvedInjuries: injuryIdentities.filter((r) => !r.id).length,
    },
    timestamps: {
      lineups: lineups.length,
      lineupViolations: lineupTimes.filter((r) => !r.plausible).length,
      finalReports: finalReports.length,
      missingFinalReports: finalReports.filter((r) => !r.id).length,
      transcriptTitles: transcriptTimes.length,
      transcriptFlags: transcriptTimes.filter((r) => !r.plausible).length,
      postViolations: postViolations.length,
    },
    resolution: {
      gamePlayers: resolution.length,
      findings: resolution.filter((r) => r.issues.length).length,
      consensusSample: consensusSample.length,
      consensusDisagreements: consensusSample.filter((r) => r.problems.length)
        .length,
      outcomeSample: outcomeSample.length,
      outcomeDisagreements: outcomeSample.filter((r) => !r.agrees).length,
    },
    availability: {
      windowMinutes: 30,
      sourceCounts,
      boundaryCounts,
      pbpBoundaryTimes,
    },
    content: {
      transcripts: selectedTranscripts.length,
      posts: selectedPosts.length,
      reviewFile: "content-review.json",
    },
  });
  console.log(
    "Audit evidence written to docs/evidence/audit; content samples require qualitative review.",
  );
} finally {
  raw.close();
}
