import { DatabaseSync } from "node:sqlite";
import { Temporal } from "@js-temporal/polyfill";
import { before } from "../data/time.js";
import { releaseTime } from "../env/visibility.js";
import { digest } from "../runner/config.js";
import type { Forecast } from "./forecast.js";
import type { Game, projectionSource } from "./input.js";
import { projectionModel, recordReference } from "./reference.js";
import { scoreGame, type Metering } from "./scoring.js";
import { validateForecast, type Pregame } from "./validation.js";

type Source = Awaited<ReturnType<typeof projectionSource>>;
export interface ForecastClock {
  phase: "pregame" | "postgame";
  now: string;
}

// Called while the store holds exclusive write access. Both storage backends
// use the same validation and trusted-clock check immediately before insertion.
export function lockForecast(
  pre: Pregame,
  draft: unknown,
  clock: () => ForecastClock,
  insert: (forecast: Forecast) => boolean,
) {
  const result = validateForecast(draft, pre);
  if (!result.ok) return result;
  const at = clock();
  if (at.phase !== "pregame" || !before(at.now, pre.tip))
    return { ok: false, reason: "Forecast cutoff has passed" } as const;
  return insert(result.forecast)
    ? ({ ok: true } as const)
    : ({ ok: false, reason: "Forecast already locked" } as const);
}

// One database per experiment arm/replicate. The host owns the handle and clock.
export class ForecastRecord {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS forecasts(game TEXT, tip TEXT, context TEXT NOT NULL, draft TEXT, PRIMARY KEY(game,tip))",
    );
  }
  close() {
    this.db.close();
  }
  freeze(
    pre: Pregame,
    context: string,
    draft: unknown,
    clock: () => ForecastClock,
  ) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = lockForecast(pre, draft, clock, (forecast) =>
        Boolean(
          this.db
            .prepare("INSERT OR IGNORE INTO forecasts VALUES(?,?,?,?)")
            .run(pre.gameId, pre.tip, context, JSON.stringify(forecast))
            .changes,
        ),
      );
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  // Once released, an absent submission becomes a durable no_forecast.
  finalized(pre: Pregame, context: string): Forecast | null {
    this.db
      .prepare("INSERT OR IGNORE INTO forecasts VALUES(?,?,?,NULL)")
      .run(pre.gameId, pre.tip, context);
    const row = this.db
      .prepare("SELECT context,draft FROM forecasts WHERE game=? AND tip=?")
      .get(pre.gameId, pre.tip)!;
    if (row.context !== context) throw Error("Forecast evidence changed");
    return row.draft === null ? null : JSON.parse(String(row.draft));
  }
}

// Bind to one scheduled session. No tool accepts a caller-selected timestamp or feedback game.
export async function forecastSession(options: {
  gameId: string;
  source: Source;
  record: Pick<ForecastRecord, "freeze" | "finalized">;
  referenceRoot: string;
  model: ReturnType<typeof projectionModel>;
  clock: () => ForecastClock;
  metering: (gameId: string) => Metering;
}) {
  const { source, record, model, clock } = options;
  const season = source.schedule
    .filter((g) => g.boston && g.season === "2025-26")
    .sort((a, b) => a.tip.localeCompare(b.tip));
  const index = season.findIndex((g) => g.gameId === options.gameId);
  if (index < 0) throw Error("Unknown Celtics game");
  const current = season[index];
  async function prepare(game: Game) {
    const input = await source.input(game);
    const receipt = await recordReference(options.referenceRoot, model, input);
    const pre = { gameId: input.gameId, tip: input.tip, roster: input.roster };
    return {
      pre,
      reference: receipt.forecast,
      context: digest(receipt),
      exclusions: receipt.exclusions,
      modelHash: receipt.modelHash,
    };
  }
  function feedbackGame() {
    const { phase, now } = clock();
    const game = phase === "postgame" ? current : season[index - 1];
    if (!game || before(now, releaseTime(game.tip)))
      throw Error("Feedback unavailable");
    return game;
  }
  const currentData = await prepare(current);
  return {
    feedbackGame,
    reference: {
      forecast: currentData.reference,
      modelHash: currentData.modelHash,
    },
    validate_forecast: (draft: unknown) =>
      validateForecast(draft, currentData.pre),
    freeze_forecast: (draft: unknown) =>
      record.freeze(currentData.pre, currentData.context, draft, clock),
    async read_feedback() {
      const game = feedbackGame();
      const exclusion = currentData.exclusions.find(
        (e) => e.gameId === game.gameId,
      );
      if (exclusion)
        return {
          gameId: game.gameId,
          status: "excluded" as const,
          reason: exclusion.reason,
        };
      const { pre, reference, context } =
        game === current ? currentData : await prepare(game);
      // The V1 data reader takes an exclusive bound. Only canonical release-time
      // envelopes for this game are eligible, including at the exact release instant.
      const release = releaseTime(game.tip);
      if (Temporal.Instant.compare(game.release, release) !== 0)
        throw Error("Unexpected game release");
      const box = await source.outcomes(
        game,
        Temporal.Instant.from(release).add({ milliseconds: 1 }).toString(),
      );
      return scoreGame(
        pre,
        record.finalized(pre, context),
        reference,
        box,
        options.metering(game.gameId),
      );
    },
  };
}
