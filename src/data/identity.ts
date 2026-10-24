import type { ObjectRef } from "./store.js";
export type Entity = "game" | "team" | "player" | "account" | "post" | "media";
export interface Mapping {
  entity: Entity;
  provider: string;
  providerId: string;
  canonicalId: string;
  basis: string;
  scope?: { teamId: string };
  evidence: ObjectRef[];
}
export const normalizeName = (name: string) =>
  name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/,?\s+(?:jr\.?|sr\.?|ii|iii|iv)$/, "")
    .replace(/[^a-z0-9]/g, "");
export class NameResolutionError extends Error {
  constructor(
    readonly kind: "unresolved" | "ambiguous",
    entity: Entity,
    name: string,
    readonly candidates: string[] = [],
  ) {
    super(
      `${kind === "unresolved" ? "Unresolved" : "Ambiguous"} ${entity} name: ${name}`,
    );
  }
}
// Injury PDFs print "Family, Given"; keep the original spelling as provider ID.
export function injuryPlayerName(name: string): string {
  const parts = name.split(",");
  if (parts.length !== 2 || parts.some((part) => !part.trim()))
    throw Error(`Invalid injury player name: ${name}`);
  return `${parts[1].trim()} ${parts[0].trim()}`;
}
// Only the injury-source exceptions accepted in the brief (SPO-783).
// Keep the exact printed spelling; these are not general normalization rules.
export function injuryIdentityKey(name: string, teamId: string) {
  return name === "Williams, Jaylin" ? JSON.stringify([name, teamId]) : name;
}
export function resolveInjuryPlayer(
  ids: Identities,
  name: string,
  teamId: string,
) {
  if (name === "Yang, Hansen")
    return { playerId: "1642905", basis: "brief_sanctioned_alias" };
  if (name === "Williams, Jaylin") {
    if (teamId !== "1610612760")
      throw new NameResolutionError(
        "unresolved",
        "player",
        `${name} (team ${teamId})`,
      );
    return {
      playerId: "1631119",
      basis: "brief_sanctioned_team_scoped_name",
      scope: { teamId },
    };
  }
  return {
    playerId: ids.byName("player", injuryPlayerName(name)),
    basis: "unique_normalized_published_player_name",
  };
}
export class Identities {
  private mappings = new Map<string, Mapping>();
  private names = new Map<string, Set<string>>();
  private excludedNames = new Set<string>();
  excludeNameCandidate(entity: Entity, canonicalId: string) {
    this.excludedNames.add(`${entity}:${canonicalId}`);
    for (const [key, candidates] of this.names)
      if (key.startsWith(`${entity}:`)) candidates.delete(canonicalId);
  }
  addName(entity: Entity, name: string, canonicalId: string) {
    if (this.excludedNames.has(`${entity}:${canonicalId}`)) return;
    const key = `${entity}:${normalizeName(name)}`,
      ids = this.names.get(key) ?? new Set();
    ids.add(canonicalId);
    this.names.set(key, ids);
  }
  byName(entity: Entity, name: string): string {
    const ids = this.names.get(`${entity}:${normalizeName(name)}`);
    if (!ids?.size) throw new NameResolutionError("unresolved", entity, name);
    if (ids.size !== 1)
      throw new NameResolutionError("ambiguous", entity, name, [...ids].sort());
    return [...ids][0];
  }
  add(mapping: Mapping) {
    if (!mapping.providerId || !mapping.canonicalId || !mapping.evidence.length)
      throw Error("Mapping requires IDs and evidence");
    const key = `${mapping.entity}:${mapping.provider}:${mapping.providerId}`,
      existing = this.mappings.get(key);
    if (
      existing &&
      (existing.canonicalId !== mapping.canonicalId ||
        existing.scope?.teamId !== mapping.scope?.teamId)
    )
      throw Error(`Conflicting identity mapping: ${key}`);
    this.mappings.set(key, mapping);
  }
  resolve(
    entity: Entity,
    provider: string,
    id: string,
    context?: { teamId?: string },
  ): string {
    const row = this.mappings.get(`${entity}:${provider}:${id}`);
    if (!row) throw Error(`Unmapped ${entity}: ${provider}:${id}`);
    if (row.scope && row.scope.teamId !== context?.teamId)
      throw Error(`Identity mapping requires matching team: ${provider}:${id}`);
    return row.canonicalId;
  }
  rows(): Mapping[] {
    return [...this.mappings.values()].sort((a, b) =>
      `${a.entity}:${a.provider}:${a.providerId}`.localeCompare(
        `${b.entity}:${b.provider}:${b.providerId}`,
      ),
    );
  }
}
