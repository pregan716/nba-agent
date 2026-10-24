import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { annotate } from "../src/evaluation/learning.js";
const [root, file] = process.argv.slice(2);
if (!root || !file || !existsSync(join(root, "record.sqlite")))
  throw Error(
    "Usage: tsx scripts/annotate-learning.ts EXISTING_RUN_DIRECTORY ANNOTATION.json",
  );
annotate(root, JSON.parse(readFileSync(file, "utf8")));
