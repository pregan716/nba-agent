import { createServer } from "node:http";

// Local streaming Messages endpoint. Each step is an assistant turn, including
// turns that request multiple tools or exhaust the output limit.
type Call = { name: string; input: Record<string, unknown> };
export async function architectProvider() {
  const requests: {
    model: string;
    stream: boolean;
    messages: unknown[];
    tools: { name: string }[];
    max_tokens: number;
  }[] = [];
  const steps: {
    // A function builds the calls from the request, to use an earlier result.
    calls?: Call[] | ((request: { messages: unknown[] }) => Call[]);
    truncated?: boolean;
    disconnected?: boolean;
    streamError?: string;
    inputTokens?: number;
    outputTokens?: number;
    // Report the input tokens as written to the prompt cache.
    cacheWrite?: boolean;
  }[] = [];
  const failures = { count: [] as number[], model: [] as number[] };
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const count = req.url?.includes("count_tokens");
    const status = (count ? failures.count : failures.model).shift();
    if (status) {
      res.writeHead(status, {
        "content-type": "application/json",
        "retry-after": "0",
      });
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "api_error", message: "fixture failure" },
        }),
      );
      return;
    }
    if (count) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: steps[0]?.inputTokens ?? 10 }));
      return;
    }
    const request = JSON.parse(body);
    requests.push(request);
    const step = steps.shift();
    if (!step) {
      res.writeHead(400);
      res.end("No fixture turn");
      return;
    }
    const calls =
      typeof step.calls === "function" ? step.calls(request) : step.calls;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (type: string, data: Record<string, unknown>) =>
      res.write(
        "event: " +
          type +
          "\ndata: " +
          JSON.stringify({ type, ...data }) +
          "\n\n",
      );
    emit("message_start", {
      message: {
        id: "m" + requests.length,
        model: request.model,
        type: "message",
        role: "assistant",
        content: [],
        usage: step.cacheWrite
          ? {
              input_tokens: 0,
              cache_creation_input_tokens: step.inputTokens ?? 10,
              output_tokens: 0,
            }
          : { input_tokens: step.inputTokens ?? 10, output_tokens: 0 },
        stop_reason: null,
      },
    });
    for (const [index, call] of (calls ?? []).entries()) {
      emit("content_block_start", {
        index,
        content_block: {
          type: "tool_use",
          id: "t" + requests.length + "_" + index,
          name: call.name,
          input: {},
        },
      });
      emit("content_block_delta", {
        index,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(call.input),
        },
      });
      emit("content_block_stop", { index });
    }
    if (!calls?.length) {
      emit("content_block_start", {
        index: 0,
        content_block: { type: "text", text: "" },
      });
      emit("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text: "continuing" },
      });
      emit("content_block_stop", { index: 0 });
    }
    if (step.streamError)
      emit("error", {
        error: { type: step.streamError, message: "fixture stream error" },
      });
    if (step.disconnected || step.streamError) {
      res.end();
      return;
    }
    emit("message_delta", {
      delta: {
        stop_reason: step.truncated
          ? "max_tokens"
          : calls?.length
            ? "tool_use"
            : "end_turn",
      },
      usage: { output_tokens: step.outputTokens ?? 3 },
    });
    emit("message_stop", {});
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
    options: { apiKey: "fixture", baseURL: "http://127.0.0.1:" + address.port },
    close: () => server.close(),
  };
}
