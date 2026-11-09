import {
  mkdirSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { STARTER_SPEC, type StarterMount } from "../../src/starter/model.js";
import { canonicalJson } from "../../src/env/tools.js";
export function fixtureStarter(root: string): StarterMount {
  const path = join(root, "starter");
  mkdirSync(path, { recursive: true });
  chmodSync(path, 0o755);
  const binary = { columns: [], classes: [0, 1], baseline: [[0]], trees: [] };
  writeFileSync(
    join(path, "model.json"),
    JSON.stringify({
      version: STARTER_SPEC.version,
      history: [],
      target: {
        gameId: "fixture",
        teamId: "1610612738",
        scheduledStart: "2025-10-22T23:30:00Z",
      },
      models: [
        binary,
        binary,
        { ...binary, classes: [1], baseline: [[0]] },
        binary,
      ],
    }),
  );
  copyFileSync("starter/nba_starter.py", join(path, "nba_starter.py"));
  const sha = (name: string) =>
    createHash("sha256")
      .update(readFileSync(join(path, name)))
      .digest("hex");
  const modelSha256 = sha("model.json"),
    apiSha256 = sha("nba_starter.py");
  return {
    path,
    modelSha256,
    apiSha256,
    hash: createHash("sha256")
      .update(
        canonicalJson({
          model: modelSha256,
          api: apiSha256,
          spec: STARTER_SPEC,
        }),
      )
      .digest("hex"),
    gameId: "fixture",
    cutoff: "2025-10-22T23:30:00Z",
  };
}
export const starterState = {
  gameId: "fixture",
  sequence: 1,
  period: 1,
  clockMs: 600000,
  margin: 0,
  stoppage: { kind: "timeout", timeoutTeam: "1610612738" },
  celtics: ["0", "1", "2", "3", "4"],
  eligibleBench: ["5", "6"],
  players: Array.from({ length: 7 }, (_, i) => ({
    playerId: String(i),
    minutes: 2,
    currentStintMinutes: 2,
    personalFouls: 0,
    restMs: 0,
  })),
  history: { substitutions: [] },
};
