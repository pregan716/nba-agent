import { stemmer } from "stemmer";
import { Temporal } from "@js-temporal/polyfill";
import type { RecordEnvelope } from "../data/contracts.js";
import type { Identities } from "../data/identity.js";
import { digest } from "../runner/config.js";
import {
  SessionError,
  type EvidenceSource,
  type FetchEvidenceResult,
  type SearchEvidenceInput,
  type ListEvidenceInput,
  type SearchEvidenceResult,
} from "./contract.js";

export const evidenceId = (r: RecordEnvelope) =>
  `evidence:${digest([r.source, r.id, r.provenance.manifestSha256])}`;
const exactWords = (s: string) =>
  s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const words = (s: string) =>
  exactWords(s.normalize("NFD").replace(/\p{M}/gu, ""));
// Function words add noise to OR retrieval; preserve basketball terms like "out".
const stopwords = new Set(
  "a an the is are was were be been being am to of for in on at by with and or but as it its this that these those".split(
    " ",
  ),
);
const nullable = (value: unknown) => (typeof value === "string" ? value : null);
const cmp = (a: RecordEnvelope, b: RecordEnvelope) =>
  Temporal.Instant.compare(a.availableAt, b.availableAt) ||
  a.id.localeCompare(b.id);

/** Construct only from eligible envelopes. The index never retains a future
 * record, so neither lookup errors nor ranking can depend on future evidence. */
export class EvidenceIndex {
  #records = new Map<string, FetchEvidenceResult>();
  #names = new Map<string, Set<string>>();
  #players = new Map<string, Set<string>>();
  #strongPlayers = new Map<string, Set<string>>();
  #chunks = new Map<string, string[]>();
  #documents = new Map<
    string,
    { counts: Map<string, number>; length: number }
  >();
  #df = new Map<string, number>();
  #averageLength = 1;
  constructor(
    records: RecordEnvelope[],
    ids: Identities,
    profiles: RecordEnvelope[] = [],
  ) {
    const addName = (name: string, id: string) => {
      const parts = words(name.replace(/,?\s+(jr\.?|sr\.?|ii|iii|iv)$/i, ""));
      for (const key of [parts.join(" "), parts.at(-1)]) {
        if (!key) continue;
        const candidates = this.#names.get(key) ?? new Set<string>();
        candidates.add(id);
        this.#names.set(key, candidates);
      }
    };
    for (const row of ids.rows()) {
      if (row.entity !== "player") continue;
      if (row.provider === "lineup-name")
        addName(row.providerId, row.canonicalId);
      if (
        row.provider === "injury-name" &&
        row.providerId.split(",").length === 2
      )
        addName(row.providerId.split(",").reverse().join(" "), row.canonicalId);
    }
    for (const p of profiles)
      if (
        typeof p.data.full_name === "string" &&
        typeof p.data.player_id === "string"
      )
        addName(p.data.full_name, p.data.player_id);

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
      // Keep published fetch text unchanged; search also includes the structured starters.
      const chunks = [
        ...(result.starters
          ? [
              `Starting lineup: ${result.starters.map((p) => p.name).join(", ")}`,
            ]
          : []),
        result.title ?? "",
        result.text,
        ...(result.segments ?? []).map((s) => s.text),
      ];
      this.#chunks.set(result.evidence_id, chunks);
      const tokens = chunks
        .flatMap(words)
        .filter((t) => !stopwords.has(t))
        .map(stemmer);
      const counts = new Map<string, number>();
      for (const token of tokens)
        counts.set(token, (counts.get(token) ?? 0) + 1);
      for (const token of counts.keys())
        this.#df.set(token, (this.#df.get(token) ?? 0) + 1);
      this.#documents.set(result.evidence_id, {
        counts,
        length: tokens.length,
      });
      const tagged = new Set<string>([
        ...(typeof d.player_id === "string" ? [d.player_id] : []),
        ...(Array.isArray(d.player_ids)
          ? d.player_ids.filter((id: unknown) => typeof id === "string")
          : []),
        ...(result.starters ?? []).map((p) => p.id),
      ]);
      this.#strongPlayers.set(
        result.evidence_id,
        new Set([...tagged, ...this.#resolveNames(chunks.join(" "), true)]),
      );
      // These releases generally provide text rather than canonical mention tags.
      // Use exact name tokens as the fallback, never stems (e.g. Brown/browning).
      for (const id of this.#resolveNames(chunks.join(" "))) tagged.add(id);
      this.#players.set(result.evidence_id, tagged);
    }
    this.#averageLength =
      [...this.#documents.values()].reduce((n, d) => n + d.length, 0) /
        (this.#documents.size || 1) || 1;
  }
  all(): FetchEvidenceResult[] {
    return structuredClone([...this.#records.values()]);
  }
  fetch(id: string): FetchEvidenceResult {
    const record = this.#records.get(id);
    if (!record) throw new SessionError("not_found", "Evidence not found");
    return structuredClone(record);
  }
  #resolveNames(text: string, fullOnly = false): Set<string> {
    const tokens = words(text),
      result = new Set<string>();
    // Longest match first prevents a full name from also selecting all surname peers.
    for (let i = 0; i < tokens.length; i++) {
      for (
        let n = Math.min(6, tokens.length - i);
        n > (fullOnly ? 1 : 0);
        n--
      ) {
        const ids = this.#names.get(tokens.slice(i, i + n).join(" "));
        if (!ids) continue;
        for (const id of ids) result.add(id);
        i += n - 1;
        break;
      }
    }
    return result;
  }
  #snippet(r: FetchEvidenceResult, terms: string[]): string {
    const chunks = this.#chunks.get(r.evidence_id)!;
    // Prefer the starters for lineups; keep exact-token snippet anchors otherwise.
    const chunk = r.starters
      ? chunks[0]
      : chunks.find((c) => exactWords(c).some((w) => terms.includes(w))) ||
        r.text;
    const first =
      [...chunk.matchAll(/[\p{L}\p{N}]+/gu)].find((m) =>
        terms.includes(m[0].toLowerCase()),
      )?.index ?? 0;
    const start = r.starters ? 0 : Math.max(0, first - 60),
      end = Math.min(chunk.length, start + 240);
    return (
      (start ? "…" : "") +
      chunk.slice(start, end) +
      (end < chunk.length ? "…" : "")
    );
  }
  list(
    input: ListEvidenceInput,
    binding: string,
    cutoff: string,
  ): SearchEvidenceResult {
    return this.#query(input, binding, cutoff);
  }
  search(
    input: SearchEvidenceInput,
    binding: string,
    cutoff: string,
  ): SearchEvidenceResult {
    if (!words(input.query).length)
      throw new SessionError(
        "invalid_input",
        "Search requires at least one word",
      );
    return this.#query(input, binding, cutoff, input);
  }
  #query(
    input: ListEvidenceInput,
    binding: string,
    cutoff: string,
    search?: SearchEvidenceInput,
  ): SearchEvidenceResult {
    const terms = [...new Set(words(search?.query ?? ""))].sort();
    const stems = [
      ...new Set(terms.filter((t) => !stopwords.has(t)).map(stemmer)),
    ];
    const snippetTerms = [...new Set(exactWords(search?.query ?? ""))].sort();
    const fullEntities = search
      ? this.#resolveNames(search.query, true)
      : new Set<string>();
    const entities = search
      ? this.#resolveNames(search.query)
      : new Set<string>();
    const sources = [
      ...new Set(input.sources ?? ["posts", "transcripts", "lineups"]),
    ].sort();
    const to =
      input.to && Temporal.Instant.compare(input.to, cutoff) < 0
        ? input.to
        : cutoff;
    const all = [...this.#records.values()];
    // BM25 statistics were computed once from the complete eligible index.
    const ranked = all
      .flatMap((r) => {
        if (
          !sources.includes(r.source) ||
          (input.from &&
            Temporal.Instant.compare(r.available_at, input.from) < 0) ||
          Temporal.Instant.compare(r.available_at, to) >= 0
        )
          return [];
        const players = this.#players.get(r.evidence_id)!;
        if (search?.player_id && !players.has(search.player_id)) return [];
        const entityMatch = [...entities].some((id) => players.has(id));
        if (
          fullEntities.size &&
          ![...fullEntities].some((id) => players.has(id))
        )
          return [];
        const document = this.#documents.get(r.evidence_id)!;
        let score = 0;
        for (const term of stems) {
          const tf = document.counts.get(term) ?? 0;
          if (!tf) continue;
          const frequency = this.#df.get(term)!;
          const idf = Math.log(
            1 + (all.length - frequency + 0.5) / (frequency + 0.5),
          );
          score +=
            (idf * tf * 2.2) /
            (tf +
              1.2 * (0.25 + (0.75 * document.length) / this.#averageLength));
        }
        if (search && !score && !entityMatch) return [];
        return [
          {
            record: r,
            score,
            entityStrength: [...entities].some((id) =>
              this.#strongPlayers.get(r.evidence_id)!.has(id),
            )
              ? 1
              : 0,
            snippet: this.#snippet(r, snippetTerms),
          },
        ];
      })
      .sort(
        (a, b) =>
          b.entityStrength - a.entityStrength ||
          b.score - a.score ||
          Temporal.Instant.compare(
            b.record.available_at,
            a.record.available_at,
          ) ||
          a.record.evidence_id.localeCompare(b.record.evidence_id),
      );
    const signature = digest([
      search ? "search" : "list",
      binding,
      cutoff,
      terms,
      search?.player_id ?? null,
      [...entities].sort(),
      [...fullEntities].sort(),
      snippetTerms,
      sources,
      input.from ?? null,
      to,
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
