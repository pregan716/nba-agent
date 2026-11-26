// The architect on a model from another provider (SPO-939): what is sent, what
// is held before a request and what is charged after it, for each wire format.
import { fixtureReview } from "./review-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fixtureCorpus } from "./fixtures/session/corpus.js";
import type { EvaluationHost } from "../src/evaluation/service/index.js";
import { evaluationProfile } from "../src/evaluation/service/profile.js";
import { Iteration, architectLimits } from "../src/architect/iteration.js";
import { architectIteration } from "../src/architect/session.js";
import {
  architectModels,
  architectProvider,
  dearestRates,
  sameModel,
  type ArchitectModel,
} from "../src/architect/providers.js";
import {
  otherProvider,
  turnUsage,
  type Wire,
} from "./fixtures/architect-other-providers.js";

// Dollars per million tokens, written out here so that a change in the
// library's price table is a failing test and not a silent change of budget.
const cases: {
  model: ArchitectModel;
  wire: Wire;
  keyEnv: string;
  price: { input: number; cached: number; output: number };
  // The dearest input and output prices, across price tiers.
  hold: { input: number; output: number };
  limit: (body: any) => unknown;
  effort: (body: any) => unknown;
  tools: (body: any) => string[];
}[] = [
  {
    model: "gpt-6.2-sol",
    wire: "responses",
    keyEnv: "OPENAI_API_KEY",
    price: { input: 2, cached: 0.1, output: 10 },
    hold: { input: 5, output: 15 },
    limit: (b) => b.max_output_tokens,
    // The adapter states the effort in a configuration item of the input.
    effort: (b) =>
      b.input.findLast(
        (i: { type?: string }) => i.type === "configuration_update",
      ).reasoning.effort,
    // The adapter declares the tools in an item of the input as well.
    tools: (b) =>
      b.input
        .filter((i: { type?: string }) => i.type === "additional_tools")
        .flatMap((i: { tools: { name: string }[] }) => i.tools)
        .map((t: { name: string }) => t.name),
  },
  {
    model: "gemini-4-neon",
    wire: "gemini",
    keyEnv: "GEMINI_API_KEY",
    price: { input: 3, cached: 0.15, output: 15 },
    hold: { input: 3, output: 15 },
    limit: (b) => b.generationConfig.maxOutputTokens,
    effort: (b) => b.generationConfig.thinkingConfig.thinkingLevel,
    tools: (b) =>
      b.tools.flatMap((t: { functionDeclarations: { name: string }[] }) =>
        t.functionDeclarations.map((d) => d.name),
      ),
  },
  {
    model: "moonshotai/Kimi-K3.1-Pro",
    wire: "completions",
    keyEnv: "BASETEN_API_KEY",
    price: { input: 2, cached: 0.2, output: 10 },
    hold: { input: 2, output: 10 },
    limit: (b) => b.max_tokens,
    effort: (b) => b.reasoning_effort,
    tools: (b) =>
      b.tools.map((t: { function: { name: string } }) => t.function.name),
  },
];

function host(root: string): EvaluationHost {
  const f = fixtureCorpus();
  const unused = async (): Promise<never> => {
    throw Error("Unexpected call");
  };
  return {
    root,
    profile: structuredClone(evaluationProfile),
    config: f.config,
    review: fixtureReview,
    runAgent: unused,
    source: {
      data: f.source,
      schedule: [],
      projection: unused,
      outcomes: unused,
    },
    training: {
      gameLines: unused,
      games: [],
      data: {
        identities: f.source.identities,
        async columns() {
          return [];
        },
        async *exportHistory() {},
      },
      evidence: [],
      rosters: new Map(),
      corpus: { injuries: { async *partitions() {} } },
    },
  };
}
const call = (name: string) => ({ name, input: {} });
const ledger = (root: string) => {
  const db = new DatabaseSync(join(root, "architect.sqlite"), {
    readOnly: true,
  });
  try {
    return db
      .prepare(
        "SELECT status,spent,held FROM iterations ORDER BY rowid DESC LIMIT 1",
      )
      .get()! as { status: string; spent: number; held: number };
  } finally {
    db.close();
  }
};

test("the permitted architect models and the price tables the holds use", () => {
  assert.deepEqual(
    [...architectModels],
    ["claude-opus-5-5", "claude-opus-4-6", ...cases.map((c) => c.model)],
  );
  for (const c of cases) {
    const p = architectProvider(c.model);
    assert.equal(p.model.id, c.model);
    assert.equal(p.keyEnv, c.keyEnv);
    assert.deepEqual(
      {
        input: p.model.cost.input,
        cached: p.model.cost.cacheRead,
        output: p.model.cost.output,
      },
      c.price,
    );
    assert.deepEqual(dearestRates(p.model), c.hold);
  }
  // The rounds' architect is held as before: every input token a cache write.
  assert.deepEqual(dearestRates(architectProvider().model), {
    input: 5,
    output: 20,
  });
  assert.ok(sameModel("gpt-6.2-sol", "gpt-6.2-sol-2026-11-03"));
  assert.ok(sameModel("gemini-4-neon", "models/gemini-4-neon"));
  assert.ok(sameModel("moonshotai/Kimi-K3.1-Pro", "moonshotai/kimi-k3.1-pro"));
  assert.ok(!sameModel("gpt-6.2-sol", "gpt-6.2-solar"));
  assert.ok(!sameModel("gpt-6.2-sol", "gpt-6.1-sol"));
});

for (const c of cases)
  test(`${c.model}: requests, holds, retries and charges`, async (t) => {
    const provider = await otherProvider();
    t.after(() => provider.close());
    const root = mkdtempSync(join(tmpdir(), "architect-provider-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const options = { ...provider.options, model: c.model };

    provider.steps.push(
      { calls: [call("budget")] },
      // After an HTTP 429: the request was refused, so its hold is released.
      { calls: [call("hypotheses")] },
      // After an HTTP 500: the request may have been billed, so its hold stands.
      { calls: [call("budget")] },
      // The stream stops short: the hold stands and the turn is asked again.
      { calls: [call("budget")], disconnected: true },
      { calls: [call("budget")] },
      // No usage report: the turn is charged its whole hold.
      { calls: [call("hypotheses")], noUsage: true },
    );
    // Each failure is taken by the next request that arrives.
    const original = provider.steps.shift.bind(provider.steps);
    let turn = 0;
    provider.steps.shift = () => {
      turn++;
      if (turn === 1) provider.failures.push(429);
      if (turn === 2) provider.failures.push(500);
      return original();
    };
    // With no turn left the fixture answers 400, which ends the session.
    await assert.rejects(
      architectIteration(host(root), options),
      /Architect provider HTTP 400/,
    );
    assert.equal(provider.steps.length, 0);

    const [first] = provider.requests;
    assert.equal(first.wire, c.wire);
    assert.equal(first.key, "sk-fixture");
    assert.equal(c.limit(first.body), 32000);
    assert.match(String(c.effort(first.body)), /^high$/i);
    for (const name of ["submit", "data_python", "document_write"])
      assert.ok(c.tools(first.body).includes(name), name);
    assert.match(JSON.stringify(first.body), /# The reference projection/);

    const u = turnUsage;
    const turnCost =
      (u.input - u.cached) * c.price.input +
      u.cached * c.price.cached +
      u.output * c.price.output;
    // A hold is the whole output allowance plus the input, bounded by the size
    // of the request (tens of kilobytes) at the dearest input price.
    const isHold = (nanoUsd: number, label: string) => {
      const input = nanoUsd / 1000 - 32000 * c.hold.output;
      assert.ok(
        input > 20000 * c.hold.input && input < 400000 * c.hold.input,
        label + " " + nanoUsd,
      );
    };
    const row = ledger(root);
    assert.equal(row.status, "failed");
    // Four turns with a usage report, and one charged its hold.
    isHold(row.spent - 4 * turnCost * 1000, "charged without usage");
    // The HTTP 500 and the disconnect each keep a hold. The 429 and the final
    // 400 kept none.
    isHold(row.held / 2, "retained");
    assert.ok(row.spent - 4 * turnCost * 1000 > turnCost * 1000);

    // The pool belongs to this model from its first iteration on.
    await assert.rejects(
      architectIteration(host(root), {
        ...provider.options,
        model: "claude-opus-5-5",
      }),
      new RegExp(
        "This pool's architect model is " + c.model.replace(/[.]/g, "\\."),
      ),
    );
  });

for (const c of cases)
  test(`${c.model}: the output limit shrinks to the balance and the iteration ends on budget`, async (t) => {
    const provider = await otherProvider();
    t.after(() => provider.close());
    const root = mkdtempSync(join(tmpdir(), "architect-provider-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    // Earlier iterations left thirty cents of the total, less than one full hold.
    const earlier = new Iteration(root);
    earlier.status = "full";
    earlier.close();
    const db = new DatabaseSync(join(root, "architect.sqlite"));
    db.prepare("UPDATE iterations SET spent=?").run(
      (architectLimits.totalUsd - 0.3) * 1e9,
    );
    db.close();

    provider.steps.push({ calls: [call("budget")], noUsage: true });
    const result = await architectIteration(host(root), {
      ...provider.options,
      model: c.model,
    });
    assert.equal(result.status, "budget");
    assert.equal(provider.requests.length, 1);
    const limit = Number(c.limit(provider.requests[0].body));
    assert.ok(limit >= 16 && limit < 32000, String(limit));
    // The hold took the balance to within one output token, and was charged.
    const row = ledger(root);
    assert.equal(row.held, 0);
    assert.ok(row.spent <= 0.3e9);
    assert.ok(0.3e9 - row.spent < c.hold.output * 1000, String(row.spent));
  });

test("a reply from a different model than the one asked for stops the session", async (t) => {
  const provider = await otherProvider();
  t.after(() => provider.close());
  const root = mkdtempSync(join(tmpdir(), "architect-provider-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Baseten's own name for the model is accepted; another model's is not.
  provider.steps.push(
    { calls: [call("budget")], model: "moonshotai/Kimi-K3.1" },
    { calls: [call("budget")], model: "moonshotai/Kimi-K3" },
  );
  await assert.rejects(
    architectIteration(host(root), {
      ...provider.options,
      model: "moonshotai/Kimi-K3.1-Pro",
    }),
    /Unexpected architect model/,
  );
  assert.equal(provider.requests.length, 2);
});

test("a missing credential stops the session before any request", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "architect-provider-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(() => {
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
  });
  await assert.rejects(
    architectIteration(host(root), { model: "gpt-6.2-sol" }),
    /Missing architect provider credentials/,
  );
});
