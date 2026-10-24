import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Session } from "../src/env/session.js";
import { DockerSandbox } from "../src/env/sandbox.js";
import { fixtureCorpus } from "./fixtures/session/corpus.js";

function fixture(future = true) {
  const root = mkdtempSync(join(tmpdir(), "nba-sandbox-test-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const f = fixtureCorpus(future);
  f.config.profile.capabilities.enabled.push("code_execution");
  if (process.env.NBA_SANDBOX_IMAGE)
    f.config.harness.sandboxImage = process.env.NBA_SANDBOX_IMAGE;
  const session = new Session(
    f.config,
    f.game,
    "pregame",
    f.game.scheduledStart,
    f.source,
    undefined,
    undefined,
    workspace,
    root,
  );
  return {
    root,
    f,
    session,
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}
const limits = {
  wallSeconds: 15,
  computeSeconds: 10,
  stdoutBytes: 4096,
  cpu: 1,
  memoryBytes: 512 * 1024 * 1024,
};
const signal = () => new AbortController().signal;
function dump(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Object.fromEntries(
      (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
          )
          .all() as { name: string }[]
      ).map((t) => [t.name, db.prepare(`SELECT * FROM "${t.name}"`).all()]),
    );
  } finally {
    db.close();
  }
}
test("session export is invariant to planted future evidence, preserves public projections and gates release", async () => {
  const exports = [];
  for (const future of [false, true]) {
    const s = fixture(future);
    try {
      const path = await s.session.exportTo(join(s.root, "export"), signal());
      const data = dump(path);
      assert.equal(data.questions.length, 1);
      assert.equal(data.released_results.length, 0);
      assert.ok(data.evidence.length > 0);
      assert.ok(data.odds_history.length > 0);
      assert.ok(!JSON.stringify(data).includes("future-secret"));
      exports.push(data);
    } finally {
      s.clean();
    }
  }
  assert.deepEqual(exports[0], exports[1]);
});
const dockerTest = process.env.NBA_SANDBOX_IMAGE ? test : test.skip;
dockerTest(
  "Docker isolates host data, blocks network/install/links, provides scientific packages and mediates workspace",
  async () => {
    const s = fixture();
    const sandbox = new DockerSandbox(
      s.f.config,
      (dir, abort) => s.session.exportTo(dir, abort),
      s.session.workspaceForSandbox(),
    );
    try {
      writeFileSync(join(s.root, "future-secret"), "FUTURE SECRET");
      let result = await sandbox.execute(
        `import os, sqlite3, numpy, pandas, scipy, sklearn, pickle
from sklearn.linear_model import LinearRegression
os.mkdir('/workspace/models')
model=LinearRegression().fit([[1],[2]],[2,4])
with open('/workspace/models/fit.pkl','wb') as file: pickle.dump(model,file)
with open('/workspace/models/fit.pkl','rb') as file: assert abs(pickle.load(file).predict([[3]])[0]-6)<1e-6
print('packages-ok')
print(sqlite3.connect('file:/data/session.sqlite?mode=ro',uri=True).execute('select count(*) from questions').fetchone()[0])
print(os.path.exists(${JSON.stringify(join(s.root, "future-secret"))}))
open('/scratch/state','w').write('scratch')
open('/workspace/notes','w').write('first')
print(open('/workspace/notes').read())`,
        limits,
        signal(),
      );
      assert.equal(result.exitStatus, 0, result.stderr);
      assert.match(result.stdout, /packages-ok\n1\nFalse\nfirst/);
      result = await sandbox.execute(
        `import socket, subprocess, os
for fn in [lambda: socket.socket(), lambda: os.fork(), lambda: subprocess.run(['python','-m','pip','install','requests']), lambda: open('/data/session.sqlite','w'), lambda: os.symlink('/data/session.sqlite','/workspace/link'), lambda: os.link('/scratch/state','/workspace/hard')]:
 try: fn(); print('BYPASS')
 except (OSError, PermissionError): print('blocked')
print(open('/scratch/state').read())
open('/workspace/notes','a').write('-second')`,
        limits,
        signal(),
      );
      assert.equal(result.exitStatus, 0, result.stderr);
      assert.ok(!result.stdout.includes("BYPASS"));
      assert.match(result.stdout, /scratch/);
      assert.equal(
        s.session.workspaceForSandbox()!.readBytes("notes").toString(),
        "first-second",
      );
      await s.session.transition("commit", s.f.game.scheduledStart);
      result = await sandbox.execute(
        "open('/workspace/notes','a').write('forbidden')",
        limits,
        signal(),
      );
      assert.notEqual(result.exitStatus, 0); // Direct trusted sandbox handle still cannot bypass live workspace policy.
    } finally {
      await sandbox.close();
      await s.session.close();
      s.clean();
    }
    assert.throws(() =>
      execFileSync("docker", ["inspect", sandbox.name], { stdio: "pipe" }),
    );
  },
);
dockerTest(
  "Docker append-only mount refuses truncation/deletion, limits output/compute/wall and discards scratch",
  async () => {
    const s = fixture();
    await s.session.close();
    s.f.config.profile.memory.revision = "append-only";
    const session = new Session(
      s.f.config,
      s.f.game,
      "pregame",
      s.f.game.scheduledStart,
      s.f.source,
      undefined,
      undefined,
      join(s.root, "workspace"),
      s.root,
    );
    const sandbox = new DockerSandbox(
      s.f.config,
      (dir, abort) => session.exportTo(dir, abort),
      session.workspaceForSandbox(),
    );
    try {
      let r = await sandbox.execute(
        "open('/workspace/script.py','w').write('print(1)'); open('/scratch/old','w').write('old')",
        limits,
        signal(),
      );
      assert.equal(r.exitStatus, 0, r.stderr);
      r = await sandbox.execute(
        `import os
for fn in [lambda: open('/workspace/script.py','w'),lambda: os.unlink('/workspace/script.py')]:
 try: fn(); print('BYPASS')
 except OSError: print('blocked')
open('/workspace/script.py','a').write('\\n')
open('/workspace/script-v2.py','w').write('print(2)')
print('x'*10000)`,
        { ...limits, stdoutBytes: 100 },
        signal(),
      );
      assert.equal(r.exitStatus, 0, r.stderr);
      assert.ok(r.truncated);
      assert.ok(Buffer.byteLength(r.stdout) <= 100);
      assert.ok(!r.stdout.includes("BYPASS"));
      assert.equal(
        session.workspaceForSandbox()!.readBytes("script.py").toString(),
        "print(1)\n",
      );
      r = await sandbox.execute(
        "while True: pass",
        { ...limits, computeSeconds: 0.2 },
        signal(),
      );
      assert.equal(r.limit, "compute");
      assert.ok(r.computeSeconds >= 0.2);
      r = await sandbox.execute(
        "import time; time.sleep(20)",
        { ...limits, wallSeconds: 0.2 },
        signal(),
      );
      assert.equal(r.limit, "wall_clock");
    } finally {
      await sandbox.close();
      await session.close();
    }
    const post = new Session(
      s.f.config,
      s.f.game,
      "postgame",
      s.f.game.release,
      s.f.source,
      undefined,
      undefined,
      join(s.root, "workspace"),
      s.root,
    );
    const next = new DockerSandbox(
      s.f.config,
      (dir, abort) => post.exportTo(dir, abort),
      post.workspaceForSandbox(),
    );
    try {
      const r = await next.execute(
        "import os; print(os.path.exists('/scratch/old')); print(open('/workspace/script.py').read())",
        limits,
        signal(),
      );
      assert.equal(r.exitStatus, 0, r.stderr);
      assert.match(r.stdout, /False\nprint\(1\)/);
    } finally {
      await next.close();
      await post.close();
      s.clean();
    }
  },
);

dockerTest(
  "Docker reports memory exhaustion, aborts cleanly and gives stateless code an ephemeral workspace",
  async () => {
    const s = fixture();
    s.f.config.profile.memory.horizon = "stateless";
    const box = new DockerSandbox(s.f.config, (dir, abort) =>
      s.session.exportTo(dir, abort),
    );
    try {
      let r = await box.execute(
        `import os
print(os.getuid())
print(next(x for x in open('/proc/self/status') if x.startswith('CapEff:')).strip())
try: open('/proc/1/fd/0').read(); print('BYPASS')
except OSError: print('protected')
open('/workspace/transient','w').write('gone later')`,
        limits,
        signal(),
      );
      assert.equal(r.exitStatus, 0, r.stderr);
      assert.match(r.stdout, /1000\nCapEff:\s+0000000000000000\nprotected/);
      const inspected = JSON.parse(
        execFileSync("docker", ["inspect", box.name], { encoding: "utf8" }),
      )[0];
      assert.equal(inspected.HostConfig.NetworkMode, "none");
      assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
      assert.equal(inspected.HostConfig.Memory, limits.memoryBytes);
      assert.equal(inspected.HostConfig.NanoCpus, 1e9);
      assert.equal(inspected.Mounts.length, 1);
      assert.equal(inspected.Mounts[0].Destination, "/data");
      assert.equal(inspected.Mounts[0].RW, false);
      r = await box.execute("x=bytearray(1024*1024*1024)", limits, signal());
      assert.equal(r.limit, "memory");
      assert.notEqual(r.exitStatus, 0);
      const abort = new AbortController();
      const running = box.execute(
        "import time; time.sleep(20)",
        limits,
        abort.signal,
      );
      setTimeout(() => abort.abort(), 100);
      await assert.rejects(() => running);
    } finally {
      await box.close();
      await s.session.close();
      s.clean();
    }
    assert.throws(() =>
      execFileSync("docker", ["inspect", box.name], { stdio: "pipe" }),
    );
  },
);

test("postgame exports release history at the shared boundary and disabled capabilities export no private source", async () => {
  const s = fixture();
  try {
    const pre = dump(await s.session.exportTo(join(s.root, "pre"), signal()));
    assert.ok(
      !JSON.stringify(pre.player_box_scores).includes('"game_id":"current"'),
    );
    await s.session.transition("commit", s.f.game.scheduledStart);
    await assert.rejects(
      () => s.session.exportTo(join(s.root, "commit"), signal()),
      { code: "phase_refused" },
    );
    await s.session.transition("postgame", s.f.game.release);
    const post = dump(await s.session.exportTo(join(s.root, "post"), signal()));
    assert.ok(
      JSON.stringify(post.player_box_scores).includes('"game_id":"current"'),
    );
    s.f.config.profile.capabilities.enabled = ["code_execution"];
    const limited = new Session(
      s.f.config,
      s.f.game,
      "pregame",
      s.f.game.scheduledStart,
      s.f.source,
    );
    const data = dump(
      await limited.exportTo(join(s.root, "limited"), signal()),
    );
    assert.deepEqual(Object.keys(data).sort(), [
      "questions",
      "released_results",
      "session",
    ]);
  } finally {
    s.clean();
  }
});

dockerTest(
  "production runner executes through the sandbox, meters compute and freezes code-written memory",
  async () => {
    const { sessionEnvironment } = await import("../src/env/session.js");
    const { Runner } = await import("../src/runner/runner.js");
    const { manifest } = await import("../src/runner/config.js");
    const { MeteringProxy } = await import("../src/runner/proxy.js");
    const { provider } = await import("./fixtures/runner/support.js");
    const s = fixture();
    Object.assign(s.f.config.budget.sandbox, {
      perCallSeconds: 5,
      cpu: 1,
      memoryBytes: limits.memoryBytes,
      stdoutBytes: 4096,
    });
    const proxy = new MeteringProxy(provider);
    await proxy.listen();
    const runner = new Runner(
      s.root,
      manifest(s.f.config, [s.f.game]),
      proxy,
      sessionEnvironment(s.f.config, s.f.source),
    );
    let checked = 0;
    try {
      await runner.run(async ({ session }) => {
        const context = await session.call("context", {});
        const code =
          context.phase === "pregame"
            ? "open('/workspace/model.txt','w').write('trained'); print('ok')"
            : "import os; print(open('/workspace/model.txt').read()); print(os.path.exists('/scratch/old'))";
        const result = await session.call("execute_code", { program: code });
        assert.equal(result.exit_status, 0, result.stderr);
        assert.ok(result.compute_seconds > 0);
        if (context.phase === "pregame") {
          const questions = await session.call("list_questions", {});
          await session.call("begin_commit", {});
          await assert.rejects(
            () =>
              session.call("execute_code", { program: "print('forbidden')" }),
            { code: "phase_refused" },
          );
          await session.call("submit", {
            answers: questions.questions.map((q) => ({
              question_id: q.question_id,
              p_over: q.p_over,
            })),
          });
        } else assert.match(result.stdout, /trained\nFalse/);
        checked++;
      });
      assert.equal(checked, 2);
      assert.equal(runner.record.events("code_result").length, 2);
      assert.ok(
        runner.record
          .events("session_end")
          .every((e) => e.data.status === "completed"),
      );
      const journal =
        runner.record.events("submission")[0].data.value.workspaceChanges;
      assert.ok(journal.length > 0);
      assert.ok(journal.every((r: any) => r.sha256 && !r.content));
    } finally {
      runner.close();
      await proxy.close();
      await s.session.close();
      s.clean();
    }
  },
);

test("cancellation during export waits for the exporter before removing its directory", async () => {
  const { existsSync } = await import("node:fs");
  const s = fixture();
  let directory = "";
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const box = new DockerSandbox(s.f.config, async (dir, abort) => {
    directory = dir;
    await blocked;
    return s.session.exportTo(dir, abort);
  });
  const abort = new AbortController();
  const call = box.execute("pass", limits, abort.signal);
  const rejected = assert.rejects(() => call);
  abort.abort();
  release();
  await rejected;
  await box.close();
  assert.ok(directory);
  assert.equal(existsSync(directory), false);
  s.clean();
});
