import { Workspace, WorkspacePolicy } from "../../../src/env/workspace.js";
import type { LifecyclePhase } from "../../../src/env/lifecycle.js";
import { validateSubmission } from "../../../src/env/submission.js";
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
      validateSubmission: async (value) =>
        validateSubmission(value, await env.questions()),
    };
  },
);
try {
  await runner.run(async ({ session }) => {
    const ctx = (await session.call("context", {})) as any;
    if (ctx.phase !== "postgame") {
      if (process.argv[3] === "resume")
        throw Error("Committed pregame was replayed");
      await session.call("workspace_write", {
        path: "notes.txt",
        content: "committed memory",
      });
      const { questions } = await session.call("list_questions", {});
      await session.call("begin_commit", {});
      await session.call("submit", {
        answers: questions.map((q) => ({
          question_id: q.question_id,
          p_over: q.p_over,
        })),
        notes: "valid",
      });
      process.kill(process.pid, "SIGKILL");
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
