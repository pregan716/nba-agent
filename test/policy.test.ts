import { PackageExecutionError } from "../src/policy/errors.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  symlinkSync,
  chmodSync,
  readdirSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../src/data/store.js";
import {
  genericAssembly,
  buildJevRequest,
  mapJevAnswers,
  JEV_MODEL,
} from "../src/policy/request.js";
import { PackageStore, packageFiles } from "../src/policy/package.js";
import { PolicyTools } from "../src/policy/tools.js";
import { Workspace, WorkspacePolicy } from "../src/env/workspace.js";
import { RecordStore } from "../src/runner/record.js";
import { MeteringProxy } from "../src/runner/proxy.js";
import { JevHttpError } from "../src/runner/jev.js";
import { validatePrediction } from "../src/replay/contract.js";
import {
  REPLAY_VERSIONS,
  type ObservableState,
  type DecisionDataset,
} from "../src/replay/types.js";
import {
  policyHarness,
  policyVersion,
  replayPolicy,
} from "../src/policy/replay.js";
import { probeJev } from "../src/policy/probe.js";
import type { Assembler } from "../src/policy/sandbox.js";
const state = {
  schemaVersion: "state-v1",
  gameId: "g",
  celtics: ["a", "b", "c", "d", "e"],
  eligibleBench: ["f", "g"],
} as unknown as ObservableState;
const signal = () => new AbortController().signal;
const image = "local@sha256:" + "a".repeat(64);
const assembler: Assembler = {
  image,
  limits: {
    wallSeconds: 10,
    memoryBytes: 128 * 1024 * 1024,
    outputBytes: 100000,
  },
  run: async (_p, s, _signal, mode) => ({
    value:
      mode === "load"
        ? { loaded: true }
        : genericAssembly(s as ObservableState),
    computeSeconds: 0.01,
  }),
};
function remove(path: string) {
  function unlock(p: string) {
    if (lstatSync(p).isDirectory()) {
      chmodSync(p, 0o700);
      for (const n of readdirSync(p)) unlock(join(p, n));
    }
  }
  unlock(path);
  rmSync(path, { recursive: true, force: true });
}
const temp = () => mkdtempSync(join(tmpdir(), "policy-test-"));
function source(root: string) {
  mkdirSync(root, { recursive: true });
  const code = Buffer.from("def assemble(state): return {}\n");
  writeFileSync(join(root, "assemble.py"), code);
  writeFileSync(
    join(root, "manifest.json"),
    JSON.stringify({
      stateVersion: "state-v1",
      components: { "assemble.py": sha256(code) },
      notes: "fixture",
    }),
  );
}
const response = (request: any) => ({
  model: JEV_MODEL,
  answers: Object.fromEntries(
    Object.entries(request.questions).map(([q, v]: [string, any]) => [
      q,
      q === "substitution"
        ? { type: "noul", noul: 0.8 }
        : {
            type: v.type,
            probabilities: Object.fromEntries(
              (Array.isArray(v.criteria)
                ? v.criteria.map((_: any, i: number) => String(i))
                : Object.keys(v.criteria)
              ).map((k: string) => [
                k,
                1 /
                  (Array.isArray(v.criteria)
                    ? v.criteria.length
                    : Object.keys(v.criteria).length),
              ]),
            ),
          },
    ]),
  ),
  usage: { input_tokens: 100, output_tokens: 10 },
});
const analyst = {
  count: async () => 0,
  create: async () => {
    throw Error("Analyst forbidden");
  },
};

test("request keys fixed, numeric score mapping exact, invalid entry falls back alone, size guard", () => {
  const request = buildJevRequest(genericAssembly(state), state);
  assert.deepEqual(Object.keys(request.questions).sort(), [
    "count",
    "entry",
    "exit",
    "substitution",
  ]);
  const raw = response(request);
  raw.answers.entry.probabilities = { f: 1 };
  const validated = validatePrediction(mapJevAnswers(raw.answers), state);
  assert.equal(validated.questions.entry.valid, false);
  assert.equal(validated.questions.exit.valid, true);
  assert.equal(validated.questions.count.valid, true);
  assert.equal(validated.answers.substitution.noul, 0.8);
  assert.deepEqual(validated.answers.entry.probabilities, { f: 0.5, g: 0.5 });
  const assembly = genericAssembly(state);
  assembly.criteria.entry["future-player"] = "leak";
  assert.throws(() => buildJevRequest(assembly, state), /keys differ/);
  assembly.criteria.entry = genericAssembly(state).criteria.entry;
  assembly.jev_state = "a".repeat(33000);
  assert.throws(() => buildJevRequest(assembly, state), /context upper bound/);
  raw.answers.count.probabilities = { "0": 1, "1": 0, "2": 0, "3": 0, none: 0 };
  assert.equal(
    validatePrediction(mapJevAnswers(raw.answers), state).questions.count.valid,
    false,
  );
});

test("freeze is atomic, idempotent, hash checked, cutoff enforced, and workspace tools cannot change it", async () => {
  const root = temp(),
    workspace = join(root, "workspace"),
    path = join(workspace, "packages/g");
  source(path);
  try {
    const packages = new PackageStore(join(root, "frozen-packages"));
    const receipt = await packages.freeze(
      "g",
      path,
      () => "2025-01-01T00:00:00Z",
      "2025-01-02T00:00:00Z",
      assembler,
      signal(),
    );
    assert.deepEqual(
      await packages.freeze(
        "g",
        path,
        () => "2025-01-01T00:00:00Z",
        "2025-01-02T00:00:00Z",
        assembler,
        signal(),
      ),
      receipt,
    );
    const w = new Workspace(
      workspace,
      new WorkspacePolicy(
        {
          version: "memory-v1",
          horizon: "season",
          revision: "editable",
          process: "voluntary",
        },
        () => "pregame",
      ),
      root,
      "g",
    );
    for (const operation of ["write", "append", "delete"] as const)
      assert.throws(
        () =>
          w.mutate(operation, "packages/g/assemble.py", Buffer.from("changed")),
        /frozen/,
      );
    assert.throws(() => w.authorize("write", "packages/g/new.py"), /frozen/);
    assert.throws(() => w.mkdir("packages/g/other"), /frozen/);
    assert.throws(() => w.read("packages/other/assemble.py"), /unavailable/);
    await assert.rejects(
      packages.freeze(
        "late",
        path,
        () => "2025-01-02T00:00:00Z",
        "2025-01-02T00:00:00Z",
        assembler,
        signal(),
      ),
      /cutoff/,
    );
    writeFileSync(join(path, "assemble.py"), "changed");
    assert.throws(() => packageFiles(path), /hash mismatch/);
    symlinkSync("/etc/passwd", join(path, "link"));
    assert.throws(() => packageFiles(path), /links/);
  } finally {
    remove(root);
  }
});

test("proxy records mismatch and usage, retries once on 429, refuses analyst route for Jev", async () => {
  const root = temp(),
    record = new RecordStore(root, { test: true });
  let calls = 0;
  const proxy = new MeteringProxy(analyst, {
    create: async (r) => {
      calls++;
      if (calls === 1) throw new JevHttpError(429, { detail: "busy" }, "0");
      return response(r);
    },
  });
  try {
    const out = await proxy.jev(
      buildJevRequest(genericAssembly(state), state),
      record,
      "test",
      signal(),
    );
    assert.equal(calls, 2);
    assert(Math.abs(out.usd! - 0.0000042) < 1e-15);
    assert.equal(record.events("jev_request").length, 2);
    const wrong = new MeteringProxy(analyst, {
      create: async (r) => ({ ...response(r), model: "jev-latest" }),
    });
    await assert.rejects(
      wrong.jev(
        buildJevRequest(genericAssembly(state), state),
        record,
        "wrong",
        signal(),
      ),
      /model mismatch/,
    );
    assert.equal(
      record.events("jev_response", "wrong")[0].data.modelValid,
      false,
    );
    let badCalls = 0;
    const bad = new MeteringProxy(analyst, {
      create: async () => {
        badCalls++;
        throw new JevHttpError(400, { detail: "bad" }, null);
      },
    });
    await assert.rejects(
      bad.jev(
        buildJevRequest(genericAssembly(state), state),
        record,
        "bad",
        signal(),
      ),
    );
    assert.equal(badCalls, 1);
  } finally {
    record.close();
    remove(root);
  }
});

test("feedback permits only previous pregame/current postgame after release, validation samples only prior games and no Jev", async () => {
  const root = temp(),
    workspace = join(root, "workspace");
  source(join(workspace, "packages/g"));
  const games = [
    {
      gameId: "old",
      scheduledStart: "2025-01-01T23:00:00Z",
      release: "2025-01-02T14:00:00Z",
    },
    {
      gameId: "previous",
      scheduledStart: "2025-01-03T23:00:00Z",
      release: "2025-01-04T14:00:00Z",
    },
    {
      gameId: "g",
      scheduledStart: "2025-01-05T23:00:00Z",
      release: "2025-01-06T14:00:00Z",
    },
    {
      gameId: "future",
      scheduledStart: "2025-01-07T23:00:00Z",
      release: "2025-01-08T14:00:00Z",
    },
  ];
  let now = "2025-01-04T23:00:00Z";
  const service = new PolicyTools(
    root,
    workspace,
    games[2],
    games,
    assembler,
    games.map((g) => ({
      gameId: g.gameId,
      state: { ...state, gameId: g.gameId },
    })),
    () => now,
  );
  try {
    for (const g of games)
      service.saveFeedback({
        gameId: g.gameId,
        releaseAt: g.release,
        windows: [],
      } as any);
    assert.equal(service.readFeedback("pregame").gameId, "previous");
    for (const id of ["old", "g", "future"])
      assert.throws(() => service.readFeedback("pregame", id), /unavailable/);
    assert.throws(() => service.readFeedback("postgame"), /unavailable/);
    const validated = await service.validate("pregame", 10, signal());
    assert.equal(validated.error, null);
    assert.deepEqual(readdirSync(join(root, "local-validation")), []);
    assert.deepEqual(
      validated.outputs.map((r: any) => r.gameId),
      ["old", "previous"],
    );
    now = games[2].release;
    assert.equal(service.readFeedback("postgame").gameId, "g");
    assert.throws(
      () => service.readFeedback("postgame", "previous"),
      /unavailable/,
    );
  } finally {
    remove(root);
  }
});

test("policy replay scores per-question fallback and resumes without another provider call; probe hides truth", async () => {
  const root = temp();
  let calls = 0;
  const proxy = new MeteringProxy(analyst, {
    create: async (r) => {
      calls++;
      const out = response(r);
      out.answers.entry && (out.answers.entry.probabilities = { bad: 1 });
      return out;
    },
  });
  const dataset = {
    gameId: "g",
    version: "windows-v2:release",
    inputHash: "input",
    release: { sha256: "release" },
    windows: [
      {
        id: "w",
        gameId: "g",
        kind: "in_period",
        state,
        actual: { players_out: ["a"], players_in: ["f"] },
        exclusions: [],
      },
    ],
    ledger: [],
  } as unknown as DecisionDataset;
  const version = policyVersion(assembler, null, "fixture");
  const record = new RecordStore<any>(root, {
    schemaVersion: 1,
    kind: "replay-mvp",
    releaseManifestSha256: "release",
    datasetVersion: dataset.version,
    datasets: [{ gameId: "g", inputHash: "input" }],
    harness: { ...REPLAY_VERSIONS, policy: policyHarness(assembler) },
    predictors: { generic: { id: "generic", policy: version } },
    codeRevision: "fixture",
  });
  const options = {
    dataset,
    predictorId: "generic",
    record,
    proxy,
    assembler,
    receipt: null,
    packagePath: "",
    signal: signal(),
    releaseAt: "2025-01-02T14:00:00Z",
    codeRevision: "fixture",
  };
  try {
    const trace = await replayPolicy(options);
    assert.equal(
      trace.windows[0].result.validation?.questions.entry.valid,
      false,
    );
    assert.equal(
      trace.windows[0].result.validation?.questions.exit.valid,
      true,
    );
    assert.notEqual(trace.windows[0].result.scores, null);
    await replayPolicy(options);
    assert.equal(calls, 1);
    const facts = [
      {
        id: "yes",
        question: "Did A win on date?",
        truth: true,
        source: "fixture",
      },
      {
        id: "no",
        question: "Did B win on date?",
        truth: false,
        source: "fixture",
      },
    ];
    const probe = await probeJev(facts, proxy, record, signal());
    assert.equal(probe.request.state, "");
    assert(!JSON.stringify(probe.request).includes('"truth"'));
    assert.equal(probe.chanceBrier, 0.25);
  } finally {
    record.close();
    remove(root);
  }
});

test("stateless policy workspace exposes only current package; legacy stateless remains closed", () => {
  const root = temp(),
    workspace = join(root, "workspace");
  source(join(workspace, "packages/g"));
  source(join(workspace, "packages/old"));
  writeFileSync(join(workspace, "memory.txt"), "other game");
  try {
    const memory = {
      version: "memory-v1",
      horizon: "stateless",
      revision: "editable",
      process: "voluntary",
    } as const;
    const w = new Workspace(
      workspace,
      new WorkspacePolicy(memory, () => "pregame", true),
      root,
      "g",
    );
    assert.deepEqual(
      w.list().entries.map((e) => e.path),
      ["packages"],
    );
    assert.deepEqual(
      w.list("packages").entries.map((e) => e.path),
      ["packages/g"],
    );
    w.mutate("write", "packages/g/new.txt", Buffer.from("draft"));
    assert.throws(() => w.read("memory.txt"), /Stateless/);
    const legacy = new Workspace(
      workspace,
      new WorkspacePolicy(memory, () => "pregame"),
      root,
    );
    assert.throws(() => legacy.read("packages/g/assemble.py"), /Stateless/);
  } finally {
    remove(root);
  }
});

test("freeze failure leaves no receipt and package stays editable", async () => {
  const root = temp(),
    path = join(root, "draft");
  source(path);
  try {
    const store = new PackageStore(join(root, "frozen"));
    await assert.rejects(
      store.freeze(
        "g",
        path,
        () => "2025-01-01T00:00:00Z",
        "2025-01-02T00:00:00Z",
        {
          ...assembler,
          run: async () => {
            throw Error("entry point missing");
          },
        },
        signal(),
      ),
      /entry point/,
    );
    assert.equal(store.receipt("g"), null);
    writeFileSync(join(path, "assemble.py"), "still editable");
  } finally {
    remove(root);
  }
});

test("first assembler exception invalidates the game; later exception scores fallback; oversized first request is assembler_error", async () => {
  for (const scenario of ["first", "later", "oversize"] as const) {
    const root = temp(),
      path = join(root, "draft");
    source(path);
    const packages = new PackageStore(join(root, "frozen"));
    let runs = 0;
    const selected: Assembler = {
      ...assembler,
      run: async (_p, s, _signal, mode) => {
        if (mode === "load")
          return { value: { loaded: true }, computeSeconds: 0 };
        runs++;
        if (scenario === "first" || (scenario === "later" && runs > 2))
          throw new PackageExecutionError("assembler raises");
        const a = genericAssembly(s as ObservableState);
        if (scenario === "oversize") a.jev_state = "x".repeat(33000);
        return { value: a, computeSeconds: 0 };
      },
    };
    const receipt = await packages.freeze(
      "g",
      path,
      () => "2025-01-01T00:00:00Z",
      "2025-01-02T00:00:00Z",
      selected,
      signal(),
    );
    const dataset = {
      gameId: "g",
      version: "windows-v2:release",
      inputHash: "i",
      release: { sha256: "release" },
      windows: [1, 2].map((i) => ({
        id: `w${i}`,
        gameId: "g",
        kind: "in_period",
        state: { ...state, clockMs: i },
        actual: { players_out: ["a"], players_in: ["f"] },
        exclusions: [],
      })),
      ledger: [],
    } as unknown as DecisionDataset;
    const record = new RecordStore<any>(join(root, "record"), {
      releaseManifestSha256: "release",
      datasetVersion: dataset.version,
      datasets: [{ gameId: "g", inputHash: "i" }],
      harness: { ...REPLAY_VERSIONS, policy: policyHarness(selected) },
      predictors: {
        p: { id: "p", policy: policyVersion(selected, receipt, "fixture") },
      },
    });
    try {
      const trace = await replayPolicy({
        dataset,
        predictorId: "p",
        record,
        proxy: new MeteringProxy(analyst, { create: async (r) => response(r) }),
        assembler: selected,
        receipt,
        packagePath: join(packages.path("g"), "package"),
        signal: signal(),
        releaseAt: "2025-01-02T14:00:00Z",
        codeRevision: "fixture",
      });
      if (scenario === "first") {
        assert(
          trace.windows.every(
            (w) =>
              w.result.failure === "invalid_package" &&
              w.result.scores === null,
          ),
        );
      } else if (scenario === "later") {
        assert.equal(trace.windows[0].result.failure, null);
        assert.equal(trace.windows[1].result.failure, "assembler_error");
        assert.notEqual(trace.windows[1].result.scores, null);
      } else
        assert(
          trace.windows.every(
            (w) =>
              w.result.failure === "assembler_error" &&
              w.result.scores !== null,
          ),
        );
    } finally {
      record.close();
      remove(root);
    }
  }
});

test("session exposes policy tools under pinned harness and blocks writes after freeze", async () => {
  const { Session } = await import("../src/env/session.js");
  const { fixtureCorpus } = await import("./fixtures/session/corpus.js");
  const root = temp(),
    workspace = join(root, "workspace"),
    f = fixtureCorpus();
  f.config.harness.policy = policyHarness(assembler);
  source(join(workspace, "packages", f.game.gameId));
  const tools = new PolicyTools(
    root,
    workspace,
    f.game,
    [f.game],
    assembler,
    [],
    () => new Date(Date.parse(f.game.scheduledStart) - 1).toISOString(),
  );
  assert.throws(
    () =>
      new Session(
        f.config,
        f.game,
        "pregame",
        f.game.scheduledStart,
        f.source,
        workspace,
        join(root, "wrong"),
        tools,
      ),
    /root differs/,
  );
  const session = new Session(
    f.config,
    f.game,
    "pregame",
    f.game.scheduledStart,
    f.source,
    workspace,
    root,
    tools,
  );
  try {
    const receipt = await session.call("freeze_package", {}, signal());
    assert("packageHash" in receipt);
    await assert.rejects(
      session.call(
        "workspace_write",
        { path: `packages/${f.game.gameId}/assemble.py`, content: "changed" },
        signal(),
      ),
      /frozen/,
    );
    await session.transition("commit", f.game.scheduledStart);
    await assert.rejects(
      session.call("freeze_package", {}, signal()),
      /unavailable/,
    );
  } finally {
    await session.close();
    remove(root);
  }
});

test("nondeterministic assembly is refused before any Jev request", async () => {
  const { assembleRequest } = await import("../src/policy/replay.js");
  const root = temp(),
    path = join(root, "draft");
  source(path);
  let n = 0;
  try {
    const store = new PackageStore(join(root, "frozen"));
    const receipt = await store.freeze(
      "g",
      path,
      () => "2025-01-01T00:00:00Z",
      "2025-01-02T00:00:00Z",
      assembler,
      signal(),
    );
    const random: Assembler = {
      ...assembler,
      run: async () => ({
        value: { ...genericAssembly(state), diagnostics: { n: n++ } },
        computeSeconds: 0,
      }),
    };
    await assert.rejects(
      assembleRequest(
        random,
        join(store.path("g"), "package"),
        receipt,
        state,
        join(root, "cache"),
        signal(),
      ),
      /Nondeterministic/,
    );
  } finally {
    remove(root);
  }
});

test("cancelled assembly/Jev and Docker infrastructure failure leave replay resumable", async () => {
  for (const mode of [
    "assembly-abort",
    "jev-abort",
    "infrastructure",
  ] as const) {
    const root = temp(),
      path = join(root, "draft");
    source(path);
    const store = new PackageStore(join(root, "frozen"));
    const receipt = await store.freeze(
      "g",
      path,
      () => "2025-01-01T00:00:00Z",
      "2025-01-02T00:00:00Z",
      assembler,
      signal(),
    );
    const controller = new AbortController();
    let interrupted = false,
      calls = 0;
    const run: Assembler = {
      ...assembler,
      run: async (p, s, abort, operation) => {
        if (!interrupted && mode !== "jev-abort") {
          interrupted = true;
          if (mode === "assembly-abort") controller.abort();
          throw Error("Docker interrupted");
        }
        return assembler.run(p, s, abort, operation);
      },
    };
    const proxy = new MeteringProxy(analyst, {
      create: async (r) => {
        calls++;
        if (!interrupted && mode === "jev-abort") {
          interrupted = true;
          controller.abort();
          throw new DOMException("aborted", "AbortError");
        }
        return response(r);
      },
    });
    const dataset = {
      gameId: "g",
      version: "windows-v2:release",
      inputHash: "i",
      release: { sha256: "release" },
      windows: [1, 2].map((i) => ({
        id: `w${i}`,
        gameId: "g",
        state: { ...state, clockMs: i },
        actual: { players_out: ["a"], players_in: ["f"] },
        exclusions: [],
      })),
      ledger: [],
    } as unknown as DecisionDataset;
    const record = new RecordStore<any>(join(root, "record"), {
      releaseManifestSha256: "release",
      datasetVersion: dataset.version,
      datasets: [{ gameId: "g", inputHash: "i" }],
      harness: { ...REPLAY_VERSIONS, policy: policyHarness(run) },
      predictors: {
        p: { id: "p", policy: policyVersion(run, receipt, "fixture") },
      },
    });
    const options = {
      dataset,
      predictorId: "p",
      record,
      proxy,
      assembler: run,
      receipt,
      packagePath: join(store.path("g"), "package"),
      signal: controller.signal,
      releaseAt: "2025-01-02T14:00:00Z",
      codeRevision: "fixture",
    };
    try {
      await assert.rejects(replayPolicy(options));
      for (const kind of [
        "policy_prediction",
        "replay_window",
        "policy_trace",
        "replay_summary",
      ])
        assert.equal(record.events(kind).length, 0, `${mode}: ${kind}`);
      const resumed = await replayPolicy({ ...options, signal: signal() });
      assert.equal(resumed.windows.length, 2);
      assert(resumed.windows.every((w) => w.result.failure === null));
      assert.equal(calls, mode === "jev-abort" ? 3 : 2);
    } finally {
      record.close();
      remove(root);
    }
  }
});

test("feedback is paged and full window detail can be reconstructed without a large tool result", async () => {
  const { feedbackPage } = await import("../src/policy/feedback.js");
  const window = {
    result: {
      window: {
        id: "w",
        state,
        actual: { players_in: [], players_out: [] },
        exclusions: [],
      },
      raw: {},
      validation: {},
      scores: null,
      failure: null,
    },
    assembly: {
      assembly: { jev_state: "x".repeat(100000), diagnostics: {} },
      request: { state: "x".repeat(100000), questions: {} },
    },
    jev: [],
  };
  const trace = {
    gameId: "g",
    summary: { windows: 75 },
    windows: Array.from({ length: 75 }, (_, i) => ({
      ...window,
      result: {
        ...window.result,
        window: { ...window.result.window, id: `w${i}` },
      },
    })),
  } as any;
  const page = feedbackPage(trace);
  assert(Buffer.byteLength(JSON.stringify(page)) < 24000);
  assert.equal(page.nextCursor, 2);
  let offset: number | null = 0,
    text = "";
  while (offset !== null) {
    const detail = feedbackPage(trace, { window_id: "w0", offset });
    assert(Buffer.byteLength(JSON.stringify(detail)) < 24000);
    text += detail.content;
    offset = detail.nextOffset!;
  }
  assert.deepEqual(JSON.parse(text), trace.windows[0]);
});

test("empty bench is a window-level environment error, not invalid_package", () => {
  const empty = { ...state, eligibleBench: [] };
  assert.throws(
    () => buildJevRequest(genericAssembly(empty), empty),
    (e: any) => e instanceof PackageExecutionError && e.windowOnly,
  );
});

test("excessive Retry-After fails without retrying early", async () => {
  const root = temp(),
    record = new RecordStore(root, { test: true });
  let calls = 0;
  const proxy = new MeteringProxy(analyst, {
    create: async () => {
      calls++;
      throw new JevHttpError(429, { detail: "busy" }, "61");
    },
  });
  try {
    await assert.rejects(
      proxy.jev(
        buildJevRequest(genericAssembly(state), state),
        record,
        "cap",
        signal(),
      ),
    );
    assert.equal(calls, 1);
    assert(record.events("jev_error").some((e) => e.data.retry === false));
  } finally {
    record.close();
    remove(root);
  }
});
