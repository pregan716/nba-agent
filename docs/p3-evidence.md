# Evidence browsing, search and fetch (SPO-788, SPO-819)

`Session.list_evidence`, `search_evidence` and `fetch_evidence` implement the `search_and_fetch` capability in pregame and postgame. The trusted P1 source supplies posts, transcripts and preferred lineup announcements. The Session applies `visible()` before selecting versions, projecting fields or constructing its lazy per-session index. Lineups must also precede their own game's scheduled start, even when queried in a later session. The index is reused at the same immutable cutoff; commit-phase access remains refused.

`list_evidence` browses eligible records newest first, with the same hit shape and paging as search. With no `from`, pregame starts at the previous Celtics game's scheduled-start cutoff in the pinned schedule; the first game has no lower bound. Postgame starts at the current game's scheduled start. This makes “what is new” a query-free call. The next pregame includes evidence from the previous postgame window: it was not visible at the previous pregame cutoff. Source filters apply in both tools.

Search is lexical, with no model calls or embeddings. Queries are case-insensitive, accent-folded Unicode letter/number tokens. Common English function words are ignored for BM25; an all-stopword query returns no lexical matches. BM25 (k1=1.2, b=0.75) ranks records matching **any** English Porter-stemmed query term. Document frequencies, per-document term counts and average length are computed once from only the eligible index, before query filters; future records cannot affect ranking. Titles, published text, transcript utterances, and announced lineup starters are searchable. Lineups include a synthetic “Starting lineup: …” search field and snippet; fetch still returns the original caption. A transcript remains one result.

Player full names and surnames resolve through the pinned injury/lineup identity mappings and eligible opening player profiles. Surname matches boost ranking without excluding other lexical matches, so common-word surnames such as Post or Holiday cannot hide rotation evidence. Full-name matches restrict results to those players; longest full-name matches disambiguate. Canonical `player_id`/`player_ids` tags and resolved lineup starters are always unioned with exact, accent-folded name tokens in the text, so a tagged record can still mention other players. The current post adapter and transcript releases generally supply text rather than canonical mention tags. Explicit tags and full-name mentions rank ahead of surname-only text (so Derrick White beats the colour white). Within that tier, BM25 ranks results, then descending availability and stable evidence ID break ties. An optional `player_id` further filters results. Use one or two query terms. Name matching does not stem names.

Snippets retain up to 240 original characters around an exact query-token match, with ellipses when clipped; stem-only or tag-only matches fall back to the beginning of the text. Lineup snippets prefer the starters. Titles never determine availability.

`from` is inclusive and `to` exclusive, explicitly clamped to the session cutoff. `sources: []` matches nothing. Counts are after filtering, before pagination. Pages default to 20, maximum 100. Cursors bind to the tool, normalized query and resolved identities, filters, page size, run, game, phase, cutoff and pins. Cross-tool/query/session cursors are invalid. A future-only match has zero count and no cursor.

Adding the browse definition and changing the search description changes the serialized tool definitions and thus the harness version. Start a new pilot/run with this version; do not change the harness mid-run. `offeredTools` uses the shared names, capabilities and phase table, so browsing is available automatically in both research phases and refused during commit.


Evidence IDs hash source, P1 stable record ID and the pinned manifest hash. They are stable across queries and sessions on the same pins and can be put directly in submission `evidence_refs`. Posts use the latest eligible version per account/post ID. Superseded versions are absent from this session's index. Reply/quote references include only indexed eligible posts; missing, future and excluded targets do not appear.

Fetch returns explicit public fields, never a raw envelope. Text is returned verbatim, including the accepted C2 transcript defects. Transcript segments preserve utterance text, start seconds and speaker-cluster labels; speaker names, confidence, word metadata and audio are excluded. Lineup starters resolve through the persisted P1 name mappings, preserving the announced names and order. Post authors use `@handle` from the pinned `config/post-authors.json` mapping, falling back to the original account ID when unmapped. Fetch provenance includes `account_id` and `author_mapping_sha256`; unavailable transcript channel metadata is null. Fetch results are defensive copies.

SPO-788 requires citation provenance, so the public contract adds `provenance.manifest_sha256` and an `objects` list of bucket/key/SHA-256 triples. Transcripts include the normalized artifact supporting segments and the readable artifact supporting full text, both verified by P1. Search results omit provenance. Object locations are citation identifiers, not access credentials or additional tools.

The later P3a contract specifies identical `not_found` errors for unknown and future evidence IDs, replacing the issue's original `cutoff_refused` wording. IDs are looked up only in the eligible index; fetch cannot distinguish absent, superseded, equality-boundary or future records.

Verification: `npm test` exercises the shared adversarial corpus with and without future records; equality boundaries; latest eligible post versions; reference pruning; verbatim transcript defects; segment-only search; provenance; immutable fetch results; deterministic pagination; and the real runner-backed tools. `npm run session:verify` additionally searches and fetches each media source against the pinned corpus, resolves returned references, checks transcript artifact hashes and five announced lineup starters, and repeats queries for determinism.

SPO-823 adds readable post authors. The pinned relevance release has `accountId`
but no handle or display-name field. The two-account mapping is derived from the
[sports-text reporter inventory](https://github.com/pregan716/sports-text/blob/bafd296e998eb75eadc893a1e9c900309cc3781e/data/reporters.json);
its upstream commit and file hash are recorded in the mapping. These are identity
labels, not claims about reporter reliability or historical handle-change dates.
`openCorpus` loads and validates the mapping, and `corpusSource` adds its exact-byte
SHA-256 as the `postAuthors` data-source version. Changing the mapping changes run
identity even if its human-readable release label is unchanged. Existing run pins
must not be reused with a changed mapping. Browse/search/fetch descriptions also
change the harness version. No live account lookup is performed.

`npm run session:verify` checks every account ID in the pinned posts release,
including excluded rows, against the mapping and fails with the unmapped IDs.
Update `config/post-authors.json` when accepting a release with new accounts.
Runtime evidence still falls back to numeric IDs for unmapped accounts.
