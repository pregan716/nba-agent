import { Temporal } from "@js-temporal/polyfill";
import { STATIC_AT, type RecordEnvelope } from "../data/contracts.js";
import { VISIBILITY, type CutoffRule } from "./contract.js";

const rules: Record<RecordEnvelope["availabilityConvention"], CutoffRule> = {
  odds_requested_at: VISIBILITY.odds.cutoff,
  game_next_morning_eastern: VISIBILITY.game_history.cutoff,
  injury_printed_report: VISIBILITY.injuries.cutoff,
  injury_dst_later_reading: VISIBILITY.injuries.cutoff,
  opening_reference_static: VISIBILITY.player_reference.cutoff,
  schedule_static: "static",
  post_version_publication: VISIBILITY.posts.cutoff,
  lineup_announcement: VISIBILITY.lineups.cutoff,
  video_publication: VISIBILITY.transcripts.cutoff,
  livestream_end: VISIBILITY.transcripts.cutoff,
  video_eastern_day_end: VISIBILITY.transcripts.cutoff,
};

/** The sole availability gate. Call before joins, filtering, counting or paging.
 * Fail closed for malformed/unknown availability, including late static builds. */
export function visible(record: RecordEnvelope, cutoff: string): boolean {
  try {
    const rule = rules[record.availabilityConvention];
    if (rule === "static")
      return Temporal.Instant.compare(record.availableAt, STATIC_AT) <= 0;
    const comparison = Temporal.Instant.compare(record.availableAt, cutoff);
    return rule === "at_or_before"
      ? comparison <= 0
      : rule === "strictly_before" && comparison < 0;
  } catch {
    return false;
  }
}

export function releaseTime(scheduledStart: string): string {
  return Temporal.Instant.from(scheduledStart)
    .toZonedDateTimeISO("America/New_York")
    .toPlainDate()
    .add({ days: 1 })
    .toZonedDateTime({ timeZone: "America/New_York", plainTime: "09:00" })
    .toInstant()
    .toString();
}
/** Turn a static schedule envelope into the game's release gate. No outcomes added. */
export function releasedGame(game: RecordEnvelope): RecordEnvelope {
  return {
    ...game,
    availableAt: releaseTime(game.data.scheduled_tipoff),
    availabilityConvention: "game_next_morning_eastern",
  };
}
