import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  linkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace, WorkspacePolicy } from "../src/env/workspace.js";
import { Session } from "../src/env/session.js";
import { fixtureCorpus } from "./fixtures/session/corpus.js";
import { snapshot, restore, diff } from "../src/runner/record.js";
import { windowSnapshot } from "../src/runner/workspace.js";
import { manifest } from "../src/runner/config.js";

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "nba-workspace-"));
  const path = join(root, "workspace");
  mkdirSync(path);
  const f = fixtureCorpus();
  let phase: "pregame" | "commit" | "postgame" | "closed" = "pregame";
  const policy = new WorkspacePolicy(f.config.profile.memory, () => phase);
  const w = new Workspace(path, policy, root);
  return {
    root,
    path,
    f,
    w,
    phase: (p: typeof phase) => {
      phase = p;
    },
    close: () => rmSync(root, { recursive: true, force: true }),
  };
};
test("workspace tools edit text, count UTF-8 bytes, list immediate entries and checkpoint special filenames", () => {
  const s = setup();
  try {
    const before = snapshot(s.root, s.path);
    assert.deepEqual(s.w.list(), { entries: [] });
    assert.deepEqual(s.w.mutate("write", "notes/a", Buffer.from("é")), {
      path: "notes/a",
      bytes: 2,
    });
    s.w.mutate("append", "notes/a", Buffer.from("!"));
    assert.deepEqual(s.w.read("notes/a"), {
      path: "notes/a",
      content: "é!",
      bytes: 3,
    });
    assert.deepEqual(s.w.list(), {
      entries: [{ path: "notes", kind: "directory", bytes: null }],
    });
    assert.deepEqual(s.w.list("notes"), {
      entries: [{ path: "notes/a", kind: "file", bytes: 3 }],
    });
    s.w.mutate("write", "__proto__", Buffer.from("safe"));
    const after = snapshot(s.root, s.path);
    assert.equal(Object.keys(after.files).length, 2);
    assert.deepEqual(diff(before, after).added.sort(), [
      "__proto__",
      "notes/a",
    ]);
    s.w.mutate("delete", "notes/a");
    assert.throws(() => s.w.read("notes/a"), { code: "not_found" });
    restore(s.root, s.path, after);
    assert.equal(s.w.read("__proto__").content, "safe");
    assert.equal(s.w.read("notes/a").content, "é!");
  } finally {
    s.close();
  }
});
test("shared policy permits new scripts and appends but rejects replacement/delete, commit and stateless access", () => {
  const s = setup();
  try {
    s.f.config.profile.memory.revision = "append-only";
    s.w.mutate("write", "script.py", Buffer.from("print(1)"));
    assert.throws(
      () => s.w.mutate("write", "script.py", Buffer.from("print(2)")),
      { code: "memory_mode_refused" },
    );
    assert.throws(() => s.w.mutate("delete", "script.py"), {
      code: "memory_mode_refused",
    });
    s.w.mutate("write", "script-v2.py", Buffer.from("print(2)"));
    s.w.mutate("append", "script.py", Buffer.from("\n"));
    s.phase("commit");
    assert.throws(() => s.w.mutate("append", "script.py", Buffer.from("bad")), {
      code: "phase_refused",
    });
    assert.throws(() => s.w.read("script.py"), { code: "phase_refused" });
    s.phase("postgame");
    assert.equal(s.w.read("script.py").content, "print(1)\n");
    s.f.config.profile.memory.horizon = "stateless";
    assert.throws(() => s.w.list(), { code: "memory_mode_refused" });
  } finally {
    s.close();
  }
});
test("workspace refuses traversal, absolute paths, symlinks and hard links without leaking host paths", () => {
  const s = setup();
  try {
    writeFileSync(join(s.root, "secret"), "secret");
    for (const path of [
      "../secret",
      "/etc/passwd",
      "C:/secret",
      "a/../../secret",
      "a\\..\\secret",
      "a//b",
      "a/./b",
      "a\0b",
      "",
    ]) {
      assert.throws(() => s.w.mutate("write", path, Buffer.from("bad")), {
        code: "invalid_input",
      });
      assert.throws(() => s.w.read(path), { code: "invalid_input" });
    }
    symlinkSync(s.root, join(s.path, "link"));
    linkSync(join(s.root, "secret"), join(s.path, "hard"));
    for (const path of ["link/secret", "hard"])
      for (const operation of ["write", "append", "delete"] as const)
        assert.throws(() => s.w.mutate(operation, path, Buffer.from("bad")), {
          code: "invalid_input",
        });
    assert.throws(() => s.w.read("link/secret"), { code: "invalid_input" });
    assert.throws(() => s.w.list(), { code: "invalid_input" });
    assert.equal(readFileSync(join(s.root, "secret"), "utf8"), "secret");
    assert.throws(
      () => s.w.read("missing"),
      (e) => !String(e).includes(s.root),
    );
  } finally {
    s.close();
  }
});
test("session routes workspace tools and revokes the shared service at commit and close", async () => {
  const s = setup();
  s.f.config.profile.memory.revision = "append-only";
  const session = new Session(
    s.f.config,
    s.f.game,
    "pregame",
    s.f.game.scheduledStart,
    s.f.source,
    undefined,
    undefined,
    s.path,
    s.root,
  );
  const signal = new AbortController().signal;
  try {
    await session.call(
      "workspace_write",
      { path: "notes", content: "persistent" },
      signal,
    );
    assert.equal(
      (await session.call("workspace_read", { path: "notes" }, signal)).content,
      "persistent",
    );
    assert.equal(session.workspaceChanges().length, 1);
    const mount = session.workspaceForSandbox()!;
    mount.mutate("write", "binary", Buffer.from([0, 255]));
    assert.throws(() => mount.mutate("write", "binary", Buffer.from([1])), {
      code: "memory_mode_refused",
    });
    assert.throws(
      () => mount.mutate("truncate" as "write", "binary", Buffer.from([1])),
      { code: "invalid_input" },
    );
    assert.deepEqual(mount.readBytes("binary"), Buffer.from([0, 255]));
    await session.transition("commit", s.f.game.scheduledStart);
    assert.throws(() => mount.mutate("append", "binary", Buffer.from([1])), {
      code: "phase_refused",
    });
    await assert.rejects(
      () =>
        session.call(
          "workspace_append",
          { path: "notes", content: "bad" },
          signal,
        ),
      { code: "phase_refused" },
    );
    await session.transition("postgame", s.f.game.release);
    await session.call(
      "workspace_append",
      { path: "notes", content: "!" },
      signal,
    );
    await session.close();
    assert.throws(() => mount.readBytes("binary"), { code: "phase_refused" });
    await assert.rejects(
      () => session.call("workspace_read", { path: "notes" }, signal),
      { code: "phase_refused" },
    );
  } finally {
    s.close();
  }
});
test("window snapshots expire inherited prefixes and preserve recent binary writes and deletion", () => {
  const s = setup();
  try {
    s.w.mutate("write", "notes", Buffer.from("old"));
    const old = s.w.changes().length;
    s.w.mutate("append", "notes", Buffer.from("new"));
    s.w.mutate("write", "model", Buffer.from([0, 255, 1]));
    s.w.mutate("write", "temporary", Buffer.from("delete me"));
    s.w.mutate("delete", "temporary");
    const snap = windowSnapshot(s.root, s.w.changes().slice(old));
    restore(s.root, s.path, snap);
    assert.equal(s.w.read("notes").content, "new");
    assert.deepEqual(s.w.readBytes("model"), Buffer.from([0, 255, 1]));
    assert.throws(() => s.w.read("temporary"), { code: "not_found" });
    s.f.config.profile.memory.horizon = "window";
    assert.throws(() => manifest(s.f.config, [s.f.game]), /windowGames/);
    s.f.config.profile.memory.windowGames = 1;
    assert.equal(
      manifest(s.f.config, [s.f.game]).config.profile.memory.windowGames,
      1,
    );
    s.f.config.profile.memory.horizon = "season";
    assert.throws(() => manifest(s.f.config, [s.f.game]), /windowGames/);
  } finally {
    s.close();
  }
});

test("journal hashes deduplicate snapshot bytes and window replay rejects corrupt blobs", () => {
  const s = setup();
  try {
    const bytes = Buffer.alloc(2 * 1024 * 1024, 65);
    s.w.mutate("write", "large", bytes);
    s.w.mutate("write", "large", bytes);
    const journal = s.w.changes();
    assert.equal(journal[0].sha256, journal[1].sha256);
    assert.equal(journal[0].sha256, snapshot(s.root, s.path).files.large);
    assert.ok(JSON.stringify(journal).length < 300);
    assert.deepEqual(
      readFileSync(join(s.root, "blobs", journal[0].sha256!)),
      bytes,
    );
    s.w.mutate("append", "large", Buffer.from("tail"));
    const append = s.w.changes().at(-1)!;
    assert.equal(
      readFileSync(join(s.root, "blobs", append.sha256!), "utf8"),
      "tail",
    );
    writeFileSync(join(s.root, "blobs", append.sha256!), "corrupt");
    assert.throws(() => windowSnapshot(s.root, [append]), /integrity mismatch/);
    assert.throws(
      () =>
        windowSnapshot(s.root, [
          { operation: "write", path: "x", sha256: "../escape" },
        ]),
      /Invalid workspace blob hash/,
    );
  } finally {
    s.close();
  }
});
