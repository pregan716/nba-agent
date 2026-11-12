// Private IPC entrypoint. Launched with an empty environment and temporary cwd.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { forecastTools, forecastPrompts } from "../projection/tools.js";
import { type ContextResult } from "../env/contract.js";
import { TOOL_DEFINITIONS } from "../env/tools.js";
import { offeredTools } from "./loop.js";
import { piLoop, PI_CONTRACT } from "./version.js";
import { promptTexts } from "./prompts.js";

let stopped = false;
let activeSession: AgentSession | undefined;
let acknowledgeFinalHistory: (() => void) | undefined;
let nextId = 0;
const pending = new Map<
  number,
  { resolve: (value: any) => void; reject: (error: Error) => void }
>();
const send = (message: unknown) => process.send?.(message);
function call(name: string, args: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    send({ type: "call", id, name, args });
  });
}
process.on("message", (message: any) => {
  if (message.type === "history_recorded") {
    acknowledgeFinalHistory?.();
  } else if (message.type === "abort") {
    stopped = true;
    void activeSession?.abort();
  } else if (message.type === "result") {
    const waiter = pending.get(message.id)!;
    pending.delete(message.id);
    if (message.error)
      waiter.reject(Object.assign(Error(message.error.message), message.error));
    else waiter.resolve(message.value);
  } else if (message.type === "start") {
    run(message)
      .then(() => process.disconnect?.())
      .catch((error) => {
        send({ type: "failure", message: String(error) });
        process.exitCode = 1;
        process.disconnect?.();
      });
  }
});

async function run({ options, model, memoryInstructions, root }: any) {
  if (VERSION !== PI_CONTRACT.packageVersion)
    throw Error("Pi package version does not match harness descriptor");
  const context: ContextResult = await call("context", {});
  const forecast = context.capabilities.includes("player_forecasts");
  const loop = piLoop(forecast, options.loop);
  const definitions = forecast
    ? forecastTools(context.phase, context.memory.horizon === "season")
    : TOOL_DEFINITIONS.filter((t) => offeredTools(context).includes(t.name));
  const names: string[] = definitions.map((t) => t.name);
  const texts = forecast
    ? forecastPrompts
    : promptTexts(options.promptSet ?? "infrastructure");
  const system = `${texts.system}\n\n${memoryInstructions}`;
  const cwd = join(root, "cwd"),
    agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: {
      enabled: false,
      maxRetries: 0,
      provider: { maxRetries: 0, timeoutMs: loop.timeoutMs },
    },
    cacheWarming: "off",
  });
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  runtime.registerProvider("nba-metered", {
    baseUrl: model.baseURL,
    apiKey: model.apiKey,
    api: "anthropic-messages",
    models: [
      {
        id: options.model,
        name: "Metered analyst",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: loop.maxTokens,
      },
    ],
  });
  let session: AgentSession | undefined;
  let turns = 0,
    settled = false;
  const events: unknown[] = [];
  let failure: Error | undefined;
  const abort = () => {
    stopped = true;
    void session?.abort();
  };
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => system,
    appendSystemPromptOverride: () => [],
    extensionFactories: [
      (pi) => {
        for (const definition of definitions) {
          pi.registerTool({
            name: definition.name,
            label: definition.name,
            description: definition.description,
            parameters: definition.input_schema as TSchema,
            async execute(_id, args) {
              try {
                const value = await call(definition.name, args);
                return {
                  content: [{ type: "text", text: JSON.stringify(value) }],
                  details: value,
                };
              } catch (error: any) {
                if (error.code === "budget_exhausted" || error.limit) abort();
                else if (!error.sessionError) {
                  failure = error;
                  abort();
                }
                throw error;
              }
            },
          });
        }
        pi.on("tool_call", async (event) => {
          if (!names.includes(event.toolName))
            return { block: true, reason: "Tool outside session allowlist" };
        });
        // Pi normally adds coding instructions and cwd/date to a base prompt.
        // Return the exact contract prompt after that assembly, too.
        pi.on("before_agent_start", async () => ({ systemPrompt: system }));
        pi.on("before_provider_request", async (event) => {
          const payload = {
            ...(event.payload as object),
            max_tokens: loop.maxTokens,
          };
          if (loop.promptCache === "none") {
            const strip = (value: any): void => {
              if (!value || typeof value !== "object") return;
              delete value.cache_control;
              for (const child of Object.values(value)) strip(child);
            };
            strip(payload);
          }
          return payload;
        });
        pi.on("after_provider_response", async (event) => {
          if (event.status === 429) abort();
        });
        pi.on("turn_start", async () => {
          if (++turns > loop.maxTurns) abort();
        });
      },
    ],
  });
  await loader.reload();
  session = (
    await createAgentSession({
      cwd,
      agentDir,
      modelRuntime: runtime,
      model: runtime.getModel("nba-metered", options.model)!,
      thinkingLevel: "high",
      noTools: "builtin",
      tools: names,
      settingsManager: settings,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
    })
  ).session;
  activeSession = session;
  session.subscribe((event) => {
    if (
      event.type === "message_end" &&
      event.message.role === "assistant" &&
      event.message.stopReason === "error" &&
      /^429 .*rate_limit_error.*Session limit:/.test(
        event.message.errorMessage ?? "",
      )
    )
      abort();
    if (
      event.type === "message_end" ||
      event.type === "tool_execution_end" ||
      event.type === "agent_end"
    )
      events.push(structuredClone(event));
    if (event.type === "agent_end")
      send({
        type: "history",
        history: { messages: session!.messages, events, turns },
      });
    if (event.type === "agent_settled") settled = true;
  });
  try {
    const phasePrompt =
      context.phase === "postgame"
        ? options.process === "mandated-reflection"
          ? texts.postgame_mandated
          : texts.postgame
        : texts.pregame;
    const continuation = PI_CONTRACT.recovery.outputLimitContinuation;
    let prompt = `${phasePrompt}\n\nSession context:\n${JSON.stringify(context)}`;
    for (let count = 0; ; count++) {
      settled = false;
      await session.prompt(prompt);
      if (failure) throw failure;
      if (!settled) throw Error("Pi returned before agent_settled");
      const last = session.messages.at(-1);
      if (stopped || last?.role !== "assistant") break;
      if (last.stopReason === "error") throw Error(last.errorMessage);
      if (
        last.stopReason !== "length" ||
        last.content.some((block) => block.type === "toolCall") ||
        count >= continuation.limit ||
        turns >= loop.maxTurns
      )
        break;
      send({
        type: "output_limit_continuation",
        continuation: count + 1,
        outputTokens: last.usage.output,
      });
      prompt = continuation.prompt;
    }
  } finally {
    // process.send queues large payloads; disconnect/exit must wait until the
    // parent has durably appended the final snapshot, not merely queued bytes.
    await new Promise<void>((resolve) => {
      acknowledgeFinalHistory = resolve;
      send({
        type: "history",
        final: true,
        history: {
          messages: session.messages,
          events,
          turns,
          settled,
          stopped,
        },
      });
    });
    session.dispose();
  }
}
