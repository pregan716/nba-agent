import type { RecordStore } from "../runner/record.js";
import type { AgentRunner } from "./agents.js";
import type { Package } from "./package.js";
import type { GameMeter } from "./meter.js";
import type { TeamGame } from "./replay.js";

/** Only this host dispatcher can turn a sandbox action into a provider request. */
export function agentDispatcher(
  pkg: Package,
  game: TeamGame,
  scope: string,
  record: RecordStore,
  meter: GameMeter,
  agentsOff: boolean,
  run: AgentRunner,
  signal: AbortSignal,
  invoke: (file: string, input: unknown) => Promise<unknown>,
) {
  return async (name: string, input: unknown) => {
    const agent = Object.hasOwn(pkg.agents, name)
      ? pkg.agents[name]
      : undefined;
    const system = agent
      ? [agent.prompt, ...agent.skills]
          .join("\n\n")
          .replaceAll("{{team}}", () => game.teamId)
          .replaceAll("{{game}}", () => game.gameId)
      : null;
    const start = record.append("agent_start", scope, {
      name,
      model: agent?.model ?? null,
      system,
      input,
    });
    const initial = meter.usd,
      initialHeld = meter.unresolvedUsd;
    let reply;
    if (!agent || !system || agentsOff || meter.remaining() <= 0)
      reply = { ok: false, error: "Agent call refused" };
    else
      try {
        signal.throwIfAborted();
        const value = await run({
          agent,
          system,
          input: { teamId: game.teamId, gameId: game.gameId, task: input },
          signal,
          remaining: meter.remaining,
          reserve: meter.reserve,
          transcript: (value) => {
            record.append("agent_transcript", scope, {
              call: start.seq,
              value,
            });
          },
          async tool(toolName, args) {
            if (!Object.hasOwn(agent.tools, toolName))
              throw Error("Undeclared tool");
            return invoke(agent.tools[toolName].file, args);
          },
        });
        reply = { ok: true, value };
      } catch (error) {
        record.append("agent_error", scope, {
          call: start.seq,
          message: String(error),
        });
        reply = { ok: false, error: "Agent call failed" };
      }
    record.append("agent_end", scope, {
      call: start.seq,
      model: agent?.model ?? null,
      reply,
      usd: meter.usd - initial,
      unresolvedUsd: meter.unresolvedUsd - initialHeld,
    });
    return reply;
  };
}
