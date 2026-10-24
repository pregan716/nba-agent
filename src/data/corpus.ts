import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256, VerifiedStore, type ObjectStore } from "./store.js";
import type { PinSet, Row } from "./contracts.js";
import { Release } from "./release.js";
import {
  OddsAdapter,
  PlayByPlayAdapter,
  InjuryAdapter,
  PlayerReferenceAdapter,
  BeatPostsAdapter,
  LineupsAdapter,
  TranscriptsAdapter,
} from "./adapters.js";
export async function openCorpus(
  store: ObjectStore,
  root = process.cwd(),
  cache?: string,
) {
  const pins: PinSet = JSON.parse(
    await readFile(resolve(root, "config/datasets.json"), "utf8"),
  );
  if (pins.schemaVersion !== 1) throw Error("Unsupported dataset pins");
  const verified = new VerifiedStore(store, cache);
  const release = (name: string) => Release.open(pins.sources[name], verified);
  const indexBytes = await readFile(resolve(root, pins.transcriptIndex.path));
  if (sha256(indexBytes) !== pins.transcriptIndex.sha256)
    throw Error("Transcript index hash mismatch");
  const index: Row[] = JSON.parse(indexBytes.toString());
  const metadata = await readFile(
    resolve(root, "config/transcript-publication-metadata.json"),
  );
  for (const entry of index)
    if (sha256(metadata) !== entry.livestream_provenance.sha256)
      throw Error("Transcript publication evidence hash mismatch");
  return {
    pins,
    verified,
    odds: new OddsAdapter(await release("odds")),
    oddsArchive: await release("oddsArchive"),
    pbp: new PlayByPlayAdapter(await release("pbp-2025-26")),
    priorPbp: new PlayByPlayAdapter(await release("pbp-2024-25")),
    injuries: new InjuryAdapter(await release("injuries")),
    players: new PlayerReferenceAdapter(await release("players")),
    posts: new BeatPostsAdapter(await release("posts")),
    celticsLineups: new LineupsAdapter(
      pins.sources.celticsLineups,
      verified,
      "celtics",
    ),
    opponentLineups: new LineupsAdapter(
      pins.sources.opponentLineups,
      verified,
      "opponent",
    ),
    transcripts: new TranscriptsAdapter(
      index,
      pins.transcriptManifests,
      verified,
    ),
    versions: {
      sources: pins.sources,
      odds: new OddsAdapter(await release("odds")).version(),
      transcriptIndex: pins.transcriptIndex,
      transcriptManifests: pins.transcriptManifests,
    },
  };
}
export type Corpus = Awaited<ReturnType<typeof openCorpus>>;
