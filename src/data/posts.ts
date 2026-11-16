import { Temporal } from "@js-temporal/polyfill";
import type { RecordEnvelope } from "./contracts.js";

export const postUrl = (id: string) =>
  `https://x.com/i/status/${encodeURIComponent(id)}`;

/** Apply only after the caller's visibility filters. */
export function latestPosts(eligible: RecordEnvelope[]) {
  const selected = new Map<string, RecordEnvelope>();
  for (const r of eligible) {
    const key = JSON.stringify([r.data.accountId, r.data.postId]);
    const previous = selected.get(key);
    if (
      !previous ||
      (Temporal.Instant.compare(previous.availableAt, r.availableAt) ||
        previous.id.localeCompare(r.id)) < 0
    )
      selected.set(key, r);
  }
  return [...selected.values()];
}
