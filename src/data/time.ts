import { Temporal } from "@js-temporal/polyfill";
const EASTERN = "America/New_York";
export function instant(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("Missing availability timestamp");
  return Temporal.Instant.from(value).toString();
}
export function easternTime(day: string, hour: number): string {
  return Temporal.PlainDate.from(day)
    .toPlainDateTime({ hour })
    .toZonedDateTime(EASTERN)
    .toInstant()
    .toString();
}
export function nextMorning(day: string): string {
  return easternTime(
    Temporal.PlainDate.from(day).add({ days: 1 }).toString(),
    9,
  );
}
export function easternDayEnd(day: string): string {
  return Temporal.PlainDate.from(day)
    .add({ days: 1 })
    .toPlainDateTime()
    .toZonedDateTime(EASTERN)
    .toInstant()
    .subtract({ nanoseconds: 1 })
    .toString();
}
export function laterEasternReading(value: string): string {
  // Source's ambiguous printed timestamp has no offset; choose the later fold.
  return Temporal.PlainDateTime.from(value)
    .toZonedDateTime(EASTERN, { disambiguation: "later" })
    .toInstant()
    .toString();
}
export function before(time: string, cutoff: string): boolean {
  return Temporal.Instant.compare(time, cutoff) < 0;
}
