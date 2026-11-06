import { execFileSync } from "node:child_process";
// Local immutable pin; publication/registry selection is a separate deployment task.
execFileSync(
  "docker",
  ["build", "--tag", "nba-agent-assembler:local", "assembler"],
  { stdio: "inherit" },
);
const id = execFileSync(
  "docker",
  ["image", "inspect", "nba-agent-assembler:local", "--format", "{{.Id}}"],
  { encoding: "utf8" },
).trim();
if (!/^sha256:[a-f0-9]{64}$/.test(id))
  throw Error("Invalid assembler image identity");
console.log(`local@${id}`);
