import type {
  MessageCreateParamsNonStreaming,
  TextBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import type { Budget } from "../runner/budget.js";

// Pi rebuilds the full transcript on every request. Keep the original budget
// annotations at their message positions so later turns see the same history.
export class ForecastBudgetNotices {
  private turns = new Map<number, { tokens: number; warning?: string }>();
  private warnings = 0;

  annotate(request: MessageCreateParamsNonStreaming, budget: Budget) {
    const index = request.messages.length - 1;
    if (request.messages[index]?.role !== "user")
      throw Error("Expected a forecast user turn");
    const remaining = budget.remaining();
    const threshold = budget.config.budget.warnRemainingTokens;
    const level = this.warnings === 0 ? threshold : Math.floor(threshold / 2);
    let delivery;
    if (!this.turns.has(index)) {
      const turn: { tokens: number; warning?: string } = {
        tokens: remaining.tokens,
      };
      if (this.warnings < 2 && remaining.tokens <= level) {
        const action =
          budget.stage === "postgame"
            ? "Finish writing memory now."
            : budget.stage === "commit"
              ? "The forecast is frozen. Finish now."
              : "Validate and freeze the forecast now. If a draft already passed validation, call freeze_forecast with {}.";
        turn.warning = `Budget warning: ${remaining.tokens} tokens, ${remaining.compute} compute seconds and ${remaining.tools} tool calls remaining. ${action}`;
        delivery = { threshold: level, remaining, text: turn.warning };
        this.warnings++;
      }
      this.turns.set(index, turn);
    }
    for (const [position, turn] of this.turns) {
      const message = request.messages[position];
      if (message?.role !== "user") continue;
      const content =
        typeof message.content === "string"
          ? [{ type: "text" as const, text: message.content }]
          : message.content;
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        const line: TextBlockParam = {
          type: "text",
          text: `Remaining token budget: ${turn.tokens}`,
        };
        if (typeof block.content === "string")
          block.content += "\n" + line.text;
        else block.content = [...(block.content ?? []), line];
      }
      if (turn.warning)
        message.content = [...content, { type: "text", text: turn.warning }];
    }
    return delivery;
  }
}
