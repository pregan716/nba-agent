import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { sha256 } from "../data/store.js";
import { normalizeName } from "../data/identity.js";
import { teamCode } from "../data/teams.js";
import { BOS } from "./roster-types.js";

export interface LocalSource {
  path: string;
  sha256: string;
  bytes: number;
}
const player = z.object({ playerId: z.string(), name: z.string() });
const schema = z.object({
  schemaVersion: z.literal(1),
  team: z.object({ teamId: z.string() }),
  season: z.literal("2025-26"),
  openingAvailableFrom: z.iso.datetime(),
  openingRoster: z.array(player),
  players: z.array(player),
  sources: z.object({
    official: z.object({ path: z.string(), fullDownloadSha256: z.string() }),
  }),
  events: z.array(
    z.object({
      id: z.string(),
      availableAt: z.iso.datetime(),
      out: z.array(z.string()),
      in: z.array(z.string()),
    }),
  ),
});

/** Verify both committed evidence files before interpreting any membership. */
export async function loadSeasonRoster(
  root = process.cwd(),
  teamId: string = BOS,
) {
  const pins = JSON.parse(
    await readFile(
      resolve(
        root,
        teamId === BOS
          ? "config/roster-evidence.json"
          : `config/five-team/roster-${teamCode(teamId)}-pins.json`,
      ),
      "utf8",
    ),
  );
  const sources: LocalSource[] = [];
  const read = async (pin: LocalSource) => {
    const bytes = await readFile(resolve(root, pin.path));
    if (sha256(bytes) !== pin.sha256 || bytes.length !== pin.bytes)
      throw Error(`Roster evidence hash mismatch: ${pin.path}`);
    sources.push(pin);
    return JSON.parse(bytes.toString());
  };
  const config = schema.parse(await read(pins.curated));
  const official = await read(pins.official);
  if (
    config.team.teamId !== teamId ||
    pins.official.path !== config.sources.official.path ||
    official.source.sha256 !== config.sources.official.fullDownloadSha256
  )
    throw Error("Roster official-feed provenance mismatch");
  const names = new Map(
    [...config.openingRoster, ...config.players].map((p) => [
      p.playerId,
      p.name,
    ]),
  );
  const events = [...config.events].sort(
    (a, b) =>
      Date.parse(a.availableAt) - Date.parse(b.availableAt) ||
      a.id.localeCompare(b.id),
  );
  return {
    sources,
    openingAvailableFrom: config.openingAvailableFrom,
    departed(key: string, tip: string) {
      const matching = [...names].filter(
        ([, name]) => normalizeName(name) === key,
      );
      if (matching.length !== 1) return false;
      const [id] = matching[0];
      const latest = events
        .filter(
          (e) =>
            Date.parse(e.availableAt) < Date.parse(tip) &&
            (e.in.includes(id) || e.out.includes(id)),
        )
        .at(-1);
      return !!latest?.out.includes(id);
    },
    at(tip: string) {
      const time = Date.parse(tip);
      if (
        !Number.isFinite(time) ||
        Date.parse(config.openingAvailableFrom) >= time
      )
        throw Error("Roster opening evidence is not before tip");
      const members = new Map(
        config.openingRoster.map((p) => [
          p.playerId,
          config.openingAvailableFrom,
        ]),
      );
      for (const event of events) {
        if (Date.parse(event.availableAt) >= time) break;
        for (const id of event.out) {
          if (!members.delete(id))
            throw Error(`Departure of non-member: ${event.id}: ${id}`);
        }
        for (const id of event.in) {
          if (members.has(id) || !names.has(id))
            throw Error(`Invalid arrival: ${event.id}: ${id}`);
          members.set(id, event.availableAt);
        }
      }
      return [...members]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([playerId, availableAt]) => ({
          playerId,
          availableAt,
          name: names.get(playerId)!,
        }));
    },
  };
}
