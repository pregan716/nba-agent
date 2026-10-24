import { mkdir, writeFile } from "node:fs/promises";
import { DopplerStore } from "../src/data/store.js";
import { openCorpus } from "../src/data/corpus.js";
import { coverageDiagnostic } from "../src/data/diagnostic.js";
const raw = new DopplerStore();
try {
  const corpus = await openCorpus(raw, process.cwd(), ".cache/objects");
  const report = await coverageDiagnostic(corpus, (message) =>
    console.log(message),
  );
  await mkdir("docs/evidence", { recursive: true });
  const { identities, ...coverage } = report;
  await writeFile(
    "docs/evidence/coverage-2025-26.json",
    JSON.stringify(coverage, null, 2) + "\n",
  );
  await writeFile(
    "config/identities.json",
    "[\n" + identities.map((row) => JSON.stringify(row)).join(",\n") + "\n]\n",
  );
  console.log(JSON.stringify(report.totals, null, 2));
  for (const finding of report.injuryIdentityFindings) {
    console.warn(
      `INJURY IDENTITY JOIN REFUSED: ${finding.reason}; candidates=${finding.candidates?.join(",") || "none"}; observations=${finding.observations}`,
    );
  }
} finally {
  raw.close();
}
