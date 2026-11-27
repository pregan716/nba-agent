# Game-loop runtime

The evaluation host calls `replay` in `src/game-loop/replay.ts` with a new run directory, a pinned research-sandbox configuration, a package, selected team-games and a trusted `ReplaySource`. The source provides the full season schedule, per-team pregame roster and reference projection, optional pregame spread and total, and released outcomes. The host supplies `specialists({anthropic, typesafe})` for live agents or a scripted provider for fixtures. Credentials stay in the host process.

## Package

A `game-loop-v1` JSON object contains a hypothesis, an entry filename, a map of Python filenames to source text, a list of training filenames, and declarations for agents and artifacts. The SHA-256 digest covers the entire canonical JSON package, including training scripts. The evaluation service owns model builds. The read-only path reserved for its built artifacts is `/data/models`. Package files share a flat importable directory. An agent declares its pinned model, prompt, ordered skill texts and named tools. Each tool declares a description and a Python filename. Prompts and skills accept `{{team}}` and `{{game}}` placeholders.

## Python entry point

The entry file defines `run(ctx, arg)`. The first invocation receives `None` for `arg`. Return a JSON action. For example, this loop asks a specialist for a forecast and falls back to the reference if the call is refused.

```python
def run(ctx, arg):
    import json

    if arg is None:
        return {"type": "agent", "name": "analyst",
                "input": {"reference": ctx["reference"]}, "state": None}

    forecast = ctx["reference"]
    if arg["reply"]["ok"]:
        forecast = json.loads(arg["reply"]["value"])
    return {"type": "finish", "forecast": forecast,
            "writes": {"last_game": ctx["gameId"]}}
```

The example expects an agent named `analyst` and an artifact declaration such as `{"last_game": "team"}`. A code-only entry can return a finish action immediately. Each agent action resumes the entry with the submitted JSON state and a reply containing either a value or an error. Claude returns text. A Claude agent may declare `thinking` as `low`, `medium` or `high`; without it the agent runs with thinking off. Thinking is billed as output within the call's reservation and is recorded in the call's transcript, not in the reply. Jev accepts a task containing `state` and named System One `questions` (choice, noul or score), and returns its answers. Its declared tools prepare evidence from the task state. Claude chooses its declared tools per turn. Tool files also define `run(ctx, arg)` and return JSON. Send diagnostic output to stderr. Each completed sandbox step records its file, action, exit status and a stderr tail of up to 4 KiB. Claude tools may declare an object `parameters` schema with typed, named properties, descriptions, required keys and an additional-properties flag.

The context includes team ID, game ID, tip, roster, spread, total, tonight's reference, released reference history and the chronological `scores` list for this team's released games in the replay. The previous-game `feedback` field is also available. Research tables use the existing read-only sandbox export. Python globals are fresh at each invocation. The scratch directory lasts for one team-game. Only declared JSON artifact writes on a valid finish carry forward. Team artifacts are private to that team. League artifacts are shared. Simultaneous tips read the same pre-tip snapshot. Later games see the last write in deterministic team/game order.

## Result and artifact limits

Each Python invocation can return up to 1 MiB (1,048,576 bytes) of JSON on stdout. The whole action counts, including the forecast and writes on a finish or the input and state on an agent call. The same limit applies to a specialist tool's result. Exceeding it fails that step with a size-limit diagnostic. Stderr has a separate diagnostic budget and retains a tail of up to 4 KiB.

An artifact value can occupy up to 256 KiB. The sum of retained values can reach 1 MiB for each team and a separate 1 MiB for the league. Sizes use the UTF-8 byte length of each compact JSON value, including string quotes and escapes. Replacing a value removes its old size from the total. The host checks all writes before freezing the forecast. A rejected finish records the reason, preserves the previous artifacts and scores the team-game on the reference.

## Metering and records

The default run allowance is $2 times the number of team-games. The game safeguards are $10 and 45 minutes. Pass a budget profile to override them. Set `agentsOff` to refuse all agent calls or `clearArtifacts` to start each team-game with an empty store. A model request reserves from both remaining allowances. A response settles its usage. An ambiguous failure keeps its reservation against the caps and records the amount separately from confirmed spend.

## Order of team-games

A team-game depends on another team's games only through league artifacts: a league value written by one team is visible to every team from the next tip. So the replay runs in one of two ways.

- **A package that declares a league artifact** (written or not) runs every team-game in one loop, in tip order.
- **A package with only team artifacts, or any package under `clearArtifacts`**, runs each team in a lane of its own. A lane takes its team's games in tip order; the lanes run side by side.

Both ways give each team-game the same context, and so the same forecast, score and spend. A team-game's receipt (`team_game`) is recorded the moment the game ends, so the watcher sees a missing forecast without waiting for another lane. Receipts from different lanes therefore interleave, as do the other events. The artifact store after each team-game is recorded separately (`game_artifacts`), in tip order, as the single loop would hold it at that point. The archive lists forecasts and scores in tip order whichever way the replay ran. The run allowance is shared by all lanes and cannot be overspent. When it runs out, which team-games fall back to the reference can differ between the two ways, because the lanes reach it in a different order. A failure in one lane stops the games in progress in the others and ends the replay.

The run directory contains the package and manifest plus the hash-chained SQLite record. Each team-game records the reference, freeze or failure reason, and spend, and then the current artifacts. Agent events include rendered instructions, task, transcript, reservations, settlements and result. After release the host scores valid forecasts and substitutes the reference for missing forecasts. A fresh replay requires a new directory.

The Docker acceptance fixture runs with `FORECAST_SANDBOX_IMAGE` set to a pinned research image. Set `GAME_LOOP_LONG_STREAM=1` to hold the scripted Claude response open for more than five minutes.
