// SPO-837 read-only diagnostic export. Uses the existing adapter for schedule and
// coverage, and its hash-verified release reader to inspect even withheld products.
// No exports below authorize those products for agent access or scoring.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { DopplerStore, VerifiedStore } from "../src/data/store.js";
import { Release } from "../src/data/release.js";
import { PlayByPlayAdapter } from "../src/data/adapters.js";
const pins = JSON.parse(await readFile("config/datasets.json", "utf8"));
const raw = new DopplerStore();
try {
  await mkdir(".cache/spo837", { recursive: true });
  for (const season of ["2025-26", "2024-25"]) {
    const release = await Release.open(
      pins.sources["pbp-" + season],
      new VerifiedStore(
        {
          get: async (b, k) => {
            console.log("Cache miss", b, k);
            return raw.get(b, k);
          },
        },
        ".cache/objects",
      ),
    );
    const adapter = new PlayByPlayAdapter(release);
    const games = (await adapter.games()).filter((g) =>
      season === "2025-26"
        ? [g.data.home_team_id, g.data.away_team_id].includes("1610612738")
        : ["0022400061", "0022400230"].includes(g.id),
    );
    const ids = new Set(games.map((g) => g.id));
    const index = JSON.parse(
      (
        await release.bytes(
          release.manifest.object_prefix + release.manifest.game_index,
        )
      ).toString(),
    );
    const out: any = {
      pin: release.root,
      games: games.map((g) => g.data),
      coverage: (await adapter.coverage()).filter((r) => ids.has(r.game_id)),
      tables: {},
      objects: [],
    };
    for (const table of [
      "events",
      "event_participants",
      "v_player_stints",
      "player_box_scores",
      "lineup_states",
      "raw_objects",
      "data_quality_issues",
    ]) {
      const rows = [];
      for (const name of release.manifest.tables[table] ?? []) {
        const indexed = index.tables[table]?.[name];
        if (indexed && !indexed.some((e: any) => ids.has(e[0]))) continue;
        if (
          !indexed &&
          !name.includes("regular_season") &&
          !name.includes("shared")
        )
          continue;
        const key = release.manifest.object_prefix + name;
        for (const r of await release.rows(key))
          if (ids.has(r.game_id)) rows.push(r);
        out.objects.push(release.ref(key));
      }
      out.tables[table] = rows;
      console.log(season, table, rows.length);
    }
    await writeFile(".cache/spo837/" + season + ".json", JSON.stringify(out));
    if (season === "2025-26") {
      const verified = new VerifiedStore(raw, ".cache/objects");
      for (const gameId of ["0022500083", "0022500637", "0022500338"]) {
        for (const source of ["cdn_pbp", "cdn_box"]) {
          const ref = out.tables.raw_objects.find(
            (r: any) => r.game_id === gameId && r.source === source,
          );
          if (!ref) throw Error(`Missing official source ${gameId}/${source}`);
          const bytes = await verified.read({
            bucket: "sports-nba-data",
            key: ref.object_location.replace("r2://sports-nba-data/", ""),
            sha256: ref.content_hash,
          });
          await writeFile(`.cache/spo837/${source}-${gameId}.json`, bytes);
        }
      }
    }
  }
} finally {
  raw.close();
}
