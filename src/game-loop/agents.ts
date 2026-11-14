import { runAgentLoop, type StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import { Type, type TSchema } from "typebox";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { anthropicProvider } from "../runner/proxy.js";
import type { Specialist } from "./package.js";

export interface AgentSession {
  agent: Specialist;
  system: string;
  input: { teamId: string; gameId: string; task: unknown };
  signal: AbortSignal;
  remaining(): number;
  // Reserve before sending. On ambiguous provider failure the reservation stands.
  reserve(usd: number): (actual: number) => void;
  transcript(value: unknown): void;
  tool(name: string, input: unknown): Promise<unknown>;
}
export type AgentRunner = (call: AgentSession) => Promise<unknown>;
export function specialists(keys: {
  anthropic?: string;
  typesafe?: string;
  anthropicBaseURL?: string;
}): AgentRunner {
  return async (call) => {
    const { agent, system, input, signal } = call;
    if (agent.model === "jev-1.14.0") {
      if (!keys.typesafe) throw Error("Missing Jev credentials");
      const criteria = z.record(z.string(), z.string());
      const question = z.discriminatedUnion("type", [
        z.strictObject({
          type: z.literal("choice"),
          criteria,
          instructions: z.string().optional(),
        }),
        z.strictObject({
          type: z.literal("noul"),
          criteria: z.strictObject({ true: z.string(), false: z.string() }),
          instructions: z.string().optional(),
        }),
        z.strictObject({
          type: z.literal("score"),
          criteria: z.array(z.string()),
          instructions: z.string().optional(),
        }),
      ]);
      const args = z
        .strictObject({
          state: z.json(),
          questions: z.record(z.string(), question),
        })
        .parse(input.task);
      const evidence: Record<string, unknown> = {};
      for (const name of Object.keys(agent.tools))
        evidence[name] = await call.tool(name, args.state);
      const request = {
        model: agent.model,
        state: JSON.stringify({
          teamId: input.teamId,
          gameId: input.gameId,
          state: args.state,
          evidence,
        }),
        questions: Object.fromEntries(
          Object.entries(args.questions).map(([name, q]) => [
            name,
            {
              ...q,
              instructions: [system, q.instructions]
                .filter(Boolean)
                .join("\n\n"),
            },
          ]),
        ),
      };
      const questions = Object.values(request.questions);
      if (
        !questions.length ||
        questions.some(
          (q) =>
            Buffer.byteLength(
              JSON.stringify({ state: request.state, question: q }),
            ) +
              1024 >
            32000,
        )
      )
        throw Error("Invalid Jev question size");
      const bytes = Buffer.byteLength(JSON.stringify(request)) + 4096;
      if (bytes > 64000) throw Error("Jev request exceeds context limit");
      for (let attempt = 1; ; attempt++) {
        signal.throwIfAborted();
        const settle = call.reserve((bytes * 0.042) / 1e6);
        call.transcript({ request, attempt });
        let res: Response;
        try {
          res = await fetch("https://api.typesafe.ai/v1/systemone", {
            method: "POST",
            signal,
            headers: {
              Authorization: "Bearer " + keys.typesafe,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(request),
          });
        } catch (error) {
          call.transcript({ attempt, error: "Jev transport failure" });
          if (signal.aborted || attempt !== 1 || !(error instanceof TypeError))
            throw error;
          await delay(1000, undefined, { signal });
          continue;
        }
        if (!res.ok) {
          call.transcript({ attempt, status: res.status });
          if (res.status >= 400 && res.status < 500 && res.status !== 408)
            settle(0);
          await res.body?.cancel();
          if (attempt !== 1 || res.status !== 429)
            throw Error("Jev HTTP " + res.status);
          const header = res.headers.get("retry-after");
          const seconds = header === null ? 1 : Number(header);
          const ms = Number.isFinite(seconds)
            ? seconds * 1000
            : Date.parse(header!) - Date.now();
          if (ms > 60000) throw Error("Jev Retry-After exceeds 60 seconds");
          await delay(Number.isFinite(ms) ? Math.max(0, ms) : 1000, undefined, {
            signal,
          });
          continue;
        }
        const raw = await res.json();
        call.transcript({ response: raw });
        const response = z
          .object({
            model: z.string(),
            usage: z.object({
              input_tokens: z.number().int().nonnegative(),
              output_tokens: z.number().int().nonnegative(),
            }),
            answers: z.json(),
          })
          .parse(raw);
        settle((response.usage.input_tokens * 0.042) / 1e6);
        if (response.model !== agent.model)
          throw Error("Unexpected Jev response model");
        return response.answers;
      }
    }
    if (!keys.anthropic) throw Error("Missing Claude credentials");
    const catalog = ANTHROPIC_MODELS[agent.model];
    const model = {
      ...catalog,
      baseUrl: keys.anthropicBaseURL ?? catalog.baseUrl,
    };
    const provider = anthropicProvider(keys.anthropic, model.baseUrl);
    let settle: ((usd: number) => void) | undefined;
    const stream: StreamFn = (_model, ctx, opts) =>
      streamSimple(model, ctx, {
        ...opts,
        apiKey: keys.anthropic,
        cacheRetention: "none",
        maxRetries: 0,
        timeoutMs: 45 * 60 * 1000,
        async onPayload(raw) {
          const req = raw as MessageCreateParamsNonStreaming;
          const tokens = await provider.count(req, signal);
          const max = Math.min(
            req.max_tokens,
            Math.floor(
              (call.remaining() * 1e6 - tokens * model.cost.input) /
                model.cost.output,
            ),
          );
          if (!Number.isSafeInteger(max) || max < 1)
            throw Error("Insufficient model budget");
          req.max_tokens = max;
          settle = call.reserve(
            (tokens * model.cost.input + max * model.cost.output) / 1e6,
          );
          call.transcript({ request: req });
          return req;
        },
      });
    const messages = await runAgentLoop(
      [{ role: "user", content: JSON.stringify(input), timestamp: Date.now() }],
      {
        messages: [{ role: "system", content: system, timestamp: Date.now() }],
        tools: Object.entries(agent.tools).map(([name, t]) => ({
          name,
          label: name,
          description: t.description,
          parameters: (t.parameters ??
            Type.Object({}, { additionalProperties: true })) as TSchema,
          async execute(_id, args) {
            const value = await call.tool(name, args);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(value) }],
              details: undefined,
            };
          },
        })),
      },
      {
        model,
        convertToLlm: (messages) =>
          messages.filter(
            (m) =>
              m.role === "user" ||
              m.role === "system" ||
              m.role === "assistant" ||
              m.role === "toolResult",
          ),
        toolExecution: "sequential",
      },
      (event) => {
        if (event.type !== "message_end") return;
        const message = event.message;
        call.transcript(message);
        if (
          message.role === "assistant" &&
          settle &&
          !["error", "aborted"].includes(message.stopReason)
        ) {
          settle(message.usage.cost.total);
          settle = undefined;
          if (message.responseModel && message.responseModel !== agent.model)
            throw Error("Unexpected response model");
        }
      },
      signal,
      stream,
    );
    const last = messages.at(-1);
    if (
      last?.role !== "assistant" ||
      ["error", "aborted"].includes(last.stopReason)
    )
      throw Error("Specialist failed");
    return last.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  };
}
