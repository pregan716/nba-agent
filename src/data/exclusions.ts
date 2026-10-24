import type { Exclusion } from "./contracts.js";

/** A release-scoped diagnostic log: repeated reads replace, rather than duplicate, an exclusion. */
export class ExclusionLog {
  private entries = new Map<string, Exclusion>();
  add(exclusion: Exclusion, table = ""): void {
    this.entries.set(JSON.stringify([exclusion.source, exclusion.id, table]), {
      ...exclusion,
    });
  }
  values(): Exclusion[] {
    return [...this.entries.values()].map((entry) => ({ ...entry }));
  }
}
