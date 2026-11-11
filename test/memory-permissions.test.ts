import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  readdirSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  memoryVariant,
  memoryV3Schema,
  SECOND_STAGE,
  REPRESENTATIONS,
} from "../src/env/memory.js";
import { Workspace, WorkspacePolicy } from "../src/env/workspace.js";
import { sessionEnvironment } from "../src/env/session.js";
import { manifest, configSchema } from "../src/runner/config.js";
import { Runner } from "../src/runner/runner.js";
import { MeteringProxy } from "../src/runner/proxy.js";
import { RecordStore } from "../src/runner/record.js";
import {
  measureMemory,
  recordedMemoryCounter,
  type MemoryCounter,
} from "../src/runner/memory.js";
import { auditBoundary, boundaryNames } from "../src/env/memory-audit.js";
import { fixtureCorpus } from "./fixtures/session/corpus.js";
import { harnessConfig } from "../src/harness/version.js";

const count: MemoryCounter = async (files) =>
  Object.values(files).reduce((sum, text) => sum + text.length, 0); // deterministic fixture tokenizer
function fixture(variant: Parameters<typeof memoryVariant>[0] = "M3") {
  const f = fixtureCorpus();
  f.config.profile.memory = memoryVariant(variant);
  f.config.budget.memory = {
    tokenCap: 50000,
    countProtocol: "analyst-count-snapshot-v1",
  };
  f.config.harness = harnessConfig({
    memory: f.config.profile.memory,
    memoryInstructions: "fixture-only",
    effort: "high",
    thinking: "adaptive",
    sandboxImage: f.config.harness.sandboxImage,
    codeRevision: "test",
  });
  return f;
}
const temp = () => mkdtempSync(join(tmpdir(), "nba-memory-"));
function clean(root: string) {
  const unlock = (p: string) => {
    if (lstatSync(p).isDirectory()) {
      chmodSync(p, 0o700);
      for (const n of readdirSync(p)) unlock(join(p, n));
    }
  };
  unlock(root);
  rmSync(root, { recursive: true, force: true });
}
const provider = {
  count: async (request: any) => {
    const files = JSON.parse(request.messages[0].content);
    assert.equal(request.model, "claude-opus-4-6");
    return files.reduce(
      (sum: number, file: any) => sum + file.content.length,
      0,
    );
  },
  create: async () => {
    throw Error("No inference in fixture");
  },
};

test("v3 profiles pin separate rights, reject mixed legacy modes and refuse all second-stage values", () => {
  for (const variant of ["M0", "M1", "M2", "M3", "M4"] as const) {
    const f = fixture(variant);
    assert.equal(
      manifest(f.config, [f.game]).config.profile.memory.variant,
      variant,
    );
  }
  const f = fixture();
  assert.throws(() =>
    configSchema.parse({
      ...f.config,
      profile: {
        ...f.config.profile,
        memory: { ...f.config.profile.memory, horizon: "stateless" },
      },
    }),
  );
  for (const value of SECOND_STAGE) {
    const memory = memoryV3Schema.parse({
      ...memoryVariant("M3"),
      ...((REPRESENTATIONS as readonly string[]).includes(value)
        ? { representation: value }
        : { management: value }),
    });
    assert.throws(
      () =>
        manifest({ ...f.config, profile: { ...f.config.profile, memory } }, [
          f.game,
        ]),
      /Second-stage/,
    );
  }
  assert.throws(
    () =>
      manifest(
        {
          ...f.config,
          profile: {
            ...f.config.profile,
            memory: {
              ...memoryVariant("M3"),
              skills: { read: true, create: false, revise: false },
            },
          },
        },
        [f.game],
      ),
    /rights differ/,
  );
});

test("workspace tools hide every gated-off tree even when planted on the host", async () => {
  for (const variant of ["M0", "M1", "M2", "M3", "M4"] as const) {
    const root = temp();
    const memory = memoryVariant(variant);
    const w = new Workspace(
      root,
      new WorkspacePolicy(memory, () => "pregame"),
      root,
      count,
    );
    const paths = [
      ["memory/coach_profile.md", memory.coachProfile.read],
      ["memory/coach/x.txt", memory.coachProfile.read],
      ["memory/best_practices.md", memory.bestPractices.read],
      ["memory/practices/x.txt", memory.bestPractices.read],
      ["skills/x.py", memory.skills.read],
    ] as const;
    try {
      for (const [path, on] of paths) {
        mkdirSync(join(root, path, ".."), { recursive: true });
        writeFileSync(join(root, path), "planted");
        if (on) {
          assert.equal(w.read(path).content, "planted");
          await w.mutate("write", path, Buffer.from("ok"));
        } else {
          assert.throws(() => w.read(path), { code: "not_found" });
          await assert.rejects(
            Promise.resolve().then(() =>
              w.mutate("write", path, Buffer.from("bad")),
            ),
            { code: "not_found" },
          );
        }
      }
      const rootNames = w.list().entries.map((e) => e.path);
      assert.equal(rootNames.includes("skills"), memory.skills.read);
      assert.equal(
        rootNames.includes("memory"),
        memory.coachProfile.read || memory.bestPractices.read,
      );
      if (rootNames.includes("memory")) {
        const entries = w.list("memory").entries.map((e) => e.path);
        assert.equal(
          entries.includes("memory/coach_profile.md"),
          memory.coachProfile.read,
        );
        assert.equal(
          entries.includes("memory/best_practices.md"),
          memory.bestPractices.read,
        );
      }
      for (const path of ["other.txt", "packages/old/x", "skills-hidden/x"]) {
        await assert.rejects(
          Promise.resolve().then(() =>
            w.mutate("write", path, Buffer.from("bad")),
          ),
          { code: "not_found" },
        );
      }
      await w.mutate("write", "scratch/x", Buffer.from("ok"));
    } finally {
      clean(root);
    }
  }
});

test("cap enforcement is atomic across writes/appends, counts only allowed memory, and leaves skills uncapped", async () => {
  const root = temp();
  let phase: "pregame" | "commit" = "pregame";
  const w = new Workspace(
    root,
    new WorkspacePolicy(memoryVariant("M4"), () => phase),
    root,
    count,
  );
  try {
    await w.mutate(
      "write",
      "memory/coach_profile.md",
      Buffer.from("a".repeat(30000)),
    );
    await w.mutate(
      "write",
      "memory/best_practices.md",
      Buffer.from("b".repeat(20000)),
    );
    await assert.rejects(
      Promise.resolve(
        w.mutate("append", "memory/coach_profile.md", Buffer.from("x")),
      ),
      /current 50000 tokens; proposed 50001; cap 50000/,
    );
    assert.equal(w.read("memory/coach_profile.md").bytes, 30000);
    await assert.rejects(
      Promise.resolve(
        w.mutate("write", "memory/practices/binary", Buffer.from([255])),
      ),
      /UTF-8/,
    );
    await w.mutate("write", "skills/big.py", Buffer.from("x".repeat(90000)));
    const size = await measureMemory(root, count);
    assert.equal(size.tokens, 50000);
    assert.equal(size.skills.bytes, 90000);
    await w.mutate("delete", "memory/best_practices.md");
    const writes = await Promise.allSettled([
      w.mutate(
        "append",
        "memory/coach_profile.md",
        Buffer.from("a".repeat(15000)),
      ),
      w.mutate("write", "memory/practices/x", Buffer.from("a".repeat(15000))),
    ]);
    assert.equal(writes.filter((r) => r.status === "fulfilled").length, 1);
    phase = "commit";
    await assert.rejects(
      Promise.resolve().then(() =>
        w.mutate("write", "memory/practices/x", Buffer.from("bad")),
      ),
      { code: "phase_refused" },
    );
  } finally {
    clean(root);
  }
});

test("token-count records cache exact inputs across reconstruction without inference or research spend", async () => {
  const root = temp(),
    f = fixture();
  const record = new RecordStore(root, manifest(f.config, [f.game]));
  let calls = 0;
  try {
    const counter = () =>
      recordedMemoryCounter(record, "g", async (request) => {
        calls++;
        return provider.count(request);
      });
    assert.equal(await counter()({ "memory/coach_profile.md": "abc" }), 3);
    assert.equal(await counter()({ "memory/coach_profile.md": "abc" }), 3);
    assert.equal(calls, 1);
    assert.equal(record.events("reservation").length, 0);
    const event = record.events("memory_token_count")[0].data;
    assert.equal(event.researchBudgetCharged, false);
    assert.ok(event.requestBlob);
  } finally {
    record.close();
    clean(root);
  }
});

test("boundary audit flags player, staff and game names without modifying any file", async () => {
  const root = temp(),
    f = fixture("M4");
  mkdirSync(join(root, "memory"));
  mkdirSync(join(root, "skills"));
  const texts = {
    "memory/best_practices.md":
      "Ask Fixture Player, Joe Mazzulla and Brad Stevens.",
    "skills/learn.py": "# prior game",
  };
  for (const [path, text] of Object.entries(texts))
    writeFileSync(join(root, path), text);
  try {
    const names = await boundaryNames(f.source),
      audit = auditBoundary(root, "current", names);
    for (const match of [
      "Fixture Player",
      "Joe Mazzulla",
      "Brad Stevens",
      "prior",
    ])
      assert.ok(
        audit.flags.some(
          (f) => f.matchedText === match && f.queue === "human-review",
        ),
      );
    for (const [path, text] of Object.entries(texts))
      assert.equal(readFileSync(join(root, path), "utf8"), text);
  } finally {
    clean(root);
  }
});

test("boundary audit scans literal and separator-normalized paths without editing files", () => {
  const root = temp();
  const paths = [
    "skills/games/0022500083.json",
    "memory/practices/jayson-tatum-minutes.md",
    "skills/jayson_tatum/helper.py",
    "skills/jayson.tatum.md",
    "skills/Jayson Tatum.md",
    "skills/joe-mazzulla.md",
  ];
  try {
    for (const path of paths) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), "generic helper");
    }
    writeFileSync(join(root, "skills/notjayson-tatumish.md"), "generic helper");
    const audit = auditBoundary(root, "current", {
      players: ["Jayson Tatum"],
      staff: ["Joe Mazzulla"],
      gameIds: ["0022500083"],
      sources: [],
    });
    assert.deepEqual(
      audit.flags.map((f) => f.matchedText).sort(),
      [...paths].sort(),
    );
    for (const flag of audit.flags) {
      assert.equal(flag.source, "path");
      assert.equal(flag.offset, 0);
      assert.equal(flag.file, flag.matchedText);
      assert.equal(flag.game, "current");
      assert.equal(flag.queue, "human-review");
    }
    for (const path of paths)
      assert.equal(readFileSync(join(root, path), "utf8"), "generic helper");
  } finally {
    clean(root);
  }
});

for (const failure of ["harness", "environment", "audit"] as const)
  test(`postgame ${failure} failure records an audit or explicit gap`, async () => {
    const root = temp(),
      f = fixture();
    f.config.recovery = { maxSessionAttempts: 1 };
    const proxy = new MeteringProxy(provider);
    await proxy.listen();
    const factory = sessionEnvironment(f.config, f.source);
    const runner = new Runner(
      root,
      manifest(f.config, [f.game]),
      proxy,
      async (context, trusted) => {
        if (context.phase === "postgame" && failure === "environment")
          throw Error("fixture environment failure");
        const env = await factory(context, trusted);
        if (failure === "audit")
          env.boundaryAudit = async () => {
            throw Error("fixture audit failure");
          };
        return env;
      },
    );
    try {
      await runner.run(async ({ session }) => {
        const context = await session.call("context", {});
        await session.call("workspace_write", {
          path: "memory/best_practices.md",
          content: "Fixture Player",
        });
        if (context.phase === "postgame")
          throw Error("fixture harness failure");
      });
      const end = runner.record.events("phase_end", "current:postgame")[0];
      assert.equal(end.data.status, "infrastructure_failure");
      if (failure === "harness") {
        const audits = runner.record.events("boundary_audit", "current");
        assert.equal(audits.length, 1);
        assert.ok(
          audits[0].data.flags.some(
            (flag: any) => flag.matchedText === "Fixture Player",
          ),
        );
        assert.equal(runner.record.events("boundary_audit_skipped").length, 0);
      } else {
        const skipped = runner.record.events(
          "boundary_audit_skipped",
          "current",
        );
        assert.equal(skipped.length, 1);
        assert.equal(
          skipped[0].data.reason,
          failure === "audit" ? "audit_failed" : "environment_unavailable",
        );
        assert.equal(skipped[0].data.attempt, 1);
      }
    } finally {
      runner.close();
      await proxy.close();
      clean(root);
    }
  });

test("existing analyst loop operates v3 workspace tools and receives optional postgame reflection", async () => {
  const { analystHarness } = await import("../src/harness/loop.js");
  const root = temp(),
    f = fixture("M3");
  let calls = 0;
  const proxy = new MeteringProxy({
    count: async (request) =>
      request.max_tokens === 1 ? provider.count(request) : 5,
    create: async (request) => {
      const first = ++calls === 1;
      return {
        id: `fixture-${calls}`,
        type: "message",
        role: "assistant",
        model: request.model,
        content: first
          ? [
              {
                type: "tool_use",
                id: "write",
                name: "workspace_write",
                input: { path: "memory/coach_profile.md", content: "retained" },
              },
            ]
          : [{ type: "text", text: "done" }],
        stop_reason: first ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 10 },
      } as any;
    },
  });
  await proxy.listen();
  const runner = new Runner(
    root,
    manifest(f.config, [f.game]),
    proxy,
    sessionEnvironment(f.config, f.source),
  );
  try {
    await runner.run(analystHarness({ model: "claude-opus-4-6" }));
    assert.deepEqual(runner.record.events("session_error"), []);
    assert.equal(calls, 3);
    assert.equal(runner.record.events("session_end").length, 2);
    assert.equal(
      readFileSync(join(runner.workspace, "memory/coach_profile.md"), "utf8"),
      "retained",
    );
  } finally {
    runner.close();
    await proxy.close();
    clean(root);
  }
});

test("a phase change during token counting refuses the pending write", async () => {
  const root = temp();
  let phase: "pregame" | "commit" = "pregame",
    release!: () => void;
  const wait = new Promise<void>((resolve) => (release = resolve));
  const w = new Workspace(
    root,
    new WorkspacePolicy(memoryVariant("M3"), () => phase),
    root,
    async (files) => {
      await wait;
      return count(files);
    },
  );
  try {
    const write = Promise.resolve(
      w.mutate("write", "memory/coach_profile.md", Buffer.from("pending")),
    );
    await new Promise((resolve) => setImmediate(resolve));
    phase = "commit";
    release();
    await assert.rejects(write, { code: "phase_refused" });
    phase = "pregame";
    assert.throws(() => w.read("memory/coach_profile.md"), {
      code: "not_found",
    });
  } finally {
    release();
    clean(root);
  }
});

test("exact edits are atomic and memory mutations report retained usage", async () => {
  const root = temp();
  let phase: "pregame" | "commit" = "pregame";
  const w = new Workspace(
    root,
    new WorkspacePolicy(memoryVariant("M3"), () => phase),
    root,
    count,
  );
  try {
    const path = "memory/coach_profile.md";
    const m0 = new Workspace(
      root,
      new WorkspacePolicy(memoryVariant("M0"), () => phase),
      root,
      count,
    );
    await assert.rejects(
      Promise.resolve().then(() => m0.edit(path, "a", "b")),
      { code: "not_found" },
    );
    assert.deepEqual(
      (await w.mutate("write", path, Buffer.from("alpha beta"))).memoryUsage,
      { retainedTokens: 10, cap: 50000 },
    );
    assert.deepEqual((await w.edit(path, "beta", "gamma")).memoryUsage, {
      retainedTokens: 11,
      cap: 50000,
    });
    assert.equal(w.read(path).content, "alpha gamma");
    for (const old of ["", "missing", "a"])
      await assert.rejects(
        Promise.resolve().then(() => w.edit(path, old, "x")),
      );
    await assert.rejects(
      Promise.resolve().then(() => w.edit(path, "gamma", "x".repeat(50000))),
      /cap/,
    );
    assert.equal(w.read(path).content, "alpha gamma");
    assert.deepEqual(await w.memoryUsage(), { retainedTokens: 11, cap: 50000 });
    assert.deepEqual(
      (await w.mutate("append", path, Buffer.from("!"))).memoryUsage,
      { retainedTokens: 12, cap: 50000 },
    );
    phase = "commit";
    await assert.rejects(
      Promise.resolve().then(() => w.edit(path, "gamma", "beta")),
      { code: "phase_refused" },
    );
    phase = "pregame";
    assert.deepEqual((await w.mutate("delete", path)).memoryUsage, {
      retainedTokens: 0,
      cap: 50000,
    });
  } finally {
    clean(root);
  }
});

test("boundary audit catches case-sensitive surnames, suffixes and compound names", () => {
  const root = temp();
  const names = {
    players: [
      "Jaylen Brown",
      "Derrick White",
      "Ron Harper Jr.",
      "Karl-Anthony Towns",
      "Royce O'Neale",
      "Shai Gilgeous-Alexander",
      "Nikola Vučević",
      "Hugo González",
    ],
    staff: ["Joe Mazzulla"],
    gameIds: [],
    sources: [],
  };
  try {
    for (const path of [
      "memory/best_practices.md",
      "memory/practices/notes.md",
      "skills/notes.md",
    ]) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(
        join(root, path),
        "Stars (currently Brown, White), Harper, Mazzulla, O'Neale, Neale, Gilgeous-Alexander, Vucevic, Gonzalez. white background, brown paper. jaylen brown.",
      );
    }
    mkdirSync(join(root, "skills/White"));
    writeFileSync(join(root, "skills/White/note.md"), "white background");
    const audit = auditBoundary(root, "g", names);
    for (const file of [
      "memory/best_practices.md",
      "memory/practices/notes.md",
      "skills/notes.md",
    ]) {
      const flags = audit.flags.filter(
        (f) => f.file === file && f.source === "content",
      );
      for (const name of [
        "Brown",
        "White",
        "Harper",
        "Mazzulla",
        "O'Neale",
        "Neale",
        "Gilgeous-Alexander",
        "Vucevic",
        "Gonzalez",
        "jaylen brown",
      ])
        assert.ok(
          flags.some((f) => f.matchedText === name),
          name,
        );
      assert.ok(flags.every((f) => f.queue === "human-review"));
      assert.ok(
        !flags.some((f) =>
          ["white", "brown", "Jr", "Anthony"].includes(f.matchedText),
        ),
      );
    }
    assert.ok(
      audit.flags.some(
        (f) => f.source === "path" && f.file === "skills/White/note.md",
      ),
    );
    assert.ok(
      !audit.flags.some(
        (f) => f.source === "content" && f.file === "skills/White/note.md",
      ),
    );
  } finally {
    clean(root);
  }
});

test("accent-insensitive audit preserves original matches and UTF-16 offsets", () => {
  const root = temp();
  const names = {
    players: ["Nikola Vučević", "Hugo González"],
    staff: [],
    gameIds: [],
    sources: [],
  };
  const text =
    "🏀 Cafe\u0301: Vucevic and Gonzalez closed. Vučević too. Nikola Vucevic. nikola vucevic. Vuc\u030cevic\u0301. vucevic gonzalez.";
  const file = "memory/best_practices.md";
  try {
    mkdirSync(join(root, "memory"));
    mkdirSync(join(root, "skills"));
    writeFileSync(join(root, file), text);
    for (const path of [
      "Vucevic.md",
      "Gonzalez.md",
      "Vučević.md",
      "Gonza\u0301lez.md",
      "vucevic.md",
    ])
      writeFileSync(join(root, "skills", path), "generic");
    const audit = auditBoundary(root, "g", names);
    const flags = audit.flags.filter((f) => f.source === "content");
    for (const expected of [
      "Vucevic",
      "Gonzalez",
      "Vučević",
      "Nikola Vucevic",
      "nikola vucevic",
      "Vuc\u030cevic\u0301",
    ]) {
      assert.ok(
        flags.some(
          (f) =>
            f.matchedText === expected && f.offset === text.indexOf(expected),
        ),
        expected,
      );
    }
    for (const flag of flags)
      assert.equal(
        text.slice(flag.offset, flag.offset + flag.matchedText.length),
        flag.matchedText,
      );
    assert.ok(
      !flags.some(
        (f) => f.matchedText === "vucevic" || f.matchedText === "gonzalez",
      ),
    );
    const paths = audit.flags
      .filter((f) => f.source === "path")
      .map((f) => f.file);
    assert.deepEqual(
      paths.sort(),
      [
        "skills/Vucevic.md",
        "skills/Gonzalez.md",
        "skills/Vučević.md",
        "skills/Gonza\u0301lez.md",
      ].sort(),
    );
    assert.equal(readFileSync(join(root, file), "utf8"), text);
  } finally {
    clean(root);
  }
});
