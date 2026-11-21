import { DatabaseSync, backup } from "node:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Iteration } from "../../architect/iteration.js";
import { digest } from "../../runner/config.js";
import { readPackage } from "../../game-loop/package.js";
import { before } from "../../data/time.js";
import { EvaluationPool } from "./pool.js";
import { archiveRun } from "./archive.js";
import { evaluationProfile, profileSchema, lateStart } from "./profile.js";
import type { EvaluationHost } from "./index.js";

/** Copy only the SQLite record, through SQLite's consistent backup API.
 * Opening its snapshot verifies the event chain without changing the source. */
async function snapshotRun(source: string, destination: string) {
  mkdirSync(destination, { recursive: true });
  const db = new DatabaseSync(join(source, "record.sqlite"), {
    readOnly: true,
  });
  try {
    await backup(db, join(destination, "record.sqlite"));
  } finally {
    db.close();
  }
  const archive = archiveRun(destination);
  const saved = new DatabaseSync(join(destination, "record.sqlite"), {
    readOnly: true,
  });
  try {
    const manifest = JSON.parse(
      String(
        saved.prepare("SELECT data FROM events WHERE kind='manifest'").get()!
          .data,
      ),
    );
    return { archive, manifest };
  } finally {
    saved.close();
  }
}

/** The pool lists a run's games in schedule order and the record in replay
 * order (by tip), so they are compared as sets. */
const sameGames = (a: unknown[], b: unknown[]) =>
  digest(a.map((g) => digest(g)).sort()) ===
  digest(b.map((g) => digest(g)).sort());

/** Operator-only import. Historical records keep their original harness pins;
 * only the new pool's live evaluations are bound to the current environment. */
export async function seedRoundTwo(
  host: Pick<EvaluationHost, "root" | "config" | "profile">,
  sourceRoot: string,
) {
  const destination = resolve(host.root);
  if (existsSync(destination)) throw Error("Seed destination must not exist");
  const source = new DatabaseSync(join(sourceRoot, "evaluations.sqlite"), {
    readOnly: true,
  });
  mkdirSync(dirname(destination), { recursive: true });
  const staging = mkdtempSync(join(dirname(destination), ".round-two-"));
  try {
    source.exec("BEGIN");
    if (
      source
        .prepare("SELECT 1 FROM sqlite_master WHERE name='round_info'")
        .get() &&
      source.prepare("SELECT 1 FROM round_info").get()
    )
      throw Error("Seed source must be a round-one pool");
    if (source.prepare("SELECT 1 FROM runs WHERE status='running'").get())
      throw Error("Seed source has an active evaluation");
    const settings = source
      .prepare("SELECT nominee,value FROM settings WHERE id=1")
      .get();
    if (!settings?.nominee) throw Error("Seed source has no nominee");
    const baselineRunId = String(settings.nominee);
    const sourceSettings = JSON.parse(String(settings.value));
    const profile = profileSchema.parse(host.profile ?? evaluationProfile);
    const pool = new EvaluationPool(staging, profile, digest(host.config));
    try {
      const rows = source
        .prepare("SELECT * FROM runs WHERE status='complete' ORDER BY rowid")
        .all();
      for (const row of rows) {
        const id = String(row.id);
        if (!/^[\w-]+$/.test(id)) throw Error("Invalid source run ID");
        const games = JSON.parse(String(row.games));
        // Import only the development windows reachable before the reserved stretch.
        if (
          !games.length ||
          games.some((g: { tip: string }) => !before(g.tip, lateStart(profile)))
        )
          continue;
        const { archive, manifest } = await snapshotRun(
          join(sourceRoot, "development", id),
          join(staging, "development", id),
        );
        if (
          !manifest.development ||
          archive.hash !== row.hash ||
          readPackage(archive.configuration).hash !== row.hash ||
          digest(archive.configuration) !==
            digest(JSON.parse(String(row.pkg))) ||
          sameGames(manifest.games, games) === false ||
          digest(manifest.config) !== sourceSettings.environment
        )
          throw Error("Source development record mismatch");
        pool.db
          .prepare("INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?)")
          .run(
            id,
            row.kind,
            row.parent,
            row.hash,
            row.pkg,
            row.games,
            0,
            0,
            "complete",
          );
        pool.db
          .prepare("INSERT INTO inherited_runs VALUES(?,?,?)")
          .run(id, row.charge, row.full);
      }
      const baseline = pool.complete(baselineRunId);
      if (baseline.kind !== "full")
        throw Error("Source nominee must be a full evaluation");
      const info = {
        round: 2 as const,
        baselineRunId,
        baselineHash: baseline.hash,
        sourceEnvironment: sourceSettings.environment as string,
      };
      pool.db
        .prepare("INSERT INTO round_info VALUES(1,?)")
        .run(JSON.stringify(info));
      const previous = new DatabaseSync(join(sourceRoot, "architect.sqlite"), {
        readOnly: true,
      });
      const iteration = new Iteration(staging);
      try {
        previous.exec("BEGIN");
        if (
          previous
            .prepare("SELECT 1 FROM iterations WHERE status='running'")
            .get()
        )
          throw Error("Seed source has an active architect iteration");
        const note = iteration.db.prepare(
          "INSERT INTO documents VALUES('notes',?,?)",
        );
        for (const row of previous
          .prepare("SELECT name,content FROM documents WHERE area='notes'")
          .all())
          note.run(row.name, row.content);
        const hypothesis = iteration.db.prepare(
          "INSERT INTO hypotheses VALUES(?,?,?)",
        );
        for (const row of previous
          .prepare("SELECT name,description,closed FROM hypotheses")
          .all())
          hypothesis.run(row.name, row.description, row.closed);
        const { files, ...metadata } = baseline.pkg;
        const draft = iteration.db.prepare(
          "INSERT INTO documents VALUES('draft',?,?)",
        );
        draft.run("package.json", JSON.stringify(metadata));
        for (const [name, content] of Object.entries(files))
          draft.run(name, content);
      } finally {
        previous.close();
        iteration.close();
      }
      // Seeding is not an architect iteration and consumes no budget.
      const ledger = new DatabaseSync(join(staging, "architect.sqlite"));
      try {
        ledger.exec("DELETE FROM iterations");
      } finally {
        ledger.close();
      }
      renameSync(staging, destination);
      return info;
    } finally {
      pool.close();
    }
  } finally {
    source.close();
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Final records are supplied by the operator and never copied into the pool. */
export async function roundOneFinal(
  source: string,
  baselineHash: string,
  sourceEnvironment: string,
) {
  const temporary = mkdtempSync(join(tmpdir(), "round-one-final-"));
  try {
    const { archive, manifest } = await snapshotRun(source, temporary);
    if (
      digest(manifest.config) !== sourceEnvironment ||
      archive.hash !== baselineHash ||
      readPackage(archive.configuration).hash !== baselineHash ||
      manifest.development !== false ||
      manifest.agentsOff ||
      manifest.clearArtifacts
    )
      throw Error(
        "Round-one final record must be the baseline nominee's nominated run",
      );
    return archive;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
