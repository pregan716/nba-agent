import { mountModels, type BuiltModels } from "./models.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunConfig, Game } from "../runner/config.js";
import { DockerSandbox } from "../env/sandbox.js";
import { Session } from "../env/session.js";
import type { SessionSource } from "../env/source.js";
import { approvedPackage } from "../evaluation/review/index.js";
import type { Package } from "./package.js";

const stepResultBytes = 1024 * 1024;

export function gameSandbox(
  config: RunConfig,
  data: SessionSource,
  game: Game,
  submission: Package,
  context: { teamId: string },
  root: string,
  recordStep: (entry: Record<string, unknown>) => void,
  trainedModels: BuiltModels = {},
) {
  const { pkg } = approvedPackage(submission);
  const session = new Session(
    config,
    game,
    "pregame",
    game.scheduledStart,
    data,
    undefined,
    undefined,
    undefined,
    true,
    context.teamId,
  );
  const box = new DockerSandbox(
    config,
    (dir, signal) => session.exportTo(dir, signal),
    undefined,
    root,
    (dir) => {
      mountModels(dir, trainedModels);
      const path = join(dir, "package");
      mkdirSync(path);
      for (const [name, source] of Object.entries(pkg.files))
        writeFileSync(join(path, name), source, { flag: "wx", mode: 0o444 });
      writeFileSync(join(dir, "game.json"), JSON.stringify(context), {
        mode: 0o444,
      });
    },
  );
  return {
    async invoke(
      file: string,
      argument: unknown,
      seconds: number,
      signal: AbortSignal,
    ) {
      const input = Buffer.from(JSON.stringify(argument)).toString("base64");
      const program = [
        "import json, sys, runpy, base64",
        "sys.path.insert(0, '/data/package')",
        "ctx = json.load(open('/data/game.json'))",
        "args = json.loads(base64.b64decode('" + input + "'))",
        "fn = runpy.run_path(" +
          JSON.stringify("/data/package/" + file) +
          ")['run']",
        "sys.stdout.write(json.dumps(fn(ctx,args),allow_nan=False,separators=(',',':')))",
      ].join("\n");
      const res = await box.execute(
        program,
        {
          ...config.budget.sandbox,
          stdoutBytes: stepResultBytes,
          stderrBytes: config.budget.sandbox.stdoutBytes,
          wallSeconds: seconds,
          computeSeconds: seconds * config.budget.sandbox.cpu,
        },
        signal,
        "json",
      );
      const diagnostic = {
        file,
        stderr: res.stderr,
        exitStatus: res.exitStatus,
        limit: res.limit,
        stdoutTruncated: res.truncated,
      };
      let action: unknown;
      try {
        if (res.exitStatus !== 0 || res.truncated || res.limit)
          throw Error(
            "Sandbox step failed: " +
              (res.limit ||
                (res.truncated
                  ? "result exceeds the 1 MiB step result limit"
                  : res.stderr || res.exitStatus)),
          );
        const value = JSON.parse(res.stdout);
        action =
          file === pkg.entry && typeof value?.type === "string"
            ? value.type.slice(0, 64)
            : null;
        return value as unknown;
      } finally {
        recordStep({ ...diagnostic, action: action ?? null });
      }
    },
    async close() {
      await box.close();
      await session.close();
    },
  };
}
