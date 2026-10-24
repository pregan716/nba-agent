import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import {
  VerifiedStore,
  sha256,
  type ObjectRef,
  type ObjectStore,
} from "../src/data/store.js";
import { Release, parquet } from "../src/data/release.js";
import {
  OddsAdapter,
  BeatPostsAdapter,
  LineupsAdapter,
  TranscriptsAdapter,
  PlayerReferenceAdapter,
  injuryObservation,
  postAvailability,
  selectLineups,
  transcriptAvailability,
  PlayByPlayAdapter,
} from "../src/data/adapters.js";
import { nextMorning, easternDayEnd, before } from "../src/data/time.js";
import { Identities } from "../src/data/identity.js";
const bytes = (data: unknown) => Buffer.from(JSON.stringify(data));
function fixture(objects: Record<string, Buffer>) {
  const calls: string[] = [];
  const raw: ObjectStore = {
    async get(_bucket, key) {
      calls.push(key);
      if (!objects[key]) throw Error("Missing fixture object");
      return objects[key];
    },
  };
  const ref = (key: string): ObjectRef => ({
    bucket: "sports-text",
    key,
    sha256: sha256(objects[key]),
    bytes: objects[key].length,
  });
  return { raw, store: new VerifiedStore(raw), ref, calls };
}
const fakeRef: ObjectRef = {
  bucket: "sports-text",
  key: "fixture",
  sha256: "0".repeat(64),
};

test("hash and size verification refuses tampered roots, objects, and cached bytes", async () => {
  const f = fixture({
    root: bytes({
      objects: [{ key: "rows", sha256: sha256(Buffer.from("good")), bytes: 4 }],
    }),
    rows: Buffer.from("evil"),
  });
  const release = await Release.open(f.ref("root"), f.store);
  await assert.rejects(release.bytes("rows"), /Integrity mismatch/);
  await assert.rejects(release.bytes("unlisted"), /not in manifest/);
  await assert.rejects(
    Release.open({ ...f.ref("root"), sha256: "1".repeat(64) }, f.store),
    /Integrity mismatch/,
  );
  await assert.rejects(
    f.store.read({ ...f.ref("root"), bytes: 1 }),
    /Integrity mismatch/,
  );
  const cache = await mkdtemp(`${tmpdir()}/nba-adapter-`);
  try {
    await writeFile(`${cache}/${f.ref("root").sha256}`, "tampered");
    await assert.rejects(
      new VerifiedStore(f.raw, cache).read(f.ref("root")),
      /Integrity mismatch/,
    );
  } finally {
    await rm(cache, { recursive: true });
  }
});

test("odds consumes published probabilities and exposes only the v1 projection", async () => {
  const row = {
    espn_event_id: "1",
    espn_player_id: "2",
    requested_at: "2025-10-22T23:30Z",
    scheduled_start: "2025-10-22T23:30Z",
    prop_type: "player_points",
    status: "ok",
    selected_line: 20.5,
    p_over: 0.534,
    contributing_books: ["secret-detail"],
  };
  const objects = {
    "release/consensus.ndjson.gz": gzipSync(
      Buffer.from(
        [row, { ...row, status: "dfs_only" }]
          .map((r) => JSON.stringify(r))
          .join("\n"),
      ),
    ),
    "release/methodology.json": bytes({ method: "published" }),
  };
  const root = bytes({
    objects: Object.entries(objects).map(([key, b]) => ({
      key,
      sha256: sha256(b),
      bytes: b.length,
    })),
  });
  const f = fixture({ ...objects, root }),
    adapter = new OddsAdapter(await Release.open(f.ref("root"), f.store));
  const records = await adapter.records();
  assert.equal(records.length, 1);
  assert.equal(records[0].availableAt, "2025-10-22T23:30:00Z");
  assert.equal(records[0].availabilityConvention, "odds_requested_at");
  assert.equal(records[0].data.p_over, 0.534);
  assert.deepEqual(Object.keys(records[0].data), [
    "espn_event_id",
    "espn_player_id",
    "prop_type",
    "selected_line",
    "p_over",
  ]);
  assert.equal(
    adapter.version().methodologySha256,
    sha256(objects["release/methodology.json"]),
  );
});

test("Eastern release times handle both DST transitions; equality is not before cutoff", () => {
  assert.equal(nextMorning("2025-11-01"), "2025-11-02T14:00:00Z");
  assert.equal(nextMorning("2026-03-07"), "2026-03-08T13:00:00Z");
  assert.equal(easternDayEnd("2025-11-02"), "2025-11-03T04:59:59.999999999Z");
  assert.equal(before("2025-10-22T23:30Z", "2025-10-22T23:30:00Z"), false);
});

test("injuries expose observed PDF state, exclude retrospective interpretation, and choose the later DST fold", () => {
  const row = {
    record_id: "i",
    phase: "regular_season",
    game_id: "g",
    team_id: "t",
    report_timestamp_utc: null,
    report_timestamp_et: "2025-11-02T01:30:00",
    timestamp_ambiguous: true,
    observed_state: "team_absent",
    interpreted_state: "empty_report_corroborated",
    interpretation_assessed_at: "2026-10-20T00:00Z",
    evidence_ids: ["later"],
  };
  const result = injuryObservation(row, fakeRef, "0".repeat(64))!;
  assert.equal(result.availableAt, "2025-11-02T06:30:00Z");
  assert.equal(result.availabilityConvention, "injury_dst_later_reading");
  assert.equal(result.data.observed_state, "team_absent");
  assert.equal("interpreted_state" in result.data, false);
  assert.equal("evidence_ids" in result.data, false);
  assert.equal(
    injuryObservation({ ...row, game_link_status: "unmatched" }, fakeRef, ""),
    null,
  );
  assert.throws(
    () =>
      injuryObservation({ ...row, timestamp_ambiguous: false }, fakeRef, ""),
    /no usable timestamp/,
  );
});

test("edited posts never fall back to original publication time", async () => {
  const post = {
    accountId: "a",
    postId: "1",
    versionId: "x:1",
    editHistoryIds: ["1"],
    publishedAt: "2025-10-22T10:00Z",
    retrievedAt: "2026-10-20T10:00Z",
    text: "original",
    references: [],
  };
  assert.equal(postAvailability(post), "2025-10-22T10:00:00Z");
  assert.equal(
    postAvailability({ ...post, versionId: "x:2", editHistoryIds: ["1", "2"] }),
    null,
  );
  assert.equal(
    postAvailability({ ...post, versionId: "sha256:unknown" }),
    null,
  );
  assert.equal(
    postAvailability({
      ...post,
      versionId: "x:2",
      versionPublishedAt: "2025-10-22T12:00Z",
    }),
    "2025-10-22T12:00:00Z",
  );
  const rows = Buffer.from(
    [
      { post, relevance: { relevant: true } },
      { post: { ...post, postId: "3" }, relevance: { relevant: false } },
      { post: { ...post, versionId: "x:2" }, relevance: { relevant: true } },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n"),
  );
  const f = fixture({
      rows,
      root: bytes({ rows: { objectKey: "rows", sha256: sha256(rows) } }),
    }),
    adapter = new BeatPostsAdapter(await Release.open(f.ref("root"), f.store));
  assert.equal((await adapter.records()).length, 1);
  assert.equal(adapter.exclusions.length, 2);
});

test("lineups select a preferred announcement and reject conflicting unselected fives", async () => {
  const base = {
    phase: "regular",
    gameId: "g",
    startingLineup: ["a", "b", "c", "d", "e"],
    postedAt: "2025-10-22T23:20Z",
    postId: "p",
  };
  const earlier = { ...base, postId: "q", postedAt: "2025-10-22T23:19Z" };
  assert.equal(selectLineups([base, earlier])[0].postId, "q");
  assert.equal(
    selectLineups([
      { ...base, preferredForGame: true },
      { ...earlier, preferredForGame: false },
    ])[0].postId,
    "p",
  );
  assert.throws(
    () =>
      selectLineups([
        base,
        { ...earlier, startingLineup: ["v", "w", "x", "y", "z"] },
      ]),
    /Conflicting/,
  );
  assert.throws(
    () => selectLineups([{ ...base, preferredForGame: false }]),
    /Missing preferred/,
  );
  const f = fixture({
    root: bytes({ rows: [{ ...base, boxscoreStarters: ["future"] }] }),
  });
  const record = (
    await new LineupsAdapter(f.ref("root"), f.store, "celtics").records()
  )[0];
  assert.equal(record.availabilityConvention, "lineup_announcement");
  assert.equal("boxscoreStarters" in record.data, false);
});

test("transcripts use publication, livestream end, or Eastern day end, with review exclusions", () => {
  assert.deepEqual(
    transcriptAvailability({
      published_at_precision: "second",
      published_at: "2025-10-22T18:00Z",
    }),
    { at: "2025-10-22T18:00:00Z", convention: "video_publication" },
  );
  assert.equal(
    transcriptAvailability({
      is_livestream: true,
      stream_ended_at: "2025-10-23T02:00Z",
    })?.convention,
    "livestream_end",
  );
  assert.equal(
    transcriptAvailability({
      published_at_precision: "day",
      publicationDay: "2025-11-02",
    })?.at,
    "2025-11-03T04:59:59.999999999Z",
  );
  assert.equal(transcriptAvailability({ cutoff_requires_review: true }), null);
  assert.throws(
    () => transcriptAvailability({ is_livestream: true }),
    /timestamp/,
  );
});

test("transcript payload hashes are verified before serving and audio is never fetched", async () => {
  const normalized = bytes({ utterances: [{ speaker: "A", text: "hello" }] }),
    readable = Buffer.from("hello");
  const f = fixture({
    normalized,
    readable,
    root: bytes({
      createdAt: "2026-10-20T00:00Z",
      media: { id: "media" },
      run: {
        id: "run",
        normalized: { key: "normalized", sha256: sha256(normalized) },
      },
      artifacts: {
        readable: { key: "readable", sha256: sha256(readable) },
        audio: { key: "never-read" },
      },
    }),
  });
  const remote: ObjectStore = {
    get: async (b, k) => f.raw.get(b, k.replace(/^dev\//, "")),
  };
  const entry = {
    manifestKey: "m",
    mediaId: "media",
    runId: "run",
    jsonSha256: sha256(normalized),
    published_at: "2025-10-22T18:00Z",
    published_at_precision: "second",
  };
  const adapter = new TranscriptsAdapter(
    [entry],
    { m: f.ref("root") },
    new VerifiedStore(remote),
  );
  const result = await adapter.records();
  assert.equal(result[0].data.readable, "hello");
  assert.equal(result[0].collectedAt, "2026-10-20T00:00:00Z");
  assert.deepEqual(f.calls, ["root", "normalized", "readable"]);
  await assert.rejects(
    new TranscriptsAdapter(
      [{ ...entry, mediaId: "wrong" }],
      { m: f.ref("root") },
      new VerifiedStore(remote),
    ).records(),
    /identity disagree/,
  );
});

test("canonical joins fail on collisions instead of selecting the first match", () => {
  const ids = new Identities();
  ids.addName("player", "Xavier Tillman", "1");
  assert.equal(ids.byName("player", "Xavier Tillman, Sr."), "1");
  ids.addName("player", "Xavier Tillman Jr.", "2");
  assert.throws(() => ids.byName("player", "Xavier Tillman"), /Ambiguous/);
  assert.throws(() => ids.byName("player", "Unseen"), /Unresolved/);
  ids.add({
    entity: "game",
    provider: "espn",
    providerId: "1",
    canonicalId: "g",
    basis: "fixture",
    evidence: [fakeRef],
  });
  assert.throws(
    () =>
      ids.add({
        entity: "game",
        provider: "espn",
        providerId: "1",
        canonicalId: "other",
        basis: "fixture",
        evidence: [fakeRef],
      }),
    /Conflicting/,
  );
});

test("Parquet decoding returns JSON-safe published values; reference tables forbid archive access", async () => {
  const body = await readFile(
    new URL("./fixtures/games.parquet", import.meta.url),
  );
  const rows = await parquet(body);
  assert.ok(rows.length);
  assert.doesNotThrow(() => JSON.stringify(rows));
  const f = fixture({ root: bytes({ objects: [] }) });
  const adapter = new PlayerReferenceAdapter(
    await Release.open(f.ref("root"), f.store),
  );
  await assert.rejects(adapter.records("archive"), /Only published/);
});

test("PBP suppresses partial products before reading their files; static schedule omits results", async () => {
  const games = await readFile(
    new URL("./fixtures/games.parquet", import.meta.url),
  );
  const first = (await parquet(games))[0];
  const coverage = Buffer.from(
    JSON.stringify({
      game_id: first.game_id,
      product: "summaries",
      quality_status: "partial",
      missing_reason: "broken chain",
    }),
  );
  const key = "tables/games/phase=regular_season/part.parquet";
  const f = fixture({
    ["objects/" + key]: games,
    "objects/coverage.jsonl": coverage,
    root: bytes({
      object_prefix: "objects/",
      objects: { [key]: sha256(games), "coverage.jsonl": sha256(coverage) },
      tables: { games: [key] },
    }),
  });
  const adapter = new PlayByPlayAdapter(
    await Release.open(f.ref("root"), f.store),
  );
  assert.deepEqual(
    await adapter.records("v_player_game_summary", first.game_id),
    [],
  );
  assert.equal(adapter.exclusions[0].reason, "broken chain");
  const schedule = await adapter.games();
  assert.equal("home_score" in schedule[0].data, false);
  assert.equal("status" in schedule[0].data, false);
  await assert.rejects(
    adapter.records("raw_objects", first.game_id),
    /not replay evidence/,
  );
});
