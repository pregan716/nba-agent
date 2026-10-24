import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
const built = spawnSync(
  "docker",
  ["build", "--tag", "nba-agent-sandbox:local", "sandbox"],
  { stdio: "inherit" },
);
if (built.status !== 0) throw Error("Sandbox image build failed");
const result = spawnSync(
  "docker",
  ["image", "inspect", "nba-agent-sandbox:local", "--format", "{{.Id}}"],
  { encoding: "utf8" },
);
const id = result.stdout.trim();
if (result.status !== 0 || !/^sha256:[a-f0-9]{64}$/.test(id))
  throw Error("Sandbox image inspect failed");
const image = `local@${id}`;
mkdirSync(".cache", { recursive: true });
writeFileSync(".cache/sandbox-image.json", JSON.stringify({ image }) + "\n");
console.log(`Pin harness.sandboxImage to ${image}`);
