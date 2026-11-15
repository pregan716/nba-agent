// Select the team and release window on schedule columns before opening box-score rows.
import { readFile } from "node:fs/promises";
import type { PinSet } from "../src/data/contracts.js";
import { parquet, Release } from "../src/data/release.js";
import { PlayByPlayAdapter } from "../src/data/adapters.js";
import { holdoutBoundary } from "../src/data/architect-view.js";
import { before } from "../src/data/time.js";
import { DopplerStore, VerifiedStore } from "../src/data/store.js";
import { teamIds, type Team } from "../src/data/teams.js";
import { releaseTime } from "../src/env/visibility.js";
import { loadSeasonRoster } from "../src/projection/roster.js";

const team = process.argv[2] as Team;
if (!Object.hasOwn(teamIds, team)) throw Error("Unknown team");
const teamId = teamIds[team];
const store = new DopplerStore();
try {
  const pins: PinSet = JSON.parse(
    await readFile("config/datasets.json", "utf8"),
  );
  const release = await Release.open(
    pins.sources["pbp-2025-26"],
    new VerifiedStore(store, ".cache/objects"),
  );
  const adapter = new PlayByPlayAdapter(release, true);
  const schedule = await adapter.games();
  const cutoff = holdoutBoundary(schedule);
  const games = schedule
    .filter(
      ({ data }) =>
        [data.home_team_id, data.away_team_id].includes(teamId) &&
        before(data.scheduled_tipoff, cutoff) &&
        before(releaseTime(data.scheduled_tipoff), cutoff),
    )
    .sort((a, b) =>
      a.data.scheduled_tipoff.localeCompare(b.data.scheduled_tipoff),
    );
  const roster = await loadSeasonRoster(process.cwd(), teamId);
  // The diagnostic compares membership even when the normalization product
  // has statistical quality findings. Minutes distinguish participants from DNP listings.
  const manifest = release.manifest;
  const index = JSON.parse(
    (
      await release.bytes(manifest.object_prefix + manifest.game_index)
    ).toString(),
  );
  const selected = new Set(games.map((g) => g.id));
  const rows = new Map<
    string,
    { playerId: string; minutesSeconds: number | null }[]
  >();
  for (const name of manifest.tables.player_box_scores) {
    const ranges: [string, number, number][] =
      index.tables.player_box_scores[name] ?? [];
    const wanted = ranges.filter(([id]) => selected.has(id));
    if (!wanted.length) continue;
    const bytes = await release.bytes(manifest.object_prefix + name);
    for (const [id, start, count] of wanted) {
      const records = await parquet(bytes, {
        rowStart: start,
        rowEnd: start + count,
        columns: ["game_id", "team_id", "player_id", "minutes_seconds"],
      });
      if (
        records.length !== count ||
        records.some((r) => r.game_id !== id) ||
        rows.has(id)
      )
        throw Error("Invalid game index for " + id);
      const players = records
        .filter((r) => r.team_id === teamId)
        .map((r) => ({
          playerId: r.player_id,
          minutesSeconds: r.minutes_seconds,
        }));
      if (!players.length) throw Error("Empty team box for " + id);
      rows.set(id, players);
    }
  }
  console.log(
    JSON.stringify({
      release_pin: release.root,
      cutoff,
      roster_sources: roster.sources,
      games: games.map((g) => {
        const tip = g.data.scheduled_tipoff;
        const box = rows.get(g.id);
        if (!box) throw Error("Missing box for " + g.id);
        return {
          game_id: g.id,
          scheduled_tip: tip,
          roster: roster.at(tip).map((p) => p.playerId),
          box,
        };
      }),
    }),
  );
} finally {
  store.close();
}
