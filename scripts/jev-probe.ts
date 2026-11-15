// Jev contamination probe for the five v5 teams (SPO-906). Builds true/false
// statements about regular-season facts from the pinned releases, sends them to
// Jev with an empty state, and stores what it answered with summary statistics.
//
//   npx tsx scripts/jev-probe.ts --dry-run
//   doppler run --project nba-agent --config prd -- npx tsx scripts/jev-probe.ts --out=docs/evidence/v5-probe
//
// Truth never enters a request. 2024-25 is the comparison group. No game from
// the holdout date on is used: the schedule is cut at that date before any
// box-score row is looked at.
import { mkdirSync, writeFileSync } from "node:fs";
import { Temporal } from "@js-temporal/polyfill";
import { openCorpus } from "../src/data/corpus.js";
import { DopplerStore } from "../src/data/store.js";
import { teamIds, teamNames, teams } from "../src/data/teams.js";
import { before } from "../src/data/time.js";
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
const key = process.env.TYPESAFE_API_KEY;
delete process.env.TYPESAFE_API_KEY;
const store = new DopplerStore();
try {
  const corpus = await openCorpus(store, process.cwd(), ".cache/objects");
  const facts: ProbeFact[] = [];
  for (const adapter of [corpus.priorPbp, corpus.pbp]) {
    const release = adapter.release;
    const table = async (name: string) => {
      const rows: any[] = [];
      for (const part of release.manifest.tables[name])
        rows.push(
          ...(await release.rows(release.manifest.object_prefix + part)),
        );
      return rows;
    };
    const names = new Map(
      (await table("teams")).map((t) => [t.team_id, t.name]),
    );
    // The holdout cut comes first. Nothing below sees a later game.
    const eligible = (await adapter.games()).filter(
      (g) =>
        g.data.phase === "regular_season" &&
        g.data.status === "completed" &&
        before(g.data.scheduled_tipoff, holdout),
    );
    const allowed = new Set(eligible.map((g) => g.id));
    const points = new Map<string, number>();
    for (const r of await table("team_box_scores"))
      if (allowed.has(r.game_id))
        points.set(`${r.game_id}:${r.team_id}`, r.points);
    const played = new Map<string, Set<string>>();
    if (adapter === corpus.pbp)
      for (const r of await table("player_box_scores"))
        if (allowed.has(r.game_id) && r.minutes_seconds > 0) {
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
    const kindSeason = (r: ProbeRow) =>
      r.group.split(":").slice(0, 2).join(":");
    const output = {
      kind: "jev-contamination-probe-v5",
      model: MODEL,
      executedAt,
      state: "",
      batchSize: BATCH,
      inputTokens,
      holdout,
      chance: { accuracy: 0.5, brier: 0.25, discrimination: 0 },
      pooled: summarizeGroups(rows, kindSeason),
      byTeam: summarizeGroups(rows, (r) => r.group),
      all: summarize(rows),
      facts: rows,
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
