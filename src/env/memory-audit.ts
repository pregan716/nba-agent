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
        additionalSources: staff.additionalSources ?? [],
        status: staff.status,
        acceptedAt: staff.acceptedAt,
      },
      ...source.versions,
    ],
  };
}
const foldAccents = (text: string) =>
  text.normalize("NFD").replace(/\p{M}/gu, "");
/** Map folded UTF-16 indices back to the original, including decomposed accents. */
function foldedContent(original: string) {
  let text = "",
    offset = 0;
  const starts: number[] = [],
    ends: number[] = [];
  for (const character of original) {
    const folded = foldAccents(character);
    if (!folded && ends.length)
      ends[ends.length - 1] = offset + character.length;
    for (let i = 0; i < folded.length; i++) {
      starts.push(offset);
      ends.push(offset + character.length);
    }
    text += folded;
    offset += character.length;
  }
  return { text, starts, ends };
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
  const nameTerms = (names: string[], kind: string) =>
    names.flatMap((text) => {
      const tokens = text.trim().split(/\s+/);
      while (
        tokens.length > 1 &&
        /^(?:Jr\.?|Sr\.?|II|III|IV|V)$/i.test(tokens.at(-1)!)
      )
        tokens.pop();
      const surname = tokens.at(-1)!;
      const surnames = [
        ...new Set([surname, ...surname.split(/[-’']/u)]),
      ].filter((s) => s.length > 1);
      return [
        { text, kind, sensitive: false },
        ...surnames.map((text) => ({ text, kind, sensitive: true })),
      ];
    });
  const terms = [
    ...new Map(
      [
        ...nameTerms(names.players, "player"),
        ...nameTerms(names.staff, "staff"),
        ...names.gameIds.map((text) => ({
          text,
          kind: "game-id",
          sensitive: false,
        })),
      ].map((t) => [JSON.stringify(t), t]),
    ).values(),
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
      text = bytes.toString("utf8"),
      folded = foldedContent(text);
    inputs.push({
      file: path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    for (const term of terms) {
      const escaped = foldAccents(term.text).replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      );
      const pattern = `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`;
      const pathPattern = new RegExp(pattern, term.sensitive ? "u" : "iu");
      if (
        pathPattern.test(foldAccents(path)) ||
        (term.kind !== "game-id" &&
          pathPattern.test(foldAccents(path).replace(/[-_.]/g, " ")))
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
      for (const match of folded.text.matchAll(
        new RegExp(pattern, term.sensitive ? "gu" : "giu"),
      )) {
        const offset = folded.starts[match.index!];
        const end = folded.ends[match.index! + match[0].length - 1];
        flags.push({
          game: gameId,
          file: path,
          matchedText: text.slice(offset, end),
          source: "content",
          offset,
          kind: term.kind,
          queue: "human-review",
        });
      }
    }
  };
  for (const path of ["memory/best_practices.md", "memory/practices", "skills"])
    visit(path);
  return {
    version: "boundary-audit-v1",
    game: gameId,
    names,
    inputs,
    flags: [
      ...new Map(flags.map((flag) => [JSON.stringify(flag), flag])).values(),
    ],
    action: "flag-only",
  };
}
