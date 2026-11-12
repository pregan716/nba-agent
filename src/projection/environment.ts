import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gameLineVersion } from "./game-lines.js";
import { Temporal } from "@js-temporal/polyfill";
import { sessionEnvironment } from "../env/session.js";
import type { SessionSource } from "../env/source.js";
import { SessionError } from "../env/contract.js";
import { codeBytes, CODE_BYTE_CAP } from "../env/workspace.js";
import { gameMetering } from "../runner/budget.js";
import { snapshot, type RecordEntry } from "../runner/record.js";
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
  const researchData = {
    ...data,
    versions: [...data.versions, gameLineVersion],
  };
  return async (context, trusted) => {
    const { record, root, workspace } = trusted,
      { game } = context;
    let phase = context.phase;

    let missing: RecordEntry | undefined;
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
            missing = {
              kind: "forecast_missing",
              scope: pre.gameId,
              data: {
                context: hash,
                status: "no_forecast",
              },
            };
          return row?.data.forecast ?? null;
        },
      },
      metering: (id) => gameMetering(record, id, "pregame"),
    });
    const saved = record.events("reference_forecast", game.gameId)[0];
    if (!saved)
      record.append("reference_forecast", game.gameId, service.reference);
    else if (digest(saved.data) !== digest(service.reference))
      throw Error("Recorded reference forecast changed");
    let pending:
      | {
          gameId: string;
          feedback: Awaited<ReturnType<typeof service.read_feedback>>;
        }
      | undefined;
    async function releasedFeedback() {
      if (phase === "pregame" && game.index === 0)
        return { status: "unavailable", reason: "First game of the season" };
      const target = service.feedbackGame();
      if (!target) return undefined;
      const saved = record.events("forecast_feedback", target.gameId)[0];
      if (saved) return JSON.parse(readBlob(root, saved.data.blob).toString());
      const feedback = await service.read_feedback();
      pending = { gameId: target.gameId, feedback };
      return feedback;
    }
    const feedback = await releasedFeedback();
    const { history } = await referenceTables(
      source,
      game.gameId,
      referenceRoot,
      model,
    );
    const research = sessionEnvironment(config, researchData, {
      prepareSandboxData(directory) {
        const referenceDir = join(directory, "reference");
        const historyDir = join(referenceDir, "history");
        mkdirSync(historyDir, { recursive: true });
        const writeJson = (file: string, payload: unknown) =>
          writeFileSync(file, JSON.stringify(payload), {
            mode: 0o444,
            flag: "wx",
          });
        writeJson(join(referenceDir, "tonight.json"), service.reference);
        for (const prior of history) {
          if (!/^[a-zA-Z0-9_-]+$/.test(prior.gameId))
            throw Error("Invalid reference game ID");
          writeJson(join(historyDir, prior.gameId + ".json"), prior);
        }
        if (feedback !== undefined)
          writeJson(join(directory, "feedback.json"), feedback);
      },
    });
    const base = await research(context, trusted);

    return {
      ...base,
      releaseEntries() {
        const entries = missing ? [missing] : [];
        if (pending)
          entries.push({
            kind: "forecast_feedback",
            scope: pending.gameId,
            data: {
              status: pending.feedback.status,
              blob: writeBlob(
                root,
                Buffer.from(JSON.stringify(pending.feedback)),
              ),
            },
          });
        return entries;
      },
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
            if (feedback === undefined) throw Error("Feedback unavailable");
            return structuredClone(feedback);
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
