import { gameLineVersion } from "./game-lines.js";
import type { DatasetVersion } from "../env/contract.js";
import { presetConfig } from "../harness/presets.js";
import { FORECAST_MEMORY_INSTRUCTIONS, forecastPrompts } from "./prompts.js";
import { forecastDefinitions } from "./tools.js";

export type ForecastArm = "no-memory" | "full-memory";
export function forecastProfile(o: {
  arm: ForecastArm;
  runId: string;
  replicateId: string;
  purpose: "fixture" | "pilot";
  dataSources: DatasetVersion[];
  sandboxImage: string;
  projectionImage: string;
  throughGame?: number;
  pilotCaps?: boolean;
}) {
  if (!["no-memory", "full-memory"].includes(o.arm))
    throw Error("Unknown forecast arm");
  const full = o.arm === "full-memory";
  const config = presetConfig({
    ...o,
    dataSources: [...o.dataSources, gameLineVersion],
    harness: "pi",
    memory: {
      version: "forecast-memory-v1",
      horizon: full ? "season" : "stateless",
      revision: "editable",
      process: "voluntary",
    },
  });
  config.profile.capabilities = {
    version: "forecast-capabilities-v1",
    enabled: [
      "player_forecasts",
      "game_history",
      "search_and_fetch",
      "code_execution",
      ...(full ? ["workspace"] : []),
    ],
  };
  config.budget.id = "forecast-development-generous-v1";
  config.budget.memory = {
    tokenCap: 50000,
    countProtocol: "analyst-count-snapshot-v1",
  };
  if (o.throughGame !== undefined) config.policy.throughGame = o.throughGame;
  if (o.pilotCaps || (o.throughGame ?? 10) > 10) {
    if (o.purpose !== "pilot") throw Error("Extension caps require a pilot");
    config.budget = {
      ...config.budget,
      id: "forecast-pilot-caps-v1",
      pregame: {
        tokens: 260000,
        computeSeconds: 300,
        toolCalls: 80,
        wallSeconds: 2700,
      },
      postgame: {
        tokens: 225000,
        computeSeconds: 300,
        toolCalls: 80,
        wallSeconds: 1800,
      },
      warnRemainingTokens: 50000,
      price: {
        ...config.budget.price,
        id: "claude-opus-4-6-standard-usd-per-million-v1",
      },
    };
  }
  config.harness.identity = "pi-forecast-v4";
  config.harness.projectionImage = o.projectionImage;
  config.harness.sandboxImage = o.sandboxImage;
  config.harness.toolDefinitions = forecastDefinitions.filter(
    (t) => full || !t.name.startsWith("workspace_"),
  );
  config.harness.prompts = { ...forecastPrompts };
  config.harness.memoryInstructions = FORECAST_MEMORY_INSTRUCTIONS[o.arm];
  config.codeRevision = config.harness.codeRevision;
  return config;
}
