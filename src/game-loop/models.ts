import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../data/store.js";

export interface BuiltModel {
  format: "json" | "binary";
  sha256: string;
  bytes: number;
  base64: string;
}
export type BuiltModels = Record<string, BuiltModel>;
/** Model bytes come exclusively from the host's training build. */
export function mountModels(dir: string, models: BuiltModels) {
  const path = join(dir, "models");
  mkdirSync(path);
  for (const [script, m] of Object.entries(models)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*\.py$/.test(script))
      throw Error("Invalid training script name");
    const bytes = Buffer.from(m.base64, "base64");
    if (bytes.length !== m.bytes || sha256(bytes) !== m.sha256)
      throw Error("Trained model integrity mismatch");
    writeFileSync(join(path, script + "." + m.format), bytes, {
      flag: "wx",
      mode: 0o444,
    });
  }
}
