import { digest, type Manifest, type RunConfig } from "./config.js";
import type { Event } from "./record.js";

export function pilotEnd(config: RunConfig) {
  return config.policy.throughGame ?? config.policy.developmentGames;
}

export function continuationData(original: Manifest, next: Manifest) {
  const firstGame = pilotEnd(original.config) + 1;
  const lastGame = pilotEnd(next.config);
  // Only the revision, harness, budget and end of the pilot may change.
  const comparable = (config: RunConfig) => {
    const { codeRevision, harness, budget, policy, ...identity } = config;
    const { throughGame, ...seasonPolicy } = policy;
    return { ...identity, seasonPolicy };
  };
  if (
    original.config.purpose !== "pilot" ||
    next.config.purpose !== "pilot" ||
    original.config.profile.memory.version !== "forecast-memory-v1" ||
    digest(comparable(original.config)) !== digest(comparable(next.config)) ||
    digest(original.games) !== digest(next.games)
  )
    throw Error("Incompatible pilot continuation");
  if (lastGame < firstGame || lastGame > 20 || lastGame > next.games.length)
    throw Error("Invalid pilot continuation range");
  return {
    originalManifestDigest: digest(original),
    config: next.config,
    firstGame,
    lastGame,
  };
}

export function checkPilotBoundary(
  original: Manifest,
  ends: Event[],
  runEnds: Event[],
) {
  const ids = original.games
    .slice(0, pilotEnd(original.config))
    .map((g) => g.gameId);
  if (
    runEnds.length !== 1 ||
    ends.some((e) => e.seq >= runEnds[0].seq) ||
    digest(ends.map((e) => e.scope)) !== digest(ids)
  )
    throw Error("Continuation requires a completed pilot at a game boundary");
}
