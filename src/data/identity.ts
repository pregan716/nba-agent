import type { ObjectRef } from "./store.js";
export type Entity = "game" | "team" | "player" | "account" | "post" | "media";
export interface Mapping {
  entity: Entity;
  provider: string;
  providerId: string;
  canonicalId: string;
  basis: string;
  evidence: ObjectRef[];
}
export const normalizeName = (name: string) =>
  name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/,?\s+(?:jr\.?|sr\.?|ii|iii|iv)$/, "")
    .replace(/[^a-z0-9]/g, "");
export class Identities {
  private mappings = new Map<string, Mapping>();
  private names = new Map<string, Set<string>>();
  addName(entity: Entity, name: string, canonicalId: string) {
    const key = `${entity}:${normalizeName(name)}`,
      ids = this.names.get(key) ?? new Set();
    ids.add(canonicalId);
    this.names.set(key, ids);
  }
  byName(entity: Entity, name: string): string {
    const ids = this.names.get(`${entity}:${normalizeName(name)}`);
    if (!ids?.size) throw Error(`Unresolved ${entity} name: ${name}`);
    if (ids.size !== 1) throw Error(`Ambiguous ${entity} name: ${name}`);
    return [...ids][0];
  }
  add(mapping: Mapping) {
    if (!mapping.providerId || !mapping.canonicalId || !mapping.evidence.length)
      throw Error("Mapping requires IDs and evidence");
    const key = `${mapping.entity}:${mapping.provider}:${mapping.providerId}`,
      existing = this.mappings.get(key);
    if (existing && existing.canonicalId !== mapping.canonicalId)
      throw Error(`Conflicting identity mapping: ${key}`);
    this.mappings.set(key, mapping);
  }
  resolve(entity: Entity, provider: string, id: string): string {
    const row = this.mappings.get(`${entity}:${provider}:${id}`);
    if (!row) throw Error(`Unmapped ${entity}: ${provider}:${id}`);
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
