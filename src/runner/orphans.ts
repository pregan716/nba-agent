import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { digest } from "./config.js";
const exec = promisify(execFile);
export const ROOT_LABEL = "nba-agent.run-root";
const marker = "sandbox-owner";
export const sandboxOwner = (root: string) => digest(realpathSync(root));
/** Written before Docker create so a crash at any later point triggers a sweep. */
export function registerSandboxRoot(root: string): string {
  const owner = sandboxOwner(root);
  writeFileSync(join(root, marker), owner, { mode: 0o600, flush: true });
  return owner;
}
export type DockerCommand = (args: string[]) => Promise<string>;
const docker: DockerCommand = async (args) =>
  (await exec("docker", args, { timeout: 30000 })).stdout;
/** Must run under the exclusive run-root lock, before any new session is created.
 * Containers from other roots (and legacy unlabeled containers) are never removed.
 */
export async function sweepOrphanContainers(
  root: string,
  removed: (id: string, name: string) => void,
  command: DockerCommand = docker,
): Promise<void> {
  if (!existsSync(join(root, marker))) return; // No managed sandbox has used this root.
  const owner = sandboxOwner(root);
  const listing = await command([
    "ps",
    "--all",
    "--filter",
    `label=${ROOT_LABEL}=${owner}`,
    "--filter",
    "name=nba-session-",
    "--format",
    "{{json .}}",
  ]);
  for (const line of listing.split("\n").filter(Boolean)) {
    const row = JSON.parse(line);
    if (
      !/^[a-f0-9]{12,64}$/.test(row.ID) ||
      !/^nba-session-[a-f0-9-]{36}$/.test(row.Names)
    )
      continue;
    // Verify exact labels before deletion rather than relying on name matching.
    const [container] = JSON.parse(await command(["inspect", row.ID]));
    if (
      container.Config?.Labels?.[ROOT_LABEL] !== owner ||
      container.Name !== `/${row.Names}`
    )
      continue;
    await command(["rm", "--force", row.ID]);
    removed(row.ID, row.Names);
  }
}
