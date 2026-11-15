// Outcome reads for the Jev probe (SPO-906). The probe may use an outcome only
// if it was released before the holdout, and it must not decode any other
// outcome row on the way. Eligibility is decided from schedule columns alone;
// outcome files are then opened only where they hold an eligible game, and only
// the row ranges of eligible games are decoded.
import { before } from "../data/time.js";
import { releaseTime } from "../env/visibility.js";

/** A game is eligible when its outcome was released before the holdout: 9 a.m.
 * Eastern on the morning after it was played, not the scheduled tip. */
export function eligibleGame(scheduledTipoff: string, holdout: string) {
  return before(releaseTime(scheduledTipoff), holdout);
}

/** One entry per game in a file: [game id, first row, row count]. */
export type GameIndex = Record<string, [string, number, number][]>;

/** The row ranges of the allowed games in one file, adjacent ranges merged. */
export function allowedRanges(
  entries: [string, number, number][],
  allowed: ReadonlySet<string>,
) {
  const ranges: { start: number; end: number }[] = [];
  for (const [id, start, length] of entries) {
    if (!allowed.has(id)) continue;
    const last = ranges.at(-1);
    if (last && last.end === start) last.end += length;
    else ranges.push({ start, end: start + length });
  }
  return ranges;
}

/** Rows of the allowed games from an indexed table. A file with no allowed
 * game is never opened. `read` decodes one row range of one file. */
export async function readAllowedRows<Row extends { game_id: string }>(
  index: GameIndex,
  allowed: ReadonlySet<string>,
  read: (file: string, start: number, end: number) => Promise<Row[]>,
) {
  const rows: Row[] = [];
  for (const [file, entries] of Object.entries(index))
    for (const { start, end } of allowedRanges(entries, allowed))
      for (const row of await read(file, start, end)) {
        if (!allowed.has(row.game_id))
          throw Error("Game index does not match table rows: " + file);
        rows.push(row);
      }
  return rows;
}
