import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { sha256 } from "../../data/store.js";
import { DockerSandbox } from "../../env/sandbox.js";
import type { RunConfig } from "../../runner/config.js";
import type { Package } from "../../game-loop/package.js";
import type { BuiltModels } from "../../game-loop/models.js";
import { writeSessionExport } from "../../env/export.js";
import { viewBatches } from "../../data/architect-view.js";

export type TrainingData = Parameters<typeof viewBatches>[0];
export async function buildModels(
  config: RunConfig,
  pkg: Package,
  data: TrainingData,
  root: string,
) {
  const models: BuiltModels = {};
  if (!pkg.training.length) return models;
  const box = new DockerSandbox(
    config,
    (dir, signal) =>
      writeSessionExport(dir, viewBatches(data, "training", signal), signal),
    undefined,
    root,
    (dir) => {
      const path = join(dir, "package");
      mkdirSync(path);
      for (const [file, code] of Object.entries(pkg.files))
        writeFileSync(join(path, file), code, { flag: "wx", mode: 0o444 });
    },
  );
  try {
    const limits = {
      ...config.budget.sandbox,
      wallSeconds: config.budget.pregame.wallSeconds,
      computeSeconds: config.budget.pregame.computeSeconds,
    };
    for (const file of pkg.training) {
      const signal = AbortSignal.timeout(limits.wallSeconds * 1000);
      async function execute(program: string) {
        const result = await box.execute(program, limits, signal, "json");
        if (result.exitStatus !== 0 || result.limit || result.truncated)
          throw Error(
            "Training script failed or exceeded its limits: " +
              file +
              " " +
              result.stderr,
          );
        return result.stdout.trim();
      }
      const program = [
        "import hashlib,json,runpy,sys,pathlib",
        "sys.path.insert(0,'/data/package')",
        "train=runpy.run_path(" +
          JSON.stringify("/data/package/" + file) +
          ")['train']",
        "value=train('/data/session.sqlite')",
        "binary=isinstance(value,bytes)",
        "payload=value if binary else json.dumps(value,allow_nan=False).encode()",
        "pathlib.Path('/scratch/model').write_bytes(payload)",
        "print(json.dumps(dict(bytes=len(payload),sha256=hashlib.sha256(payload).hexdigest(),format='binary' if binary else 'json')))",
      ].join("\n");
      const meta = z
        .strictObject({
          bytes: z.number().int().min(0).max(limits.memoryBytes),
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
          format: z.enum(["json", "binary"]),
        })
        .parse(JSON.parse(await execute(program)));
      const chunkSize = Math.floor((limits.stdoutBytes - 1) / 4) * 3;
      if (chunkSize < 1) throw Error("Training output buffer too small");
      const chunks: Buffer[] = [];
      for (let offset = 0; offset < meta.bytes; offset += chunkSize) {
        const size = Math.min(chunkSize, meta.bytes - offset);
        const encoded = await execute(
          "import base64\nwith open('/scratch/model','rb') as f:\n f.seek(" +
            offset +
            ")\n print(base64.b64encode(f.read(" +
            size +
            ")).decode())",
        );
        const chunk = Buffer.from(encoded, "base64");
        if (chunk.length !== size) throw Error("Incomplete model export");
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      if (sha256(bytes) !== meta.sha256)
        throw Error("Trained model integrity mismatch");
      models[file] = { ...meta, base64: bytes.toString("base64") };
    }
    return models;
  } finally {
    await box.close();
  }
}
