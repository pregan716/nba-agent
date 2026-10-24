// P5 homemade harness (SPO-781): a hand-written tool loop over direct Anthropic
// SDK calls. It holds exactly the three contract handles (session, metered model
// endpoint, memory instructions) and nothing else: no credentials, no paths, no
// access to the workspace or sandbox except through session tools.
//
// Fresh conversation per invocation. Memory, if any, is the workspace, which the
// environment enforces; this loop is identical for A and B.

import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlock,
  ContentBlockParam,
  Message,
  MessageParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages";
import {
  SessionError,
  TOOL_CAPABILITY,
  TOOL_NAMES,
  TOOL_PHASES,
  type ContextResult,
  type Phase,
  type ToolName,
} from "../env/contract.js";
import { messagesApiTools } from "../env/tools.js";
import type { Harness, HarnessHandles } from "../runner/runner.js";
import { PHASE_PROMPTS, SYSTEM_PROMPT } from "./prompts.js";
import { DEFAULT_LOOP, type LoopParameters } from "./version.js";

export interface AnalystOptions {
  /** Pinned analyst model id; the proxy pins it too, so this is for the request body. */
  model: string;
  loop?: Partial<LoopParameters>;
  /** Mandated reflection (configuration C) uses the mandated postgame prompt. */
  process?: "voluntary" | "mandated-reflection";
  /** Optional observer for tests and diagnostics; never alters behaviour. */
  onTurn?: (event: {
    phase: Phase;
    turn: number;
    stopReason: Message["stop_reason"];
    toolCalls: string[];
  }) => void;
}

/** Tools the model is offered in a session: legal in the phase (pregame spans commit),
 * enabled by the run's capabilities, and not workspace tools in a stateless run. */
export function offeredTools(context: ContextResult): ToolName[] {
  const phases: Phase[] =
    context.phase === "postgame" ? ["postgame"] : ["pregame", "commit"];
  return TOOL_NAMES.filter((name) => {
    if (!TOOL_PHASES[name].some((p) => phases.includes(p))) return false;
    const capability = TOOL_CAPABILITY[name];
    if (capability && !context.capabilities.includes(capability)) return false;
    if (name.startsWith("workspace_") && context.memory.horizon === "stateless")
      return false;
    return true;
  });
}

const text = (value: unknown) => JSON.stringify(value, null, 1);
const toParams = (content: ContentBlock[]): ContentBlockParam[] =>
  content as unknown as ContentBlockParam[];

function budgetError(error: unknown): "research" | "hard" | null {
  if (!(error instanceof Anthropic.APIError) || error.status !== 429)
    return null;
  const message = String(error.message);
  if (message.includes("research_tokens")) return "research";
  return "hard";
}

export function analystHarness(options: AnalystOptions): Harness {
  const loop = { ...DEFAULT_LOOP, ...options.loop };
  return async ({ session, model, memoryInstructions }: HarnessHandles) => {
    const client = new Anthropic({
      baseURL: model.baseURL,
      apiKey: model.apiKey,
      maxRetries: 0,
      timeout: loop.timeoutMs,
    });
    let context = await session.call("context", {});
    const phase = context.phase;
    const tools: Tool[] = messagesApiTools(offeredTools(context)) as Tool[];
    const system = `${SYSTEM_PROMPT}\n\n${memoryInstructions}`;
    const opening: string[] = [];
    if (phase === "postgame") {
      opening.push(
        options.process === "mandated-reflection"
          ? PHASE_PROMPTS.postgame_mandated
          : PHASE_PROMPTS.postgame,
      );
      opening.push(`Session context:\n${text(context)}`);
      const released = await session.call("read_released_results", {
        game_id: context.game.game_id,
      });
      opening.push(`Released results for this game:\n${text(released)}`);
    } else {
      opening.push(PHASE_PROMPTS.pregame);
      opening.push(`Session context:\n${text(context)}`);
      const questions = await session.call("list_questions", {});
      opening.push(`Question set:\n${text(questions)}`);
    }
    const messages: MessageParam[] = [
      { role: "user", content: opening.join("\n\n") },
    ];
    let submitted = false,
      committed = false,
      nudges = 0,
      rounds = 0,
      maxTokens = loop.maxTokens,
      truncations = 0;
    for (let turn = 1; turn <= loop.maxTurns; turn++) {
      let response: Message;
      try {
        response = await client.messages.create({
          model: options.model,
          max_tokens: maxTokens,
          system,
          messages,
          tools,
        });
      } catch (error) {
        const kind = budgetError(error);
        if (kind === null) throw error;
        if (phase === "postgame" || kind === "hard" || submitted) return;
        // Research allowance spent: the brief says stop research and require a
        // complete submission from the reserve. The harness commits on the
        // model's behalf so the next call can draw on the reserve.
        if (!committed) {
          await session.call("begin_commit", {});
          committed = true;
        }
        messages.push({
          role: "user",
          content: `${PHASE_PROMPTS.commit}\n\nYour research allowance is exhausted and the session has entered commit. Submit now.`,
        });
        continue;
      }
      const truncatedToolCall =
        response.stop_reason === "max_tokens" &&
        response.content.some((b) => b.type === "tool_use");
      if (truncatedToolCall && truncations < loop.truncationRetries) {
        // A tool call cut at max_tokens has incomplete arguments and no
        // tool_result can be paired with it. Do not commit it to history; retry
        // the same request with a larger output allowance (the proxy still
        // clamps to the remaining budget). Documented stop-reason handling.
        truncations++;
        maxTokens = Math.min(loop.maxTokensCeiling, maxTokens * 2);
        options.onTurn?.({
          phase,
          turn,
          stopReason: response.stop_reason,
          toolCalls: [],
        });
        continue;
      }
      // After the retries are spent, keep the text and thinking but drop the
      // unfinished tool_use blocks, so history never holds an unmatched call.
      const content = truncatedToolCall
        ? response.content.filter((b) => b.type !== "tool_use")
        : response.content;
      if (content.length)
        messages.push({ role: "assistant", content: toParams(content) });
      const uses = truncatedToolCall
        ? []
        : response.content.filter((b) => b.type === "tool_use");
      options.onTurn?.({
        phase,
        turn,
        stopReason: response.stop_reason,
        toolCalls: uses.map((u) => u.name),
      });
      if (response.stop_reason === "tool_use" && uses.length) {
        const results: ContentBlockParam[] = [];
        for (const use of uses) {
          let content: string,
            isError = false;
          try {
            const result = await session.call(
              use.name as ToolName,
              (use.input ?? {}) as never,
            );
            content = text(result);
            if (use.name === "submit") submitted = true;
            if (use.name === "begin_commit") committed = true;
          } catch (error) {
            if (!(error instanceof SessionError)) throw error;
            content = text(error.toJSON());
            isError = true;
          }
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            content,
            is_error: isError,
          });
        }
        rounds++;
        if (
          !submitted &&
          phase !== "postgame" &&
          rounds % loop.contextEvery === 0
        ) {
          try {
            context = await session.call("context", {});
            if (context.budget.warning)
              results.push({
                type: "text",
                text: `Budget warning: ${text(context.budget)}. Finish research and submit.`,
              });
          } catch (error) {
            if (!(error instanceof SessionError)) throw error;
          }
        }
        messages.push({ role: "user", content: results });
        if (submitted && phase !== "postgame") return;
        continue;
      }
      if (response.stop_reason === "max_tokens") {
        messages.push({
          role: "user",
          content: truncatedToolCall
            ? "Your tool call was cut off at the output limit and was not executed. Make smaller tool calls: shorter programs, fewer fields, less text per call."
            : phase === "postgame"
              ? "Your reply was cut off at the output limit. Finish briefly."
              : "Your reply was cut off at the output limit. Keep replies short and proceed to begin_commit and submit.",
        });
        continue;
      }
      // end_turn (or any other stop) without tools.
      if (phase === "postgame" || submitted) return;
      if (nudges >= loop.nudges) return;
      nudges++;
      messages.push({
        role: "user",
        content: committed
          ? `${PHASE_PROMPTS.commit}\n\nYou have not submitted. Call submit now.`
          : "You have not submitted. Call begin_commit, then submit the complete set.",
      });
    }
  };
}
