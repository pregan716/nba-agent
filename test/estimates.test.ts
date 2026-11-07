import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasAssertedEstimate,
  summarizeEstimates,
} from "../src/replay/estimates.js";
import { digest } from "../src/runner/config.js";
import type { WindowResult } from "../src/replay/types.js";

test("assertion heuristic covers decimal and percentage estimates in either order", () => {
  for (const text of [
    "Sub probability estimate: 0.06",
    "Exit estimate: 0.43",
    "Substitution analysis: somewhat unlikely (25% estimate)",
    "estimated probability 8%",
    "likelihood of substitution: .4",
    "probability = 1",
    "The probability is 0.06.",
    "0 percent likelihood",
  ])
    assert.equal(hasAssertedEstimate(text), true, text);
  for (const text of [
    "played 25 minutes",
    "probability unknown",
    "estimated minutes: 25",
    "estimate: -0.2",
    "probability 1.2",
    "estimated 150%",
    "player123 probability",
  ])
    assert.equal(hasAssertedEstimate(text), false, text);
});

const scope = "game:input:policy";
function fixture(
  id: number,
  text: string,
  diagnostics: Record<string, unknown>,
  answer: unknown = 0.4,
) {
  const result = {
    window: { state: { sequence: id }, exclusions: [] },
    raw: { substitution: { noul: answer } },
    failure: null,
    validation: { questions: { substitution: { valid: true } } },
  } as unknown as WindowResult;
  const event = {
    kind: "policy_assembly",
    scope: `${scope}:${digest(result.window.state)}`,
    data: {
      assembly: { diagnostics },
      request: { state: text, questions: {} },
    },
  };
  return { result, event };
}

test("counts windows once, scans each request text surface, and keeps diagnostics private", () => {
  const a = fixture(1, "estimated 20% and probability .3", { sub_prob: 0.2 });
  const b = fixture(2, "plain state", {
    sub_prob: 0.5,
    note: "probability 0.4",
  });
  const c = fixture(3, "", { p_sub: 0.4 });
  c.event.data.request.questions = {
    substitution: {
      instructions: "likelihood .4",
      criteria: { true: "probability .4" },
    },
  };
  const d = fixture(4, "", {});
  d.event.data.request.questions = { entry: { criteria: ["estimated 30%"] } };
  const summary = summarizeEstimates(
    [a.result, b.result, c.result, d.result],
    scope,
    [a.event, a.event, b.event, c.event, d.event],
  );
  assert.equal(summary.assertedEstimates, 3);
  assert.equal(summary.jevAgreementWithDiagnostics?.count, 3);
  assert.ok(
    Math.abs(
      summary.jevAgreementWithDiagnostics!.meanAbsoluteDifference - 0.1,
    ) < 1e-12,
  );
});

test("agreement excludes missing, invalid and fallback answers and uses one stable eligible diagnostic", () => {
  const rows = [
    fixture(1, "", { nested: { sub: 0.2 }, sub_prob: "0.2" }),
    fixture(2, "", { sub_prob: -1, substitution: 2 }),
    fixture(3, "", { sub_prob: 0.2 }, null),
    fixture(4, "", { sub_prob: 0.2 }, 0.5),
    fixture(5, "probability .2", { sub_prob: 0.2 }),
    fixture(6, "", { sub_prob: 0.2 }),
    fixture(7, "", { sub_prob: 0.9, p_sub: 0.1, substitution: 0.8 }),
  ];
  rows[3].result.validation!.questions.substitution.valid = false;
  rows[4].result.window.exclusions = ["excluded"] as any;
  rows[5].result.failure = "provider_failure";
  const summary = summarizeEstimates(
    rows.map((r) => r.result),
    scope,
    rows.map((r) => r.event),
  );
  assert.equal(summary.assertedEstimates, 0);
  assert.equal(summary.jevAgreementWithDiagnostics?.count, 1);
  assert.ok(
    Math.abs(
      summary.jevAgreementWithDiagnostics!.meanAbsoluteDifference - 0.3,
    ) < 1e-12,
  );
  assert.deepEqual(summarizeEstimates([], scope, []), {
    assertedEstimates: 0,
    jevAgreementWithDiagnostics: null,
  });
});
