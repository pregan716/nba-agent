import { runAgentLoop, type StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import { APIConnectionError } from "@anthropic-ai/sdk";
import {
  retryArchitectProvider,
  unbilledProviderFailure,
} from "../runner/retry.js";
import { anthropicProvider } from "../runner/proxy.js";
import { PI_CONTRACT } from "../harness/version.js";
import { DockerSandbox } from "../env/sandbox.js";
import { viewBatches } from "../data/architect-view.js";
import { writeSessionExport } from "../env/export.js";
import {
  developmentService,
  type EvaluationHost,
} from "../evaluation/service/index.js";
import { architectTools, type SubmissionKind } from "./tools.js";
import { Iteration } from "./iteration.js";
import { ARCHITECT_PROMPT } from "./prompt.js";

const model = ANTHROPIC_MODELS["claude-opus-4-6"];
interface ArchitectOptions {
  apiKey?: string;
  baseURL?: string;
  signal?: AbortSignal;
  /** Operator restriction on what this iteration may submit. */
  only?: readonly SubmissionKind[];
}
// Pi exposes Anthropic SSE error events as their JSON data in errorMessage.
function streamFailureStatus(message: string | undefined) {
  if (!message) return;
  let body;
  try {
    body = JSON.parse(message);
  } catch {
    return;
  }
  if (body?.type !== "error") return;
  switch (body.error?.type) {
    case "overloaded_error":
      return 529;
    case "api_error":
      return 500;
    case "rate_limit_error":
      return 429;
  }
}
function metered(i: Iteration, signal: AbortSignal, options: ArchitectOptions) {
  const key = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!key) throw Error("Missing architect provider credentials");
  const provider = anthropicProvider(key, options.baseURL ?? model.baseUrl);
  const stream: StreamFn = async (_, context, streamOptions) =>
    retryArchitectProvider(async () => {
      let settle: ((usd: number) => void) | undefined;
      let transportError: unknown;
      let streamHeaders: Headers | undefined;
      const events = streamSimple(
        { ...model, baseUrl: options.baseURL ?? model.baseUrl },
        context,
        {
          ...streamOptions,
          apiKey: key,
          cacheRetention: "none",
          maxRetries: 0,
          maxTokens: 32000,
          async onPayload(raw) {
            const req = raw as MessageCreateParamsNonStreaming;
            const tokens = await retryArchitectProvider(
              (signal) => provider.count(req, signal),
              signal,
            );
            if (!Number.isSafeInteger(tokens) || tokens < 0)
              throw Error("Invalid architect input token count");
            const input = tokens * model.cost.input;
            const max = Math.min(
              req.max_tokens,
              Math.floor(
                (i.budget().sessionUsd * 1e6 - input) / model.cost.output,
              ),
            );
            if (max < 1) {
              i.status = "budget";
              throw Error("Architect budget exhausted");
            }
            req.max_tokens = max;
            settle = i.reserve((input + max * model.cost.output) / 1e6);
            return req;
          },
          // Pi reduces provider errors to text. Preserve HTTP status and retry
          // headers here, including on Pi's strict-tool fallback request.
          async fetch(input, init) {
            transportError = undefined;
            if (!settle) throw Error("Missing architect reservation");
            const response = await fetch(input, init).catch((error) => {
              transportError = new APIConnectionError({ cause: error });
              throw transportError;
            });
            if (response.ok) streamHeaders = response.headers;
            else {
              const { status, headers } = response;
              signal.throwIfAborted();
              if (unbilledProviderFailure(response)) {
                settle(0);
                settle = undefined;
              }
              transportError = Object.assign(
                Error("Architect provider HTTP " + status),
                { status, headers },
              );
            }
            return response;
          },
        },
      );
      // Only a completed attempt may enter the transcript or execute tools.
      const reply = await events.result();
      signal.throwIfAborted();
      if (reply.stopReason === "error" || reply.stopReason === "aborted") {
        if (transportError) throw transportError;
        if (streamHeaders) {
          const status = streamFailureStatus(reply.errorMessage);
          if (status)
            throw Object.assign(
              Error("Architect stream failed (" + status + ")"),
              { status, headers: streamHeaders },
            );
        }
        if (
          settle &&
          /^(terminated|Anthropic stream ended (?:before message_stop|without a stop reason))$/.test(
            reply.errorMessage ?? "",
          )
        )
          throw Object.assign(Error("Architect stream disconnected"), {
            code: "ECONNRESET",
          });
        return events;
      }
      settle!(reply.usage.cost.total);
      return events;
    }, signal);
  return stream;
}
async function converse(
  i: Iteration,
  tools: ReturnType<typeof architectTools>,
  signal: AbortSignal,
  options: ArchitectOptions,
) {
  const stream = metered(i, signal, options);
  const user = (content: string) => ({
    role: "user" as const,
    content,
    timestamp: Date.now(),
  });
  const system = {
    role: "system" as const,
    content: ARCHITECT_PROMPT,
    timestamp: Date.now(),
  };
  i.record("system", system);
  let next = "";
  await runAgentLoop(
    [
      user(
        "This is the start of a new iteration. Read your notes, the hypothesis list and the results of earlier runs before deciding what to do. " +
          (options.only
            ? "In this iteration submit accepts only these kinds: " +
              options.only.join(", ") +
              ". "
            : "") +
          "Your budget: " +
          JSON.stringify(i.budget()),
      ),
    ],
    { messages: [system], tools },
    {
      model,
      toolExecution: "sequential",
      convertToLlm: (messages) =>
        messages.filter(
          (m) =>
            m.role === "system" ||
            m.role === "user" ||
            m.role === "assistant" ||
            m.role === "toolResult",
        ),
      finishTurn: ({ message, toolResults }) => {
        if (i.budget().sessionUsd <= 0 && i.status === "running")
          i.status = "budget";
        if (i.status !== "running") return { action: "end" };
        if (message.stopReason === "error" || message.stopReason === "aborted")
          throw Error("Architect provider request failed");
        if (!toolResults.length) {
          next =
            message.stopReason === "length"
              ? PI_CONTRACT.recovery.outputLimitContinuation.prompt
              : "The iteration is still open. It ends only when you call submit. Continue, or save your notes and submit.";
          return { action: "continue" };
        }
      },
      prepareNextTurn: () => {
        if (next) {
          const message = user(next + " " + JSON.stringify(i.budget()));
          next = "";
          return { messages: [message] };
        }
      },
    },
    (event) => {
      if (event.type === "tool_execution_start")
        i.record("tool_call", { name: event.toolName, args: event.args });
      if (event.type !== "message_end") return;
      const m = event.message;
      if (m.role === "toolResult" && m.isError)
        m.content.push({
          type: "text",
          text: JSON.stringify({ budget: i.budget() }),
        });
      i.record("message", m);
      if (
        m.role === "assistant" &&
        !["error", "aborted"].includes(m.stopReason)
      ) {
        if (m.responseModel && m.responseModel !== model.id)
          throw Error("Unexpected architect model");
      }
    },
    signal,
    stream,
  );
  if (i.status === "running")
    throw Error("Architect session stopped without a submission");
}

export async function architectIteration(
  host: EvaluationHost,
  options: ArchitectOptions = {},
) {
  const signal = options.signal ?? new AbortController().signal;
  const service = developmentService(host);
  try {
    if (service.budget().nominee)
      throw Error("Development closed after nomination");
    const i = new Iteration(host.root);
    try {
      const box = new DockerSandbox(
        host.config,
        (dir, sig) =>
          writeSessionExport(
            dir,
            viewBatches(host.training, "architect", sig),
            sig,
          ),
        undefined,
        host.root,
      );
      try {
        const limits = host.config.budget.sandbox;
        const tools = architectTools(
          i,
          service,
          (code) =>
            box.execute(
              code,
              {
                ...limits,
                wallSeconds: limits.perCallSeconds,
                computeSeconds: limits.perCallSeconds * limits.cpu,
              },
              signal,
            ),
          options.only,
        );
        if (i.budget().sessionUsd <= 0) i.status = "budget";
        else {
          await converse(i, tools, signal, options);
        }
        return { iteration: i.id, status: i.status, budget: i.budget() };
      } finally {
        await box.close();
      }
    } catch (e) {
      if (i.status === "running") i.status = "failed";
      throw e;
    } finally {
      i.close();
    }
  } finally {
    service.close();
  }
}
