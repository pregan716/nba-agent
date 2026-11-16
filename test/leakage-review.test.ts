import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanner } from "../src/evaluation/review/scan.js";
import {
  review,
  approvedPackage,
  restoreAcceptance,
  humanReviews,
} from "../src/evaluation/review/index.js";
import { reviewer, REVIEW_PROMPT } from "../src/evaluation/review/reviewer.js";
import { readPackage, type Package } from "../src/game-loop/package.js";
import { fixtureReview } from "./review-fixture.js";

const clean: Package = {
  entry: "main.py",
  version: "game-loop-v1",
  hypothesis: "Fit on 2024-25.",
  training: [],
  artifacts: {},
  files: { "main.py": "def run(ctx, arg):\n    return ctx['reference']" },
  agents: {
    a: {
      model: "claude-haiku-4-5-20251001",
      prompt: "Estimate minutes.",
      tools: {},
      skills: [],
    },
  },
};
const scan = scanner([
  { kind: "player", value: "Nikola Jokić" },
  { kind: "player", value: "203999" },
  { kind: "team", value: "Denver Nuggets" },
  { kind: "team", value: "1610612743" },
  { kind: "coach", value: "David Adelman" },
  { kind: "coach", value: "1626369" },
]);
test("general basketball prompts and ordinary Python identifiers pass season identity checks", () => {
  const season = scanner(
    [
      { kind: "player", value: "Trae Young" },
      { kind: "player", value: "Jrue Holiday" },
      { kind: "coach", value: "Cooper Little" },
      { kind: "player", value: "201939" },
    ],
    [
      {
        team_id: "1610612750",
        name: "Minnesota Timberwolves",
        abbreviation: "MIN",
      },
      { team_id: "1610612748", name: "Miami Heat", abbreviation: "MIA" },
      { team_id: "1610612753", name: "Orlando Magic", abbreviation: "ORL" },
    ],
  );
  const pkg = {
    ...clean,
    agents: {
      a: {
        ...clean.agents.a,
        prompt: [
          "Young players and players returning from injury carry more uncertainty, so widen their ranges.",
          "Little evidence of rest days is available.",
          "Holiday schedules can compress games.",
        ].join("\n"),
      },
    },
    files: {
      "main.py": [
        "MIN_MINUTES = 5",
        "IND = 1",
        "DEN = 2",
        "DET = 3",
        "SAS = 4",
        "magic_number = 3",
        "def heat(x):",
        "    return x * magic_number",
        "def run(ctx, arg):",
        "    heat_level = heat(MIN_MINUTES)",
        "    return ctx['reference']",
      ].join("\n"),
    },
  };
  assert.deepEqual(season(pkg), []);
  for (const leak of [
    "Trae Young",
    "Jrue Holiday",
    "Cooper Little",
    "Miami Heat",
    "Heat",
    "Magic",
    "201939",
  ])
    assert.ok(
      season({ ...pkg, hypothesis: leak }).some((f) => f.file === "hypothesis"),
      leak,
    );
});
test("scanner checks package keys, every source line and nested metadata", () => {
  assert.deepEqual(scan(clean), []);
  for (const leak of [
    "Nikola Jokic",
    "203999",
    "Denver Nuggets",
    "1610612743",
    "David Adelman",
    "1626369",
    "2026-01-20T00:00:00Z",
    "January 20, 2026",
    "0022500001",
    "a\x00b",
    "model_weights = [1, 0]",
  ]) {
    const result = scan({
      ...clean,
      files: { "main.py": "# clean\n# " + leak },
    });
    assert.ok(
      result.some((f) => f.file === "main.py" && f.line === 2),
      leak,
    );
  }
  assert.ok(
    scan({ ...clean, files: { "weights.safetensors": "payload" } }).some(
      (f) => f.file === "weights.safetensors",
    ),
  );
  assert.ok(scan({ artifacts: { Denver_Nuggets: "league" } }).length);
  assert.ok(
    scan({ agents: { a: { skills: ["Look up David Adelman."] } } }).some(
      (f) => f.file === "agents/a/skills/0",
    ),
  );
});
test("review isolates the request, records costs on invalid output and binds approval to the reviewed bytes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "review-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  let text = '{"verdict":"accept","reasons":[]}';
  const gate = {
    scan,
    reviewer: reviewer(async (request) => {
      calls++;
      assert.deepEqual(Object.keys(request).sort(), [
        "max_tokens",
        "messages",
        "model",
        "output_config",
        "system",
        "thinking",
      ]);
      assert.deepEqual(request.thinking, { type: "adaptive" });
      assert.equal(request.output_config?.effort, "high");
      assert.equal(request.max_tokens, 16000);
      assert.equal(request.system, REVIEW_PROMPT);
      assert.equal(request.model, "claude-opus-4-6");
      assert.equal(request.messages.length, 1);
      assert.equal(request.messages[0].role, "user");
      assert.deepEqual(JSON.parse(String(request.messages[0].content)), clean);
      return {
        usage: { input_tokens: 100, output_tokens: 20 },
        stop_reason: "end_turn",
        // The verdict is read past a thinking block.
        content: [
          { type: "thinking", thinking: "…", signature: "s" },
          { type: "text", text, citations: null },
        ],
      } as Awaited<ReturnType<NonNullable<Parameters<typeof reviewer>[0]>>>;
    }),
  };
  const accepted = await review(root, gate, clean);
  assert.equal(approvedPackage(accepted).hash, readPackage(clean).hash);
  assert.throws(() => approvedPackage(structuredClone(accepted)), /review/);
  assert.equal(
    approvedPackage(restoreAcceptance(root, structuredClone(clean))).hash,
    readPackage(clean).hash,
  );
  accepted.hypothesis = "new";
  assert.throws(
    () => restoreAcceptance(root, accepted),
    /No recorded acceptance/,
  );
  assert.throws(() => approvedPackage(accepted), /review/);
  const rows = humanReviews(root) as {
    id: string;
    hash: string;
    reviewerUsd: number;
  }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hash, readPackage(clean).hash);
  assert.equal(rows[0].reviewerUsd, 0.001);
  const inspect = async (input: unknown, expected: RegExp) => {
    let id = "";
    await assert.rejects(review(root, gate, input), (e) => {
      const message = String(e);
      assert.match(message, expected);
      id = message.match(/review ([\da-f-]+) rejected/)![1];
      return true;
    });
    return humanReviews(root, id) as Record<string, unknown>;
  };
  const blocked = await inspect(
    { ...clean, files: { "model.pkl": "blob" } },
    /model.pkl:1/,
  );
  assert.equal(blocked.reviewerUsd, 0);
  assert.equal(blocked.reviewerVerdict, null);
  assert.equal(calls, 1);
  text =
    '{"verdict":"reject","reasons":[{"file":"main.py","line":2,"reason":"Season-specific habit"}]}';
  assert.equal(
    (await inspect(clean, /main.py:2 Season-specific habit/)).reviewerVerdict,
    "reject",
  );
  text = "incomplete";
  assert.equal((await inspect(clean, /invalid decision/)).reviewerUsd, 0.001);
  assert.equal(calls, 3);
  assert.deepEqual(
    (humanReviews(root, rows[0].id) as Record<string, unknown>).configuration,
    clean,
  );
  await assert.rejects(
    review(
      root,
      {
        ...fixtureReview,
        reviewer: async () => {
          throw Object.assign(Error("Unauthorized"), { status: 401 });
        },
      },
      clean,
    ),
    /Ask the operator to check the reviewer/,
  );
});

test("review honours a rate limit beyond its retry window and records zero billed usage", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "review-rate-limit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const retryAfter of [
    "120",
    new Date(Date.now() + 120000).toUTCString(),
  ]) {
    let calls = 0;
    let id = "";
    await assert.rejects(
      review(
        root,
        {
          ...fixtureReview,
          reviewer: async () => {
            assert.equal(++calls, 1);
            throw Object.assign(Error("rate limited"), {
              status: 429,
              headers: new Headers({ "retry-after": retryAfter }),
            });
          },
        },
        clean,
        (receipt) => {
          id = receipt.id;
        },
      ),
      /Submit the configuration again/,
    );
    assert.equal(calls, 1);
    const record = humanReviews(root, id) as Record<string, unknown>;
    assert.equal(record.verdict, "failed");
    assert.equal(record.reviewerUsd, 0);
    assert.equal(record.reviewerVerdict, null);
  }
});
