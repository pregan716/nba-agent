import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { manifest } from "../src/runner/config.js";
import { MeteringProxy } from "../src/runner/proxy.js";
import { Runner } from "../src/runner/runner.js";
import {
  fixtureConfig,
  environment,
  provider,
  harness,
} from "../test/fixtures/runner/support.js";
// Exercises all schedule slots using synthetic questions, tools and model usage.
// This is neither a scored run nor an assertion that the P3/P5/P6 gates have passed.
const schedule = JSON.parse(
  readFileSync("docs/evidence/audit/schedule.json", "utf8"),
).map((g: any) => ({ gameId: g.gameId, scheduledStart: g.cutoff }));
const proxy = new MeteringProxy(provider);
await proxy.listen();
const runner = new Runner(
  resolve(".cache/runner-fixture"),
  manifest(fixtureConfig("fixture-v1"), schedule),
  proxy,
  environment,
);
try {
  await runner.run(harness);
  const events = runner.record.events();
  console.log(
    JSON.stringify(
      {
        fixtureOnly: true,
        root: runner.root,
        games: events.filter((e) => e.kind === "game_end").length,
        submissions: events.filter((e) => e.kind === "submission").length,
        sessions: events.filter((e) => e.kind === "session_end").length,
        developmentGames: runner.manifest.games
          .filter((g) => g.development)
          .map((g) => g.gameId),
        statuses: events
          .filter((e) => e.kind === "session_end")
          .reduce((counts: Record<string, number>, e) => {
            counts[e.data.status] = (counts[e.data.status] ?? 0) + 1;
            return counts;
          }, {}),
      },
      null,
      2,
    ),
  );
} finally {
  runner.close();
  await proxy.close();
}
