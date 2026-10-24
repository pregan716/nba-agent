// Contamination probe (brief, "Contamination"): ask the pinned model, with no
// tools, for outcomes and notable events in the replay window and record what
// it says. The launcher projects the stored record to the manifest shape with
// `probeForManifest`, so the file may carry usage and response metadata too.
//
// Credentials: ANTHROPIC_API_KEY must come from Doppler at run time, e.g.
//   doppler run --project nba-agent --config prd -- npx tsx scripts/contamination-probe.ts
// Use --dry-run to print the prompt without calling the model.

import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  PROBE_MODEL,
  PROBE_PROMPT,
  buildProbeRecord,
  probeForManifest,
} from "../src/harness/probe.js";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const model =
    process.argv.find((a) => a.startsWith("--model="))?.slice(8) ?? PROBE_MODEL;
  if (dryRun) {
    console.log(`model: ${model}\n\n${PROBE_PROMPT}`);
    return;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey)
    throw Error("ANTHROPIC_API_KEY is not set; run under doppler run");
  const client = new Anthropic({
    apiKey,
    maxRetries: 0,
    timeout: 10 * 60 * 1000,
  });
  const executedAt = new Date().toISOString();
  const response = await client.messages.create({
    model,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    messages: [{ role: "user", content: PROBE_PROMPT }],
  });
  const output = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n");
  const record = buildProbeRecord({
    model,
    prompt: PROBE_PROMPT,
    output,
    executedAt,
    usage: response.usage,
    responseModel: response.model,
  });
  probeForManifest(record); // fail here, not at launch, if the record is unusable
  mkdirSync(".cache", { recursive: true });
  const file = `.cache/contamination-probe-${executedAt.replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
  console.log(
    `Probe stored at ${file}. Pass it to the launcher with --probe=${file}.`,
  );
  console.log(output);
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
