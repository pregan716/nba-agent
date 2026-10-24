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
  environment,
);
try {
  await runner.run(async ({ session }) => {
    const ctx = (await session.call("context")) as any;
    if (ctx.phase !== "postgame") {
      if (process.argv[3] === "resume")
        throw Error("Committed pregame was replayed");
      await session.call("workspace_write", "committed memory");
      await session.call("begin_commit");
      await session.call("submit", "valid");
      process.kill(process.pid, "SIGKILL");
    } else await session.call("workspace_write", "postgame memory");
  });
} finally {
  runner.close();
  await proxy.close();
}
