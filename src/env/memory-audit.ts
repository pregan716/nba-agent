import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { SessionSource } from "./source.js";

export interface BoundaryNames {
  players: string[];
  staff: string[];
  gameIds: string[];
  sources: unknown[];
}
/** Audit-only inputs, never exposed as evidence or added to the analyst context. */
export async function boundaryNames(
  source: SessionSource,
): Promise<BoundaryNames> {
  const rosterBytes = readFileSync(
    new URL("../../config/celtics-transactions-2025-26.json", import.meta.url),
  );
  const roster = JSON.parse(rosterBytes.toString());
  const staffBytes = readFileSync(
    new URL("../../config/celtics-staff-2025-26.json", import.meta.url),
  );
  const staff = JSON.parse(staffBytes.toString());
  const members = [...roster.openingRoster, ...roster.players];
  const ids = new Set(members.map((p) => p.playerId));
  const refs = await source.reference("player_profiles");
  const names = [
    ...members.map((p) => p.name),
    ...refs
      .filter(
        (r) =>
          ids.has(r.data.player_id) || r.data.opening_team_id === "1610612738",
      )
      .map((r) => r.data.full_name),
  ].filter((n): n is string => typeof n === "string");
  return {
    players: [...new Set(names)].sort(),
    staff: staff.names,
    gameIds: (await source.games()).map((g) => g.id).sort(),
    sources: [
      {
        path: "config/celtics-transactions-2025-26.json",
        sha256: createHash("sha256").update(rosterBytes).digest("hex"),
      },
      {
        path: "config/celtics-staff-2025-26.json",
        sha256: createHash("sha256").update(staffBytes).digest("hex"),
        source: staff.source,
        status: "Proposed",
      },
      ...source.versions,
    ],
  };
}
export function auditBoundary(
  root: string,
  gameId: string,
  names: BoundaryNames,
) {
  const flags: {
    game: string;
    file: string;
    matchedText: string;
    source: "path" | "content";
    offset: number;
    kind: string;
    queue: "human-review";
  }[] = [];
  const inputs: { file: string; sha256: string }[] = [];
  const terms = [
    ...names.players.map((text) => ({ text, kind: "player" })),
    ...names.staff.map((text) => ({ text, kind: "staff" })),
    ...names.gameIds.map((text) => ({ text, kind: "game-id" })),
  ];
  const visit = (path: string) => {
    const file = join(root, path);
    let stat;
    try {
      stat = lstatSync(file);
    } catch (e: any) {
      if (e.code === "ENOENT") return;
      throw e;
    }
    if (stat.isSymbolicLink()) throw Error("Boundary audit refuses symlinks");
    if (stat.isDirectory()) {
      for (const name of readdirSync(file).sort()) visit(`${path}/${name}`);
      return;
    }
    const bytes = readFileSync(file),
      text = bytes.toString("utf8");
    inputs.push({
      file: path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    for (const term of terms) {
      const escaped = term.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`;
      const pathPattern = new RegExp(pattern, "iu");
      if (
        pathPattern.test(path) ||
        (term.kind !== "game-id" &&
          pathPattern.test(path.replace(/[-_.]/g, " ")))
      )
        flags.push({
          game: gameId,
          file: path,
          matchedText: path,
          source: "path",
          offset: 0,
          kind: term.kind,
          queue: "human-review",
        });
      for (const match of text.matchAll(new RegExp(pattern, "giu")))
        flags.push({
          game: gameId,
          file: path,
          matchedText: match[0],
          source: "content",
          offset: match.index!,
          kind: term.kind,
          queue: "human-review",
        });
    }
  };
  for (const path of ["memory/best_practices.md", "memory/practices", "skills"])
    visit(path);
  return {
    version: "boundary-audit-v1",
    game: gameId,
    names,
    inputs,
    flags,
    action: "flag-only",
  };
}
