import { createServer } from "node:http";

// Local streaming endpoints in the three wire formats the architect's other
// providers use: OpenAI Responses, OpenAI-style chat completions (Fireworks) and
// Gemini's streamGenerateContent. Each step is one assistant turn.
type Call = { name: string; input: Record<string, unknown> };
export type Wire = "responses" | "completions" | "gemini";
interface Step {
  calls?: Call[];
  /** The stream ends before its terminal event. */
  disconnected?: boolean;
  /** The stream completes without a usage report. */
  noUsage?: boolean;
  /** The model name the reply carries. An empty string leaves it out. */
  model?: string;
}
/** What every turn is billed, in tokens. `cached` is part of `input` and
 * `reasoning` is part of `output`. */
export const turnUsage = {
  input: 1000,
  cached: 400,
  output: 100,
  reasoning: 60,
};

export async function otherProvider() {
  const requests: { wire: Wire; key: string | undefined; body: any }[] = [];
  const steps: Step[] = [];
  const failures: number[] = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const url = req.url ?? "";
    const wire: Wire | undefined = url.endsWith("/responses")
      ? "responses"
      : url.endsWith("/chat/completions")
        ? "completions"
        : url.includes(":streamGenerateContent")
          ? "gemini"
          : undefined;
    const fail = (status: number, message: string) => {
      res.writeHead(status, {
        "content-type": "application/json",
        "retry-after": "0",
      });
      res.end(JSON.stringify({ error: { message, code: status } }));
    };
    if (!wire) return fail(404, "Unknown fixture path " + url);
    const status = failures.shift();
    if (status) return fail(status, "fixture failure");
    const body = JSON.parse(text);
    const key =
      req.headers.authorization?.replace(/^Bearer /, "") ??
      (req.headers["x-goog-api-key"] as string | undefined);
    requests.push({ wire, key, body });
    const step = steps.shift();
    if (!step) return fail(400, "No fixture turn");
    const calls = step.calls ?? [];
    const n = requests.length;
    const u = turnUsage;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const data = (value: unknown, event?: string) =>
      res.write(
        (event ? "event: " + event + "\n" : "") +
          "data: " +
          (typeof value === "string" ? value : JSON.stringify(value)) +
          "\n\n",
      );
    if (wire === "responses") {
      const model = step.model ?? body.model;
      const emit = (type: string, rest: Record<string, unknown>) =>
        data({ type, ...rest }, type);
      const base = {
        id: "resp" + n,
        object: "response",
        ...(model ? { model } : {}),
      };
      emit("response.created", {
        response: { ...base, status: "in_progress", output: [] },
      });
      const output = calls.map((call, index) => ({
        type: "function_call",
        id: "fc" + n + "_" + index,
        call_id: "call" + n + "_" + index,
        name: call.name,
        arguments: JSON.stringify(call.input),
        status: "completed",
      }));
      for (const [output_index, item] of output.entries()) {
        emit("response.output_item.added", {
          output_index,
          item: { ...item, arguments: "", status: "in_progress" },
        });
        emit("response.function_call_arguments.delta", {
          item_id: item.id,
          output_index,
          delta: item.arguments,
        });
        emit("response.function_call_arguments.done", {
          item_id: item.id,
          output_index,
          arguments: item.arguments,
        });
        emit("response.output_item.done", { output_index, item });
      }
      if (step.disconnected) return res.end();
      emit("response.completed", {
        response: {
          ...base,
          status: "completed",
          output,
          ...(step.noUsage
            ? {}
            : {
                usage: {
                  input_tokens: u.input,
                  input_tokens_details: { cached_tokens: u.cached },
                  output_tokens: u.output,
                  output_tokens_details: { reasoning_tokens: u.reasoning },
                  total_tokens: u.input + u.output,
                },
              }),
        },
      });
    } else if (wire === "completions") {
      const chunk = (rest: Record<string, unknown>) =>
        data({
          id: "cmpl" + n,
          object: "chat.completion.chunk",
          created: 0,
          ...(step.model === "" ? {} : { model: step.model ?? body.model }),
          ...rest,
        });
      chunk({
        choices: [
          {
            index: 0,
            finish_reason: null,
            delta: {
              role: "assistant",
              tool_calls: calls.map((call, index) => ({
                index,
                id: "call" + n + "_" + index,
                type: "function",
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.input),
                },
              })),
            },
          },
        ],
      });
      if (step.disconnected) return res.end();
      chunk({
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      });
      if (!step.noUsage)
        chunk({
          choices: [],
          usage: {
            prompt_tokens: u.input,
            prompt_tokens_details: { cached_tokens: u.cached },
            completion_tokens: u.output,
            completion_tokens_details: { reasoning_tokens: u.reasoning },
            total_tokens: u.input + u.output,
          },
        });
      data("[DONE]");
    } else {
      const parts = calls.map((call) => ({
        functionCall: { name: call.name, args: call.input },
      }));
      data({
        candidates: [
          {
            index: 0,
            content: { role: "model", parts },
            ...(step.disconnected ? {} : { finishReason: "STOP" }),
          },
        ],
        ...(step.noUsage || step.disconnected
          ? {}
          : {
              usageMetadata: {
                promptTokenCount: u.input,
                cachedContentTokenCount: u.cached,
                candidatesTokenCount: u.output - u.reasoning,
                thoughtsTokenCount: u.reasoning,
                totalTokenCount: u.input + u.output,
              },
            }),
        ...(step.model === ""
          ? {}
          : { modelVersion: step.model ?? "gemini-4-neon" }),
      });
    }
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Fixture failed to bind");
  return {
    requests,
    failures,
    steps,
    // The OpenAI adapter drops request fields for a key that is not an API key.
    options: {
      apiKey: "sk-fixture",
      baseURL: "http://127.0.0.1:" + address.port,
    },
    close: () => server.close(),
  };
}
