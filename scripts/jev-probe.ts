// Jev contamination probe for the five v5 teams (SPO-906). Builds true/false
// statements about regular-season facts from the pinned releases, sends them to
// Jev with an empty state, and stores what it answered with summary statistics.
//
//   npx tsx scripts/jev-probe.ts --dry-run
//   doppler run --project nba-agent --config prd -- npx tsx scripts/jev-probe.ts --out=docs/evidence/v5-probe
//
// Truth never enters a request. 2024-25 is the comparison group. Only outcomes
// released before the holdout are used. Eligibility is decided from schedule
// columns, and only eligible games' row ranges are decoded from the box-score
// files (src/harness/jev-probe-source.ts).
import { mkdirSync, writeFileSync } from "node:fs";
import { Temporal } from "@js-temporal/polyfill";
import { openCorpus } from "../src/data/corpus.js";
import { DopplerStore } from "../src/data/store.js";
import { teamIds, teamNames, teams } from "../src/data/teams.js";
import { PlayByPlayAdapter } from "../src/data/adapters.js";
import { parquet } from "../src/data/release.js";
import {
  eligibleGame,
  readAllowedRows,
  type GameIndex,
} from "../src/harness/jev-probe-source.js";
import { holdout } from "../src/evaluation/service/profile.js";
import { loadSeasonRoster } from "../src/projection/roster.js";
import {
  appearanceFacts,
  selectAppearances,
  summarize,
  summarizeGroups,
  winLossFacts,
  type ProbeAppearance,
  type ProbeFact,
  type ProbeGame,
  type ProbeRow,
} from "../src/harness/jev-probe.js";

const MODEL = "jev-1.14.0";
const BATCH = 40;
const dryRun = process.argv.includes("--dry-run");
const out =
  process.argv.find((a) => a.startsWith("--out="))?.slice(6) ?? ".cache";
const five = new Set<string>(Object.values(teamIds));
const opened: { table: string; file: string; start: number; end: number }[] =
  [];
const kindSeason = (r: ProbeRow) => r.group.split(":").slice(0, 2).join(":");
const statistics = (rows: ProbeRow[]) => ({
  chance: { accuracy: 0.5, brier: 0.25, discrimination: 0 },
  pooled: summarizeGroups(rows, kindSeason),
  byTeam: summarizeGroups(rows, (r) => r.group),
  all: summarize(rows),
  facts: rows,
});
const key = process.env.TYPESAFE_API_KEY;
delete process.env.TYPESAFE_API_KEY;
const store = new DopplerStore();
try {
  const corpus = await openCorpus(store, process.cwd(), ".cache/objects");
  const facts: ProbeFact[] = [];
  for (const adapter of [corpus.priorPbp, corpus.pbp]) {
    const release = adapter.release,
      m = release.manifest;
    // The team dimension holds names only, no outcomes.
    const names = new Map<string, string>();
    for (const part of m.tables.teams)
      for (const t of await release.rows(m.object_prefix + part))
        names.set(t.team_id, t.name);
    // Eligibility comes from schedule columns alone: the projection-only
    // adapter decodes no score or status. A game counts when its outcome was
    // released before the holdout, which is the morning after it was played.
    const schedule = await new PlayByPlayAdapter(release, true).games();
    const eligible = schedule.filter(
      (g) =>
        (five.has(g.data.home_team_id) || five.has(g.data.away_team_id)) &&
        eligibleGame(g.data.scheduled_tipoff, holdout),
    );
    const allowed = new Set(eligible.map((g) => g.id));
    // Outcome files are opened only where they hold an allowed game, and only
    // those games' row ranges are decoded.
    const index: Record<string, GameIndex> = JSON.parse(
      (await release.bytes(m.object_prefix + m.game_index)).toString(),
    ).tables;
    const read = (table: string) =>
      readAllowedRows<any>(index[table] ?? {}, allowed, async (file, a, b) => {
        if (!m.tables[table].includes(file))
          throw Error("Game index references an unlisted table file");
        opened.push({ table, file, start: a, end: b });
        return parquet(await release.bytes(m.object_prefix + file), {
          rowStart: a,
          rowEnd: b,
        });
      });
    const points = new Map<string, number>();
    for (const r of await read("team_box_scores"))
      points.set(`${r.game_id}:${r.team_id}`, r.points);
    const played = new Map<string, Set<string>>();
    if (adapter === corpus.pbp)
      for (const r of await read("player_box_scores"))
        if (r.minutes_seconds > 0) {
          const k = `${r.game_id}:${r.team_id}`;
          played.set(k, (played.get(k) ?? new Set()).add(r.player_id));
        }
    for (const team of teams) {
      const id = teamIds[team];
      const games = eligible
        .filter((g) => [g.data.home_team_id, g.data.away_team_id].includes(id))
        .sort((a, b) =>
          a.data.scheduled_tipoff.localeCompare(b.data.scheduled_tipoff),
        );
      const describe = (g: (typeof games)[number]) => {
        const other =
          g.data.home_team_id === id
            ? g.data.away_team_id
            : g.data.home_team_id;
        const opponent = names.get(other);
        if (!opponent) throw Error(`Unknown opponent team ${other}`);
        return {
          season: g.data.season as string,
          gameId: g.id,
          date: Temporal.Instant.from(g.data.scheduled_tipoff)
            .toZonedDateTimeISO("America/New_York")
            .toPlainDate()
            .toString(),
          team,
          teamName: teamNames[team],
          opponent,
          other,
        };
      };
      const results: ProbeGame[] = games.map((g) => {
        const d = describe(g),
          own = points.get(`${g.id}:${id}`),
          theirs = points.get(`${g.id}:${d.other}`);
        if (own === undefined || theirs === undefined || own === theirs)
          throw Error(`No final score for ${g.id}`);
        return { ...d, won: own > theirs };
      });
      facts.push(...winLossFacts(results));
      // Appearance facts need a dated roster, which exists for 2025-26 only.
      if (adapter !== corpus.pbp) continue;
      const roster = await loadSeasonRoster(process.cwd(), id);
      const playerNames = new Map<string, string>();
      const picks = selectAppearances(
        games.map((g) => {
          const members = roster.at(g.data.scheduled_tipoff);
          for (const m of members) playerNames.set(m.playerId, m.name);
          return {
            gameId: g.id,
            roster: members.map((m) => m.playerId),
            played: played.get(`${g.id}:${id}`) ?? new Set<string>(),
          };
        }),
      );
      const rows: ProbeAppearance[] = picks.map((p) => ({
        ...describe(games.find((g) => g.id === p.gameId)!),
        playerId: p.playerId,
        playerName: playerNames.get(p.playerId)!,
        played: p.played,
      }));
      facts.push(...appearanceFacts(rows));
    }
  }
  if (new Set(facts.map((f) => f.id)).size !== facts.length)
    throw Error("Duplicate probe fact");
  if (dryRun) {
    const groups = Map.groupBy(facts, (f) => f.group);
    console.log(
      JSON.stringify(
        {
          facts: facts.length,
          rangesDecoded: opened.length,
          rowsDecoded: opened.reduce((n, r) => n + r.end - r.start, 0),
          groups: Object.fromEntries(
            [...groups].sort().map(([k, v]) => [k, v.length]),
          ),
          sampleQuestions: facts
            .filter((_, i) => i % 150 === 0)
            .map((f) => f.question),
        },
        null,
        2,
      ),
    );
  } else {
    if (!key) throw Error("TYPESAFE_API_KEY is not set; run under doppler run");
    const executedAt = new Date().toISOString();
    const rows: ProbeRow[] = [];
    let inputTokens = 0;
    for (let i = 0; i < facts.length; i += BATCH) {
      const batch = facts.slice(i, i + BATCH);
      const res = await fetch("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          state: "",
          questions: Object.fromEntries(
            batch.map((f) => [
              f.id,
              {
                type: "noul",
                instructions: f.question,
                criteria: {
                  true: "The statement is true.",
                  false: "The statement is false.",
                },
              },
            ]),
          ),
        }),
      });
      if (!res.ok) throw Error("Jev HTTP " + res.status);
      const body: any = await res.json();
      if (body.model !== MODEL) throw Error("Unexpected Jev response model");
      inputTokens += body.usage?.input_tokens ?? 0;
      for (const f of batch) {
        const a = body.answers?.[f.id],
          p = a?.noul;
        rows.push({
          ...f,
          probability:
            a?.type === "noul" &&
            typeof p === "number" &&
            Number.isFinite(p) &&
            p >= 0 &&
            p <= 1
              ? p
              : null,
        });
      }
    }
    const output = {
      kind: "jev-contamination-probe-v5",
      model: MODEL,
      executedAt,
      state: "",
      batchSize: BATCH,
      inputTokens,
      holdout,
      sent: rows.length,
      eligible: rows.length,
      eligibility:
        "Outcome released before the holdout (9 a.m. Eastern on the morning after the game).",
      ...statistics(rows),
      interpretation:
        "Descriptive. Positive discrimination can come from recall of outcomes or from ordinary inference from team and player priors, and does not by itself distinguish them. baseRateReference is what an outcome-blind predictor that knows only the realised rate scores. 2024-25 is a comparison group, not a control for priors.",
    };
    mkdirSync(out, { recursive: true });
    const file = `${out}/${MODEL}.json`;
    writeFileSync(file, JSON.stringify(output, null, 2) + "\n");
    console.log(
      JSON.stringify({ pooled: output.pooled, inputTokens }, null, 2),
    );
    console.log(`Probe stored at ${file}.`);
  }
} finally {
  store.close();
}
