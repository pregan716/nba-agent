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
import { Session, sessionEnvironment } from "../src/env/session.js";
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
import { PolicyTools } from "../src/policy/tools.js";
import { PackageStore } from "../src/policy/package.js";
import { policyHarness } from "../src/policy/replay.js";
import { sha256 } from "../src/data/store.js";
import type { Assembler } from "../src/policy/sandbox.js";

const signal = () => new AbortController().signal;
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
const assembler: Assembler = {
  image: `fixture@sha256:${"c".repeat(64)}`,
  limits: { wallSeconds: 1, memoryBytes: 1000000, outputBytes: 10000 },
  run: async () => ({ value: { loaded: true }, computeSeconds: 0.01 }),
};
const code = "def assemble(state): return {}\n";
const packageManifest = JSON.stringify({
  stateVersion: "state-v1",
  components: { "assemble.py": sha256(Buffer.from(code)) },
  notes: "fixture",
});
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
      new WorkspacePolicy(memory, () => "pregame", true, "g"),
      root,
      "g",
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
      await w.mutate("write", "packages/g/x", Buffer.from("ok"));
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
    new WorkspacePolicy(memoryVariant("M4"), () => phase, true, "g"),
    root,
    "g",
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

for (const variant of ["M0", "M3", "M4"] as const)
  test(`${variant} two games: reflection, previous feedback, memory persistence and checkpoint sizes`, async () => {
    const root = temp(),
      f = fixture(variant);
    f.config.harness.policy = policyHarness(assembler);
    const schedule = [
        { gameId: "prior", scheduledStart: "2025-10-31T23:00:00Z" },
        f.game,
      ],
      m = manifest(f.config, schedule);
    const proxy = new MeteringProxy(provider);
    await proxy.listen();
    let replays = 0,
      posts = 0;
    const tools = (
      game: (typeof m.games)[number],
      trusted: { root: string; workspace: string },
      phase: string,
    ) =>
      new PolicyTools(
        trusted.root,
        trusted.workspace,
        game,
        m.games,
        assembler,
        [],
        () =>
          phase === "postgame"
            ? game.release
            : new Date(Date.parse(game.scheduledStart) - 1).toISOString(),
      );
    const environment = sessionEnvironment(f.config, f.source, {
      policy: (context, trusted) => tools(context.game, trusted, context.phase),
    });
    const runner = new Runner(
      root,
      m,
      proxy,
      environment,
      undefined,
      async (game, trusted) => {
        replays++;
        const receipt = new PackageStore(
          join(trusted.root, "frozen-packages"),
        ).receipt(game.gameId);
        assert.ok(receipt);
        tools(
          game,
          { root: trusted.root, workspace: runner.workspace },
          "postgame",
        ).saveFeedback({
          gameId: game.gameId,
          releaseAt: game.release,
          summary: { fixture: true },
          windows: [],
        } as any);
      },
    );
    try {
      await runner.run(async ({ session }) => {
        const context = await session.call("context", {}),
          game = context.game.game_id;
        assert.equal(context.memory.variant, variant);
        assert.deepEqual(
          (await session.call("workspace_list", { path: "scratch" })).entries,
          [],
        );
        if (context.phase === "pregame") {
          if (game === "current") {
            assert.equal(
              (await session.call("read_feedback", {})).gameId,
              "prior",
            );
            assert.equal(
              JSON.parse(
                (
                  await session.call("workspace_read", {
                    path: "feedback/prior/trace.json",
                  })
                ).content,
              ).gameId,
              "prior",
            );
            await assert.rejects(
              session.call("workspace_read", {
                path: "packages/prior/assemble.py",
              }),
              { code: "not_found" },
            );
            if (variant !== "M0")
              assert.equal(
                (
                  await session.call("workspace_read", {
                    path: "memory/coach_profile.md",
                  })
                ).content,
                "learned",
              );
            else
              await assert.rejects(
                session.call("workspace_read", {
                  path: "memory/coach_profile.md",
                }),
                { code: "not_found" },
              );
          }
          await session.call("workspace_write", {
            path: `packages/${game}/assemble.py`,
            content: code,
          });
          await session.call("workspace_write", {
            path: `packages/${game}/manifest.json`,
            content: packageManifest,
          });
          await session.call("freeze_package", {});
          await assert.rejects(
            session.call("workspace_write", {
              path: "scratch/locked",
              content: "bad",
            }),
            { code: "phase_refused" },
          );
        } else {
          posts++;
          assert.equal((await session.call("read_feedback", {})).gameId, game);
          if (game === "current")
            await assert.rejects(
              session.call("read_feedback", { game_id: "prior" }),
              { code: "not_found" },
            );
          await session.call("workspace_write", {
            path: "scratch/ephemeral",
            content: "discard",
          });
          if (variant !== "M0")
            await session.call("workspace_write", {
              path: "memory/coach_profile.md",
              content: "learned",
            });
          if (variant !== "M0")
            await session.call("workspace_write", {
              path: "memory/best_practices.md",
              content: "Fixture Player",
            });
          if (variant === "M4")
            await session.call("workspace_write", {
              path: "skills/example.py",
              content: "# prior",
            });
        }
      });
      assert.deepEqual(runner.record.events("session_error"), []);
      assert.equal(posts, 2);
      assert.equal(replays, 2);
      assert.equal(runner.record.events("package_freeze").length, 2);
      assert.equal(runner.record.events("boundary_audit").length, 2);
      if (variant !== "M0")
        assert.ok(
          runner.record
            .events("boundary_audit")
            .every((e) =>
              e.data.flags.some(
                (flag: any) => flag.matchedText === "Fixture Player",
              ),
            ),
        );
      if (variant === "M4")
        assert.ok(
          runner.record
            .events("boundary_audit")
            .every((e) =>
              e.data.flags.some(
                (flag: any) =>
                  flag.file === "skills/example.py" &&
                  flag.matchedText === "prior",
              ),
            ),
        );
      assert.ok(
        runner.record.events("session_start").every((e) => e.data.memorySize),
      );
      assert.ok(
        runner.record.events("session_end").every((e) => e.data.memorySize),
      );
      assert.ok(
        runner.record
          .events("memory_checkpoint")
          .every((e) => e.data.cap === 50000),
      );
    } finally {
      runner.close();
      await proxy.close();
      clean(root);
    }
  });

for (const point of ["receipt", "record"] as const)
  test(`SIGKILL after freeze ${point} resumes with one receipt and one replay, preserving committed memory`, async () => {
    const { fork } = await import("node:child_process");
    const root = temp(),
      f = fixture();
    f.config.harness.policy = policyHarness(assembler);
    const child = fork(
      new URL("./fixtures/runner/memory-crash.ts", import.meta.url),
      [root, point],
      {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          reject(Error("No freeze: " + stderr));
        }, 15000);
        let frozen = false;
        child.on("message", (message) => {
          if (message === "frozen") {
            frozen = true;
            child.kill("SIGKILL");
          }
        });
        child.once("close", () => {
          clearTimeout(timeout);
          if (frozen) resolve();
          else reject(Error(stderr));
        });
        child.once("error", reject);
      });
      const m = manifest(f.config, [f.game]),
        proxy = new MeteringProxy(provider);
      await proxy.listen();
      let replayCalls = 0,
        sessions = 0;
      const policy = (
        game: (typeof m.games)[number],
        trusted: { root: string; workspace: string },
      ) =>
        new PolicyTools(
          trusted.root,
          trusted.workspace,
          game,
          m.games,
          assembler,
          [],
          () => game.release,
        );
      const runner = new Runner(
        root,
        m,
        proxy,
        sessionEnvironment(f.config, f.source, {
          policy: (context, trusted) => policy(context.game, trusted),
        }),
        undefined,
        async (game, trusted) => {
          replayCalls++;
          policy(game, {
            root: trusted.root,
            workspace: runner.workspace,
          }).saveFeedback({
            gameId: game.gameId,
            releaseAt: game.release,
            windows: [],
            summary: {},
          } as any);
        },
      );
      try {
        const harness = async ({
          session,
        }: import("../src/runner/runner.js").HarnessHandles) => {
          sessions++;
          assert.equal((await session.call("context", {})).phase, "postgame");
          assert.equal(
            (
              await session.call("workspace_read", {
                path: "memory/coach_profile.md",
              })
            ).content,
            "saved-before-freeze",
          );
          assert.equal(
            (await session.call("read_feedback", {})).gameId,
            "current",
          );
        };
        await runner.run(harness);
        await runner.run(harness);
        assert.equal(sessions, 1);
        assert.equal(replayCalls, 1);
        assert.equal(runner.record.events("package_freeze").length, 1);
        assert.equal(runner.record.events("replay_completed").length, 1);
      } finally {
        runner.close();
        await proxy.close();
      }
    } finally {
      child.kill("SIGKILL");
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

test("record and blobs restore frozen packages and released feedback after checkpoint relocation", async () => {
  const { restoreMemoryArtifacts } =
    await import("../src/runner/memory-artifacts.js");
  const { snapshot } = await import("../src/runner/record.js");
  const { writeBlob } = await import("../src/runner/blobs.js");
  const { digest } = await import("../src/runner/config.js");
  const root = temp(),
    f = fixture(),
    record = new RecordStore(root, manifest(f.config, [f.game]));
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "packages/current"), { recursive: true });
  writeFileSync(join(workspace, "packages/current/assemble.py"), code);
  writeFileSync(
    join(workspace, "packages/current/manifest.json"),
    packageManifest,
  );
  const packages = new PackageStore(join(root, "frozen-packages"));
  try {
    const receipt = await packages.freeze(
      "current",
      join(workspace, "packages/current"),
      () => new Date(Date.parse(f.game.scheduledStart) - 1).toISOString(),
      f.game.scheduledStart,
      assembler,
      signal(),
    );
    record.append("package_freeze", "current", {
      receipt,
      workspace: snapshot(root, workspace),
    });
    const trace = { gameId: "current", releaseAt: f.game.release, windows: [] };
    record.append("replay_completed", "current", {
      feedbackHash: digest(trace),
      feedbackBlob: writeBlob(root, Buffer.from(JSON.stringify(trace))),
    });
    clean(join(root, "frozen-packages"));
    restoreMemoryArtifacts(root, record);
    restoreMemoryArtifacts(root, record);
    assert.deepEqual(packages.receipt("current"), receipt);
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, "feedback/current.json"), "utf8")),
      trace,
    );
  } finally {
    record.close();
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
    new WorkspacePolicy(memoryVariant("M3"), () => phase, true, "g"),
    root,
    "g",
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
