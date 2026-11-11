import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  readFileSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  linkSync,
  rmSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../data/store.js";
import { digest } from "../runner/config.js";
import { BOS } from "./roster-types.js";
import {
  eligibleHistory,
  type Game,
  type ReleasedGame,
  type ModelInput,
} from "./input.js";
import { quantities, type Forecast } from "./forecast.js";

const script = fileURLToPath(
  new URL("../../projection/fit.py", import.meta.url),
);
export interface Fit {
  modelHash: string;
  forecast: Forecast;
}
export function projectionModel(image: string) {
  if (!/^(local|[^@\s]+)@sha256:[a-f0-9]{64}$/.test(image))
    throw Error("Pin the projection runtime by digest");
  return {
    async identity() {
      return {
        version: "reference-projection-v1",
        image,
        source: digest([
          sha256(await readFile(script)),
          ...(await Promise.all(
            [
              "./reference.ts",
              "./pregame.ts",
              "./roster.ts",
              "../data/adapters.ts",
              "../data/release.ts",
              "../env/visibility.ts",
            ].map(async (path) =>
              sha256(await readFile(new URL(path, import.meta.url))),
            ),
          )),
          sha256(await readFile(new URL("./input.ts", import.meta.url))),
          sha256(await readFile(new URL("./forecast.ts", import.meta.url))),
        ]),
      };
    },
    fit(data: ModelInput): Fit {
      const output = execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "-i",
          "--network=none",
          "--read-only",
          "--mount",
          "type=bind,source=" + script + ",target=/fit.py,readonly",
          "--entrypoint",
          "python",
          image.replace(/^local@/, ""),
          "-B",
          "/fit.py",
        ],
        {
          input: JSON.stringify(data),
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
        },
      );
      return JSON.parse(output);
    },
  };
}
export interface ReferenceRecord extends Fit {
  gameId: string;
  cutoff: string;
  inputHash: string;
  harnessHash: string;
  exclusions: NonNullable<ModelInput["exclusions"]>;
}
type Model = ReturnType<typeof projectionModel>;

// An immutable pregame receipt. Concurrent equivalent writers may share it;
// differing fits or changed evidence cannot silently replace a game's forecast.
export async function recordReference(
  root: string,
  model: Model,
  input: ModelInput,
): Promise<ReferenceRecord> {
  if (!/^[\w-]+$/.test(input.gameId)) throw Error("Invalid game ID");
  const harnessHash = digest(await model.identity()),
    inputHash = digest(input);
  const path = resolve(root, harnessHash, input.gameId + ".json");
  const load = () => {
    const { record, checksum } = JSON.parse(readFileSync(path, "utf8")) as {
      record: ReferenceRecord;
      checksum: string;
    };
    if (
      digest(record) !== checksum ||
      record.inputHash !== inputHash ||
      record.harnessHash !== harnessHash ||
      record.gameId !== input.gameId ||
      record.cutoff !== input.tip
    )
      throw Error("Reference receipt mismatch: " + input.gameId);
    return record;
  };
  try {
    return load();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  // Serialize cold fits across launcher processes. SQLite releases the lock on
  // process exit. Keep this section synchronous so callers in one process cannot
  // block their own lock holder while it is awaiting filesystem I/O.
  mkdirSync(dirname(path), { recursive: true });
  const lock = new DatabaseSync(path + ".lock.sqlite");
  try {
    lock.exec("PRAGMA busy_timeout=300000; BEGIN IMMEDIATE");
    try {
      return load();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const fitted = model.fit(input);
    const record = {
      ...fitted,
      exclusions: input.exclusions ?? [],
      gameId: input.gameId,
      cutoff: input.tip,
      inputHash,
      harnessHash,
      modelHash: digest([harnessHash, fitted.modelHash]),
    };
    const tmp = mkdtempSync(join(dirname(path), ".fit-"));
    try {
      const file = join(tmp, "receipt");
      writeFileSync(
        file,
        JSON.stringify({ record, checksum: digest(record) }),
        { flush: true },
      );
      linkSync(file, path);
      return record;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  } finally {
    lock.close();
  }
}

export function releasedErrors(record: ReferenceRecord, game: ReleasedGame) {
  if (record.gameId !== game.gameId)
    throw Error("Reference outcome game mismatch");
  const actuals = new Map(
    game.players.filter((p) => p.teamId === BOS).map((p) => [p.playerId, p]),
  );
  if (!actuals.size) throw Error("Missing Celtics outcomes: " + game.gameId);
  return record.forecast.players.map((p) => {
    const row = actuals.get(p.playerId),
      played = row?.played ?? false;
    const started = row ? row.starter : false;
    const actual = Object.fromEntries(
      quantities.map((q) => [q, row?.[q] ?? 0]),
    );
    return {
      playerId: p.playerId,
      played,
      started,
      actual,
      playError: Number(played) - p.p_play,
      startError: started === null ? null : Number(started) - p.p_start,
      conditionalMedianError: played
        ? Object.fromEntries(quantities.map((q) => [q, actual[q] - p[q][3]]))
        : null,
    };
  });
}

/** V4 pregame entry point. Backfill missing receipts at each game's original cutoff. */
export async function referenceTables(
  source: { schedule: Game[]; input(game: Game): Promise<ModelInput> },
  gameId: string,
  root: string,
  model: Model,
) {
  const target = source.schedule.find(
    (g) => g.gameId === gameId && g.boston && g.season === "2025-26",
  );
  if (!target) throw Error("Unknown Celtics target: " + gameId);
  const input = await source.input(target);
  const released = new Map(input.history.map((g) => [g.gameId, g]));
  const history = [];
  for (const game of eligibleHistory(source.schedule, target).filter(
    (g) => g.boston && g.season === target.season,
  )) {
    const record = await recordReference(root, model, await source.input(game));
    const actual = released.get(game.gameId);
    const exclusion = input.exclusions?.find((e) => e.gameId === game.gameId);
    if (!actual && !exclusion)
      throw Error("Missing released game: " + game.gameId);
    history.push({
      gameId: game.gameId,
      cutoff: record.cutoff,
      modelHash: record.modelHash,
      forecast: record.forecast,
      errors: actual ? releasedErrors(record, actual) : [],
      exclusion: exclusion?.reason ?? null,
    });
  }
  const current = await recordReference(root, model, input);
  return {
    harnessHash: current.harnessHash,
    tonight: {
      gameId,
      cutoff: current.cutoff,
      modelHash: current.modelHash,
      forecast: current.forecast,
    },
    history,
  };
}
