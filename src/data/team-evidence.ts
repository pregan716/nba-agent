import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Corpus } from "./corpus.js";
import type { RecordEnvelope, Row } from "./contracts.js";
import type { ObjectRef } from "./store.js";
import { sha256 } from "./store.js";
import {
  BeatPostsAdapter,
  TranscriptsAdapter,
  OddsAdapter,
  envelope,
  pick,
  transcriptAvailability,
} from "./adapters.js";
import { Release } from "./release.js";
import { teamIds, type Team } from "./teams.js";
import type { EvidenceSource } from "../env/contract.js";
import { before } from "./time.js";
import type { Identities } from "./identity.js";

interface TeamPins {
  posts: ObjectRef;
  lineups: ObjectRef;
  odds?: ObjectRef;
  games: Record<string, string>;
  transcripts: { entry: Row; root: ObjectRef }[];
}
export async function openTeamEvidence(
  c: Corpus,
  team: Team,
  ids: Identities,
  root = process.cwd(),
) {
  const teamId = teamIds[team];
  let pins: TeamPins | undefined;
  const versions = [];
  let posts = c.posts,
    transcripts = c.transcripts;
  let index: Row[];
  let odds: OddsAdapter | undefined;
  if (team === "BOS") {
    index = JSON.parse(
      (await readFile(resolve(root, c.pins.transcriptIndex.path))).toString(),
    );
    odds = c.odds;
  } else {
    const releasePath = "config/five-team/" + team + ".json";
    const bytes = await readFile(resolve(root, releasePath));
    versions.push({
      source: "evidence-" + team,
      release: releasePath,
      manifest_sha256: sha256(bytes),
    });
    pins = JSON.parse(bytes.toString()) as TeamPins;
    for (const [providerId, canonicalId] of Object.entries(pins.games))
      ids.add({
        entity: "game",
        provider: "espn",
        providerId,
        canonicalId,
        basis: "team pair and Eastern game date on pinned schedules",
        evidence: [pins.lineups, c.pbp.release.root],
      });
    posts = new BeatPostsAdapter(await Release.open(pins.posts, c.verified));
    index = pins.transcripts.map((t) => t.entry);
    transcripts = new TranscriptsAdapter(
      index,
      Object.fromEntries(
        pins.transcripts.map((t) => [t.entry.manifestKey, t.root]),
      ),
      c.verified,
    );
    if (pins.odds)
      odds = new OddsAdapter(await Release.open(pins.odds, c.verified));
  }
  const annotate = (r: RecordEnvelope): RecordEnvelope => ({
    ...r,
    data: { ...r.data, team_id: teamId },
  });
  async function lineups(cutoff: string) {
    if (!pins)
      return (await c.celticsLineups.records())
        .filter((r) => before(r.availableAt, cutoff))
        .map((r) => ({
          ...annotate(r),
          data: {
            ...r.data,
            team_id: teamId,
            game_id: ids.resolve("game", "espn", r.data.gameId),
          },
        }));
    const { rows } = await c.verified.json(pins.lineups);
    return (rows as Row[])
      .filter(
        (r) =>
          r.phase === "regular" &&
          r.team === (team === "WAS" ? "WSH" : team) &&
          before(r.postedAt, cutoff),
      )
      .map((r) => {
        const id = pins.games[r.gameId];
        if (!id) throw Error("Unmapped regular-season lineup " + r.gameId);
        return envelope(
          "lineups",
          team + ":" + r.gameId + ":" + r.postId,
          {
            ...pick(r, [
              "gameId",
              "postedAt",
              "postId",
              "source",
              "url",
              "startingLineup",
            ]),
            team_id: teamId,
            game_id: id,
            text: r.startingLineup.join(", "),
          },
          pins.lineups,
          pins.lineups.sha256,
          r.postedAt,
          "lineup_announcement",
        );
      });
  }
  return {
    team,
    teamId,
    versions,
    odds,
    transcriptTimes() {
      return index.flatMap((e) => {
        const a = transcriptAvailability(e);
        return a ? [a.at] : [];
      });
    },
    async evidence(
      kind: EvidenceSource,
      cutoff: string,
    ): Promise<RecordEnvelope[]> {
      if (kind === "lineups") return lineups(cutoff);
      const rows =
        kind === "posts"
          ? await posts.records()
          : await transcripts.records(cutoff);
      return rows.filter((r) => before(r.availableAt, cutoff)).map(annotate);
    },
  };
}
export type TeamEvidence = Awaited<ReturnType<typeof openTeamEvidence>>;
