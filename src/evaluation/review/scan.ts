import type { TeamRef } from "../../env/contract.js";

export interface Finding {
  file: string;
  line: number;
  reason: string;
}

export interface Identity {
  kind: "player" | "team" | "coach";
  value: string;
  caseSensitive?: boolean;
}
const fold = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[’']/g, "")
    .replace(/[._-]/g, " ")
    .replace(/\s+/g, " ");
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Calendar forms used in code, timestamps and prose. The season spans October
// through June, including preseason and postseason.
function seasonDate(line: string) {
  const inSeason = (year: number, month: number, day: number) =>
    ((year === 2025 && month >= 10 && month <= 12) ||
      (year === 2026 && month >= 1 && month <= 6)) &&
    day >= 1 &&
    day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (const [, y, m, d] of line.matchAll(
    /(?<!\d)(20\d{2})[-/](\d{1,2})[-/](\d{1,2})(?!\d)/g,
  ))
    if (inSeason(+y, +m, +d)) return true;
  for (const [, y, m, d] of line.matchAll(
    /(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)/g,
  ))
    if (inSeason(+y, +m, +d)) return true;
  for (const [, m, d, y] of line.matchAll(
    /(?<!\d)(\d{1,2})[-/](\d{1,2})[-/](20\d{2}|\d{2})(?!\d)/g,
  ))
    if (inSeason(+y < 100 ? 2000 + +y : +y, +m, +d)) return true;
  const months =
    "january february march april may june july august september october november december".split(
      " ",
    );
  for (const match of line.matchAll(
    /\b(?:(\d{1,2})\s+([a-z]{3,9})|([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?),?\s+(202[56])\b/gi,
  )) {
    const word = (match[2] ?? match[3]).toLowerCase();
    const month =
      months.findIndex((m) => m === word || m.slice(0, 3) === word) + 1;
    if (inSeason(+match[5], month, Number(match[1] ?? match[4]))) return true;
  }
  return false;
}

export function scanner(entries: Identity[], teams: TeamRef[] = []) {
  const identities = [...entries];
  // Short team codes double as ordinary variables. Leave them and bare
  // surnames to the contextual reviewer. NBA IDs remain exact indicators.
  for (const team of teams) {
    const nickname = team.name.endsWith("Trail Blazers")
      ? "Trail Blazers"
      : team.name.split(" ").at(-1)!;
    const city = team.name.slice(0, -nickname.length).trim();
    identities.push(
      { kind: "team", value: team.name },
      { kind: "team", value: team.team_id },
      { kind: "team", value: nickname, caseSensitive: true },
    );
    if (city)
      identities.push({
        kind: "team",
        value: city,
        caseSensitive: city === "LA",
      });
  }
  const groups = new Map<string, Set<string>>();
  for (const { kind, value, caseSensitive } of identities) {
    const key = kind + (caseSensitive ? " exact" : "");
    const values = groups.get(key) ?? new Set<string>();
    if (value.trim()) values.add(fold(value).trim());
    groups.set(key, values);
  }
  const patterns = [...groups].map(([key, values]) => ({
    kind: key.split(" ")[0],
    pattern: new RegExp(
      "(?<![\\p{L}\\d])(?:" +
        [...values]
          .sort((a, b) => b.length - a.length)
          .map(escape)
          .join("|") +
        ")(?![\\p{L}\\d])",
      key.endsWith(" exact") ? "gu" : "giu",
    ),
  }));
  return (raw: unknown) => {
    const findings: Finding[] = [];
    function inspect(value: string, file: string) {
      for (const [index, line] of value.split(/\r\n|[\r\n]/).entries()) {
        const add = (reason: string) =>
          findings.push({ file, line: index + 1, reason });
        for (const { kind, pattern } of patterns)
          for (const match of fold(line).matchAll(pattern))
            add(kind + " identity: " + match[0]);
        if (/(?<!\d)(?:00)?[1-6]25\d{5}(?!\d)/.test(line))
          add("2025–26 game ID");
        const datedModel =
          /^agents\/[^/]+\/model$/.test(file) &&
          line === "claude-haiku-4-5-20251001";
        if (!datedModel && seasonDate(line)) add("2025–26 season date");
        if (
          /\b(?:model_weights|pretrained_weights|state_dict)\s*[:=]\s*[[{]\s*[-+\d"']/i.test(
            line,
          )
        )
          add("Bundled model weights");
        if (
          /[\x00-\x08\x0b\x0c\x0e-\x1f\ufffd]/.test(line) ||
          /[A-Za-z0-9+/]{120,}={0,2}/.test(line)
        )
          add("Binary or encoded payload");
      }
    }
    function walk(v: unknown, path: string[]) {
      const location =
        path[0] === "files" && path.length === 2
          ? path[1]
          : path.join("/") || "package";
      if (v !== null && typeof v === "object") {
        for (const [k, child] of Object.entries(v)) {
          const next = [...path, k];
          if (!Array.isArray(v)) inspect(k, next.join("/"));
          if (
            path.length === 1 &&
            path[0] === "files" &&
            (!/\.py$/.test(k) || typeof child !== "string")
          )
            findings.push({
              file: k,
              line: 1,
              reason: "Bundled data, binary or model weights",
            });
          walk(child, next);
        }
      } else if (typeof v === "string" || typeof v === "number")
        inspect(String(v), location);
    }
    walk(raw, []);
    return findings;
  };
}
