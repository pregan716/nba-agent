// The models the architect may run on and what differs between their
// providers: the adapter, the credential, where a request carries its output
// limit, and what one request can cost at most (SPO-939).
import type {
  Api,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimple as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as responsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as completionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as googleStream } from "@earendil-works/pi-ai/api/google-generative-ai";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models";
import { FIREWORKS_MODELS } from "@earendil-works/pi-ai/providers/fireworks.models";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import { anthropicProvider } from "../runner/proxy.js";

const kimi = "accounts/fireworks/models/kimi-k3p1-pro";

/** Models the operator may run the architect on. The first is the architect of
 * rounds one and two (user decision, Nov 17, 2026). `claude-opus-4-6` was its
 * side-by-side run. The last three are the other providers' architects (user
 * decision, Nov 25, 2026; brief v5 "Architects on other models"). Each model
 * runs in a pool of its own. */
export const architectModels = [
  "claude-opus-5-5",
  "claude-opus-4-6",
  "gpt-6.2-sol",
  "gemini-4-neon",
  kimi,
] as const;
export type ArchitectModel = (typeof architectModels)[number];

type Stream = (
  model: Model<Api>,
  context: Parameters<typeof anthropicStream>[1],
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;
/** A request as the adapter is about to send it. */
type Payload = Record<string, any>;

export interface ArchitectProvider {
  model: Model<Api>;
  stream: Stream;
  /** The environment variable that holds the credential. */
  keyEnv: string;
  /** The object and field that hold the request's output limit. Every provider
   * here counts reasoning tokens against it, so it bounds the billed output. */
  limit(request: Payload): [Payload, string];
  /** The smallest output limit the provider accepts. */
  minOutput: number;
  /** The provider's own count of a request's input tokens, where it has one. */
  count?(
    key: string,
    baseURL: string,
  ): (request: Payload, signal: AbortSignal) => Promise<number>;
  /** Whether the session id is sent, for the provider's prompt cache. */
  session: boolean;
  /** Other names the provider gives this model in its replies. */
  answersAs?: readonly string[];
  /** The model a raw stream event says is answering, if the event says. */
  answering(event: Payload): unknown;
}

const provider = <A extends Api>(
  model: Model<A>,
  stream: (
    model: Model<A>,
    context: Parameters<typeof anthropicStream>[1],
    options?: SimpleStreamOptions,
  ) => AssistantMessageEventStream,
  rest: Omit<ArchitectProvider, "model" | "stream">,
): ArchitectProvider => ({
  model: model as Model<Api>,
  stream: stream as unknown as Stream,
  ...rest,
});

const anthropic = (id: "claude-opus-5-5" | "claude-opus-4-6") =>
  provider(ANTHROPIC_MODELS[id], anthropicStream, {
    keyEnv: "ANTHROPIC_API_KEY",
    limit: (r) => [r, "max_tokens"],
    minOutput: 1,
    count: (key, baseURL) => {
      const client = anthropicProvider(key, baseURL);
      return (r, signal) =>
        client.count(r as MessageCreateParamsNonStreaming, signal);
    },
    session: false,
    answering: (e) =>
      e.type === "message_start" ? e.message?.model : undefined,
  });

const providers: Record<ArchitectModel, ArchitectProvider> = {
  "claude-opus-5-5": anthropic("claude-opus-5-5"),
  "claude-opus-4-6": anthropic("claude-opus-4-6"),
  "gpt-6.2-sol": provider(OPENAI_MODELS["gpt-6.2-sol"], responsesStream, {
    keyEnv: "OPENAI_API_KEY",
    limit: (r) => [r, "max_output_tokens"],
    // The Responses API rejects a smaller limit.
    minOutput: 16,
    session: true,
    answering: (e) => e.response?.model,
  }),
  "gemini-4-neon": provider(GOOGLE_MODELS["gemini-4-neon"], googleStream, {
    keyEnv: "GEMINI_API_KEY",
    limit: (r) => [(r.config ??= {}), "maxOutputTokens"],
    minOutput: 1,
    session: true,
    answering: (e) => e.modelVersion,
  }),
  // Kimi K3.1 Pro, served by Fireworks (user decision, Nov 27, 2026). It was
  // first served by Baseten, whose limit of 100,000 tokens a minute is below
  // the size of one request late in an iteration.
  [kimi]: provider(FIREWORKS_MODELS[kimi], completionsStream, {
    keyEnv: "FIREWORKS_API_KEY",
    limit: (r) => [
      r,
      "max_completion_tokens" in r ? "max_completion_tokens" : "max_tokens",
    ],
    minOutput: 1,
    session: true,
    answering: (e) => e.model,
  }),
};

export const architectProvider = (model: ArchitectModel = architectModels[0]) =>
  providers[model];

/** The dearest a token can be billed, in dollars per million: an input token
 * at the highest of the input, cache-read and cache-write prices, and an
 * output token at the output price, each across the model's price tiers. */
export function dearestRates(model: Model<Api>) {
  const tiers = [model.cost, ...(model.cost.tiers ?? [])];
  return {
    input: Math.max(
      ...tiers.flatMap((t) => [t.input, t.cacheRead, t.cacheWrite]),
    ),
    output: Math.max(...tiers.map((t) => t.output)),
  };
}

/** Whether the model a reply names is the one that was asked for. Anthropic
 * names a model only when a different one answered. The others may add a
 * prefix or a dated suffix, differ in case, or use a known other name. */
export function answeredBy(provider: ArchitectProvider, answered: string) {
  const { id, api } = provider.model;
  if (answered === id || provider.answersAs?.includes(answered)) return true;
  return api !== "anthropic-messages" && sameModel(id, answered);
}

export function sameModel(asked: string, answered: string) {
  const a = asked.toLowerCase(),
    b = answered.toLowerCase().replace(/^models\//, "");
  return b === a || b.startsWith(a + "-") || b.endsWith("/" + a);
}
