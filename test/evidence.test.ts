import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../src/env/session.js";
import { offeredTools } from "../src/harness/loop.js";
import {
  fixtureCorpus,
  envelope,
  before,
  cutoff,
  future,
} from "./fixtures/session/corpus.js";

const post = (id: string, text: string, at = before, extra = {}) =>
  envelope(id, "posts", at, "post_version_publication", {
    accountId: "reporter",
    postId: id,
    text,
    ...extra,
  });
const session = (
  f: ReturnType<typeof fixtureCorpus>,
  phase: "pregame" | "postgame" = "pregame",
) =>
  new Session(
    f.config,
    f.game,
    phase,
    phase === "pregame" ? cutoff : f.game.release,
    f.source,
  );
const corpus = () => {
  const f = fixtureCorpus(false);
  f.records.posts = [];
  f.records.transcripts = [];
  f.records.lineups = [];
  return f;
};
const player = (
  f: ReturnType<typeof fixtureCorpus>,
  name: string,
  id: string,
) => {
  f.source.identities.add({
    entity: "player",
    provider: "lineup-name",
    providerId: name,
    canonicalId: id,
    basis: "fixture",
    evidence: [f.schedule[0].provenance.object],
  });
};

test("browse defaults to previous team cutoff, clamps to cutoff, and pages newest first", async () => {
  const f = corpus();
  f.records.posts = [
    post("old", "old", "2025-10-30T23:00:00Z"),
    post("boundary", "boundary", "2025-10-31T23:00:00Z"),
    post("new", "new"),
    post("equal", "equal", cutoff),
    post("future", "future", future),
  ];
  const s = session(f);
  const first = await s.list_evidence({ limit: 1 });
  assert.equal(first.total, 2);
  assert.equal(first.items[0].snippet, "new");
  const second = await s.list_evidence({
    limit: 1,
    cursor: first.next_cursor!,
  });
  assert.equal(second.items[0].snippet, "boundary");
  assert.equal(second.next_cursor, null);
  assert.deepEqual(await s.list_evidence({ limit: 1, to: future }), first);
  assert.equal((await s.list_evidence({ sources: [] })).total, 0);
  assert.equal((await s.list_evidence({ sources: ["transcripts"] })).total, 0);
  assert.equal((await s.list_evidence({ sources: ["posts"] })).total, 2);
  assert.equal(
    (
      await s.list_evidence({
        from: "2025-10-01T00:00:00Z",
        to: "2025-10-31T23:00:00Z",
      })
    ).total,
    1,
  );
  await assert.rejects(
    () => s.list_evidence({ limit: 2, cursor: first.next_cursor! }),
    /Invalid evidence cursor/,
  );
  await assert.rejects(
    () =>
      s.search_evidence({ query: "new", limit: 1, cursor: first.next_cursor! }),
    /Invalid evidence cursor/,
  );
  const later = session(f, "postgame");
  const after = await later.list_evidence({});
  assert.deepEqual(
    after.items.map((h) => h.snippet),
    ["future", "equal"],
  );
  await assert.rejects(
    () => later.list_evidence({ limit: 1, cursor: first.next_cursor! }),
    /Invalid evidence cursor/,
  );
  // No previous team game: browse all eligible history.
  f.schedule.splice(0, 1);
  assert.equal((await session(f).list_evidence({})).total, 3);
});

test("ranked search uses OR semantics, English stemming, deterministic ranking and eligible-only statistics", async () => {
  const f = corpus();
  f.records.posts = [
    post("both", "injuries rotations"),
    post("one", "injury"),
    post("none", "unrelated"),
  ];
  const query = { query: "injury rotation absent", limit: 1 };
  const first = await session(f).search_evidence(query);
  assert.equal(first.total, 2);
  assert.equal(first.items[0].snippet, "injuries rotations");
  const second = await session(f).search_evidence({
    ...query,
    cursor: first.next_cursor!,
  });
  assert.equal(second.items[0].snippet, "injury");
  // Numerous later records would alter IDF/length normalization if included.
  for (let i = 0; i < 40; i++)
    f.records.posts.push(post(`future${i}`, "injury ".repeat(100), future));
  assert.deepEqual(await session(f).search_evidence(query), first);
  assert.deepEqual(
    await session(f).search_evidence({ ...query, cursor: first.next_cursor! }),
    second,
  );
  f.records.posts = [
    post("a", "minutes"),
    post("b", "minutes"),
    post("c", "minutes", "2025-11-01T00:00:00Z"),
  ];
  const tied = await session(f).search_evidence({ query: "minute" });
  assert.equal(tied.items[2].available_at, "2025-11-01T00:00:00Z");
  assert.deepEqual(
    tied.items.slice(0, 2).map((h) => h.evidence_id),
    tied.items
      .slice(0, 2)
      .map((h) => h.evidence_id)
      .sort(),
  );
});

test("names resolve to player tags and text, full names disambiguate, and explicit IDs filter", async () => {
  const f = corpus();
  player(f, "Derrick White", "derrick");
  player(f, "Coby White", "coby");
  f.records.posts = [
    post("colour", "White white white uniform"),
    post("tag", "Ready tonight", before, { player_ids: ["derrick"] }),
    post("named", "Derrick White available"),
    post("other", "Coby White available"),
    post("surname", "White available"),
    post("miss", "Brown unavailable"),
  ];
  const s = session(f);
  const resolved = await s.search_evidence({ query: "White" });
  assert.equal(resolved.total, 5);
  assert.ok(
    resolved.items.findIndex((h) => h.snippet === "Ready tonight") <
      resolved.items.findIndex((h) => h.snippet.includes("uniform")),
  );
  const full = await s.search_evidence({ query: "Derrick White" });
  assert.ok(!full.items.some((h) => h.snippet.includes("Coby")));
  const direct = await s.search_evidence({
    query: "ready",
    player_id: "derrick",
  });
  assert.deepEqual(
    direct.items.map((h) => h.snippet),
    ["Ready tonight"],
  );
  assert.equal(
    (await s.search_evidence({ query: "ready", player_id: "coby" })).total,
    0,
  );
});

test("lineup starters are searchable by surname and starting lineup without rewriting published text", async () => {
  const f = fixtureCorpus(false);
  const lineup = f.records.lineups[0];
  player(f, "Derrick White", "derrick");
  lineup.data.text = "First five of the season ⤵️";
  lineup.data.startingLineup = ["Derrick White"];
  const s = session(f);
  for (const query of ["starting lineup", "White", "Derrick White"]) {
    const result = await s.search_evidence({ query, sources: ["lineups"] });
    assert.equal(result.total, 1);
    assert.match(result.items[0].snippet, /Starting lineup: Derrick White/);
    assert.equal(
      (await s.fetch_evidence({ evidence_id: result.items[0].evidence_id }))
        .text,
      lineup.data.text,
    );
  }
  assert.match(
    (await s.list_evidence({ sources: ["lineups"] })).items[0].snippet,
    /Derrick White/,
  );
});

test("browse is offered and callable only in research phases with the evidence capability", async () => {
  const f = corpus();
  for (const phase of ["pregame", "postgame"] as const) {
    const s = session(f, phase);
    const context = await s.context({
      tokens: 100,
      compute_seconds: 0,
      tool_calls: 10,
      submission_reserve: 0,
      warning: false,
    });
    assert.ok(offeredTools(context).includes("list_evidence"));
    assert.deepEqual(await s.list_evidence({}), {
      total: 0,
      next_cursor: null,
      items: [],
    });
  }
  const commit = new Session(f.config, f.game, "commit", cutoff, f.source);
  await assert.rejects(
    () => commit.list_evidence({}),
    /unavailable in this phase/,
  );
  f.config.profile.capabilities.enabled = [];
  await assert.rejects(
    () => session(f).list_evidence({}),
    /Capability disabled/,
  );
});

test("opening player profiles supply names absent from aliases; future profiles cannot affect retrieval", async () => {
  const f = corpus();
  const profile = envelope(
    "profile",
    "player-reference",
    "2025-10-01T00:00:00Z",
    "opening_reference_static",
    { player_id: "payton", full_name: "Payton Pritchard" },
  );
  const profiles = [profile];
  f.source.reference = async () => profiles;
  f.records.posts = [
    post("tag", "Ankle improving", before, { player_id: "payton" }),
    post("noise", "Other ankle news"),
  ];
  const query = { query: "Payton Pritchard ankle" };
  const result = await session(f).search_evidence(query);
  assert.equal(result.total, 1);
  assert.equal(result.items[0].snippet, "Ankle improving");
  profiles.push({
    ...profile,
    id: "future-profile",
    availableAt: future,
    data: { player_id: "other", full_name: "Ankle News" },
  });
  assert.deepEqual(await session(f).search_evidence(query), result);
});

test("persisted scoped injury-name identities remain searchable", async () => {
  const { readFile } = await import("node:fs/promises");
  const f = corpus();
  const mappings = JSON.parse(await readFile("config/identities.json", "utf8"));
  for (const mapping of mappings) f.source.identities.add(mapping);
  f.records.posts = [
    post("jaylin", "Ready tonight", before, { player_id: "1631119" }),
  ];
  assert.equal(
    (await session(f).search_evidence({ query: "Jaylin Williams" })).total,
    1,
  );
});

test("common-word surnames boost players without hiding ordinary lexical matches", async () => {
  const f = corpus();
  for (const [name, id] of [
    ["Quinten Post", "post"],
    ["LaMelo Ball", "ball"],
    ["Jrue Holiday", "holiday"],
  ])
    player(f, name, id);
  f.records.posts = [
    post(
      "rotation",
      "Mazzulla tightened the rotation, more minutes for Hauser",
    ),
    post("tagged", "Ready tonight", before, { player_id: "post" }),
  ];
  const s = session(f);
  for (const query of [
    "rotation",
    "post rotation",
    "holiday rotation",
    "ball rotation",
  ])
    assert.ok(
      (await s.search_evidence({ query })).items.some((h) =>
        h.snippet.includes("Mazzulla"),
      ),
      query,
    );
  const boosted = await s.search_evidence({ query: "post rotation" });
  assert.equal(boosted.items[0].snippet, "Ready tonight");
  assert.deepEqual(
    (await s.search_evidence({ query: "Quinten Post rotation" })).items.map(
      (h) => h.snippet,
    ),
    ["Ready tonight"],
  );
  assert.deepEqual(
    (await s.search_evidence({ query: "rotation", player_id: "holiday" }))
      .items,
    [],
  );
});

test("tagged records also resolve other players named in their text", async () => {
  const f = corpus();
  player(f, "Derrick White", "dw");
  player(f, "Jaylen Brown", "jb");
  f.records.posts = [
    post("both", "Derrick White and Jaylen Brown both out tonight", before, {
      player_ids: ["dw"],
    }),
  ];
  const s = session(f);
  for (const query of ["Jaylen Brown", "Derrick White"])
    assert.equal((await s.search_evidence({ query })).total, 1);
  assert.equal(
    (await s.search_evidence({ query: "out", player_id: "jb" })).total,
    1,
  );
});

test("accented and ASCII names retrieve the same entities without rewriting evidence", async () => {
  const f = corpus();
  player(f, "Hugo González", "hugo");
  f.records.posts = [
    post("ascii", "Hugo Gonzalez available"),
    post("accent", "Hugo González available"),
  ];
  const s = session(f);
  for (const query of [
    "González",
    "Gonzalez",
    "Hugo González",
    "Hugo Gonzalez",
    "Hugo Gonza\u0301lez",
  ]) {
    const result = await s.search_evidence({ query });
    assert.equal(result.total, 2, query);
    assert.deepEqual(
      new Set(result.items.map((h) => h.snippet)),
      new Set(["Hugo Gonzalez available", "Hugo González available"]),
    );
    for (const hit of result.items)
      assert.equal(
        (await s.fetch_evidence({ evidence_id: hit.evidence_id })).text,
        hit.snippet,
      );
  }
});

test("OR search ignores function words and preserves exact snippet anchors", async () => {
  const f = corpus();
  f.records.posts = [
    post("noise", "the team is fine"),
    post("match", "Padding ".repeat(40) + "Tatum questionable"),
  ];
  const s = session(f);
  const result = await s.search_evidence({ query: "is tatum questionable" });
  assert.equal(result.total, 1);
  assert.match(result.items[0].snippet, /^….*Tatum questionable$/);
  assert.equal((await s.search_evidence({ query: "is the and" })).total, 0);
});
