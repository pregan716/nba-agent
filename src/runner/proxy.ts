import { VERSION } from "@anthropic-ai/sdk/version";
import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageCreateParamsNonStreaming,
  Message,
} from "@anthropic-ai/sdk/resources/messages";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import {
  Budget,
  LimitError,
  normalizeUsage,
  tokenTotal,
  cost,
} from "./budget.js";
export const SDK_VERSION: string = VERSION;
export interface ModelProvider {
  count(
    request: MessageCreateParamsNonStreaming,
    signal: AbortSignal,
  ): Promise<number>;
  create(
    request: MessageCreateParamsNonStreaming,
    signal: AbortSignal,
  ): Promise<Message>;
}
/** Construct only in the trusted runner process. No credential or client is passed to a harness. */
export function anthropicProvider(apiKey: string): ModelProvider {
  const client = new Anthropic({ apiKey, maxRetries: 0 });
  return {
    async count(r, signal) {
      const { max_tokens, stream, output_config, ...input } = r;
      return (await client.messages.countTokens(input, { signal }))
        .input_tokens;
    },
    create: (r, signal) => client.messages.create(r, { signal }),
  };
}
export interface ModelEndpoint {
  baseURL: string;
  apiKey: string;
}
export class MeteringProxy {
  #server: Server;
  #scopes = new Map<
    string,
    {
      budget: Budget;
      signal: AbortSignal;
      busy: boolean;
      closed: boolean;
      pending: Promise<void> | null;
    }
  >();
  #url = "";
  constructor(private provider: ModelProvider) {
    this.#server = createServer(async (req, res) => {
      const key =
        req.headers["x-api-key"] ??
        req.headers.authorization?.replace(/^Bearer /, "");
      const scope = typeof key === "string" ? this.#scopes.get(key) : undefined;
      const respond = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (!scope || scope.closed || scope.signal.aborted)
        return respond(401, {
          type: "error",
          error: { type: "authentication_error", message: "Expired session" },
        });
      if (req.method !== "POST" || req.url !== "/v1/messages")
        return respond(404, {
          error: { message: "Only /v1/messages is available" },
        });
      if (scope.busy)
        return respond(409, {
          error: { message: "Concurrent model calls are refused" },
        });
      scope.busy = true;
      let done!: () => void;
      scope.pending = new Promise<void>((resolve) => {
        done = resolve;
      });
      try {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 2_000_000)
            throw Error("Request too large");
        }
        if (scope.closed || scope.signal.aborted) throw Error("Session closed");
        const request = this.request(JSON.parse(body), scope.budget);
        const count = await this.provider.count(request, scope.signal);
        if (!Number.isSafeInteger(count) || count < 0)
          throw Error("Invalid input token count");
        if (scope.closed || scope.signal.aborted) throw Error("Session closed");
        const remaining = scope.budget.remaining().tokens;
        // The provider's preflight count is an estimate. Preserve actual SDK usage
        // and stop on any overrun; never silently erase it to fit the budget.
        request.max_tokens = Math.min(request.max_tokens, remaining - count);
        if (request.max_tokens < 1)
          scope.budget.block(
            scope.budget.stage === "pregame" ? "research_tokens" : "tokens",
          );
        const reservation = scope.budget.reserve(
          count + request.max_tokens,
          0,
          "model",
        );
        scope.budget.record.append("model_request", scope.budget.scope, {
          reservation,
          request,
          inputEstimate: count,
        });
        // On transport failure/crash the reservation remains charged, since the
        // provider may have generated a response we never received. No SDK retries.
        const response = await this.provider.create(request, scope.signal);
        const usage = normalizeUsage(response.usage);
        scope.budget.record.append("model_response", scope.budget.scope, {
          reservation,
          response,
          usage,
        });
        scope.budget.settle(reservation, tokenTotal(usage), 0, {
          usage,
          usd: cost(usage, scope.budget.config.budget.price),
          priceId: scope.budget.config.budget.price.id,
        });
        if (scope.budget.remaining().warning)
          scope.budget.record.append(
            "budget_warning",
            scope.budget.scope,
            scope.budget.remaining(),
          );
        respond(200, response);
      } catch (e) {
        scope.budget.record.append("model_error", scope.budget.scope, {
          message: e instanceof LimitError ? e.message : "Model request failed",
          limit: e instanceof LimitError ? e.limit : null,
        });
        respond(e instanceof LimitError ? 429 : 502, {
          type: "error",
          error: {
            type: e instanceof LimitError ? "rate_limit_error" : "api_error",
            message:
              e instanceof LimitError ? e.message : "Model request failed",
          },
        });
      } finally {
        scope.busy = false;
        done();
      }
    });
    this.#server.requestTimeout = 30_000;
  }
  request(body: any, budget: Budget): MessageCreateParamsNonStreaming {
    if (!body || typeof body !== "object" || body.stream === true)
      throw Error("Non-streaming requests required");
    const allowed = new Set([
      "model",
      "max_tokens",
      "messages",
      "system",
      "tools",
      "tool_choice",
      "stream",
      "thinking",
      "output_config",
    ]);
    if (Object.keys(body).some((k) => !allowed.has(k)))
      throw Error("Unsupported model request field");
    if (
      !Array.isArray(body.messages) ||
      !Number.isSafeInteger(body.max_tokens) ||
      body.max_tokens < 1
    )
      throw Error("Invalid model request");
    // Server-side tools, remote content and hosted file references would bypass P3.
    const inspect = (v: any): void => {
      if (!v || typeof v !== "object") return;
      if (
        v.type &&
        ["url", "file", "image", "document", "container_upload"].includes(
          v.type,
        )
      )
        throw Error("External content is not permitted");
      for (const child of Object.values(v)) inspect(child);
    };
    inspect(body);
    if (
      body.tools &&
      (!Array.isArray(body.tools) ||
        body.tools.some((t: any) => t.type && t.type !== "custom"))
    )
      throw Error("Server tools are not permitted");
    return {
      ...body,
      stream: false,
      model: "claude-opus-4-6",
      thinking: { type: budget.config.harness.loop.thinking },
      output_config: { effort: budget.config.harness.loop.effort },
    };
  }
  async listen(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.#server.listen(0, "127.0.0.1", resolve),
    );
    const address = this.#server.address();
    if (!address || typeof address === "string")
      throw Error("No proxy address");
    this.#url = `http://127.0.0.1:${address.port}`;
  }
  issue(budget: Budget, signal: AbortSignal): ModelEndpoint {
    if (!this.#url) throw Error("Proxy not listening");
    if (budget.config.harness.sdkVersion !== SDK_VERSION)
      throw Error("Harness SDK version does not match installed SDK");
    const apiKey = randomBytes(32).toString("hex");
    this.#scopes.set(apiKey, {
      budget,
      signal,
      busy: false,
      closed: false,
      pending: null,
    });
    return Object.freeze({ baseURL: this.#url, apiKey });
  }
  busy(endpoint: ModelEndpoint): boolean {
    return this.#scopes.get(endpoint.apiKey)?.busy ?? false;
  }
  async revoke(endpoint: ModelEndpoint): Promise<void> {
    const scope = this.#scopes.get(endpoint.apiKey);
    if (!scope) return;
    scope.closed = true;
    await scope.pending;
    this.#scopes.delete(endpoint.apiKey);
  }
  async close(): Promise<void> {
    for (const scope of this.#scopes.values()) scope.closed = true;
    await Promise.all([...this.#scopes.values()].map((s) => s.pending));
    await new Promise<void>((resolve, reject) =>
      this.#server.close((e) => (e ? reject(e) : resolve())),
    );
  }
}
