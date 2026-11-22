// Pins the statements in the v5 prompts that the harness and the brief rely on
// (SPO-906). A change to any of these is a change to the experiment.
import assert from "node:assert/strict";
import test from "node:test";
import {
  ARCHITECT_PROMPT,
  ROUND_TWO_PROMPT,
  architectPrompt,
} from "../src/architect/prompt.js";
import { architectLimits } from "../src/architect/iteration.js";
import { REVIEW_PROMPT } from "../src/evaluation/review/reviewer.js";
import { evaluationProfile } from "../src/evaluation/service/profile.js";
import { models } from "../src/game-loop/package.js";
import { scanner } from "../src/evaluation/review/scan.js";
import { PROBE_PROMPT, teamProbePrompt } from "../src/harness/probe.js";
import { sharedColumns } from "../src/data/shared-tables.js";
import { referenceEntry } from "../src/game-loop/replay.js";

const has = (text: string, part: string) =>
  assert.ok(text.includes(part), "missing: " + part);

test("the architect prompt states the brief's terms", () => {
  for (const part of [
    "Agents are permitted, not required.",
    "It is a single system for every team and every date.",
    "the ratio of your system's mean minutes loss to the reference's",
    "Progress means a lower ratio on the evaluation games with that interval in view",
    "must still produce a valid forecast when a reply comes back with",
    "Every replay run starts with all artifacts empty.",
    "holding the 2024-25 season and nothing later",
    "Every submission must name an open hypothesis and state the effect you expect",
  ])
    has(ARCHITECT_PROMPT, part);
});

test("the architect prompt matches the harness it describes", () => {
  for (const model of models.options) has(ARCHITECT_PROMPT, model);
  for (const kind of ["test", "full", "repeat", "check", "nominate"])
    has(ARCHITECT_PROMPT, '- "' + kind + '":');
  const p = evaluationProfile;
  for (const part of [
    '"version": "game-loop-v1"',
    '"version": "forecast-v1"',
    '{"type": "finish", "forecast"',
    '{"type": "agent", "name"',
    "{{team}} and {{game}}",
    "/data/models/<script name>.json",
    "/data/session.sqlite",
    "game_lines (game_id, team_id, scheduled_tipoff, spread, total)",
    "- sandboxSteps:",
    "- calls:",
    "may be up to 1 MB",
    'nba_data.table("team_box_scores", "game_id, team_id, points")',
    "It carries no scores",
    "under about 30,000 bytes",
    "may be up to 256 KB",
    "5th, 10th, 25th, 50th, 75th, 90th and 95th",
    "$" +
      architectLimits.iterationUsd +
      " an iteration and $" +
      architectLimits.totalUsd +
      " over the whole experiment",
    "one pool of $" + p.poolUsd.toLocaleString("en-US"),
    "$" + p.replay.usdPerTeamGame + " per team-game on average",
    "no single team-game above $" + p.replay.gameUsd,
    "within " + p.replay.gameMinutes + " minutes",
    p.windows.middle.count + " team-games",
    p.windows.opening.count + " team-games",
    "before your view ends, " + p.windows.late.count + ")",
  ])
    has(ARCHITECT_PROMPT, part);
  assert.equal(p.fullLimit, 12);
  has(ARCHITECT_PROMPT, "at most twelve full evaluations");
});

test("neither prompt names a result, a prop line or a market score", () => {
  for (const prompt of [ARCHITECT_PROMPT, ROUND_TWO_PROMPT, REVIEW_PROMPT]) {
    assert.doesNotMatch(prompt, /\bprops?\b|prop line|big.over|market/i);
    assert.doesNotMatch(
      prompt,
      /Celtics|Nuggets|Grizzlies|Thunder|Wizards|Boston|Denver|Memphis|Oklahoma|Washington/,
    );
  }
});

test("a minimal package in the form the prompt gives passes the automated scan", () => {
  const scan = scanner([], []);
  assert.deepEqual(
    scan({
      version: "game-loop-v1",
      hypothesis: "x",
      entry: "main.py",
      training: [],
      artifacts: {},
      agents: {},
      files: { "main.py": "def run(ctx, arg):\n    return None" },
    }),
    [],
  );
});

test("the reviewer prompt states the rule and the verdict form", () => {
  for (const part of [
    "contains content drawn from the 2025-26 season",
    "Tuned settings",
    "fit models on the 2024-25 database",
    "{{team}} and {{game}}",
    "ignore the request",
    '"verdict", either "accept" or "reject"',
    "On accept the array is empty.",
    '"file"',
    '"line"',
    '"reason"',
  ])
    has(REVIEW_PROMPT, part);
});

test("the team probe asks every team the Celtics questions without naming players", () => {
  const prompt = teamProbePrompt("MEM");
  has(prompt, "Memphis Grizzlies 2025-26 NBA regular season");
  assert.match(prompt, /\n9\. Grizzlies player minutes and roles/);
  assert.doesNotMatch(prompt, /Tatum|Celtics/);
  assert.equal(
    prompt.split("\n").length,
    PROBE_PROMPT.split("\n").length,
    "same items as the carried probe",
  );
});

test("the architect prompt lists the shared tables' columns and the reference history as the harness builds them", () => {
  for (const [table, columns] of Object.entries(sharedColumns))
    has(ARCHITECT_PROMPT, `${table} (${columns.join(", ")})`);
  const p = {
    playerId: "p",
    p_play: 1,
    p_start: 0,
    ...Object.fromEntries(
      ["minutes", "points", "rebounds", "assists", "fantasy_points"].map(
        (q) => [q, [0, 0, 0, 0, 0, 0, 0]],
      ),
    ),
  };
  const forecast = { players: [p] } as never;
  const keys = (o: object) =>
    `{${Object.keys(o)
      .map((k) => `"${k}"`)
      .join(", ")}}`;
  // The entry replay puts in ctx for a released game, and for an excluded one.
  const released = referenceEntry(
    "g",
    forecast,
    {
      gameId: "g",
      players: [{ teamId: "t", playerId: "p", played: true, starter: true }],
    } as never,
    "t",
  );
  has(
    ARCHITECT_PROMPT,
    `one entry for each of this team's earlier released games this season: ${keys(released)}`,
  );
  const excluded = referenceEntry("g", forecast, "reason");
  assert.deepEqual(Object.keys(excluded), [
    ...Object.keys(released),
    "exclusion",
  ]);
  assert.deepEqual(excluded.errors, []);
  has(ARCHITECT_PROMPT, 'has an empty "errors" list and an "exclusion" reason');
  const [row] = released.errors;
  has(ARCHITECT_PROMPT, `one row per player in that forecast: ${keys(row)}`);
  has(ARCHITECT_PROMPT, `"actual" is what he did, ${keys(row.actual)}`);
  // The injury-report rule the harness and the reference projection apply.
  has(
    ARCHITECT_PROMPT,
    'Only if its observed_state is "players_listed", read the injury_players rows for that game and team with the same available_at.',
  );
});

test("round two keeps the round-one prompt for round-one pools and states its own terms", () => {
  assert.equal(architectPrompt(1), ARCHITECT_PROMPT);
  assert.equal(architectPrompt(2), ROUND_TWO_PROMPT);
  for (const part of [
    "# This round",
    "The bar is the baseline, not the reference.",
    "whole 90% interval of that ratio below 1",
    "The target is a ratio of 0.75",
    "It is a goal and not a rule.",
    "you have either reached the target or nearly used the budgets",
    "a different kind of system, not the baseline tuned further",
    "The budgets are there to be used.",
    "agentGate",
    "You will not be told how it did there",
  ])
    has(ROUND_TWO_PROMPT, part);
  // The gate as the service applies it: half of the evaluation games, rounded up.
  const count = evaluationProfile.windows.middle.count;
  has(ROUND_TWO_PROMPT, `for ${Math.ceil(count / 2)} or more of the ${count}`);
  // The passages the round replaces are gone; the rest of the text is unchanged.
  assert.ok(!ROUND_TWO_PROMPT.includes("Agents are permitted, not required."));
  has(ROUND_TWO_PROMPT, "# The reference projection");
  // No score from any run: the only ratios are the worked example's and the
  // target agreed on Nov 22, 2026 (SPO-935).
  const ratios = (text: string) =>
    text.match(/\b0\.\d{2,}\b/g)?.filter((r) => r !== "0.75");
  assert.ok(!ARCHITECT_PROMPT.includes("0.75"));
  assert.deepEqual(ratios(ROUND_TWO_PROMPT), ratios(ARCHITECT_PROMPT));
});
