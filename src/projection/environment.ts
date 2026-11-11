import { gameLineVersion } from "./game-lines.js";
import { Temporal } from "@js-temporal/polyfill";
import { sessionEnvironment } from "../env/session.js";
import type { SessionSource } from "../env/source.js";
import { SessionError } from "../env/contract.js";
import { codeBytes, CODE_BYTE_CAP } from "../env/workspace.js";
import { gameMetering } from "../runner/budget.js";
import { snapshot } from "../runner/record.js";
import type { EnvironmentFactory } from "../runner/runner.js";
import { readBlob, writeBlob } from "../runner/blobs.js";
import { digest, type RunConfig } from "../runner/config.js";

import { forecastSession, lockForecast } from "./session.js";

import { referenceTables, type projectionModel } from "./reference.js";
import type { projectionSource } from "./input.js";
import { forecastTool } from "./tools.js";

export function forecastEnvironment(
  config: RunConfig,
  data: SessionSource,
  source: Awaited<ReturnType<typeof projectionSource>>,
  model: ReturnType<typeof projectionModel>,
  lines: (
    id: string,
    tip: string,
  ) => { celtics_spread: number | null; game_total: number | null },
  referenceRoot: string,
): EnvironmentFactory {
  const research = sessionEnvironment(config, {
    ...data,
    versions: [...data.versions, gameLineVersion],
  });
  return async (context, trusted) => {
    const { record, root, workspace } = trusted,
      { game } = context;
    let phase = context.phase;

    const find = (id: string) =>
      record.events("forecast_freeze", id)[0] ??
      record.events("forecast_missing", id)[0];
    const service = await forecastSession({
      gameId: game.gameId,
      source,
      model,
      referenceRoot,
      clock: () => ({
        phase: phase === "pregame" ? "pregame" : "postgame",
        now:
          phase === "pregame"
            ? Temporal.Instant.from(game.scheduledStart)
                .subtract({ nanoseconds: 1 })
                .toString()
            : context.cutoff,
      }),
      // The runner exclusively owns this arm/replicate. The immutable event commits
      // forecast, validation and workspace together and travels in every checkpoint.
      record: {
        freeze(pre, hash, draft, clock) {
          return lockForecast(pre, draft, clock, (forecast) => {
            if (find(pre.gameId)) return false;
            record.append("forecast_freeze", pre.gameId, {
              context: hash,
              forecast,
              validation: { ok: true },
              workspace: snapshot(root, workspace),
            });
            return true;
          });
        },
        finalized(pre, hash) {
          const row = find(pre.gameId);
          if (row && row.data.context !== hash)
            throw Error("Forecast evidence changed");
          if (!row)
            record.append("forecast_missing", pre.gameId, {
              context: hash,
              status: "no_forecast",
            });
          return row?.data.forecast ?? null;
        },
      },
      metering: (id) => gameMetering(record, id),
    });
    const saved = record.events("reference_forecast", game.gameId)[0];
    if (!saved)
      record.append("reference_forecast", game.gameId, service.reference);
    else if (digest(saved.data) !== digest(service.reference))
      throw Error("Recorded reference forecast changed");
    async function releasedFeedback() {
      const target = service.feedbackGame();
      const saved = record.events("forecast_feedback", target.gameId)[0];
      if (saved) return JSON.parse(readBlob(root, saved.data.blob).toString());
      const feedback = await service.read_feedback();
      const blob = writeBlob(root, Buffer.from(JSON.stringify(feedback)));
      record.append("forecast_feedback", target.gameId, {
        status: feedback.status,
        blob,
      });
      return feedback;
    }
    if (phase === "postgame") await releasedFeedback();
    const { history } = await referenceTables(
      source,
      game.gameId,
      referenceRoot,
      model,
    );
    const base = await research(context, trusted);

    return {
      ...base,
      context: async (budget) => ({
        ...(await base.context(budget)),
        game_lines: lines(game.gameId, game.scheduledStart),
        ...(config.profile.memory.horizon === "season"
          ? { codeUsage: { bytes: codeBytes(workspace), cap: CODE_BYTE_CAP } }
          : {}),
      }),
      transition: async (next, cutoff) => {
        await base.transition(next, cutoff);
        if (next === "pregame" || next === "commit" || next === "postgame")
          phase = next;
      },
      async call(name, args, signal) {
        forecastTool(name, phase, config.profile.memory.horizon === "season");
        const input = args as Record<string, unknown>;
        if (!input || typeof input !== "object" || Array.isArray(input))
          throw new SessionError(
            "invalid_input",
            "Expected a tool input object",
          );
        switch (name) {
          case "validate_forecast":
          case "freeze_forecast":
            if (
              Object.keys(input).length !== 1 ||
              !Object.hasOwn(input, "draft")
            )
              throw new SessionError("invalid_input", "Expected draft");
            return service[name](input.draft);
          case "read_feedback":
            if (Object.keys(input).length)
              throw new SessionError(
                "invalid_input",
                "Feedback takes no arguments",
              );
            if (phase === "pregame" && game.index === 0)
              return {
                status: "unavailable",
                reason: "First game of the season",
              };
            return releasedFeedback();
          case "reference_projection": {
            if (
              Object.keys(input).some(
                (k) => !["game_id", "list"].includes(k),
              ) ||
              (input.list !== undefined && typeof input.list !== "boolean") ||
              (input.game_id !== undefined && typeof input.game_id !== "string")
            )
              throw new SessionError(
                "invalid_input",
                "Invalid reference query",
              );
            if (
              !input.list &&
              (!input.game_id || input.game_id === game.gameId)
            )
              return service.reference;
            if (input.list)
              return {
                tonight: game.gameId,
                history: history.map((g) => g.gameId),
              };
            const prior = history.find((g) => g.gameId === input.game_id);
            if (!prior)
              throw new SessionError(
                "not_found",
                "Reference forecast unavailable",
              );
            return prior;
          }
          default:
            return base.call(name, args, signal);
        }
      },
    };
  };
}
