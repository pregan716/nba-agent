import { sha256 } from "../data/store.js";
import type { Row } from "../data/contracts.js";
import type { OddsAdapter } from "../data/adapters.js";
import type { Identities } from "../data/identity.js";
import { instant } from "../data/time.js";

export const GAME_LINE_METHOD = {
  version: "game-lines-v1",
  pairing:
    "Same book, market, team/handicap, snapshot_at and last_update; reject conflicting or incomplete prices; no DFS or indicative prices.",
  selection:
    "One main line per book nearest proportional p=0.5; ties lower overround then line. Offered main line nearest median; ties main votes, complete pairs, lower line. Median probability at selected line.",
  total:
    "Sum each book's selected Celtics and opponent team-total lines, then select an offered sum nearest their median; ties vote count then lower sum. No game-total probability is inferred.",
  implied:
    "Celtics=(total-spread)/2; opponent=(total+spread)/2. Counts use intersection of contributing books. Minimum one book for every value.",
};
export const gameLineMethodHash = sha256(
  Buffer.from(JSON.stringify(GAME_LINE_METHOD)),
);
export const gameLineVersion = {
  source: "gameLines",
  release: GAME_LINE_METHOD.version,
  manifest_sha256: gameLineMethodHash,
};
// Team-line calculation carried from SPO-829 (game-lines-v1).
type Pair = { book: string; line: number; p: number; overround: number };
const median = (a: number[]) => {
  const b = [...a].sort((x, y) => x - y);
  return (b[Math.floor((b.length - 1) / 2)] + b[Math.floor(b.length / 2)]) / 2;
};
const implied = (price: number) =>
  price > 0 ? 100 / (price + 100) : -price / (-price + 100);
const main = (pairs: Pair[]) =>
  [...Map.groupBy(pairs, (p) => p.book).values()].map(
    (p) =>
      [...p].sort(
        (a, b) =>
          Math.abs(a.p - 0.5) - Math.abs(b.p - 0.5) ||
          a.overround - b.overround ||
          a.line - b.line,
      )[0],
  );
function select(pairs: Pair[]) {
  const votes = main(pairs);
  if (!votes.length) return null;
  const middle = median(votes.map((p) => p.line));
  const lines = [...new Set(votes.map((p) => p.line))];
  lines.sort(
    (a, b) =>
      Math.abs(a - middle) - Math.abs(b - middle) ||
      votes.filter((p) => p.line === b).length -
        votes.filter((p) => p.line === a).length ||
      pairs.filter((p) => p.line === b).length -
        pairs.filter((p) => p.line === a).length ||
      a - b,
  );
  return lines[0];
}
function pairs(rows: Row[], market: string, team: string): Pair[] {
  const eligible = rows.filter(
    (r) =>
      r.market === market &&
      !["prizepicks", "underdog"].includes(r.bookmaker) &&
      r.price_is_indicative === false &&
      r.odds_format === "american" &&
      Number.isFinite(r.line) &&
      Number.isFinite(r.price) &&
      r.price !== 0,
  );
  const groups = Map.groupBy(eligible, (r) =>
    JSON.stringify([
      r.bookmaker,
      market === "spreads" ? (r.selection === team ? r.line : -r.line) : r.line,
      market === "spreads" ? null : r.description,
    ]),
  );
  const result: Pair[] = [];
  for (const group of groups.values()) {
    if (market !== "spreads" && group[0].description !== team) continue;
    const side = (r: Row) =>
      market === "spreads"
        ? r.selection === team
          ? 0
          : 1
        : r.selection === "Over"
          ? 0
          : r.selection === "Under"
            ? 1
            : -1;
    const a = group.filter((r) => side(r) === 0),
      b = group.filter((r) => side(r) === 1);
    const signature = (r: Row) =>
      JSON.stringify([r.price, r.snapshot_at, r.last_update, r.selection]);
    if (
      !a.length ||
      !b.length ||
      new Set(a.map(signature)).size !== 1 ||
      new Set(b.map(signature)).size !== 1
    )
      continue;
    if (
      a[0].snapshot_at !== b[0].snapshot_at ||
      a[0].last_update !== b[0].last_update
    )
      continue;
    const x = implied(a[0].price),
      y = implied(b[0].price);
    result.push({
      book: a[0].bookmaker,
      line: a[0].line,
      p: x / (x + y),
      overround: x + y - 1,
    });
  }
  return result;
}
export function buildGameLines(quotes: Row[]) {
  const groups = Map.groupBy(quotes, (r) =>
    JSON.stringify([r.espn_event_id, instant(r.requested_at)]),
  );
  return [...groups.values()]
    .map((rows) => {
      const celtics = "Boston Celtics";
      const opponents = [
        ...new Set(
          rows
            .filter((r) => ["spreads", "team_totals"].includes(r.market))
            .map((r) => (r.market === "spreads" ? r.selection : r.description))
            .filter((team) => typeof team === "string" && team !== celtics),
        ),
      ];
      const opponent = opponents.length === 1 ? opponents[0] : null;
      const spread = opponent ? select(pairs(rows, "spreads", celtics)) : null;
      const bos = main(pairs(rows, "team_totals", celtics));
      const away = opponent ? main(pairs(rows, "team_totals", opponent)) : [];
      const totals = bos.flatMap((b) => {
        const a = away.find((a) => a.book === b.book);
        return a
          ? [{ book: b.book, line: b.line + a.line, p: 0.5, overround: 0 }]
          : [];
      });
      return {
        espn_event_id: String(rows[0].espn_event_id),
        available_at: instant(rows[0].requested_at),
        celtics_spread: spread,
        game_total: select(totals),
      };
    })
    .sort(
      (a, b) =>
        a.espn_event_id.localeCompare(b.espn_event_id) ||
        a.available_at.localeCompare(b.available_at),
    );
}

export async function openingGameLines(
  odds: OddsAdapter,
  identities: Identities,
) {
  const source = await odds.release.sourceRelease();
  const quotes = [...source.objects.values()].filter((r) =>
    r.key.endsWith("/quotes.ndjson.gz"),
  );
  if (quotes.length !== 1) throw Error("Expected one pinned quotes object");
  const rows = buildGameLines(
    (await source.rows(quotes[0].key)).filter(
      (r) =>
        r.snapshot_kind === "scheduled_start" &&
        ["spreads", "team_totals"].includes(r.market),
    ),
  );
  const values = new Map(
    rows.map((r) => [
      identities.resolve("game", "espn", r.espn_event_id) +
        "/" +
        instant(r.available_at),
      { celtics_spread: r.celtics_spread, game_total: r.game_total },
    ]),
  );
  return (id: string, tip: string) =>
    values.get(id + "/" + instant(tip)) ?? {
      celtics_spread: null,
      game_total: null,
    };
}
