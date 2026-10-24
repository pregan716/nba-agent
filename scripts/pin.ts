import { writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  DopplerStore,
  VerifiedStore,
  sha256,
  type Bucket,
  type ObjectRef,
} from "../src/data/store.js";
import type { PinSet } from "../src/data/contracts.js";
const raw = new DopplerStore(),
  store = new VerifiedStore(raw, ".cache/objects");
const sources: Record<string, ObjectRef> = {};
async function pin(name: string, bucket: Bucket, key: string) {
  const body = await raw.get(bucket, key),
    ref = { bucket, key, sha256: sha256(body), bytes: body.length };
  await mkdir(".cache/objects", { recursive: true });
  await writeFile(`.cache/objects/${ref.sha256}`, body);
  sources[name] = ref;
  return JSON.parse(body.toString());
}
try {
  const base = "external/the-odds-api/v1/league=nba/season=2025-26/team=bos/";
  await pin(
    "odds",
    "pm-data-platform",
    base + "consensus/proportional/v1/_MANIFEST.json",
  );
  // The archive root pins the saved ESPN schedule and boxscore identity evidence.
  await pin("oddsArchive", "pm-data-platform", base + "_MANIFEST.json");
  for (const season of ["2024-25", "2025-26"])
    await pin(
      `pbp-${season}`,
      "sports-nba-data",
      `nba/releases/spo-771-full-v1-${season}/manifest.json`,
    );
  await pin(
    "injuries",
    "sports-nba-data",
    "nba/injury-reports/2025-26/releases/61f65449f459752a0ad06c0f41efd1cc8c13494f7b5f9c838f6536637c411c2e.json",
  );
  const players = await pin(
    "players",
    "sports-nba-data",
    "nba/player-reference/2025-26-opening/releases/15fef7276244e616b0817be4/manifest.json",
  );
  const report = players.objects.find(
    (r: any) => r.key === players.coverage_report,
  );
  await mkdir("docs/evidence", { recursive: true });
  await writeFile(
    "docs/evidence/player-reference-coverage.json",
    await store.read({ ...report, bucket: "sports-nba-data" }),
  );
  const active = await pin(
    "postSelection",
    "sports-text",
    "v1/relevance/celtics-2025-26/active.json",
  );
  sources.posts = {
    bucket: "sports-text",
    key: active.manifest.objectKey,
    sha256: active.manifest.sha256,
  };
  await store.read(sources.posts);
  await pin(
    "celticsLineups",
    "sports-text",
    "v1/research/celtics-lineups/extracted-2026-10-16/celtics-starting-lineups.json",
  );
  await pin(
    "opponentLineups",
    "sports-text",
    "v1/research/opponent-lineups/2026-10-19-complete/celtics-opponent-starting-lineups.json",
  );
  const repositoryCommit = "cc28535292efc47316c163c6969d759875e95f86";
  const repository = process.argv[2];
  if (!repository)
    throw Error(
      "Pass the sports-transcription checkout path to pin its exact Git revision",
    );
  const index = execFileSync("git", [
    "-C",
    repository,
    "show",
    `${repositoryCommit}:docs/evidence/season-backfill/manifest-index.json`,
  ]);
  const metadata = execFileSync("git", [
    "-C",
    repository,
    "show",
    `${repositoryCommit}:docs/evidence/season-backfill/publication-video-metadata.json`,
  ]);
  const entries = JSON.parse(index.toString());
  for (const entry of entries)
    if (entry.livestream_provenance.sha256 !== sha256(metadata))
      throw Error("Transcript metadata hash mismatch");
  await writeFile("config/transcript-index.json", index);
  await writeFile("config/transcript-publication-metadata.json", metadata);
  const transcriptManifests: Record<string, ObjectRef> = {};
  for (const entry of entries) {
    const key = "dev/" + entry.manifestKey,
      body = await raw.get("sports-transcription", key);
    const ref = {
      bucket: "sports-transcription" as const,
      key,
      sha256: sha256(body),
      bytes: body.length,
    };
    transcriptManifests[entry.manifestKey] = ref;
    await writeFile(`.cache/objects/${ref.sha256}`, body);
  }
  const pins: PinSet = {
    schemaVersion: 1,
    sources,
    transcriptIndex: {
      path: "config/transcript-index.json",
      sha256: sha256(index),
      repositoryCommit,
    },
    transcriptManifests,
  };
  await writeFile("config/datasets.json", JSON.stringify(pins, null, 2) + "\n");
  console.log(
    "Pinned source manifests and 134 transcript selections; player coverage report saved.",
  );
} finally {
  raw.close();
}
