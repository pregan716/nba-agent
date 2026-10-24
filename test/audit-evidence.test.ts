import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sha256 } from "../src/data/store.js";
import { nearCutoff } from "../src/audit/checks.js";
import type { Row } from "../src/data/contracts.js";
const read = async (name: string) =>
  JSON.parse(
    await readFile(
      new URL(`../docs/evidence/audit/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
test("committed audit covers the complete season and required samples", async () => {
  const schedule: Row[] = await read("schedule"),
    resolution: Row[] = await read("resolution"),
    summary = await read("summary");
  assert.equal(new Set(schedule.map((r) => r.gameId)).size, 82);
  assert.deepEqual(
    [...new Set(resolution.map((r) => r.gameId))].sort(),
    schedule.map((r) => r.gameId).sort(),
  );
  assert.equal(resolution.length, summary.resolution.gamePlayers);
  assert.equal(
    resolution.filter((r) => r.issues.length).length,
    summary.resolution.findings,
  );
  for (const name of ["consensus-sample", "outcome-sample"]) {
    const data = await read(name);
    assert.equal(data.rows.length, 50);
    assert.equal(new Set(data.rows.map((r: Row) => r.key)).size, 50);
  }
  const fallback = await read("dec5-fallback");
  assert.equal(fallback.gameId, "0022500338");
  assert.equal(fallback.summaryStatus, "partial");
  assert.equal(fallback.servedSummaryRows, 0);
  assert.ok(fallback.players.some((r: Row) => r.didNotPlay && r.seconds === 0));
  const identity = await read("identity");
  for (const r of identity.propped) {
    assert.equal(r.id, r.storedId);
    assert.equal(r.pbp.length, 1);
    assert.equal(r.reference.length, 1);
    assert.ok(r.injuries.length);
  }
});
test("qualitative audit judgments match the exact sampled content", async () => {
  const sample = await read("content-sample"),
    review = await read("content-review");
  assert.equal(sample.transcripts.length, 20);
  assert.equal(sample.posts.length, 50);
  assert.equal(review.transcripts.length, 20);
  assert.equal(review.posts.length, 50);
  for (const [i, r] of sample.transcripts.entries()) {
    assert.equal(review.transcripts[i].id, r.id);
    assert.equal(review.transcripts[i].textSha256, r.textSha256);
    assert.ok(review.transcripts[i].rationale);
    assert.ok(review.transcripts[i].evidenceSpanSeconds);
  }
  for (const [i, r] of sample.posts.entries()) {
    assert.equal(review.posts[i].postId, r.id.split(":")[1]);
    assert.equal(review.posts[i].textSha256, sha256(Buffer.from(r.text)));
    assert.ok(
      [
        "basketball",
        "basketball_with_retained_context",
        "indeterminate",
        "off_topic",
      ].includes(review.posts[i].judgment),
    );
  }
  assert.equal(
    review.posts.filter((r: Row) => r.judgment === "indeterminate").length,
    review.results.posts.indeterminate,
  );
  assert.equal(
    review.posts.filter((r: Row) => r.judgment.startsWith("basketball")).length,
    review.results.posts.confirmedBasketball,
  );
});
test("boundary inventory lists unique records at valid timestamps and matches its totals", async () => {
  const summary = await read("summary");
  const lines = (
    await readFile(
      new URL("../docs/evidence/audit/boundary-records.jsonl", import.meta.url),
      "utf8",
    )
  )
    .trim()
    .split("\n");
  const counts: Record<string, number> = {},
    seen = new Set<string>();
  for (const line of lines) {
    const r = JSON.parse(line);
    assert.ok(nearCutoff(r.availableAt, r.cutoff));
    assert.match(r.object.sha256, /^[a-f0-9]{64}$/);
    for (const id of r.ids) {
      const key = JSON.stringify([r.source, r.gameId, id]);
      assert.ok(!seen.has(key), `Duplicate ${key}`);
      seen.add(key);
    }
    counts[r.source] = (counts[r.source] ?? 0) + r.ids.length;
  }
  assert.deepEqual(counts, summary.availability.boundaryCounts);
});
