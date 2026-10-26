import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PostAuthors, loadPostAuthors } from "../src/data/post-authors.js";
import { BeatPostsAdapter } from "../src/data/adapters.js";
import { Release } from "../src/data/release.js";
import { VerifiedStore, sha256 } from "../src/data/store.js";
import { fixtureCorpus, before, future } from "./fixtures/session/corpus.js";
import { Session } from "../src/env/session.js";
import { manifest } from "../src/runner/config.js";

async function adapter(authors: PostAuthors) {
  const rows = [
    ["38032945", "jay", before],
    ["79806078", "chris", before],
    ["999999", "unknown", before],
    ["38032945", "future", future],
  ].map(([accountId, postId, at]) => ({
    post: {
      accountId,
      postId,
      versionId: `x:${postId}`,
      versionPublishedAt: at,
      publishedAt: at,
      text: "rotation update",
      references: [],
    },
    relevance: { relevant: true },
  }));
  const bytes = Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n"));
  const root = Buffer.from(
    JSON.stringify({
      rows: { objectKey: "posts.jsonl", sha256: sha256(bytes) },
      objects: [{ key: "posts.jsonl", sha256: sha256(bytes) }],
    }),
  );
  const objects: Record<string, Buffer> = { root, "posts.jsonl": bytes };
  const release = await Release.open(
    { bucket: "sports-text", key: "root", sha256: sha256(root) },
    new VerifiedStore({
      async get(_bucket, key) {
        return objects[key];
      },
    }),
  );
  return new BeatPostsAdapter(release, authors);
}
function bind(authors: PostAuthors) {
  const f = fixtureCorpus(false);
  f.source.versions.push(authors.version);
  f.config.profile.dataSources.push({
    type: authors.version.source,
    release: authors.version.release,
    manifestSha256: authors.version.manifest_sha256,
  });
  f.records.transcripts = [];
  f.records.lineups = [];
  return f;
}

test("P1 mapping reaches browse, search and fetch with stable account provenance and cutoff filtering", async () => {
  const authors = await loadPostAuthors(process.cwd());
  const posts = await adapter(authors);
  const f = bind(authors);
  const records = await posts.records();
  assert.equal(records[0].data.accountId, "38032945");
  assert.equal(records[0].data.authorHandle, "ByJayKing");
  f.records.posts = records;
  const s = new Session(
    f.config,
    f.game,
    "pregame",
    f.game.scheduledStart,
    f.source,
  );
  for (const page of [
    await s.list_evidence({ sources: ["posts"] }),
    await s.search_evidence({ query: "rotation", sources: ["posts"] }),
  ]) {
    assert.equal(page.total, 3);
    assert.deepEqual(
      new Set(page.items.map((i) => i.author)),
      new Set(["@ByJayKing", "@ChrisForsberg_", "999999"]),
    );
    for (const hit of page.items) {
      const fetched = await s.fetch_evidence({ evidence_id: hit.evidence_id });
      assert.equal(fetched.author, hit.author);
      assert.equal(fetched.text, "rotation update");
      const expected = {
        "@ByJayKing": "38032945",
        "@ChrisForsberg_": "79806078",
        "999999": "999999",
      }[hit.author!];
      assert.equal(fetched.provenance.account_id, expected);
      assert.equal(
        fetched.provenance.author_mapping_sha256,
        authors.version.manifest_sha256,
      );
      assert.equal(fetched.provenance.objects[0].key, "posts.jsonl");
    }
  }
});

test("mapping content changes data-source identity even without changing its release label", async () => {
  const bytes = await readFile("config/post-authors.json");
  const original = new PostAuthors(bytes);
  const changed = JSON.parse(bytes.toString());
  changed.accounts[0].handle = "OtherHandle";
  const next = new PostAuthors(Buffer.from(JSON.stringify(changed)));
  assert.equal(original.version.release, next.version.release);
  assert.notEqual(
    original.version.manifest_sha256,
    next.version.manifest_sha256,
  );
  const f = bind(original),
    newer = bind(next);
  const games = [
    { gameId: f.game.gameId, scheduledStart: f.game.scheduledStart },
  ];
  assert.notDeepEqual(manifest(f.config, games), manifest(newer.config, games));
  assert.throws(
    () =>
      new Session(
        f.config,
        f.game,
        "pregame",
        f.game.scheduledStart,
        newer.source,
      ),
    /dataset pins differ/,
  );
  assert.equal(original.handle("38032945"), "ByJayKing");
});

test("author mapping rejects malformed or duplicate identities", async () => {
  const value = JSON.parse(await readFile("config/post-authors.json", "utf8"));
  value.accounts.push(value.accounts[0]);
  assert.throws(
    () => new PostAuthors(Buffer.from(JSON.stringify(value))),
    /Duplicate/,
  );
  value.accounts.pop();
  value.accounts[0].handle = "@not a handle";
  assert.throws(() => new PostAuthors(Buffer.from(JSON.stringify(value))));
});
