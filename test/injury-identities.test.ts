import test from "node:test";
import assert from "node:assert/strict";
import {
  Identities,
  injuryIdentityKey,
  resolveInjuryPlayer,
  NameResolutionError,
} from "../src/data/identity.js";
import { injuryObservation } from "../src/data/adapters.js";
import type { ObjectRef } from "../src/data/store.js";
const OKC = "1610612760";
const evidence: ObjectRef = {
  bucket: "sports-nba-data",
  key: "fixture.parquet",
  sha256: "a".repeat(64),
};
function catalog() {
  const ids = new Identities();
  ids.addName("player", "Yang Hansen", "1642905");
  ids.addName("player", "Jaylin Williams", "1631119");
  ids.addName("player", "Jaylin Williams", "1642444");
  ids.addName("player", "Dillon Jones", "1641794");
  ids.addName("player", "Dillon Jones", "196295686");
  return ids;
}
test("I1 resolves the exact injury spelling without introducing a general alias", () => {
  const ids = catalog();
  assert.deepEqual(resolveInjuryPlayer(ids, "Yang, Hansen", "1610612757"), {
    playerId: "1642905",
    basis: "brief_sanctioned_alias",
  });
  assert.throws(() => ids.byName("player", "Hansen Yang"), NameResolutionError);
  assert.throws(
    () => resolveInjuryPlayer(ids, "Yang, Other", "1610612757"),
    NameResolutionError,
  );
});
test("I2 uses the adapter's retained team and survives mapping serialization with its scope", () => {
  const ids = catalog();
  const observed = injuryObservation(
    {
      record_id: "injury",
      phase: "regular_season",
      game_id: "game",
      team_id: OKC,
      player_name: "Williams, Jaylin",
      report_timestamp_utc: "2026-01-01T12:00:00Z",
    },
    evidence,
    evidence.sha256,
  )!;
  const resolved = resolveInjuryPlayer(
    ids,
    observed.data.player_name,
    observed.data.team_id,
  );
  assert.equal(resolved.playerId, "1631119");
  assert.equal(resolved.basis, "brief_sanctioned_team_scoped_name");
  ids.add({
    entity: "player",
    provider: "injury-name",
    providerId: observed.data.player_name,
    canonicalId: resolved.playerId,
    basis: resolved.basis,
    scope: resolved.scope,
    evidence: [evidence],
  });
  const loaded = new Identities();
  for (const row of JSON.parse(JSON.stringify(ids.rows()))) loaded.add(row);
  assert.equal(
    loaded.resolve("player", "injury-name", "Williams, Jaylin", {
      teamId: OKC,
    }),
    "1631119",
  );
  assert.throws(
    () => loaded.resolve("player", "injury-name", "Williams, Jaylin"),
    /matching team/,
  );
  assert.throws(
    () =>
      loaded.resolve("player", "injury-name", "Williams, Jaylin", {
        teamId: "1610612738",
      }),
    /matching team/,
  );
  assert.throws(
    () => ids.byName("player", "Jaylin Williams"),
    (e: unknown) =>
      e instanceof NameResolutionError && e.candidates.includes("1642444"),
  );
});
test("non-OKC Jaylin rows cannot reuse an OKC cached result; Dillon remains refused", () => {
  const ids = catalog(),
    cache = new Map();
  cache.set(
    injuryIdentityKey("Williams, Jaylin", OKC),
    resolveInjuryPlayer(ids, "Williams, Jaylin", OKC),
  );
  for (const team of ["1610612738", "unknown", ""]) {
    assert.equal(cache.has(injuryIdentityKey("Williams, Jaylin", team)), false);
    assert.throws(
      () => resolveInjuryPlayer(ids, "Williams, Jaylin", team),
      NameResolutionError,
    );
  }
  assert.throws(
    () => resolveInjuryPlayer(ids, "Jones, Dillon", "1610612752"),
    (e: unknown) =>
      e instanceof NameResolutionError &&
      e.kind === "ambiguous" &&
      e.candidates.join(",") === "1641794,196295686",
  );
});
