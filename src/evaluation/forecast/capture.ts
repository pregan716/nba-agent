import { createHash } from "node:crypto";
import type { OddsAdapter } from "../../data/adapters.js";
import type { Identities } from "../../data/identity.js";
import type { Row } from "../../data/contracts.js";
import type { Game } from "../../runner/config.js";
import type { RecordStore } from "../../runner/record.js";
import { canonical } from "../record.js";
import { dispersion, type Snapshot, type Stat } from "./market.js";

export function snapshots(games: Game[], ids: Identities, rows: Row[]) {
  if (games.some((g) => g.index >= 70))
    throw Error("Holdout market capture refused");
  const selected = new Map(games.map((g) => [g.gameId, g]));
  const byEspn = new Map(
    ids
      .rows()
      .filter(
        (r) =>
          r.entity === "game" &&
          r.provider === "espn" &&
          selected.has(r.canonicalId),
      )
      .map((r) => [r.providerId, selected.get(r.canonicalId)!]),
  );
  if (new Set([...byEspn.values()].map((g) => g.gameId)).size !== games.length)
    throw Error("Missing scheduled game identity");
  const data = new Map(
    games.map((g) => [g.gameId, { props: [], unavailable: 0 } as Snapshot]),
  );
  const seen = new Set<string>();
  for (const r of rows) {
    const game = byEspn.get(String(r.espn_event_id));
    if (
      !game ||
      r.snapshot_kind !== "scheduled_start" ||
      Date.parse(r.requested_at) !== Date.parse(game.scheduledStart)
    )
      continue;
    const stat = String(r.prop_type).replace(/^player_/, "") as Stat;
    if (!Object.hasOwn(dispersion, stat)) continue;
    const key = JSON.stringify([game.gameId, r.espn_player_id, stat]);
    if (seen.has(key)) throw Error("Duplicate scheduled-tip prop " + key);
    seen.add(key);
    const snapshot = data.get(game.gameId)!;
    if (r.status !== "ok") {
      snapshot.unavailable++;
      continue;
    }
    // p_over on an integer line is conditional on no push; the scorer treats a push as an under.
    if (r.probability_basis !== "unconditional")
      throw Error("Consensus is not an unconditional probability " + key);
    if (
      !Number.isFinite(r.selected_line) ||
      r.selected_line < 0 ||
      !Number.isFinite(r.p_over) ||
      r.p_over < 0 ||
      r.p_over > 1
    )
      throw Error("Malformed usable consensus " + key);
    snapshot.props.push({
      playerId: ids.resolve("player", "espn", String(r.espn_player_id)),
      stat,
      line: r.selected_line,
      market: r.p_over,
    });
  }
  for (const v of data.values())
    v.props.sort(
      (a, b) =>
        a.playerId.localeCompare(b.playerId) || a.stat.localeCompare(b.stat),
    );
  return data;
}
/** Order-independent digest of every captured (game, player, stat, line, over probability). */
export function poolDigest(captured: Map<string, Snapshot>) {
  const rows = [...captured].flatMap(([gameId, s]) =>
    s.props.map((p) =>
      JSON.stringify([gameId, p.playerId, p.stat, p.line, p.market]),
    ),
  );
  return createHash("sha256").update(rows.sort().join("\n")).digest("hex");
}
// Called by the host after run_end. No session, sandbox, or model receives this input.
export async function recordConsensus(
  record: RecordStore,
  odds: Pick<OddsAdapter, "version" | "auditRows">,
  ids: Identities,
) {
  if (!record.events("run_end").length)
    throw Error("Market capture requires a finished run");
  const manifest = record.events("manifest")[0].data;
  if (manifest.config.profile.memory.version !== "forecast-memory-v1")
    throw Error("Expected a forecast run");
  const pin = odds.version();
  if (
    !manifest.config.profile.dataSources.some(
      (d: { type: string; manifestSha256: string }) =>
        d.type === "odds" && d.manifestSha256 === pin.manifest.sha256,
    )
  )
    throw Error("Consensus release differs from run");
  const idsPlayed = new Set(record.events("game_end").map((e) => e.scope));
  const games = (manifest.games as Game[]).filter((g) =>
    idsPlayed.has(g.gameId),
  );
  if (games.length !== idsPlayed.size || games.some((g) => g.index >= 70))
    throw Error("Invalid market game selection");
  const captured = snapshots(games, ids, await odds.auditRows());
  for (const [gameId, snapshot] of captured) {
    const data = {
      version: "forecast-consensus-v1",
      release: pin.manifest.sha256,
      methodology: pin.methodologySha256,
      ...snapshot,
    };
    const saved = record.events("evaluator_consensus", gameId)[0];
    if (!saved) record.append("evaluator_consensus", gameId, data);
    else if (canonical(saved.data) !== canonical(data))
      throw Error("Recorded consensus changed");
  }
}
