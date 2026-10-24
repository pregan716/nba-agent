import { createHash } from "node:crypto";
import type { Row } from "../data/contracts.js";

export const auditKey = (r: Row) =>
  [r.espn_event_id, r.requested_at, r.espn_player_id, r.prop_type].join(":");
// Fixed seed + hash ranking: deterministic sampling without replacement, independent
// of input ordering. Each population must have unique stable keys.
export function sample<T>(
  rows: T[],
  count: number,
  seed: string,
  key: (r: T) => string,
): T[] {
  if (new Set(rows.map(key)).size !== rows.length)
    throw Error("Duplicate sample keys");
  if (rows.length < count) throw Error("Insufficient sample population");
  const hash = (r: T) =>
    createHash("sha256")
      .update(`${seed}\n${key(r)}`)
      .digest("hex");
  return [...rows]
    .sort(
      (a, b) => hash(a).localeCompare(hash(b)) || key(a).localeCompare(key(b)),
    )
    .slice(0, count);
}
export function median(values: number[]): number {
  if (!values.length || values.some((v) => !Number.isFinite(v)))
    throw Error("Invalid median input");
  const sorted = [...values].sort((a, b) => a - b),
    n = sorted.length;
  return (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2;
}
export function implied(price: number): number {
  if (!Number.isFinite(price) || price === 0)
    throw Error("Invalid American price");
  return price > 0 ? 100 / (price + 100) : -price / (-price + 100);
}
const close = (a: number, b: number) =>
  Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-12;
// Independent audit only. Never feeds replay questions or replaces published rows.
export function checkConsensus(row: Row, pairs: Row[]) {
  if (!pairs.length) throw Error(`Missing accepted pairs: ${auditKey(row)}`);
  const computed: Row[] = pairs.map((p) => {
    const over = implied(p.over_price),
      under = implied(p.under_price);
    return {
      ...p,
      calculatedP: over / (over + under),
      calculatedOverround: over + under - 1,
    };
  });
  const books = Map.groupBy(computed, (p) => p.bookmaker);
  const mains = [...books.values()].map(
    (group) =>
      [...group].sort(
        (a, b) =>
          Math.abs(a.calculatedP - 0.5) - Math.abs(b.calculatedP - 0.5) ||
          a.calculatedOverround - b.calculatedOverround ||
          a.line - b.line,
      )[0],
  );
  const mainMedian = median(mains.map((p) => p.line));
  const votes = (line: number) => mains.filter((p) => p.line === line).length;
  const contributors = (line: number) =>
    computed.filter((p) => p.line === line);
  const line = [...new Set(mains.map((p) => p.line))].sort(
    (a, b) =>
      Math.abs(a - mainMedian) - Math.abs(b - mainMedian) ||
      votes(b) - votes(a) ||
      contributors(b).length - contributors(a).length ||
      a - b,
  )[0];
  const selected = contributors(line),
    pOver = median(selected.map((p) => p.calculatedP));
  const problems: string[] = [];
  if (
    new Set(pairs.map((p) => `${p.bookmaker}:${p.line}`)).size !== pairs.length
  )
    problems.push("duplicate book/line");
  if (
    computed.some(
      (p) =>
        !close(p.p_over, p.calculatedP) || !close(p.p_under, 1 - p.calculatedP),
    )
  )
    problems.push("pair normalization");
  if (computed.some((p) => p.is_book_main_line !== mains.includes(p)))
    problems.push("main-line flags");
  if (computed.some((p) => p.contributes_to_consensus !== (p.line === line)))
    problems.push("contribution flags");
  if (row.selected_line !== line) problems.push("selected line");
  if (!close(row.p_over, pOver) || !close(row.p_under, 1 - pOver))
    problems.push("median probability");
  if (
    JSON.stringify([...row.contributing_books].sort()) !==
    JSON.stringify(selected.map((p) => p.bookmaker).sort())
  )
    problems.push("contributing books");
  if (row.contributing_book_count !== selected.length)
    problems.push("contributor count");
  return {
    key: auditKey(row),
    line,
    publishedLine: row.selected_line,
    pOver,
    publishedPOver: row.p_over,
    mainMedian,
    problems,
    pairs: computed.map((p) => ({
      book: p.bookmaker,
      line: p.line,
      overPrice: p.over_price,
      underPrice: p.under_price,
      calculatedP: p.calculatedP,
      publishedP: p.p_over,
      main: mains.includes(p),
      contributes: p.line === line,
    })),
  };
}
export function outcome(
  actual: number | null,
  line: number,
  seconds: number | null,
) {
  if (seconds === 0) return "did_not_play";
  if (
    seconds === null ||
    !Number.isFinite(seconds) ||
    seconds < 0 ||
    actual === null ||
    !Number.isFinite(actual)
  )
    return "unresolved";
  return actual === line ? "push" : actual > line ? "over" : "under";
}
export const nearCutoff = (at: string, cutoff: string) =>
  Math.abs(Date.parse(at) - Date.parse(cutoff)) <= 30 * 60 * 1000;
