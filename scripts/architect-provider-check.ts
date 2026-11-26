// A small live check of one architect model's provider connection (SPO-939).
// It makes paid requests costing a few cents and needs the user's approval.
//
//   doppler run -- npx tsx scripts/architect-provider-check.ts MODEL [BASE_URL]
//
// It sends the real architect prompt and tool definitions through the same
// metered stream an iteration uses, asks for one tool call and one reply, and
// prints what each request used, cost and held. It opens no pool: the tools
// are stubs and the ledger is in a temporary directory.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import { Iteration } from "../src/architect/iteration.js";
import { architectPrompt } from "../src/architect/prompt.js";
import {
  answeredBy,
  architectModels,
  architectProvider,
} from "../src/architect/providers.js";
import { metered } from "../src/architect/session.js";
import { architectTools } from "../src/architect/tools.js";

const id = z.enum(architectModels).parse(process.argv[2]);
const provider = architectProvider(id);
const { model } = provider;
const root = mkdtempSync(join(tmpdir(), "architect-check-"));
const i = new Iteration(root);
const signal = AbortSignal.timeout(10 * 60 * 1000);
let failed = false;
try {
  // The real names, descriptions and schemas. Nothing behind them runs.
  const tools = architectTools(i, {} as never, async () => null).map((t) => ({
    ...t,
    async execute() {
      return {
        content: [{ type: "text" as const, text: '{"result":"check"}' }],
        details: undefined,
      };
    },
  }));
  const ledger = () =>
    i.db.prepare("SELECT spent,held FROM iterations WHERE id=?").get(i.id) as {
      spent: number;
      held: number;
    };
  let before = ledger();
  let turns = 0;
  await runAgentLoop(
    [
      {
        role: "user",
        content:
          "This is a connection check, not an iteration. Call the budget tool once. When its result arrives, reply with the single word done and call nothing else.",
        timestamp: Date.now(),
      },
    ],
    {
      messages: [
        { role: "system", content: architectPrompt(1), timestamp: Date.now() },
      ],
      tools,
    },
    {
      model,
      toolExecution: "sequential",
      convertToLlm: (messages) =>
        messages.filter((m) =>
          ["system", "user", "assistant", "toolResult"].includes(m.role),
        ) as never,
      finishTurn: ({ toolResults }) =>
        !toolResults.length || ++turns >= 3 ? { action: "end" } : undefined,
    },
    (event) => {
      if (event.type !== "message_end" || event.message.role !== "assistant")
        return;
      const m = event.message;
      const after = ledger();
      const calls = m.content.flatMap((c) =>
        c.type === "toolCall" ? [c.name] : [],
      );
      if (m.stopReason === "error" || m.stopReason === "aborted") failed = true;
      // The session stops on a reply from another model.
      if (m.responseModel && !answeredBy(provider, m.responseModel))
        failed = true;
      console.log(
        JSON.stringify({
          stopReason: m.stopReason,
          error: m.errorMessage,
          responseModel: m.responseModel,
          calls,
          text: m.content
            .flatMap((c) => (c.type === "text" ? [c.text] : []))
            .join("")
            .slice(0, 80),
          usage: {
            input: m.usage.input,
            cacheRead: m.usage.cacheRead,
            cacheWrite: m.usage.cacheWrite,
            output: m.usage.output,
            reasoning: m.usage.reasoning,
          },
          reportedUsd: m.usage.cost.total,
          chargedUsd: (after.spent - before.spent) / 1e9,
          // Holds of attempts that failed and were retried stay here.
          stillHeldUsd: after.held / 1e9,
        }),
      );
      before = after;
    },
    signal,
    // A second argument points the check at a local endpoint, for testing it.
    metered(i, signal, { model: id, baseURL: process.argv[3] }),
  );
  const total = ledger();
  console.log(
    JSON.stringify({
      model: model.id,
      requests: turns + 1,
      spentUsd: total.spent / 1e9,
      heldUsd: total.held / 1e9,
    }),
  );
} finally {
  i.status = "check";
  i.close();
  rmSync(root, { recursive: true, force: true });
}
if (failed) process.exit(1);
