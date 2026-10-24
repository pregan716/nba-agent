import { Temporal } from "@js-temporal/polyfill";
import type { Game } from "../runner/config.js";
import { SessionError, type Phase } from "./contract.js";
import { releaseTime } from "./visibility.js";

export type LifecyclePhase = "initialize" | Phase | "checkpoint";
/** Runner-only clock authority. Restoring a P4 phase never exposes this object to tools. */
export class Lifecycle {
  phase: LifecyclePhase = "initialize";
  cutoff: string;
  constructor(
    private game: Game,
    restore: Phase,
    cutoff: string,
  ) {
    this.cutoff = game.scheduledStart;
    const expected =
      restore === "postgame" ? game.release : game.scheduledStart;
    if (
      Temporal.Instant.compare(
        game.release,
        releaseTime(game.scheduledStart),
      ) !== 0 ||
      Temporal.Instant.compare(cutoff, expected) !== 0
    )
      throw new SessionError(
        "cutoff_refused",
        "Cutoff does not match the game phase",
      );
    this.advance("pregame", game.scheduledStart);
    if (restore !== "pregame") this.advance("commit", game.scheduledStart);
    if (restore === "postgame") this.advance("postgame", cutoff);
  }
  advance(next: LifecyclePhase, cutoff: string) {
    const following: Record<LifecyclePhase, LifecyclePhase | null> = {
      initialize: "pregame",
      pregame: "commit",
      commit: "postgame",
      postgame: "checkpoint",
      checkpoint: null,
    };
    const expected =
      next === "postgame" || next === "checkpoint"
        ? this.game.release
        : this.game.scheduledStart;
    if (
      this.phase === "checkpoint" ||
      (next !== this.phase && next !== following[this.phase]) ||
      Temporal.Instant.compare(cutoff, expected) !== 0
    )
      throw new SessionError("phase_refused", "Invalid session transition");
    this.phase = next;
    this.cutoff = Temporal.Instant.from(cutoff).toString();
  }
}
