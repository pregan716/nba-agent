import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Iteration } from "../src/architect/iteration.js";
test("architect caps count unresolved spend and serialize iterations across handles", (t) => {
  const root = mkdtempSync(join(tmpdir(), "architect-ledger-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  for (let n = 0; n < 11; n++) {
    const iteration = new Iteration(root);
    try {
      assert.equal(iteration.budget().sessionUsd, 30);
      assert.throws(() => iteration.reserve(30.01), /budget/);
      const settle = iteration.reserve(30);
      assert.throws(() => new Iteration(root), /locked/);
      if (n !== 0) settle(30); // Simulate a lost provider reply in the first iteration.
      assert.equal(iteration.budget().sessionUsd, 0);
    } finally {
      iteration.close();
    }
  }
  const last = new Iteration(root);
  try {
    assert.deepEqual(last.budget(), { sessionUsd: 20, totalUsd: 20 });
    assert.throws(() => last.reserve(21), /budget/);
    last.reserve(20)(20);
    assert.equal(last.budget().totalUsd, 0);
  } finally {
    last.close();
  }
});
