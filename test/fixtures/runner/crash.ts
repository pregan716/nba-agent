import { Workspace, WorkspacePolicy } from "../../../src/env/workspace.js";
import type { LifecyclePhase } from "../../../src/env/lifecycle.js";
import { manifest } from "../../../src/runner/config.js";
import { Runner } from "../../../src/runner/runner.js";
import { MeteringProxy } from "../../../src/runner/proxy.js";
import { environment, fixtureConfig, provider } from "./support.js";
const proxy = new MeteringProxy(provider);
await proxy.listen();
const runner = new Runner(
  process.argv[2],
  manifest(fixtureConfig(), [
    { gameId: "g1", scheduledStart: "2025-10-22T23:30:00Z" },
  ]),
  proxy,
  async (context, trusted) => {
    const env = await environment(context, trusted);
    let phase: LifecyclePhase | "closed" = context.phase;
    const workspace = new Workspace(
      trusted.workspace,
      new WorkspacePolicy(context.memory, () =>
        phase === "initialize" || phase === "checkpoint" ? "closed" : phase,
      ),
      trusted.root,
    );
    return {
      ...env,
      workspaceChanges: () => workspace.changes(),
      async transition(next, cutoff) {
        await env.transition(next, cutoff);
        phase = next;
      },
      async close() {
        phase = "closed";
        await env.close();
      },
      async call(name, args, signal) {
        if (name === "workspace_write") {
          const a = args as { path: string; content: string };
          return workspace.mutate("write", a.path, Buffer.from(a.content));
        }
        return env.call(name, args, signal);
      },
    };
  },
);
try {
  await runner.run(async ({ session }) => {
    const ctx = (await session.call("context", {})) as any;
    if (ctx.phase !== "postgame") {
      await session.call("workspace_write", {
        path: "notes.txt",
        content:
          process.argv[3] === "resume" ? "recovered memory" : "partial memory",
      });
      if (process.argv[3] !== "resume") process.kill(process.pid, "SIGKILL");
    } else
      await session.call("workspace_write", {
        path: "notes.txt",
        content: "postgame memory",
      });
  });
} finally {
  runner.close();
  await proxy.close();
}
