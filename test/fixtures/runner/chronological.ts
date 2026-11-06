import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  chronologicalFixture,
  scriptedAnalyst,
  scriptedJev,
} from "../../../scripts/fixtures/chronological.js";
import { memoryVariant } from "../../../src/env/memory.js";
import { presetConfig } from "../../../src/harness/presets.js";
import {
  chronologicalRunner,
  replayDescriptor,
} from "../../../src/launch/run.js";
import { MeteringProxy } from "../../../src/runner/proxy.js";
import { policyHarness } from "../../../src/policy/replay.js";
import { genericAssembly } from "../../../src/policy/request.js";
import { PackageExecutionError } from "../../../src/policy/errors.js";
import type { Assembler } from "../../../src/policy/sandbox.js";
import { piHarness } from "../../../src/harness/pi.js";

export const fixtureAssembler: Assembler = {
  image: `fixture@sha256:${"a".repeat(64)}`,
  limits: {
    wallSeconds: 15,
    memoryBytes: 128 * 1024 * 1024,
    outputBytes: 256000,
  },
  async run(path, state, _signal, mode) {
    if (mode === "load")
      return { value: { loaded: true }, computeSeconds: 0.01 };
    if (
      readFileSync(join(path, "assemble.py"), "utf8").includes(
        "raise ValueError",
      )
    )
      throw new PackageExecutionError("fixture invalid first window");
    return { value: genericAssembly(state as any), computeSeconds: 0.01 };
  },
};
export function fixtureLaunchConfig(variant: "M0" | "M3") {
  const data = chronologicalFixture();
  const config = presetConfig({
    harness: "pi",
    runId: `fixture-${variant}`,
    replicateId: "r1",
    purpose: "fixture",
    memory: memoryVariant(variant),
    dataSources: data.source.versions,
  });
  config.codeRevision = config.harness.codeRevision =
    "chronological-fixture-v1";
  config.harness.policy = policyHarness(fixtureAssembler);
  config.profile.modelRoles.jev = "jev-1.14.0";
  config.replay = replayDescriptor(data.datasets);
  return { config, ...data };
}
// A real subprocess is stopped only after the durable event is written. The test
// kills it with SIGKILL, then reruns this same entrypoint without a stop point.
if (process.argv[1]?.endsWith("/fixtures/runner/chronological.ts")) {
  const [root, variant, crash, invalid] = process.argv.slice(2);
  const data = fixtureLaunchConfig(variant as "M0" | "M3");
  const proxy = new MeteringProxy(scriptedAnalyst(invalid === "invalid"), {
    async create(request, signal) {
      appendFileSync(
        join(root, "jev-calls.jsonl"),
        JSON.stringify(request) + "\n",
      );
      return scriptedJev.create(request, signal);
    },
  });
  await proxy.listen();
  const runner = chronologicalRunner({
    root,
    ...data,
    assembler: fixtureAssembler,
    proxy,
  });
  const append = runner.record.append.bind(runner.record);
  runner.record.append = (kind, scope, value) => {
    const result = append(kind, scope, value);
    const tool = value as { name?: string };
    const stop =
      (crash === "pregame" &&
        kind === "tool_result" &&
        scope === "prior:pregame" &&
        tool.name === "workspace_write") ||
      (crash === "freeze" && kind === "package_freeze") ||
      (crash === "replay" && kind === "jev_response") ||
      (crash === "postgame" &&
        kind === "tool_result" &&
        scope === "prior:postgame" &&
        tool.name === "workspace_write");
    if (stop) {
      writeFileSync(join(root, "stopped"), crash);
      process.kill(process.pid, "SIGSTOP");
    }
    return result;
  };
  try {
    await runner.run(piHarness({ model: "claude-opus-4-6" }));
  } finally {
    runner.close();
    await proxy.close();
  }
}
