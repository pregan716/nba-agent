// Source-only audit of the windows-v1 -> windows-v2 prefix change. No roster or
// availability assumptions, predictors, or season scoring are involved.
// Bucketing and cutoff rules intentionally stay independent of the engine so this
// roster-free inventory can cross-check its results against dataset.ts.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { auditCodeRevision } from "./lib/audit-revision.js";
import { DopplerStore, VerifiedStore } from "../src/data/store.js";
import { Release } from "../src/data/release.js";
import { PlayByPlayAdapter } from "../src/data/adapters.js";
import type { Row } from "../src/data/contracts.js";
import { BOS, WINDOW_VERSION } from "../src/replay/types.js";
const codeRevision = auditCodeRevision();
const raw = new DopplerStore();
try {
  const pins = JSON.parse(await readFile("config/datasets.json", "utf8"));
  const release = await Release.open(
    pins.sources["pbp-2025-26"],
    new VerifiedStore(raw, ".cache/objects"),
  );
  const adapter = new PlayByPlayAdapter(release);
  const games = (await adapter.games()).filter((g) =>
    [g.data.home_team_id, g.data.away_team_id].includes(BOS),
  );
  const moved: Row[] = [],
    interrupted: Row[] = [],
    sources = new Map();
  let jumpBuckets = 0,
    observedGames = 0;
  for await (const batch of adapter.exportRecords("events", games)) {
    if (batch.reason) throw Error(`${batch.gameId}: ${batch.reason}`);
    observedGames++;
    for (const r of batch.records)
      sources.set(r.provenance.object.sha256, r.provenance.object);
    const events = batch.records
      .map((r) => r.data)
      .filter((e) => e.validity === "effective")
      .sort((a, b) => a.canonical_sequence - b.canonical_sequence);
    const buckets: Row[][] = [];
    for (const e of events) {
      const last = buckets.at(-1);
      if (
        last &&
        last[0].period === e.period &&
        last[0].clock_remaining_ms === e.clock_remaining_ms
      )
        last.push(e);
      else buckets.push([e]);
    }
    for (const bucket of buckets) {
      if (!(
        bucket[0].clock_remaining_ms > 0 &&
        bucket[0].clock_remaining_ms < (bucket[0].period <= 4 ? 720000 : 300000)
      ))
        continue;
      const jump = bucket.find((e) => e.type === "jump_ball");
      if (!jump) continue;
      jumpBuckets++;
      const cut = bucket.findIndex(
        (e) => e.type === "substitution" || e.type === "jump_ball",
      );
      const row = bucket[cut];
      const reference = {
        gameId: batch.gameId,
        period: row.period,
        clockMs: row.clock_remaining_ms,
        oldCutoff: bucket[0].canonical_sequence,
        newCutoff: row.canonical_sequence,
        jumpSequence: jump.canonical_sequence,
      };
      if (cut)
        moved.push({
          ...reference,
          includedEvents: bucket.slice(0, cut).map((e) => ({
            sequence: e.canonical_sequence,
            type: e.type,
            eventId: e.event_id,
          })),
          scoreChanged:
            bucket[0].home_score_before !== row.home_score_before ||
            bucket[0].away_score_before !== row.away_score_before,
        });
      if (
        bucket.some(
          (e) =>
            e.canonical_sequence >= row.canonical_sequence &&
            e.canonical_sequence < jump.canonical_sequence &&
            e.type !== "substitution",
        )
      )
        interrupted.push({
          ...reference,
          events: bucket.map((e) => ({
            sequence: e.canonical_sequence,
            type: e.type,
            eventId: e.event_id,
          })),
        });
    }
  }
  if (observedGames !== games.length) throw Error("Incomplete event export");
  const sort = (a: Row, b: Row) =>
    a.gameId.localeCompare(b.gameId) || a.oldCutoff - b.oldCutoff;
  const result = {
    release: release.root,
    from: `windows-v1:${release.root.sha256}`,
    to: `${WINDOW_VERSION}:${release.root.sha256}`,
    codeRevision,
    scope:
      "Celtics regular-season event prefixes only; not a season scoring run",
    games: observedGames,
    jumpBuckets,
    movedCutoffs: moved.length,
    scoreChanges: moved.filter((r) => r.scoreChanged).length,
    interruptedBuckets: interrupted.length,
    moved: moved.sort(sort),
    interrupted: interrupted.sort(sort),
    sources: [...sources.values()].sort((a, b) => a.key.localeCompare(b.key)),
  };
  await mkdir("docs/evidence/replay-mvp", { recursive: true });
  await writeFile(
    "docs/evidence/replay-mvp/windows-v2-cutoffs.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log({
    games: result.games,
    jumpBuckets,
    movedCutoffs: result.movedCutoffs,
    scoreChanges: result.scoreChanges,
    interruptedBuckets: result.interruptedBuckets,
  });
} finally {
  raw.close();
}
