import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import {
  buildSandboxImage,
  type SandboxBuildOptions,
} from "../src/deployment/sandbox-image.js";

const options: SandboxBuildOptions = {};
for (const arg of process.argv.slice(2)) {
  const match = /^--(push|platform)=(.+)$/.exec(arg);
  if (!match)
    throw Error(
      "Usage: npm run sandbox:build -- [--push=registry/repository:tag] [--platform=linux/amd64]",
    );
  const key = match[1] as keyof SandboxBuildOptions;
  if (options[key] !== undefined) throw Error(`Duplicate --${key}`);
  options[key] = match[2];
}
const image = buildSandboxImage(options, (args, capture = false) => {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit",
  });
  if (result.error || result.status !== 0)
    throw Error(
      `Docker ${args.slice(0, args[0] === "image" ? 2 : args[0] === "buildx" ? 3 : 1).join(" ")} failed`,
      { cause: result.error },
    );
  if (capture && args[0] === "push") process.stderr.write(result.stdout);
  return result.stdout ?? "";
});
// Publish the pin only after all build/push/pull verification succeeds.
mkdirSync(".cache", { recursive: true });
const temporary = `.cache/sandbox-image.${process.pid}.json`;
writeFileSync(temporary, JSON.stringify({ image }) + "\n");
renameSync(temporary, ".cache/sandbox-image.json");
console.log(`Pin harness.sandboxImage to ${image}`);
