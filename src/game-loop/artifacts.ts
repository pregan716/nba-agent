import type { Package } from "./package.js";

const artifactBytes = 256 * 1024;
const scopeBytes = 1024 * 1024;

type Artifact = { name: string; team: string | null; value: unknown };
export type Artifacts = Map<string, Artifact>;

/** Validate the prospective store before freezing. Replacements count once,
 * including league writes committed by another team at the same tip. */
export function stageArtifacts(
  current: Artifacts,
  declarations: Package["artifacts"],
  team: string,
  writes?: Record<string, unknown>,
): Artifacts {
  if (!writes) return current;
  const next = new Map(current);
  for (const [name, value] of Object.entries(writes)) {
    if (!Object.hasOwn(declarations, name))
      throw Error("Undeclared artifact: " + name);
    if (Buffer.byteLength(JSON.stringify(value)) > artifactBytes)
      throw Error(
        "Artifact " + name + " exceeds the 256 KiB per-artifact limit",
      );
    const owner = declarations[name] === "team" ? team : null;
    next.set(JSON.stringify([owner, name]), { name, team: owner, value });
  }
  let teamBytes = 0,
    leagueBytes = 0;
  for (const artifact of next.values()) {
    if (artifact.team === team)
      teamBytes += Buffer.byteLength(JSON.stringify(artifact.value));
    else if (artifact.team === null)
      leagueBytes += Buffer.byteLength(JSON.stringify(artifact.value));
  }
  if (teamBytes > scopeBytes)
    throw Error("Team artifacts exceed the 1 MiB per-team limit");
  if (leagueBytes > scopeBytes)
    throw Error("League artifacts exceed the 1 MiB league limit");
  return next;
}
