import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { hostname } from "node:os";
import { digest } from "./config.js";
const exec = promisify(execFile);
export const ROOT_LABEL = "nba-agent.run-root";
export const ROOT_PATH_LABEL = "nba-agent.run-root-path";
export const HOST_LABEL = "nba-agent.host";
const marker = "sandbox-owner";
export const sandboxOwner = (root: string) => digest(realpathSync(root));
/** Written before Docker create so a crash at any later point triggers a sweep. */
export function registerSandboxRoot(root: string): string {
  const owner = sandboxOwner(root);
  writeFileSync(join(root, marker), owner, { mode: 0o600, flush: true });
  return owner;
}
export function sandboxLabels(root: string): string[] {
  return [
    `${ROOT_LABEL}=${registerSandboxRoot(root)}`,
    `${ROOT_PATH_LABEL}=${realpathSync(root)}`,
    `${HOST_LABEL}=${hostname()}`,
  ];
}
export type DockerCommand = (args: string[]) => Promise<string>;
const docker: DockerCommand = async (args) =>
  (await exec("docker", args, { timeout: 30000 })).stdout;

/** The caller owns runner.lock and has not started a session. Any container
 * belonging to this root predates this runner, even if it is still running. */
export async function sweepOwnOrphanContainers(
  root: string,
  removed: (id: string, name: string, runRoot: string) => void,
  command: DockerCommand = docker,
): Promise<void> {
  if (!existsSync(join(root, marker))) return;
  if (readFileSync(join(root, "runner.lock"), "utf8") !== String(process.pid))
    throw Error("Own-root cleanup requires the runner lock");
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
    const [container] = JSON.parse(await command(["inspect", row.ID]));
    if (
      container?.Config?.Labels?.[ROOT_LABEL] !== owner ||
      container.Name !== `/${row.Names}`
    )
      continue;
    await command(["rm", "--force", row.ID]);
    removed(row.ID, row.Names, realpathSync(root));
  }
}

// Older containers have only the hash label. Resolve those through sibling
// run/replicate roots, without traversing workspaces or following directory links.
// This relies on Runner.root being <base>/<runId>/<replicateId>.
function legacyRoots(root: string): Map<string, string> {
  const roots = new Map<string, string>();
  const add = (path: string) => {
    try {
      const owner = sandboxOwner(path);
      if (readFileSync(join(path, marker), "utf8") === owner)
        roots.set(owner, realpathSync(path));
    } catch {
      /* Unknown owners are never removed. */
    }
  };
  add(root);
  try {
    const base = dirname(dirname(root));
    for (const run of readdirSync(base, { withFileTypes: true })) {
      if (!run.isDirectory()) continue;
      for (const replicate of readdirSync(join(base, run.name), {
        withFileTypes: true,
      }))
        if (replicate.isDirectory()) add(join(base, run.name, replicate.name));
    }
  } catch {
    /* Inaccessible roots cannot be claimed. */
  }
  return roots;
}

export const SWEEP_LOCK = "sandbox-sweep.lock";
/** A live, unreadable or malformed cleanup claim blocks startup. Recover only
 * claims whose PID is positively known to be dead, as for runner.lock. */
export function sweepClaimHeld(root: string): boolean {
  const path = join(root, SWEEP_LOCK);
  try {
    const value = readFileSync(path, "utf8");
    const pid = Number(value);
    if (!Number.isSafeInteger(pid) || pid < 1) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e: any) {
      if (e.code !== "ESRCH") return true;
    }
    if (readFileSync(path, "utf8") !== value) return true;
    rmSync(path);
    return false;
  } catch (e: any) {
    return e.code !== "ENOENT";
  }
}

/** Claim cleanup before probing runner.lock. Runner checks this claim both before
 * and after acquiring its lock, so even concurrent startup cannot race removal.
 * Dead claims are reclaimed; unknown claims remain protected. */
function claimIdleRoot(root: string): (() => void) | undefined {
  const guard = join(root, SWEEP_LOCK);
  if (sweepClaimHeld(root)) return;
  try {
    writeFileSync(guard, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch {
    return;
  }
  const release = () => rmSync(guard, { force: true });
  try {
    const lock = join(root, "runner.lock");
    if (existsSync(lock)) {
      const pid = Number(readFileSync(lock, "utf8"));
      if (!Number.isSafeInteger(pid) || pid < 1) {
        release();
        return;
      }
      try {
        process.kill(pid, 0);
        release();
        return;
      } catch (e: any) {
        if (e.code !== "ESRCH") {
          release();
          return;
        }
      }
    }
    return release;
  } catch {
    release();
    return;
  }
}

/** Only exited, verified project containers in idle local roots are eligible.
 * The caller's root is handled separately under its exclusive runner lock. */
export async function sweepOrphanContainers(
  root: string,
  removed: (id: string, name: string, runRoot: string) => void,
  command: DockerCommand = docker,
): Promise<void> {
  const roots = legacyRoots(root);
  const listing = await command([
    "ps",
    "--all",
    "--filter",
    `label=${ROOT_LABEL}`,
    "--filter",
    "status=exited",
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
    const [container] = JSON.parse(await command(["inspect", row.ID]));
    const labels = container?.Config?.Labels ?? {};
    if (
      container?.Name !== `/${row.Names}` ||
      container.State?.Status !== "exited" ||
      container.State?.Running !== false
    )
      continue;
    let runRoot: string | undefined;
    if (labels[ROOT_PATH_LABEL] !== undefined) {
      if (
        labels[HOST_LABEL] !== hostname() ||
        typeof labels[ROOT_PATH_LABEL] !== "string" ||
        !isAbsolute(labels[ROOT_PATH_LABEL])
      )
        continue;
      runRoot = labels[ROOT_PATH_LABEL];
    } else runRoot = roots.get(labels[ROOT_LABEL]);
    if (!runRoot) continue;
    try {
      runRoot = realpathSync(runRoot);
      if (runRoot === realpathSync(root)) continue;
      if (
        sandboxOwner(runRoot) !== labels[ROOT_LABEL] ||
        readFileSync(join(runRoot, marker), "utf8") !== labels[ROOT_LABEL]
      )
        continue;
    } catch {
      continue;
    }
    const release = claimIdleRoot(runRoot);
    if (!release) continue;
    try {
      // Never force: Docker refuses removal if the container started after inspect.
      await command(["rm", row.ID]);
      removed(row.ID, row.Names, runRoot);
    } finally {
      release();
    }
  }
}
