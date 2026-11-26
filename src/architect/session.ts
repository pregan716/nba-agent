import { runAgentLoop, type StreamFn } from "@earendil-works/pi-agent-core";
import { APIConnectionError } from "@anthropic-ai/sdk";
import {
  retryArchitectProvider,
  unbilledProviderFailure,
} from "../runner/retry.js";
import { PI_CONTRACT } from "../harness/version.js";
import { DockerSandbox } from "../env/sandbox.js";
import { viewBatches } from "../data/architect-view.js";
import { writeSessionExport } from "../env/export.js";
import {
  developmentService,
  type EvaluationHost,
} from "../evaluation/service/index.js";
import { architectTools, type SubmissionKind } from "./tools.js";
import { Iteration, architectWarnUsd } from "./iteration.js";
import { architectPrompt } from "./prompt.js";
import {
  architectProvider,
  answeredBy,
  dearestRates,
  type ArchitectModel,
} from "./providers.js";

export { architectModels, type ArchitectModel } from "./providers.js";
// Tokens the provider adds to a request that are not in its bytes (the tool-use
// system prompt is a few hundred).
const providerOverheadTokens = 1000;
const maxTokens = 32000;
interface ArchitectOptions {
  apiKey?: string;
  baseURL?: string;
  signal?: AbortSignal;
  /** Operator restriction on what this iteration may submit. */
  only?: readonly SubmissionKind[];
  /** Defaults to the experiment's architect model. */
  model?: ArchitectModel;
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
/** The architect's requests to its provider, each held against the iteration's
 * budget before it is sent and settled from the reply's usage. */
export function metered(
  i: Iteration,
  signal: AbortSignal,
  options: ArchitectOptions,
) {
  const provider = architectProvider(options.model);
  const baseUrl = options.baseURL ?? provider.model.baseUrl;
  const model = { ...provider.model, baseUrl };
  const key = options.apiKey ?? process.env[provider.keyEnv];
  if (!key) throw Error("Missing architect provider credentials");
  const count = provider.count?.(key, baseUrl);
  const rates = dearestRates(model);
  const recorded = new Set<string>();
  const stream: StreamFn = async (_, context, streamOptions) => {
    // The models the provider's own stream events name for the last attempt.
    // The adapters do not all pass this on, so it is read from the events.
    let answering = new Set<string>();
    const events = await retryArchitectProvider(async () => {
      answering = new Set();
      let settle: ((usd: number) => void) | undefined;
      let heldUsd = 0;
      let transportError: unknown;
      let streamHeaders: Headers | undefined;
      const events = provider.stream(model, context, {
        ...streamOptions,
        apiKey: key,
        // The conversation is re-read on every request, so its prefix is
        // cached (five-minute retention; user decision after the pilot).
        cacheRetention: "short",
        ...(provider.session ? { sessionId: i.id } : {}),
        // High reasoning effort (user decision, Nov 16, 2026).
        reasoning: "high",
        maxRetries: 0,
        maxTokens,
        onProviderStreamEvent(event) {
          const name = provider.answering(event as Record<string, any>);
          if (typeof name === "string" && name) answering.add(name);
        },
        async onPayload(raw) {
          const req = raw as Record<string, any>;
          const tokens = count
            ? await retryArchitectProvider(
                (signal) => count(req, signal),
                signal,
              )
            : 0;
          if (!Number.isSafeInteger(tokens) || tokens < 0)
            throw Error("Invalid architect input token count");
          // The hold must cover the dearest bill this request can produce.
          // A provider's own count is only an estimate, and not every
          // provider has one, so the input is bounded by the request's size
          // instead: a token covers at least one byte of the serialised
          // request, and the allowance covers what the provider adds for
          // tool use. Every input token is priced at the dearest input rate
          // the model has. Cache reads, uncached tokens and the real count
          // settle for less.
          const bound = Math.max(
            tokens,
            Buffer.byteLength(JSON.stringify(req)) + providerOverheadTokens,
          );
          const input = bound * rates.input;
          // The iteration ends when the balance cannot hold one more request,
          // so the warning has to start a little above that.
          i.warnUsd = Math.max(architectWarnUsd, input / 1e6 + 2);
          // The limit is always set here, whether or not the adapter sent one:
          // without it the output, and so the bill, has no bound.
          const [holder, field] = provider.limit(req);
          const max = Math.min(
            Number(holder[field] ?? maxTokens),
            maxTokens,
            Math.floor((i.budget().sessionUsd * 1e6 - input) / rates.output),
          );
          if (!(max >= provider.minOutput)) {
            i.status = "budget";
            throw Error("Architect budget exhausted");
          }
          holder[field] = max;
          heldUsd = (input + max * rates.output) / 1e6;
          settle = i.reserve(heldUsd);
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
      });
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
          // What each adapter reports when the stream stops short.
          /^(terminated|.*stream ended (?:before|without) .*)$/i.test(
            reply.errorMessage ?? "",
          )
        )
          throw Object.assign(Error("Architect stream disconnected"), {
            code: "ECONNRESET",
          });
        return events;
      }
      // A reply always has input. One that reports none lost its usage report
      // (some providers send it as a last, separate event), so it is charged
      // the whole hold instead of nothing.
      const { usage } = reply;
      settle!(
        usage.input + usage.cacheRead + usage.cacheWrite > 0
          ? usage.cost.total
          : heldUsd,
      );
      return events;
    }, signal);
    const reply = await events.result();
    if (reply.stopReason === "error" || reply.stopReason === "aborted")
      return events;
    // A completed reply has been paid for. Before it enters the transcript or
    // any of its tool calls runs, it must name the model that was asked for,
    // and no other. A reply that names no model is not accepted either.
    for (const name of answering)
      if (!recorded.has(name)) {
        recorded.add(name);
        i.record("reply_model", name);
      }
    if (
      !answering.size ||
      [...answering].some((name) => !answeredBy(provider, name))
    )
      throw Error(
        "Unexpected architect model: " +
          ([...answering].join(", ") || "none named"),
      );
    return events;
  };
  return stream;
}
async function converse(
  i: Iteration,
  tools: ReturnType<typeof architectTools>,
  signal: AbortSignal,
  options: ArchitectOptions,
  round: { round: number; baselineRunId: string | null },
) {
  const stream = metered(i, signal, options);
  const provider = architectProvider(options.model);
  const { model } = provider;
  // A pool has one architect model, so its iterations describe one architect.
  for (const row of i.db
    .prepare("SELECT DISTINCT data FROM events WHERE kind='model'")
    .all())
    if (JSON.parse(String(row.data)) !== model.id)
      throw Error(
        "This pool's architect model is " + JSON.parse(String(row.data)),
      );
  i.record("model", model.id);
  const user = (content: string) => ({
    role: "user" as const,
    content,
    timestamp: Date.now(),
  });
  const system = {
    role: "system" as const,
    content: architectPrompt(round.round),
    timestamp: Date.now(),
  };
  i.record("system", system);
  let next = "";
  await runAgentLoop(
    [
      user(
        "This is the start of a new iteration. Read your notes, the hypothesis list and the results of earlier runs before deciding what to do. " +
          (round.baselineRunId
            ? "The baseline's full evaluation is run " +
              round.baselineRunId +
              ". "
            : "") +
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
              : "The iteration is still open. It ends only when you submit a full, repeat or check evaluation or a nomination. Continue, or save your notes and submit.";
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
          await converse(i, tools, signal, options, service.round());
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
