// Attach evaluator inputs to an already completed local run, including pre-V5 records.
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { OddsAdapter } from "../src/data/adapters.js";
import { Identities } from "../src/data/identity.js";
import type { PinSet } from "../src/data/contracts.js";
import { Release } from "../src/data/release.js";
import { VerifiedStore, DopplerStore } from "../src/data/store.js";
import { RecordStore } from "../src/runner/record.js";
import { checkpoint } from "../src/runner/sync.js";
import { recordConsensus } from "../src/evaluation/forecast/capture.js";

if (process.argv.length !== 3)
  throw Error("Usage: npm run forecast:capture -- RUN_DIRECTORY");
const root = resolve(process.argv[2]),
  lock = join(root, "runner.lock");
writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
try {
  const record = new RecordStore(root);
  const store = new DopplerStore();
  try {
    const pins: PinSet = JSON.parse(
      readFileSync("config/datasets.json", "utf8"),
    );
    const odds = new OddsAdapter(
      await Release.open(
        pins.sources.odds,
        new VerifiedStore(store, ".cache/objects"),
      ),
    );
    const ids = new Identities();
    for (const row of JSON.parse(
      readFileSync("config/identities.json", "utf8"),
    ))
      ids.add(row);
    await recordConsensus(record, odds, ids);
    await checkpoint(record);
  } finally {
    record.db.close();
    store.close();
  }
} finally {
  unlinkSync(lock);
}
