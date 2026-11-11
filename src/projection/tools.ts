import { SessionError, type Phase } from "../env/contract.js";
import { TOOL_DEFINITIONS } from "../env/tools.js";
import { DECISION_TABLES } from "../env/decision-history.js";
import { quantities } from "./forecast.js";

export const forecastPrompts = {
  system:
    "You are the Boston Celtics projection analyst. Use only the supplied session tools.",
  pregame:
    "Research this game and freeze one forecast-v1 roster forecast before tip. Reference tables provide the dated roster and forecast format.",
  postgame: "Review released feedback and update permitted files if useful.",
  postgame_mandated: "Review released feedback.",
};
const object = (
  properties: Record<string, unknown> = {},
  required: string[] = [],
) => ({ type: "object", properties, required, additionalProperties: false });
const draft = object(
  {
    version: { type: "string", enum: ["forecast-v1"] },
    gameId: { type: "string" },
    players: {
      type: "array",
      items: object(
        {
          playerId: { type: "string" },
          p_play: { type: "number" },
          p_start: { type: "number" },
          ...Object.fromEntries(
            quantities.map((q) => [
              q,
              {
                type: "array",
                minItems: 7,
                maxItems: 7,
                items: { type: "number" },
              },
            ]),
          ),
        },
        ["playerId", "p_play", "p_start", ...quantities],
      ),
    },
  },
  ["version", "gameId", "players"],
);
const descriptions: Record<string, string> = {
  context:
    "Return game, spread, total, clock, workspace permissions and remaining research budget.",
  query_game_history:
    "Query released game history or opening player references. Select a table and filter by game, team or player.",
  execute_code:
    "Run Python with pandas, scipy and sklearn. Use nba_data for released game data. /scratch is temporary. Full memory mounts /workspace/memory and /workspace/code.",
};
const carried = [
  "context",
  "query_game_history",
  "execute_code",
  "list_evidence",
  "search_evidence",
  "fetch_evidence",
  "read_schedule_and_injuries",
  "workspace_list",
  "workspace_read",
  "workspace_write",
  "workspace_append",
  "workspace_delete",
  "workspace_edit",
];
const tools = TOOL_DEFINITIONS.filter((t) => carried.includes(t.name)).map(
  (t) => {
    const schema = structuredClone(t.input_schema);
    if (t.name === "query_game_history") {
      const props = schema.properties as { table: { enum: string[] } };
      props.table.enum = props.table.enum.filter(
        (v) => !DECISION_TABLES.some((d) => d === v),
      );
    }
    return {
      ...t,
      description:
        descriptions[t.name] ??
        (t.name.startsWith("workspace_")
          ? t.name.replace("_", " ") + " under the arm's permitted directories."
          : t.description),
      input_schema: schema,
    };
  },
);
const both: Phase[] = ["pregame", "postgame"];
export const forecastDefinitions = [
  ...tools,
  {
    name: "reference_projection",
    description:
      "Read tonight's reference forecast or a prior game's forecast and errors. With list=true return the available game IDs.",
    input_schema: object({
      game_id: { type: "string" },
      list: { type: "boolean" },
    }),
    phases: both,
  },
  ...["validate_forecast", "freeze_forecast"].map((name) => ({
    name,
    description:
      name === "freeze_forecast"
        ? "Validate and lock the roster forecast."
        : "Check the roster forecast without locking it.",
    input_schema: object({ draft }, ["draft"]),
    phases: ["pregame"] as Phase[],
  })),
  {
    name: "read_feedback",
    description:
      "Read the previous game's released scores in pregame or this game's scores in postgame.",
    input_schema: object(),
    phases: both,
  },
];
export function forecastTools(phase: Phase, full: boolean) {
  return forecastDefinitions.filter(
    (t) =>
      t.phases.some((p) => p === phase) &&
      (full || !t.name.startsWith("workspace_")),
  );
}
export function forecastTool(name: string, phase: Phase, full: boolean) {
  const t = forecastTools(phase, full).find((t) => t.name === name);
  if (!t)
    throw new SessionError("phase_refused", "Tool unavailable in this session");
  return t;
}
