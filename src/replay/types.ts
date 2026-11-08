import type { Row } from "../data/contracts.js";
import type { ObjectRef } from "../data/store.js";
import type { LocalSource } from "./roster.js";

export const BOS = "1610612738";
export const WINDOW_VERSION = "windows-v2";
export const STATE_VERSION = "state-v1";
export const CONTRACT_VERSION = "prediction-v1";
export const REPLAY_VERSIONS = {
  implementation: "replay-mvp-v1",
  windows: WINDOW_VERSION,
  state: STATE_VERSION,
  prediction: CONTRACT_VERSION,
} as const;
export interface Action {
  players_out: string[];
  players_in: string[];
}
export interface Pregame {
  gameId: string;
  scheduledStart: string;
  roster: { playerId: string; availableAt: string }[];
  injuryReport: {
    availableAt: string;
    state: "listed" | "clear" | "unknown";
    players: { playerId: string; status: string }[];
  };
  announcedStarters: { availableAt: string; players: string[] } | null;
  sources: (ObjectRef | LocalSource)[];
}
export const BOX_FIELDS = [
  "points",
  "field_goals_made",
  "field_goals_attempted",
  "three_pointers_made",
  "three_pointers_attempted",
  "free_throws_made",
  "free_throws_attempted",
  "offensive_rebounds",
  "defensive_rebounds",
  "rebounds",
  "assists",
  "steals",
  "blocks",
  "turnovers",
] as const;
export type BoxField = (typeof BOX_FIELDS)[number];
export interface PlayerState {
  playerId: string;
  minutes: number;
  currentStintMinutes: number;
  restMs: number | null;
  personalFouls: number;
  box: Record<BoxField, number | null>;
}
export interface Substitution extends Action {
  windowId: string;
  sequence: number;
  period: number;
  clockMs: number;
  teamId: string;
}
export interface ObservableState {
  version: typeof STATE_VERSION;
  gameId: string;
  sequence: number; // exclusive prefix end; never a future marker's position
  period: number;
  periodType: "regulation" | "overtime";
  clockMs: number;
  homeScore: number;
  awayScore: number;
  margin: number;
  stoppage: {
    kind: string;
    timeoutTeam: string | null;
    freeThrowsPending: boolean | null;
  };
  celtics: string[];
  opponent: string[];
  eligibleBench: string[];
  players: PlayerState[];
  history: {
    substitutions: Substitution[];
    timeouts: { sequence: number; teamId: string | null }[];
  };
  pregame: {
    injuryState: "listed" | "clear" | "unknown";
    injuries: { playerId: string; status: string }[];
    announcedStarters: string[] | null;
  };
  flags: string[]; // informational flags, NOT exclusion reasons
}
export interface ReplayInput {
  game: {
    gameId: string;
    homeTeamId: string;
    awayTeamId: string;
    scheduledStart: string;
  };
  release: ObjectRef;
  events: Row[];
  participants: Row[];
  stints: Row[];
  coverage: Row[];
  issues: Row[];
  pregame: Pregame;
}
export interface Window {
  id: string;
  gameId: string;
  releaseManifestSha256: string;
  datasetVersion: string;
  kind: "in_period" | "between_periods";
  sequence: number;
  span: [number, number];
  state: ObservableState | null;
  actual: Action | null;
  exclusions: string[];
  adjacentSubstitutionBuckets: number;
}
export interface LedgerEntry {
  datasetVersion: string;
  gameId: string;
  releaseManifestSha256: string;
  span: [number, number];
  reason: string;
  mechanism: string;
}
export interface TrainingOnly {
  season: "2024-25";
  rosterPolicy: "same-game-box-score-v1";
}
export interface DecisionDataset {
  /** Retrospective roster approximation: forbidden as an evaluation input. */
  trainingOnly?: TrainingOnly;
  /** Static game metadata; absent in older cached datasets. */
  celticsHome?: boolean;
  version: string;
  windowVersion: typeof WINDOW_VERSION;
  release: ObjectRef;
  gameId: string;
  inputHash: string;
  windows: Window[];
  ledger: LedgerEntry[];
  diagnostics: {
    candidates: number;
    positiveCandidates: number;
    celticsSubstitutionBuckets: number;
    adjacencyBuckets: number;
    unanchoredBuckets: number;
  };
}
export type Question = "substitution" | "count" | "exit" | "entry";
export const COUNT_KEYS = ["none", "one", "two", "three_or_more"] as const;
export interface Prediction {
  substitution: { type: "noul"; noul: number };
  count: { type: "score"; probabilities: Record<string, number> };
  exit: { type: "choice"; probabilities: Record<string, number> };
  entry: { type: "choice"; probabilities: Record<string, number> };
}
export interface Validation {
  valid: boolean;
  reasons: string[];
}
export interface ValidatedPrediction {
  swap?: import("./swap.js").SwapDerived;
  answers: Prediction;
  questions: Record<Question, Validation> & { swap?: Validation };
  action: Action;
  actionValidation: Validation;
}
export type Failure =
  "provider_failure" | "assembler_error" | "invalid_package";
export interface Scores {
  setLogLoss?: number | null;
  setLogLossClips?: number;
  candidateHit?: number | null;
  setTop1?: number | null;
  candidateCount?: number | null;
  otherMass?: number | null;
  exitLogLoss: number | null;
  entryLogLoss: number | null;
  exitMRR: number | null;
  entryMRR: number | null;
  exitLogLossClips: number;
  entryLogLossClips: number;
  timing: number;
  logLoss: number;
  logLossClipped: boolean;
  probability: number;
  outcome: number;
  exit: number | null;
  entry: number | null;
  exitTop1: number | null;
  entryTop1: number | null;
  exitTopK: number | null;
  entryTopK: number | null;
  exact: number;
  overlap: number | null;
}
export interface WindowResult {
  window: Window;
  raw: unknown;
  failure: Failure | null;
  validation: ValidatedPrediction | null;
  scores: Scores | null;
}
