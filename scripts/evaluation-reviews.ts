import { resolve } from "node:path";
import { humanReviews } from "../src/evaluation/review/index.js";
const [directory, id, ...extra] = process.argv.slice(2);
if (!directory || extra.length)
  throw Error(
    "Usage: npm run evaluation:reviews -- POOL_DIRECTORY [REVIEW_ID]",
  );
console.log(JSON.stringify(humanReviews(resolve(directory), id), null, 2));
