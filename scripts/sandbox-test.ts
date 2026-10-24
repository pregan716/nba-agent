import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const image = JSON.parse(
  readFileSync(".cache/sandbox-image.json", "utf8"),
).image;
const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", "test/sandbox.test.ts"],
  { stdio: "inherit", env: { ...process.env, NBA_SANDBOX_IMAGE: image } },
);
process.exitCode = result.status ?? 1;
