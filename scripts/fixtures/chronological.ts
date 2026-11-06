// Scripted providers and synthetic evidence for the offline launcher acceptance run.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Message } from "@anthropic-ai/sdk/resources/messages";
import type { Row } from "../../src/data/contracts.js";
import { BOS, type ReplayInput } from "../../src/replay/types.js";
import { buildDataset } from "../../src/replay/dataset.js";
import { fixtureCorpus } from "../../test/fixtures/session/corpus.js";
import { sha256 } from "../../src/data/store.js";
import type { ModelProvider } from "../../src/runner/proxy.js";
import type { JevProvider } from "../../src/runner/jev.js";
import { JEV_MODEL } from "../../src/policy/request.js";
const five = ["a", "b", "c", "d", "e"],
  opp = ["v", "w", "x", "y", "z"];
function replayInput(): ReplayInput {
  const row = (seq: number, type: string, clock: number, extra: Row = {}) => ({
    game_id: "game",
    event_id: `e${seq}`,
    canonical_sequence: seq,
    period: 1,
    clock_remaining_ms: clock,
    type,
    subtype: null,
    validity: "effective",
    quality_status: "valid",
    team_id: BOS,
    home_lineup_before: [...five],
    home_lineup_after: [...five],
    away_lineup_before: [...opp],
    away_lineup_after: [...opp],
    home_score_before: 0,
    home_score_after: 0,
    away_score_before: 0,
    away_score_after: 0,
    ...extra,
  });
  const events = [
    row(0, "period_start", 720000),
    row(1, "timeout", 600000, { subtype: "full" }),
    row(2, "substitution", 600000),
    row(3, "substitution", 600000, {
      home_lineup_after: ["f", "b", "c", "d", "e"],
    }),
    row(4, "period_end", 0, {
      home_lineup_before: ["f", "b", "c", "d", "e"],
      home_lineup_after: ["f", "b", "c", "d", "e"],
    }),
  ];
  return {
    game: {
      gameId: "game",
      homeTeamId: BOS,
      awayTeamId: "other",
      scheduledStart: "2025-11-01T00:00:00Z",
    },
    release: {
      bucket: "sports-nba-data",
      key: "fixture",
      sha256: "a".repeat(64),
    },
    events,
    participants: [
      { event_id: "e2", team_id: BOS, player_id: "a", role: "sub_out" },
      { event_id: "e3", team_id: BOS, player_id: "f", role: "sub_in" },
    ],
    stints: [...five, "f", ...opp].map((player_id) => ({
      game_id: "game",
      team_id: opp.includes(player_id) ? "other" : BOS,
      player_id,
      period: 1,
      quality_status: "valid",
      duration_ms:
        player_id === "a" ? 120000 : player_id === "f" ? 600000 : 720000,
      start_clock_ms: player_id === "f" ? 600000 : 720000,
      end_clock_ms: player_id === "a" ? 600000 : 0,
      start_sequence: player_id === "f" ? 3 : 0,
      end_sequence: 4,
    })),
    coverage: ["lineups", "stints", "normalization", "summaries"].map(
      (product) => ({ game_id: "game", product, quality_status: "valid" }),
    ),
    issues: [],
    pregame: {
      gameId: "game",
      scheduledStart: "2025-11-01T00:00:00Z",
      roster: [...five, "f", "g", "h"].map((playerId) => ({
        playerId,
        availableAt: "2025-10-01T00:00:00Z",
      })),
      injuryReport: {
        availableAt: "2025-10-31T23:00:00Z",
        state: "unknown",
        players: [],
      },
      announcedStarters: null,
      sources: [],
    },
  };
}

export function chronologicalFixture() {
  const f = fixtureCorpus(false);
  const schedule = f.schedule.slice(0, 2).map((g) => ({
    gameId: g.id,
    scheduledStart: g.data.scheduled_tipoff as string,
  }));
  const inputs = schedule.map((g) => {
    const input = replayInput();
    input.game.gameId = input.pregame.gameId = g.gameId;
    input.game.scheduledStart = input.pregame.scheduledStart = g.scheduledStart;
    for (const rows of [input.events, input.stints, input.coverage])
      for (const row of rows) row.game_id = g.gameId;
    input.pregame.injuryReport.availableAt = "2025-10-01T00:00:00Z";
    return input;
  });
  return { source: f.source, schedule, datasets: inputs.map(buildDataset) };
}
export const scriptedJev: JevProvider = {
  async create(r) {
    return {
      model: JEV_MODEL,
      answers: Object.fromEntries(
        Object.entries(r.questions).map(([key, q]) => [
          key,
          q.type === "noul"
            ? { type: "noul", noul: 0.5 }
            : {
                type: q.type,
                probabilities: Object.fromEntries(
                  (Array.isArray(q.criteria)
                    ? q.criteria.map((_, i) => String(i))
                    : Object.keys(q.criteria)
                  ).map((k, _, a) => [k, 1 / a.length]),
                ),
              },
        ]),
      ),
      usage: { input_tokens: 10, output_tokens: 10 },
    };
  },
};
export function scriptedAnalyst(invalidFirst = false): ModelProvider {
  const example = fileURLToPath(
    new URL("../../examples/policy/", import.meta.url),
  );
  return {
    async count(request) {
      // Synthetic fixture counting only, never presented as an analyst tokenizer result.
      return Math.ceil(JSON.stringify(request).length / 4);
    },
    async create(request) {
      const first = request.messages[0].content;
      const text =
        typeof first === "string"
          ? first
          : first
              .filter((b: any) => b.type === "text")
              .map((b: any) => b.text)
              .join("\n");
      const context = JSON.parse(
        text.slice(
          text.indexOf("Session context:\n") + "Session context:\n".length,
        ),
      );
      const game = context.game.game_id;
      const commands: { name: string; input: any }[] = [];
      const tool = (name: string, input: any = {}) =>
        commands.push({ name, input });
      if (context.phase === "pregame") {
        if (game === "current") {
          tool("read_feedback");
          tool("workspace_read", { path: "memory/coach_profile.md" });
          tool("workspace_read", { path: "packages/prior/assemble.py" });
          tool("workspace_read", { path: "scratch/reflection.txt" });
          tool("workspace_read", { path: "feedback/current/trace.json" });
        }
        const files: Record<string, string> = {
          "assemble.py":
            invalidFirst && game === "prior"
              ? "def assemble(state):\n    raise ValueError('fixture invalid first window')\n"
              : readFileSync(join(example, "assemble.py"), "utf8"),
          "components/instructions.txt": readFileSync(
            join(example, "components/instructions.txt"),
            "utf8",
          ),
        };
        files["manifest.json"] = JSON.stringify({
          stateVersion: "state-v1",
          components: Object.fromEntries(
            Object.entries(files).map(([p, s]) => [p, sha256(Buffer.from(s))]),
          ),
          notes: "Scripted fixture only",
        });
        for (const [path, content] of Object.entries(files))
          tool("workspace_write", {
            path: `packages/${game}/${path}`,
            content,
          });
        tool("freeze_package");
      } else {
        tool("read_feedback");
        if (context.memory.coachProfile.read)
          tool("workspace_write", {
            path: "memory/coach_profile.md",
            content: `reflection-${game}`,
          });
        tool("workspace_write", {
          path: "scratch/reflection.txt",
          content: game,
        });
      }
      const turns = request.messages.filter(
        (m) => m.role === "assistant",
      ).length;
      const command = commands[turns];
      return {
        id: `fixture-${turns}`,
        type: "message",
        role: "assistant",
        model: "claude-opus-4-6",
        content: command
          ? [{ type: "tool_use", id: `tool-${turns}`, ...command }]
          : [{ type: "text", text: "Fixture complete" }],
        stop_reason: command ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 10,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      } as Message;
    },
  };
}
