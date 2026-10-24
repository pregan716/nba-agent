// Contamination probe record (brief, "Contamination"). The writer stores more
// than the manifest accepts (usage, response model); `probeForManifest`
// projects exactly the five fields `configSchema.contaminationProbe` allows.

import type { RunConfig } from "../runner/config.js";

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

export type ManifestProbe = NonNullable<RunConfig["contaminationProbe"]>;
/** What the probe script writes: the manifest fields plus provenance the manifest does not take. */
export interface ProbeRecord extends ManifestProbe {
  usage?: unknown;
  responseModel?: string;
}

export function buildProbeRecord(input: {
  model: string;
  prompt: string;
  output: string;
  executedAt: string;
  usage?: unknown;
  responseModel?: string;
}): ProbeRecord {
  return {
    model: input.model as ManifestProbe["model"],
    prompt: input.prompt,
    output: input.output,
    executedAt: input.executedAt,
    tools: [],
    ...(input.usage !== undefined ? { usage: input.usage } : {}),
    ...(input.responseModel !== undefined
      ? { responseModel: input.responseModel }
      : {}),
  };
}

/** Project a stored probe (any extra metadata included) to the strict manifest shape. */
export function probeForManifest(record: unknown): ManifestProbe {
  if (!record || typeof record !== "object")
    throw Error("Probe record must be an object");
  const r = record as Record<string, unknown>;
  for (const key of ["model", "prompt", "output", "executedAt"] as const)
    if (typeof r[key] !== "string" || !r[key])
      throw Error(`Probe record is missing ${key}`);
  if (!Array.isArray(r.tools) || r.tools.length)
    throw Error("Probe record must have been produced with no tools");
  return {
    model: r.model as ManifestProbe["model"],
    prompt: r.prompt as string,
    output: r.output as string,
    executedAt: r.executedAt as string,
    tools: [],
  };
}
