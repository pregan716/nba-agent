import assert from "node:assert/strict";
import { test } from "node:test";
import { Identities } from "../src/data/identity.js";
import { poolDigest, snapshots } from "../src/evaluation/forecast/capture.js";
import type { Snapshot } from "../src/evaluation/forecast/market.js";
import type { Game } from "../src/runner/config.js";

const tip = "2025-10-22T23:30:00.000Z";
const game: Game = {
  gameId: "g1",
  scheduledStart: tip,
  index: 0,
  development: true,
  release: "2025-10-23T13:00:00.000Z",
};
const ids = new Identities();
for (const [entity, providerId, canonicalId] of [
  ["game", "e1", "g1"],
  ["player", "7", "p7"],
] as const)
  ids.add({
    entity,
    provider: "espn",
    providerId,
    canonicalId,
    basis: "fixture",
    evidence: [
      { bucket: "sports-nba-data", key: "fixture", sha256: "a".repeat(64) },
    ],
  });
const row = {
  espn_event_id: "e1",
  espn_player_id: "7",
  prop_type: "player_points",
  requested_at: tip,
  snapshot_kind: "scheduled_start",
  status: "ok",
  probability_basis: "unconditional",
  selected_line: 20.5,
  p_over: 0.48,
};

test("capture keeps an unconditional scheduled-tip consensus", () => {
  assert.deepEqual(snapshots([game], ids, [row]).get("g1"), {
    props: [{ playerId: "p7", stat: "points", line: 20.5, market: 0.48 }],
    unavailable: 0,
  });
});

test("capture refuses a usable consensus that is conditional on no push", () => {
  for (const probability_basis of ["conditional_on_no_push", undefined])
    assert.throws(
      () =>
        snapshots([game], ids, [
          { ...row, selected_line: 20, probability_basis },
        ]),
      /not an unconditional probability/,
    );
});

test("capture does not require a basis on rows without a usable consensus", () => {
  const data = snapshots([game], ids, [
    { ...row, status: "no_quotes", probability_basis: "" },
  ]).get("g1");
  assert.deepEqual(data, { props: [], unavailable: 1 });
});

test("the pool digest ignores order and catches swapped player identities", () => {
  const prop = (
    playerId: string,
    stat: "points" | "assists",
    line: number,
  ) => ({
    playerId,
    stat,
    line,
    market: 0.5,
  });
  const pool = (a: string, b: string, reverse = false) => {
    const props = [prop(a, "points", 20.5), prop(b, "points", 9.5)];
    return new Map<string, Snapshot>(
      [
        ["g1", { props: reverse ? props.reverse() : props, unavailable: 0 }],
        ["g2", { props: [prop(a, "assists", 4.5)], unavailable: 0 }],
      ].sort(() => (reverse ? -1 : 1)) as [string, Snapshot][],
    );
  };
  const base = poolDigest(pool("p7", "p8"));
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(poolDigest(pool("p7", "p8", true)), base);
  // Same total and the same count in every game, different pool.
  assert.notEqual(poolDigest(pool("p8", "p7")), base);
  const moved = pool("p7", "p8");
  moved.get("g1")!.props[0].line = 21.5;
  assert.notEqual(poolDigest(moved), base);
});
