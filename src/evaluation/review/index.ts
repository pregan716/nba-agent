import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { canonicalJson } from "../../env/tools.js";
import { readPackage, type Package } from "../../game-loop/package.js";
import {
  retryArchitectProvider,
  unbilledProviderFailure,
} from "../../runner/retry.js";
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
export type ReviewReceipt = {
  id: string;
  hash: string;
  verdict: "accept" | "reject" | "failed";
  reasons: Finding[];
};
export class ReviewerFailure extends Error {}
export class ReviewRejection extends Error {}
// Reviewer spend is outside the architect and evaluation budgets. Keep the
// successful usage even if an earlier attempt left the review total unknown.
async function requestVerdict(
  db: DatabaseSync,
  id: string,
  reviewer: Reviewer,
  pkg: Package,
) {
  const reserve = db.prepare("INSERT INTO reviewer_attempts(review) VALUES(?)");
  const settle = db.prepare("UPDATE reviewer_attempts SET usd=? WHERE id=?");
  return retryArchitectProvider(async () => {
    const attempt = reserve.run(id).lastInsertRowid;
    let response;
    try {
      response = await reviewer(structuredClone(pkg));
    } catch (e) {
      if (unbilledProviderFailure(e)) settle.run(0, attempt);
      throw e;
    }
    if (!Number.isFinite(response.usd) || response.usd < 0)
      throw Error("Invalid reviewer spend");
    settle.run(response.usd, attempt);
    return response.text;
  }, new AbortController().signal);
}
export async function review(
  root: string,
  gate: ReviewGate,
  input: unknown,
  recorded?: (receipt: ReviewReceipt) => void,
) {
  const raw = structuredClone(input);
  const json = canonicalJson(raw) ?? "null";
  const hash = createHash("sha256").update(json).digest("hex");
  const id = randomUUID();
  const db = new DatabaseSync(join(root, "reviews.sqlite"));
  try {
    db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY, created TEXT DEFAULT CURRENT_TIMESTAMP,
      hash TEXT NOT NULL, configuration TEXT NOT NULL, findings TEXT NOT NULL, verdict TEXT NOT NULL, reasons TEXT NOT NULL, reviewerUsd REAL, reviewerVerdict TEXT);
    CREATE TABLE IF NOT EXISTS reviewer_attempts(id INTEGER PRIMARY KEY, review TEXT NOT NULL, usd REAL)`);
    let findings: Finding[] = [];
    db.prepare(
      "INSERT INTO reviews(id,hash,configuration,findings,verdict,reasons) VALUES(?,?,?,?,'pending','[]')",
    ).run(id, hash, json, JSON.stringify(findings));
    let reasons: Finding[] = [],
      reviewerUsd: number | null = 0,
      reviewerVerdict: string | null = null;
    let pkg: Package | undefined;
    let scanned = false;
    let reviewerFailed = false;
    try {
      findings = await gate.scan(raw);
      scanned = true;
      reasons = findings;
      if (!reasons.length) {
        pkg = readPackage(raw).pkg;
        reviewerUsd = null;
        reviewerFailed = true;
        const text = await requestVerdict(db, id, gate.reviewer, pkg);
        reviewerFailed = false;
        const result = verdict.parse(JSON.parse(text));
        reviewerVerdict = result.verdict;
        reasons = result.reasons;
      }
    } catch (e) {
      reasons = [
        {
          file: "package",
          line: 1,
          reason: reviewerFailed
            ? "Reviewer unavailable. Submit the configuration again."
            : !scanned
              ? "Season identity scan unavailable"
              : reviewerUsd === 0 && !pkg
                ? String(e)
                : "Reviewer returned an invalid decision",
        },
      ];
    }
    if (pkg) {
      const totals = db
        .prepare(
          "SELECT CASE WHEN count(usd)=count(*) THEN sum(usd) END AS usd FROM reviewer_attempts WHERE review=?",
        )
        .get(id)!;
      reviewerUsd = totals.usd === null ? null : Number(totals.usd);
    }
    const accepted = pkg && reviewerVerdict === "accept" && !reasons.length;
    const outcome = accepted ? "accept" : reviewerFailed ? "failed" : "reject";
    db.prepare(
      "UPDATE reviews SET findings=?,verdict=?,reasons=?,reviewerUsd=?,reviewerVerdict=? WHERE id=?",
    ).run(
      JSON.stringify(findings),
      outcome,
      JSON.stringify(reasons),
      reviewerUsd,
      reviewerVerdict,
      id,
    );
    recorded?.({ id, hash, verdict: outcome, reasons });
    if (reviewerFailed) throw new ReviewerFailure(reasons[0].reason);
    if (!accepted || !pkg)
      throw new ReviewRejection(
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
/** Restore approval for an immutable nominee when the final operator runs in
 * a new process. Both the hash and the canonical bytes must match. */
export function restoreAcceptance(
  root: string,
  raw: Package,
  recorded?: (receipt: ReviewReceipt) => void,
) {
  const { pkg, hash } = readPackage(raw);
  const db = new DatabaseSync(join(root, "reviews.sqlite"), { readOnly: true });
  try {
    const row = db
      .prepare(
        "SELECT id FROM reviews WHERE hash=? AND configuration=? AND verdict='accept' AND reviewerVerdict='accept' ORDER BY rowid DESC LIMIT 1",
      )
      .get(hash, canonicalJson(pkg));
    if (!row)
      throw Error("No recorded acceptance for the nominated configuration");
    approvals.set(pkg, hash);
    recorded?.({ id: String(row.id), hash, verdict: "accept", reasons: [] });
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
