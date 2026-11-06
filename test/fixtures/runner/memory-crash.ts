import { fixtureCorpus } from "../session/corpus.js";
import { memoryVariant } from "../../../src/env/memory.js";
import { harnessConfig } from "../../../src/harness/version.js";
import { manifest } from "../../../src/runner/config.js";
import { Runner } from "../../../src/runner/runner.js";
import { MeteringProxy } from "../../../src/runner/proxy.js";
import { sessionEnvironment } from "../../../src/env/session.js";
import { PolicyTools } from "../../../src/policy/tools.js";
import { policyHarness } from "../../../src/policy/replay.js";
import { sha256 } from "../../../src/data/store.js";
import type { Assembler } from "../../../src/policy/sandbox.js";
const f = fixtureCorpus();
f.config.profile.memory = memoryVariant("M3");
f.config.budget.memory = {
  tokenCap: 50000,
  countProtocol: "analyst-count-snapshot-v1",
};
f.config.harness = harnessConfig({
  memory: f.config.profile.memory,
  memoryInstructions: "fixture-only",
  effort: "high",
  thinking: "adaptive",
  sandboxImage: f.config.harness.sandboxImage,
  codeRevision: "test",
});
const assembler: Assembler = {
  image: `fixture@sha256:${"c".repeat(64)}`,
  limits: { wallSeconds: 1, memoryBytes: 1000000, outputBytes: 10000 },
  run: async () => ({ value: { loaded: true }, computeSeconds: 0.01 }),
};
f.config.harness.policy = policyHarness(assembler);
const m = manifest(f.config, [f.game]);
const proxy = new MeteringProxy({
  count: async (request) =>
    JSON.parse(request.messages[0].content as string).reduce(
      (sum: number, file: any) => sum + file.content.length,
      0,
    ),
  create: async () => {
    throw Error("No inference");
  },
});
await proxy.listen();
const environment = sessionEnvironment(f.config, f.source, {
  policy: (context, trusted) => {
    const tools = new PolicyTools(
      trusted.root,
      trusted.workspace,
      context.game,
      m.games,
      assembler,
      [],
      () => new Date(Date.parse(context.game.scheduledStart) - 1).toISOString(),
    );
    if (process.argv[3] === "receipt") {
      const freeze = tools.freeze.bind(tools);
      tools.freeze = async (...args) => {
        const receipt = await freeze(...args);
        process.send?.("frozen");
        await new Promise(() => {});
        return receipt;
      };
    }
    return tools;
  },
});
const runner = new Runner(
  process.argv[2],
  m,
  proxy,
  environment,
  undefined,
  async () => {
    throw Error("Replay must not precede injected crash");
  },
);
await runner.run(async ({ session }) => {
  const code = "def assemble(state): return {}\n";
  await session.call("workspace_write", {
    path: "memory/coach_profile.md",
    content: "saved-before-freeze",
  });
  await session.call("workspace_write", {
    path: "packages/current/assemble.py",
    content: code,
  });
  await session.call("workspace_write", {
    path: "packages/current/manifest.json",
    content: JSON.stringify({
      stateVersion: "state-v1",
      components: { "assemble.py": sha256(Buffer.from(code)) },
      notes: "fixture",
    }),
  });
  await session.call("freeze_package", {});
  process.send?.("frozen");
  await new Promise(() => {});
});
