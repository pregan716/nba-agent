import { Temporal } from "@js-temporal/polyfill";
import type { RecordEnvelope } from "../data/contracts.js";
import type { Identities } from "../data/identity.js";
import { digest } from "../runner/config.js";
import {
  SessionError,
  type EvidenceSource,
  type FetchEvidenceResult,
  type SearchEvidenceInput,
  type SearchEvidenceResult,
} from "./contract.js";

export const evidenceId = (r: RecordEnvelope) =>
  `evidence:${digest([r.source, r.id, r.provenance.manifestSha256])}`;
const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const nullable = (value: unknown) => (typeof value === "string" ? value : null);
const cmp = (a: RecordEnvelope, b: RecordEnvelope) =>
  Temporal.Instant.compare(a.availableAt, b.availableAt) ||
  a.id.localeCompare(b.id);

/** Construct only from eligible envelopes. The index never retains a future
 * record, so neither lookup errors nor ranking can depend on future evidence. */
export class EvidenceIndex {
  #records = new Map<string, FetchEvidenceResult>();
  constructor(records: RecordEnvelope[], ids: Identities) {
    const posts = new Map<string, RecordEnvelope>();
    for (const r of records.filter((r) => r.source === "posts")) {
      const key = JSON.stringify([r.data.accountId, r.data.postId]);
      const previous = posts.get(key);
      if (!previous || cmp(previous, r) < 0) posts.set(key, r);
    }
    const selected = [
      ...records.filter((r) => r.source !== "posts"),
      ...posts.values(),
    ].sort(cmp);
    const postIds = new Map<string, string[]>();
    for (const r of posts.values())
      postIds.set(r.data.postId, [
        ...(postIds.get(r.data.postId) ?? []),
        evidenceId(r),
      ]);
    for (const r of selected) {
      const d = r.data,
        source = r.source as EvidenceSource;
      const segments =
        source === "transcripts"
          ? (d.normalized?.utterances ?? []).map((u: any) => {
              if (
                typeof u.text !== "string" ||
                typeof u.speaker !== "string" ||
                !Number.isFinite(u.start) ||
                u.start < 0
              )
                throw Error("Invalid published transcript segment");
              return {
                speaker_label: u.speaker,
                start_seconds: u.start,
                text: u.text,
              };
            })
          : null;
      const text = source === "transcripts" ? d.readable : d.text;
      if (typeof text !== "string")
        throw Error("Missing published evidence text");
      const refs = [
        r.provenance.object,
        ...(source === "transcripts" && d.readable_ref ? [d.readable_ref] : []),
      ];
      const result: FetchEvidenceResult = {
        evidence_id: evidenceId(r),
        source,
        available_at: r.availableAt,
        author:
          source === "posts"
            ? nullable(d.accountId)
            : source === "lineups"
              ? nullable(d.source)
              : null,
        title: source === "transcripts" ? nullable(d.title) : null,
        url:
          source === "posts"
            ? `https://x.com/i/status/${encodeURIComponent(d.postId)}`
            : nullable(d.url),
        text,
        segments,
        starters:
          source === "lineups"
            ? d.startingLineup.map((name: string) => ({
                id: ids.resolve("player", "lineup-name", name),
                name,
              }))
            : null,
        references:
          source === "posts"
            ? [
                ...new Set<string>(
                  (d.references ?? []).flatMap(
                    (ref: any) => postIds.get(ref.postId) ?? [],
                  ),
                ),
              ].sort()
            : [],
        provenance: {
          manifest_sha256: r.provenance.manifestSha256,
          objects: refs.map((ref) => ({
            bucket: ref.bucket,
            key: ref.key,
            sha256: ref.sha256,
          })),
        },
      };
      if (this.#records.has(result.evidence_id))
        throw Error("Duplicate evidence identity");
      this.#records.set(result.evidence_id, result);
    }
  }
  all(): FetchEvidenceResult[] {
    return structuredClone([...this.#records.values()]);
  }
  fetch(id: string): FetchEvidenceResult {
    const record = this.#records.get(id);
    if (!record) throw new SessionError("not_found", "Evidence not found");
    return structuredClone(record);
  }
  search(
    input: SearchEvidenceInput,
    binding: string,
    cutoff: string,
  ): SearchEvidenceResult {
    const terms = [...new Set(words(input.query))].sort();
    if (!terms.length)
      throw new SessionError(
        "invalid_input",
        "Search requires at least one word",
      );
    const sources = [
      ...new Set(input.sources ?? ["posts", "transcripts", "lineups"]),
    ].sort();
    const matches = [...this.#records.values()].filter(
      (r) =>
        sources.includes(r.source) &&
        (!input.from ||
          Temporal.Instant.compare(r.available_at, input.from) >= 0) &&
        (!input.to || Temporal.Instant.compare(r.available_at, input.to) < 0),
    );
    const ranked = matches
      .flatMap((r) => {
        const chunks = [
          r.title ?? "",
          r.text,
          ...(r.segments ?? []).map((s) => s.text),
        ];
        // Set frequency by published text field; segments may supply words absent
        // from the readable export without rewriting that export.
        const tokens = new Set(chunks.flatMap(words));
        if (!terms.every((t) => tokens.has(t))) return [];
        const score = terms.reduce(
          (n, t) =>
            n +
            words(`${r.title ?? ""} ${r.text}`).filter((w) => w === t).length,
          0,
        );
        const chunk =
          chunks.find((c) => words(c).some((w) => terms.includes(w))) ?? r.text;
        const first =
          [...chunk.matchAll(/[\p{L}\p{N}]+/gu)].find((m) =>
            terms.includes(m[0].toLowerCase()),
          )?.index ?? 0;
        const start = Math.max(0, first - 60),
          end = Math.min(chunk.length, start + 240);
        return [
          {
            record: r,
            score,
            snippet:
              (start ? "…" : "") +
              chunk.slice(start, end) +
              (end < chunk.length ? "…" : ""),
          },
        ];
      })
      .sort(
        (a, b) =>
          b.score - a.score ||
          Temporal.Instant.compare(
            b.record.available_at,
            a.record.available_at,
          ) ||
          a.record.evidence_id.localeCompare(b.record.evidence_id),
      );
    const signature = digest([
      binding,
      cutoff,
      terms,
      sources,
      input.from ?? null,
      input.to ?? null,
      input.limit ?? 20,
    ]);
    let offset = 0;
    if (input.cursor)
      try {
        const cursor = JSON.parse(
          Buffer.from(input.cursor, "base64url").toString(),
        );
        if (
          cursor.signature !== signature ||
          !Number.isSafeInteger(cursor.offset) ||
          cursor.offset < 0 ||
          cursor.offset > ranked.length
        )
          throw Error();
        offset = cursor.offset;
      } catch {
        throw new SessionError("invalid_input", "Invalid evidence cursor");
      }
    const end = Math.min(ranked.length, offset + (input.limit ?? 20));
    return {
      total: ranked.length,
      next_cursor:
        end < ranked.length
          ? Buffer.from(JSON.stringify({ signature, offset: end })).toString(
              "base64url",
            )
          : null,
      items: ranked.slice(offset, end).map(({ record: r, snippet }) => ({
        evidence_id: r.evidence_id,
        source: r.source,
        available_at: r.available_at,
        author: r.author,
        title: r.title,
        snippet,
      })),
    };
  }
}
