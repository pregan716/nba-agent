import { execFileSync } from "node:child_process";

export function auditCodeRevision(): string {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  // Include staged and unstaged tracked edits, ignoring local caches and links.
  const dirty = execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=no"],
    { encoding: "utf8" },
  ).trim();
  return `${revision}${dirty ? "-dirty" : ""}`;
}
