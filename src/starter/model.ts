import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { canonicalJson } from "../env/tools.js";
import { releaseTime } from "../env/visibility.js";
import { loadAllTeamsTraining } from "../replay/load.js";
import type { Corpus } from "../data/corpus.js";
import { BOS } from "../replay/types.js";
const command = promisify(execFile);
const hash = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
export const STARTER_SPEC = {
  version: "starter-hgb-e-v1",
  libraries: {
    numpy: "2.2.6",
    pandas: "2.2.3",
    scipy: "1.15.3",
    sklearn: "1.6.1",
  },
  parameters: {
    learning_rate: 0.05,
    max_iter: 250,
    max_depth: 4,
    min_samples_leaf: 40,
    l2_regularization: 1,
    random_state: 0,
  },
  celticsWeight: 5,
  halfLifeDays: 21,
  shrinkWindows: 20,
  fitThreads: 8,
  apiHash: hash(
    readFileSync(new URL("../../starter/nba_starter.py", import.meta.url)),
  ),
  fitHash: hash(
    readFileSync(new URL("../../starter/train.py", import.meta.url)),
  ),
} as const;
export interface StarterMount {
  path: string;
  hash: string;
  modelSha256: string;
  apiSha256: string;
  cutoff: string;
  gameId: string;
}
export function starterIdentity(m: StarterMount) {
  return {
    hash: m.hash,
    modelSha256: m.modelSha256,
    apiSha256: m.apiSha256,
    cutoff: m.cutoff,
    gameId: m.gameId,
  };
}
export function verifyStarter(m: StarterMount) {
  if (
    hash(readFileSync(join(m.path, "model.json"))) !== m.modelSha256 ||
    hash(readFileSync(join(m.path, "nba_starter.py"))) !== m.apiSha256 ||
    hash(
      canonicalJson({
        model: m.modelSha256,
        api: m.apiSha256,
        spec: STARTER_SPEC,
      }),
    ) !== m.hash
  )
    throw Error("Starter artifact integrity mismatch");
}
export function starterMountArgs(m?: StarterMount) {
  if (!m) return [];
  verifyStarter(m);
  return [
    "--mount",
    `type=bind,source=${resolve(m.path)},target=/starter,readonly`,
    "--mount",
    `type=bind,source=${resolve(m.path, "nba_starter.py")},target=/usr/local/lib/python3.12/site-packages/nba_starter.py,readonly`,
    "--env",
    "STARTER_MODEL=1",
  ];
}
/** Stream the official team-parameterised datasets, never the experimental export.
 * The loader filters release times before reading game shards. */
export async function exportStarterTraining(
  corpus: Corpus,
  cutoff: string,
  path: string,
  signal: AbortSignal,
  seasons?: ("2024-25" | "2025-26")[],
) {
  const stream = createWriteStream(path);
  let games = 0,
    windows = 0,
    totalWindows = 0;
  try {
    const result = await loadAllTeamsTraining(corpus, cutoff, {
      collect: false,
      seasons,
      signal,
      onDataset: async (d, scheduledStart) => {
        signal.throwIfAborted();
        const release = releaseTime(scheduledStart);
        if (Date.parse(release) >= Date.parse(cutoff))
          throw Error("Future starter dataset");
        const row = {
          gameId: d.gameId,
          teamId: d.teamId ?? BOS,
          season: d.trainingOnly!.season,
          scheduledStart,
          release,
          inputHash: d.inputHash,
          windows: d.windows.map((w) => ({
            id: w.id,
            exclusions: w.exclusions,
            actual: w.actual,
            state: w.state && {
              ...w.state,
              players: w.state.players.map(({ box, ...p }) => p),
            },
          })),
        };
        if (!stream.write(JSON.stringify(row) + "\n"))
          await once(stream, "drain");
        games++;
        totalWindows += d.windows.length;
        windows += d.windows.filter(
          (w) => !w.exclusions.length && w.state && w.actual,
        ).length;
      },
    });
    stream.end();
    await once(stream, "finish");
    return { games, windows, totalWindows, skipped: result.skipped };
  } catch (e) {
    stream.destroy();
    throw e;
  }
}
export async function fitStarter(options: {
  input: string;
  root: string;
  image: string;
  target: { gameId: string; scheduledStart: string; teamId?: string };
  cutoff: string;
  signal: AbortSignal;
}) {
  const { signal } = options;
  signal.throwIfAborted();
  const root = resolve(options.root);
  mkdirSync(root, { recursive: true });
  chmodSync(root, 0o755);
  const request = {
    target: { ...options.target, teamId: options.target.teamId ?? BOS },
    cutoff: options.cutoff,
  };
  writeFileSync(join(root, "request.json"), JSON.stringify(request));
  const start = performance.now();
  const name = `nba-starter-fit-${randomUUID()}`;
  let stdout: string;
  try {
    ({ stdout } = await command(
      "docker",
      [
        "run",
        "--name",
        name,
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--cpus",
        "8",
        "--memory",
        "6g",
        "--user",
        `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        "--env",
        "OMP_NUM_THREADS=8",
        "--env",
        "OPENBLAS_NUM_THREADS=1",
        "--env",
        "PYTHONHASHSEED=0",
        "--mount",
        `type=bind,source=${resolve("starter")},target=/code,readonly`,
        "--mount",
        `type=bind,source=${resolve(options.input)},target=/input.jsonl,readonly`,
        "--mount",
        `type=bind,source=${root},target=/output`,
        "--entrypoint",
        "python",
        options.image.replace(/^local@/, ""),
        "/code/train.py",
        "/input.jsonl",
        "/output/request.json",
        "/output/model.json",
      ],
      { signal, maxBuffer: 10 * 1024 * 1024 },
    ));
  } finally {
    await command("docker", ["rm", "-f", name], { timeout: 10000 }).catch(
      () => {},
    );
  }
  const seconds = (performance.now() - start) / 1000;
  const trained = JSON.parse(stdout.trim().split("\n").at(-1)!);
  copyFileSync("starter/nba_starter.py", join(root, "nba_starter.py"));
  const modelSha256 = hash(readFileSync(join(root, "model.json"))),
    apiSha256 = hash(readFileSync(join(root, "nba_starter.py")));
  const mount: StarterMount = {
    path: root,
    hash: hash(
      canonicalJson({ model: modelSha256, api: apiSha256, spec: STARTER_SPEC }),
    ),
    modelSha256,
    apiSha256,
    cutoff: options.cutoff,
    gameId: options.target.gameId,
  };
  for (const file of ["model.json", "nba_starter.py"])
    chmodSync(join(root, file), 0o444);
  writeFileSync(
    join(root, "identity.json"),
    JSON.stringify(starterIdentity(mount)) + "\n",
  );
  return { mount, seconds, rows: trained.rows };
}
export class StarterService {
  private fitted = new Map<
    string,
    Awaited<ReturnType<typeof fitStarter>> & {
      data: Awaited<ReturnType<typeof exportStarterTraining>>;
      dataSeconds: number;
    }
  >();
  constructor(
    readonly root: string,
    readonly image: string,
    private corpus: Corpus,
  ) {}
  async prepare(
    game: { gameId: string; scheduledStart: string },
    signal: AbortSignal,
  ) {
    const existing = this.fitted.get(game.gameId);
    if (existing) return existing;
    const root = join(this.root, "starter", game.gameId);
    mkdirSync(root, { recursive: true });
    const start = performance.now(),
      input = join(root, "training.jsonl");
    const data = await exportStarterTraining(
      this.corpus,
      game.scheduledStart,
      input,
      signal,
    );
    const dataSeconds = (performance.now() - start) / 1000;
    const result = await fitStarter({
      input,
      root: mkdtempSync(join(root, "artifact-")),
      image: this.image,
      target: game,
      cutoff: game.scheduledStart,
      signal,
    }).finally(() => rmSync(input, { force: true }));
    const complete = { ...result, data, dataSeconds };
    this.fitted.set(game.gameId, complete);
    return complete;
  }
}

/** Trusted wrapper keeps the complete set distribution inside Python; only the
 * fixed scored answer/candidates cross the process boundary. */
export function starterPredictor(
  assembler: import("../policy/sandbox.js").Assembler,
  root: string,
): import("../policy/backtest.js").BacktestStarter {
  if (!assembler.starter) throw Error("Starter artifact is not mounted");
  const path = join(root, "starter-predictor", assembler.starter.hash);
  mkdirSync(path, { recursive: true });
  chmodSync(path, 0o755);
  const source =
    "from nba_starter import predict\ndef assemble(state):\n p = predict(state)\n return {'prediction': p['prediction'], 'candidates': p['candidates']}\n";
  const entrypoint = join(path, "assemble.py");
  if (existsSync(entrypoint)) {
    if (readFileSync(entrypoint, "utf8") !== source)
      throw Error("Starter wrapper integrity mismatch");
  } else writeFileSync(entrypoint, source, { mode: 0o444 });
  const answer = (r: import("../policy/sandbox.js").BatchAssemblyResult) => {
    if (r.error) throw Error(r.error);
    return r.value as { prediction: unknown; candidates: unknown };
  };
  return {
    hash: assembler.starter.hash,
    predict: async (state, signal) =>
      answer(await assembler.run(path, state, signal)),
    predictBatch: async (states, signal) => {
      if (assembler.runBatch)
        return (await assembler.runBatch(path, states, signal)).map(answer);
      const results = [];
      for (const state of states)
        results.push(answer(await assembler.run(path, state, signal)));
      return results;
    },
  };
}
