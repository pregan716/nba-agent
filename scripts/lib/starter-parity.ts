import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, readFileSync, mkdirSync, chmodSync } from "node:fs";
import { resolve, join } from "node:path";
import type { ObservableState } from "../../src/replay/types.js";
export async function referenceStarterPredictions(
  image: string,
  artifact: string,
  states: ObservableState[],
  root: string,
) {
  mkdirSync(root, { recursive: true });
  chmodSync(root, 0o755);
  writeFileSync(
    join(root, "states.jsonl"),
    states.map((s) => JSON.stringify(s)).join("\n") + "\n",
  );
  const { stdout } = await promisify(execFile)(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--cpus",
      "1",
      "--memory",
      "512m",
      "--user",
      `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      "--mount",
      `type=bind,source=${resolve("starter")},target=/code,readonly`,
      "--mount",
      `type=bind,source=${resolve(artifact)},target=/artifact,readonly`,
      "--mount",
      `type=bind,source=${resolve(root)},target=/output`,
      "--entrypoint",
      "python",
      image.replace(/^local@/, ""),
      "/code/compare.py",
      "/artifact/model.json",
      "/output/states.jsonl",
      "/output/predictions.jsonl",
    ],
    { maxBuffer: 1024 * 1024 },
  );
  const parity = JSON.parse(stdout.trim());
  if (parity.byteIdenticalStates !== states.length)
    throw Error("Incomplete reference comparison");
  return {
    parity,
    answers: readFileSync(join(root, "predictions.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  };
}
