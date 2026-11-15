import { scanner } from "../src/evaluation/review/scan.js";
import type { ReviewGate } from "../src/evaluation/review/index.js";
export const fixtureReview: ReviewGate = {
  scan: scanner([]),
  reviewer: async () => ({ text: '{"verdict":"accept","reasons":[]}', usd: 0 }),
};
