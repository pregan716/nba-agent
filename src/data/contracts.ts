import type { ObjectRef } from "./store.js";
export type Row = Record<string, any>;
export type Convention =
  | "odds_requested_at"
  | "game_next_morning_eastern"
  | "injury_printed_report"
  | "injury_dst_later_reading"
  | "opening_reference_static"
  | "schedule_static"
  | "post_version_publication"
  | "lineup_announcement"
  | "video_publication"
  | "livestream_end"
  | "video_eastern_day_end";
export interface RecordEnvelope<T = Row> {
  id: string;
  source: string;
  availableAt: string;
  availabilityConvention: Convention;
  eventTime: string | null;
  collectedAt: string | null;
  revisionTime: string | null;
  provenance: { object: ObjectRef; manifestSha256: string };
  data: T;
}
export interface Exclusion {
  source: string;
  id: string;
  reason: string;
}
export interface DatasetVersion {
  name: string;
  manifest: ObjectRef;
  methodologySha256?: string;
}
export interface PinSet {
  schemaVersion: 1;
  sources: Record<string, ObjectRef>;
  transcriptIndex: { path: string; sha256: string; repositoryCommit: string };
  transcriptManifests: Record<string, ObjectRef>;
}
export const STATIC_AT = "2025-10-21T23:29:59Z";
