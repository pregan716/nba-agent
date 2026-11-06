// Jev contamination probe (brief, "Contamination"; SPO-855). Builds typed
// true/false questions about regular-season facts from the pinned releases,
// sends them to Jev with an empty state, and stores per-group discrimination.
//
//   npx tsx scripts/jev-probe.ts --dry-run
//   doppler run --project nba-agent --config prd -- npx tsx scripts/jev-probe.ts
//
// The stored file is passed to the launcher with --jev-probe=<file>. Truth and
// provenance never enter a request. 2024-25 is the comparison group.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Temporal } from "@js-temporal/polyfill";
import { openCorpus } from "../src/data/corpus.js";
import { DopplerStore } from "../src/data/store.js";
import { MeteringProxy, systemOneProvider } from "../src/runner/proxy.js";
import { RecordStore } from "../src/runner/record.js";
import { probeJev, type ProbeFact } from "../src/policy/probe.js";
import {
  appearanceFacts,
  selectAppearances,
  summarizeProbeGroups,
  winLossFacts,
  type ProbeAppearance,
  type ProbeGame,
} from "../src/policy/probe-facts.js";
import { JEV_MODEL } from "../src/policy/request.js";
import { loadSeasonRoster } from "../src/replay/roster.js";
import { BOS } from "../src/replay/types.js";
import { currentCodeRevision } from "../src/harness/version.js";

const dryRun = process.argv.includes("--dry-run");
const BATCH = 40;
const key = process.env.TYPESAFE_API_KEY;
delete process.env.TYPESAFE_API_KEY;
const store = new DopplerStore();
try {
  const corpus = await openCorpus(store, process.cwd(), ".cache/objects");
  const facts: ProbeFact[] = [];
  for (const adapter of [corpus.priorPbp, corpus.pbp]) {
    const release = adapter.release,
      table = async (name: string) => {
        const rows: any[] = [];
        for (const part of release.manifest.tables[name])
          rows.push(
            ...(await release.rows(release.manifest.object_prefix + part)),
          );
        return rows;
      };
    const teams = new Map(
      (await table("teams")).map((t) => [t.team_id, t.name]),
    );
    const games = (await adapter.games())
      .filter(
        (g) =>
          g.data.phase === "regular_season" &&
          g.data.status === "completed" &&
          [g.data.home_team_id, g.data.away_team_id].includes(BOS),
      )
      .sort((a, b) =>
        a.data.scheduled_tipoff.localeCompare(b.data.scheduled_tipoff),
      );
    const ids = new Set(games.map((g) => g.id));
    const points = new Map<string, number>();
    for (const r of await table("team_box_scores"))
      if (ids.has(r.game_id)) points.set(`${r.game_id}:${r.team_id}`, r.points);
    const describe = (g: (typeof games)[number]) => {
      const other =
        g.data.home_team_id === BOS ? g.data.away_team_id : g.data.home_team_id;
      const opponent = teams.get(other);
      if (!opponent) throw Error(`Unknown opponent team ${other}`);
      return {
        season: g.data.season as string,
        gameId: g.id,
        date: Temporal.Instant.from(g.data.scheduled_tipoff)
          .toZonedDateTimeISO("America/New_York")
          .toPlainDate()
          .toString(),
        opponent,
        other,
      };
    };
    const results: ProbeGame[] = games.map((g) => {
      const d = describe(g),
        own = points.get(`${g.id}:${BOS}`),
        theirs = points.get(`${g.id}:${d.other}`);
      if (own === undefined || theirs === undefined || own === theirs)
        throw Error(`No final score for ${g.id}`);
      return { ...d, celticsWon: own > theirs };
    });
    facts.push(...winLossFacts(results, release.root.sha256));
    // Appearance facts need a frozen roster, which exists for 2025-26 only.
    if (adapter === corpus.pbp) {
      const roster = await loadSeasonRoster(),
        played = new Map<string, Set<string>>();
      for (const r of await table("player_box_scores"))
        if (ids.has(r.game_id) && r.team_id === BOS && r.minutes_seconds > 0)
          played.set(
            r.game_id,
            (played.get(r.game_id) ?? new Set()).add(r.player_id),
          );
      const names = new Map<string, string>();
      const picks = selectAppearances(
        games.map((g) => {
          const members = roster.at(g.data.scheduled_tipoff);
          for (const m of members) names.set(m.playerId, m.name);
          return {
            gameId: g.id,
            roster: members.map((m) => m.playerId),
            played: played.get(g.id) ?? new Set<string>(),
          };
        }),
      );
      const rows: ProbeAppearance[] = picks.map((p) => {
        const d = describe(games.find((g) => g.id === p.gameId)!);
        return {
          ...d,
          playerId: p.playerId,
          playerName: names.get(p.playerId)!,
          played: p.played,
        };
      });
      facts.push(...appearanceFacts(rows, release.root.sha256));
    }
  }
  const counts = summarizeProbeGroups(
    facts.map((f) => ({ ...f, probability: null })),
  );
  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          facts: facts.length,
          groups: Object.fromEntries(
            Object.entries(counts).map(([k, v]) => [
              k,
              { facts: v.facts, trueStatements: v.trueStatements },
            ]),
          ),
          samples: facts
            .filter((_, i) => i % 60 === 0)
            .map((f) => ({ question: f.question, truth: f.truth })),
        },
        null,
        2,
      ),
    );
  } else {
    if (!key) throw Error("TYPESAFE_API_KEY is not set; run under doppler run");
    const executedAt = new Date().toISOString(),
      root = mkdtempSync(join(tmpdir(), "jev-probe-"));
    const proxy = new MeteringProxy(
      {
        count: async () => 0,
        create: async () => {
          throw Error("No analyst in the Jev probe");
        },
      },
      systemOneProvider(key),
    );
    const record = new RecordStore<any>(root, {
      schemaVersion: 1,
      kind: "jev-probe",
      model: JEV_MODEL,
      codeRevision: currentCodeRevision(),
    });
    const rows: any[] = [];
    let inputTokens = 0;
    try {
      for (let i = 0; i < facts.length; i += BATCH) {
        const result = await probeJev(
          facts.slice(i, i + BATCH),
          proxy,
          record,
          new AbortController().signal,
          `jev-contamination-probe:${i / BATCH}`,
        );
        inputTokens += result.response.response?.usage?.input_tokens ?? 0;
        rows.push(...result.results);
      }
      record.verify();
    } finally {
      record.close();
      await proxy.close();
    }
    const output = {
      kind: "jev-contamination-probe-v2",
      model: JEV_MODEL,
      executedAt,
      codeRevision: currentCodeRevision(),
      state: "",
      batchSize: BATCH,
      inputTokens,
      chance: { accuracy: 0.5, brier: 0.25, discrimination: 0 },
      groups: summarizeProbeGroups(rows),
      facts: rows.map((r) => ({
        id: r.id,
        group: r.group,
        question: r.question,
        positive: r.positive,
        subject: r.subject,
        truth: r.truth,
        probability: r.probability,
        source: r.source,
      })),
      interpretation:
        "Descriptive. Positive discrimination can come from recall of outcomes or from ordinary inference from team and player priors, and does not by itself distinguish them. baseRateReference is what an outcome-blind predictor that knows only the realized rate scores; beyondBaseRate is observed minus that reference. The reference does not cover opponent-strength, home-court or schedule priors, so a positive excess is a reason to look closer, not proof of recall. 2024-25 is a comparison group, not a control for priors.",
    };
    mkdirSync(".cache", { recursive: true });
    const file = `.cache/jev-probe-${executedAt.replace(/[:.]/g, "-")}.json`;
    writeFileSync(file, JSON.stringify(output, null, 2) + "\n");
    console.log(JSON.stringify(output.groups, null, 2));
    console.log(
      `Probe stored at ${file} (full record: ${root}). Pass it to the launcher with --jev-probe=${file}.`,
    );
  }
} finally {
  store.close();
}
