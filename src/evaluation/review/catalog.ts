import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { FiveTeamData } from "../../data/five-team.js";
import { scanner, type Identity } from "./scan.js";

// Only identity dimensions and the Coaches result set from the pinned NBA
// CommonTeamRoster responses. No game box, event, score or outcome access.
export async function seasonScanner({
  corpus,
  data,
  root,
}: Pick<FiveTeamData, "corpus" | "data" | "root">) {
  const identities: Identity[] = [];
  const add = (kind: Identity["kind"], value: string) => {
    identities.push({ kind, value });
  };
  for (const { row } of await corpus.pbp.release.table("players")) {
    add("player", row.name);
    add("player", String(row.player_id));
  }
  for (const { data: p } of await corpus.players.records("player_profiles")) {
    if (p.opening_roster) {
      add("player", p.full_name);
      add("player", String(p.player_id));
    }
  }
  const pins = z
    .record(z.string(), z.string().regex(/^[a-f0-9]{64}$/))
    .parse(
      JSON.parse(
        await readFile(join(root, "config/review-coach-rosters.json"), "utf8"),
      ),
    );
  if (new Set(data.teams.map((t) => t.team_id)).size !== 30)
    throw Error("Incomplete team identity table");
  for (const t of data.teams) {
    const hash = pins[t.team_id];
    if (!hash) throw Error("Missing coach roster for " + t.team_id);
    const key = "nba/player-reference/2025-26-opening/archive/raw/" + hash;
    const raw = JSON.parse(
      (await corpus.players.release.bytes(key)).toString(),
    );
    const table = raw.resultSets.find(
      (s: { name: string }) => s.name === "Coaches",
    );
    if (!table?.rowSet?.length) throw Error("Empty coach roster");
    for (const row of table.rowSet) {
      const field = (name: string) => row[table.headers.indexOf(name)];
      if (
        String(field("TEAM_ID")) !== t.team_id ||
        field("SEASON") !== "2025" ||
        !field("COACH_ID") ||
        !field("COACH_NAME")
      )
        throw Error("Invalid coach reference row");
      add("coach", field("COACH_NAME"));
      add("coach", String(field("COACH_ID")));
    }
  }
  const staff = JSON.parse(
    await readFile(join(root, "config/celtics-staff-2025-26.json"), "utf8"),
  );
  for (const name of staff.names) add("coach", name);
  return scanner(identities, data.teams);
}
