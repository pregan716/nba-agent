import type { ObjectRef } from "../data/store.js";
import type { LocalSource } from "./roster.js";

export const BOS = "1610612738";
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
