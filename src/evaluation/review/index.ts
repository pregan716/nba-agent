import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { canonicalJson } from "../../env/tools.js";
import { readPackage, type Package } from "../../game-loop/package.js";
import { type Reviewer, verdict } from "./reviewer.js";
import type { Finding } from "./scan.js";

export interface ReviewGate {
  scan(raw: unknown): Finding[] | Promise<Finding[]>;
  reviewer: Reviewer;
}
const approvals = new WeakMap<Package, string>();
export function approvedPackage(raw: Package) {
  const result = readPackage(raw);
  if (approvals.get(raw) !== result.hash)
    throw Error("A leakage review must accept this configuration first");
  approvals.set(result.pkg, result.hash);
  return result;
}
export async function review(root: string, gate: ReviewGate, input: unknown) {
  const raw = structuredClone(input);
  const json = canonicalJson(raw) ?? "null";
  const hash = createHash("sha256").update(json).digest("hex");
  const id = randomUUID();
  const db = new DatabaseSync(join(root, "reviews.sqlite"));
  try {
    db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY, created TEXT DEFAULT CURRENT_TIMESTAMP,
      hash TEXT NOT NULL, configuration TEXT NOT NULL, findings TEXT NOT NULL, verdict TEXT NOT NULL, reasons TEXT NOT NULL, reviewerUsd REAL, reviewerVerdict TEXT)`);
    let findings: Finding[] = [];
    db.prepare(
      "INSERT INTO reviews(id,hash,configuration,findings,verdict,reasons) VALUES(?,?,?,?,'pending','[]')",
    ).run(id, hash, json, JSON.stringify(findings));
    let reasons: Finding[] = [],
      reviewerUsd: number | null = 0,
      reviewerVerdict: string | null = null;
    let pkg: Package | undefined;
    try {
      findings = await gate.scan(raw);
      reasons = findings;
      if (!reasons.length) {
        pkg = readPackage(raw).pkg;
        reviewerUsd = null;
        const response = await gate.reviewer(structuredClone(pkg));
        if (!Number.isFinite(response.usd) || response.usd < 0)
          throw Error("Invalid reviewer spend");
        reviewerUsd = response.usd;
        const result = verdict.parse(JSON.parse(response.text));
        reviewerVerdict = result.verdict;
        reasons = result.reasons;
      }
    } catch (e) {
      reasons = [
        {
          file: "package",
          line: 1,
          reason:
            reviewerUsd === 0 && !pkg
              ? String(e)
              : "Reviewer unavailable or returned an invalid decision",
        },
      ];
    }
    const accepted = pkg && reviewerVerdict === "accept" && !reasons.length;
    db.prepare(
      "UPDATE reviews SET findings=?,verdict=?,reasons=?,reviewerUsd=?,reviewerVerdict=? WHERE id=?",
    ).run(
      JSON.stringify(findings),
      accepted ? "accept" : "reject",
      JSON.stringify(reasons),
      reviewerUsd,
      reviewerVerdict,
      id,
    );
    if (!accepted || !pkg)
      throw Error(
        "Leakage review " +
          id +
          " rejected: " +
          reasons.map((r) => r.file + ":" + r.line + " " + r.reason).join("\n"),
      );
    approvals.set(pkg, hash);
    return pkg;
  } finally {
    db.close();
  }
}
export function humanReviews(root: string, id?: string) {
  const db = new DatabaseSync(join(root, "reviews.sqlite"), { readOnly: true });
  try {
    if (!id)
      return db
        .prepare(
          "SELECT id,hash,created,reviewerUsd FROM reviews WHERE verdict='accept' ORDER BY rowid",
        )
        .all();
    const row = db.prepare("SELECT * FROM reviews WHERE id=?").get(id);
    if (!row) throw Error("Unknown review");
    return {
      ...row,
      ...Object.fromEntries(
        ["configuration", "findings", "reasons"].map((k) => [
          k,
          JSON.parse(String(row[k])),
        ]),
      ),
    };
  } finally {
    db.close();
  }
}
