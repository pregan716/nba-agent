// Contamination probe (brief, "Contamination"): ask the pinned model, with no
// tools, for outcomes and notable events in the replay window and record what
// it says. The output goes into the run config's `contaminationProbe` field and
// therefore into the manifest of every scored run.
//
// Credentials: ANTHROPIC_API_KEY must come from Doppler at run time, e.g.
//   doppler run --project nba-agent --config prd -- npx tsx scripts/contamination-probe.ts
// Use --dry-run to print the prompt without calling the model.

import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, writeFileSync } from "node:fs";

export const PROBE_MODEL = "claude-opus-4-6";
export const PROBE_PROMPT = `This is a knowledge audit, not a research task. Answer from memory only, as fully and specifically as you can, and say explicitly when you do not know or are unsure.

1. State your training data cutoff as you understand it.
2. Boston Celtics 2025-26 NBA regular season (October 2025 through April 2026): the team's final regular-season record, their seed, and their record at the All-Star break.
3. List specific Celtics regular-season game results you remember from that season: date, opponent, score, and anything notable about the game.
4. Notable Celtics events during the 2025-26 regular season: injuries and return dates, trades, signings, waivers, coaching decisions, suspensions.
5. Season-end statistics for Celtics players in 2025-26: points, rebounds and assists per game for Jayson Tatum, Jaylen Brown, Derrick White, Payton Pritchard, Jrue Holiday and anyone else on the roster you can recall.
6. League-wide 2025-26 regular-season facts: standings, award winners, major trades.
7. Separately, list Celtics roster and front-office moves from the 2025 offseason (May through September 2025), which may be within your training data.

For every item, label it [KNOWN], [UNSURE] or [UNKNOWN]. Do not invent plausible-sounding specifics; a short list of genuinely remembered items is the useful answer.`;

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
  const record = {
    model,
    prompt: PROBE_PROMPT,
    output,
    executedAt,
    tools: [] as [],
    usage: response.usage,
    responseModel: response.model,
  };
  mkdirSync(".cache", { recursive: true });
  const file = `.cache/contamination-probe-${executedAt.replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
  console.log(
    `Probe stored at ${file}. Put model, prompt, output, executedAt and tools into config.contaminationProbe.`,
  );
  console.log(output);
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
