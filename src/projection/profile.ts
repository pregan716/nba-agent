import type { DatasetVersion } from "../env/contract.js";
import { presetConfig } from "../harness/presets.js";
import { forecastDefinitions, forecastPrompts } from "./tools.js";

export type ForecastArm = "no-memory" | "full-memory";
export function forecastProfile(o: {
  arm: ForecastArm;
  runId: string;
  replicateId: string;
  purpose: "fixture" | "pilot";
  dataSources: DatasetVersion[];
  sandboxImage: string;
  projectionImage: string;
}) {
  if (!["no-memory", "full-memory"].includes(o.arm))
    throw Error("Unknown forecast arm");
  const full = o.arm === "full-memory";
  const config = presetConfig({
    ...o,
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
  config.harness.identity = "pi-forecast-v4";
  config.harness.projectionImage = o.projectionImage;
  config.harness.sandboxImage = o.sandboxImage;
  config.harness.toolDefinitions = forecastDefinitions.filter(
    (t) => full || !t.name.startsWith("workspace_"),
  );
  config.harness.prompts = { ...forecastPrompts };
  config.harness.memoryInstructions = full
    ? "Free-form notes in /workspace/memory and binary or text files in /workspace/code persist between games. Notes are capped at 50,000 tokens and code at 8 MB."
    : "Start fresh each game. Read the last game's feedback. Use /scratch for temporary research.";
  config.codeRevision = config.harness.codeRevision;
  return config;
}
