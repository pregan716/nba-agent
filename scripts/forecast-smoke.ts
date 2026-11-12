import { piLoop } from "../src/harness/version.js";
import { anthropicProvider } from "../src/runner/proxy.js";

const key = process.env.ANTHROPIC_API_KEY;
if (!key) throw Error("Forecast smoke check requires ANTHROPIC_API_KEY");
const { maxTokens, timeoutMs } = piLoop(true);
const message = await anthropicProvider(key).create(
  {
    model: "claude-opus-4-6",
    max_tokens: maxTokens,
    messages: [{ role: "user", content: "Reply with OK." }],
  },
  AbortSignal.timeout(timeoutMs),
);
console.log(
  JSON.stringify({
    model: message.model,
    max_tokens: maxTokens,
    stop_reason: message.stop_reason,
    usage: message.usage,
  }),
);
