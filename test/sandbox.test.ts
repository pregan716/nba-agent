import { gunzipSync } from "node:zlib";
import { readFileSync, realpathSync } from "node:fs";
import { existsSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
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
function dumpOne(file: string) {
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
function dump(file: string) {
  const result = dumpOne(file);
  const games = join(dirname(file), "games");
  if (existsSync(games))
    for (const shard of readdirSync(games).sort()) {
      const temporary = mkdtempSync(join(tmpdir(), "nba-shard-test-"));
      try {
        const decoded = join(temporary, "shard.sqlite");
        writeFileSync(decoded, gunzipSync(readFileSync(join(games, shard))));
        for (const [table, rows] of Object.entries(dumpOne(decoded)))
          (result[table] ??= []).push(...rows);
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    }
  return result;
}
test("session export is invariant to planted future evidence, preserves public projections and gates release", async () => {
  const exports = [];
  for (const future of [false, true]) {
    const s = fixture(future);
    try {
      const path = await s.session.exportTo(join(s.root, "export"), signal());
      const data = dump(path);
      assert.ok(!("questions" in data));
      assert.ok(!("released_results" in data));
      assert.ok(data.evidence.length > 0);
      assert.ok(!("odds_history" in data));
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
      s.root,
    );
    try {
      writeFileSync(join(s.root, "future-secret"), "FUTURE SECRET");
      let result = await sandbox.execute(
        `import os, sqlite3, numpy, pandas, scipy, sklearn, pickle, nba_data
assert len(nba_data.table("games")) > 0
from sklearn.linear_model import LinearRegression
os.mkdir('/workspace/models')
model=LinearRegression().fit([[1],[2]],[2,4])
with open('/workspace/models/fit.pkl','wb') as file: pickle.dump(model,file)
with open('/workspace/models/fit.pkl','rb') as file: assert abs(pickle.load(file).predict([[3]])[0]-6)<1e-6
print('packages-ok')
print(sqlite3.connect('file:/data/session.sqlite?mode=ro',uri=True).execute('select count(*) from session').fetchone()[0])
print(os.path.exists(${JSON.stringify(join(s.root, "future-secret"))}))
open('/scratch/state','w').write('scratch')
open('/workspace/notes','w').write('first')
print(open('/workspace/notes').read())`,
        limits,
        signal(),
      );
      const { sandboxOwner, ROOT_LABEL, ROOT_PATH_LABEL, HOST_LABEL } =
        await import("../src/runner/orphans.js");
      const labels = JSON.parse(
        execFileSync(
          "docker",
          ["inspect", sandbox.name, "--format", "{{json .Config.Labels}}"],
          { encoding: "utf8" },
        ),
      );
      assert.equal(labels[ROOT_LABEL], sandboxOwner(s.root));
      assert.equal(labels[ROOT_PATH_LABEL], realpathSync(s.root));
      assert.equal(labels[HOST_LABEL], (await import("node:os")).hostname());
      assert.ok(existsSync(join(s.root, "sandbox-owner")));
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
    assert.deepEqual(Object.keys(data).sort(), ["session"]);
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
        if (context.phase === "postgame")
          assert.match(result.stdout, /trained\nFalse/);
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
        runner.record.events("session_end")[0].data.workspaceChanges;
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

dockerTest(
  "FUSE coalesces large streams and preserves read/write coherence",
  async () => {
    const s = fixture();
    const sandbox = new DockerSandbox(
      s.f.config,
      (dir, abort) => s.session.exportTo(dir, abort),
      s.session.workspaceForSandbox(),
    );
    try {
      const result = await sandbox.execute(
        `import time, json
for size in [8, 50]:
    path = '/workspace/large-' + str(size)
    block = b'x' * (1024 * 1024)
    started = time.monotonic()
    with open(path, 'wb') as f:
        for _ in range(size): f.write(block)
    written = time.monotonic()
    with open(path, 'rb') as f:
        for _ in range(size): assert f.read(len(block)) == block
        assert f.read() == b''
    print(json.dumps(dict(mib=size, write_seconds=written-started, read_seconds=time.monotonic()-written)))
with open('/workspace/large-8', 'r+b') as f:
    assert f.read(3) == b'xxx'
    f.seek(1)
    f.write(b'abc')
    f.seek(0)
    assert f.read(5) == b'xabcx'
import os
os.truncate('/workspace/large-8', 3)
with open('/workspace/large-8', 'rb') as f: assert f.read() == b'xab'
`,
        {
          ...limits,
          wallSeconds: 45,
          computeSeconds: 40,
          memoryBytes: 2 * 1024 ** 3,
        },
        signal(),
      );
      assert.equal(result.exitStatus, 0, result.stderr);
      console.log(result.stdout);
      const writes = s.session
        .workspaceChanges()
        .filter((c) => c.path === "large-50");
      assert.deepEqual(
        writes.map((c) => c.operation),
        ["write"],
      );
      assert.equal(
        s.session.workspaceForSandbox()!.readBytes("large-8").toString(),
        "xab",
      );
      assert.equal(
        s.session.workspaceForSandbox()!.readBytes("large-50").length,
        50 * 1024 ** 2,
      );
    } finally {
      await sandbox.close();
      s.clean();
    }
  },
);

test("warm exports reuse pinned game shards while reapplying the game release gate", async () => {
  const s = fixture(false);
  try {
    s.f.source.exportCacheDirectory = join(s.root, "cache");
    s.f.config.profile.capabilities.enabled =
      s.f.config.profile.capabilities.enabled.filter(
        (c) => c !== "odds_history",
      );
    const history = s.f.source.history.bind(s.f.source);
    let reads = 0;
    s.f.source.exportHistory = async function* (table, games) {
      for (const game of games) {
        reads++;
        yield { gameId: game.id, ...(await history(table, game)) };
      }
    };
    const session = new Session(
      s.f.config,
      s.f.game,
      "postgame",
      s.f.game.release,
      s.f.source,
    );
    const first = dump(await session.exportTo(join(s.root, "cold"), signal()));
    assert.ok(reads > 0);
    reads = 0;
    const second = dump(await session.exportTo(join(s.root, "warm"), signal()));
    assert.equal(reads, 0);
    assert.deepEqual(second, first);
    const pre = new Session(
      s.f.config,
      s.f.game,
      "pregame",
      s.f.game.scheduledStart,
      s.f.source,
    );
    const before = dump(await pre.exportTo(join(s.root, "before"), signal()));
    assert.equal(reads, 0);
    assert.ok(
      !JSON.stringify(before.player_box_scores).includes('"game_id":"current"'),
    );
  } finally {
    s.clean();
  }
});

test("bulk session projections match the schedule, injury and odds tools", async () => {
  const s = fixture(false);
  try {
    await s.session.transition("commit", s.f.game.scheduledStart);
    await s.session.transition("postgame", s.f.game.release);
    const data = dump(
      await s.session.exportTo(join(s.root, "export"), signal()),
    );
    const expectedInjuries = [],
      expectedSnapshots = [];
    for (const team of s.f.source.teams) {
      const result = await s.session.read_schedule_and_injuries({
        team_id: team.team_id,
      });
      expectedInjuries.push(...result.injury_reports);
      expectedSnapshots.push(...result.team_snapshots);
    }
    const normalize = (rows: object[]) =>
      rows
        .map((row) =>
          JSON.stringify(
            Object.fromEntries(
              Object.entries(row)
                .filter(([k]) => k !== "_row")
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => [
                  k,
                  v && typeof v === "object" ? JSON.stringify(v) : v,
                ]),
            ),
          ),
        )
        .sort();
    for (const [table, expected] of [
      ["injuries", expectedInjuries],
      ["injury_team_snapshots", expectedSnapshots],
    ] as const) {
      assert.deepEqual(normalize(data[table]), normalize(expected), table);
    }
  } finally {
    s.clean();
  }
});

dockerTest(
  "host classifies supervisor OOM and retains the full compute reservation",
  async () => {
    const s = fixture(false);
    const box = new DockerSandbox(s.f.config, (dir, abort) =>
      s.session.exportTo(dir, abort),
    );
    try {
      await box.execute("pass", limits, signal());
      const running = box.execute(
        "import time; time.sleep(2); x=bytearray(1024*1024*1024)",
        limits,
        signal(),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      // Set PID 1's score after the worker starts, so the worker does not inherit
      // the increased score. This setup is inaccessible to unprivileged code.
      execFileSync("docker", [
        "exec",
        box.name,
        "python",
        "-c",
        `import os, time
for _ in range(100):
    if any(p.isdigit() and os.stat('/proc/' + p).st_uid == 1000 for p in os.listdir('/proc')): break
    time.sleep(0.01)
else: raise RuntimeError('worker did not start')
open('/proc/1/oom_score_adj', 'w').write('1000')`,
      ]);
      const result = await running;
      assert.equal(result.limit, "memory");
      assert.equal(result.computeSeconds, limits.computeSeconds);
      assert.equal(result.truncated, true);
      assert.match(result.stderr, /supervisor/);
      await assert.rejects(() => box.execute("pass", limits, signal()), {
        code: "phase_refused",
      });
    } finally {
      await box.close();
      s.clean();
    }
  },
);

test(
  "runner restart removes own running/created orphans and an idle-root exited sandbox, protecting other live roots",
  { skip: !process.env.NBA_SANDBOX_IMAGE },
  async (t) => {
    const logs: string[] = [];
    t.mock.method(console, "error", (message: string) => logs.push(message));
    const { randomUUID } = await import("node:crypto");
    const { Runner } = await import("../src/runner/runner.js");
    const { MeteringProxy } = await import("../src/runner/proxy.js");
    const { manifest } = await import("../src/runner/config.js");
    const { registerSandboxRoot, ROOT_LABEL } =
      await import("../src/runner/orphans.js");
    const { fixtureConfig, provider, environment, harness } =
      await import("./fixtures/runner/support.js");
    const base = mkdtempSync(join(tmpdir(), "nba-orphan-live-")),
      proxy = new MeteringProxy(provider);
    await proxy.listen();
    const m = manifest(fixtureConfig(), [
      { gameId: "g1", scheduledStart: "2025-11-01T23:00:00Z" },
    ]);
    let runner = new Runner(base, m, proxy, environment);
    const idleRoot = join(base, "old-run", "one");
    mkdirSync(idleRoot, { recursive: true });
    const owner = registerSandboxRoot(idleRoot);
    const liveRoot = join(base, "live-run", "one");
    mkdirSync(liveRoot, { recursive: true });
    writeFileSync(join(liveRoot, "runner.lock"), String(process.pid));
    const ownRunning = `nba-session-${randomUUID()}`,
      ownCreated = `nba-session-${randomUUID()}`;
    const mine = `nba-session-${randomUUID()}`,
      other = `nba-session-${randomUUID()}`;
    const image = process.env.NBA_SANDBOX_IMAGE!.replace(/^local@/, "");
    try {
      for (const [name, label] of [
        [mine, owner],
        [other, registerSandboxRoot(liveRoot)],
        [ownRunning, registerSandboxRoot(runner.root)],
        [ownCreated, registerSandboxRoot(runner.root)],
      ]) {
        execFileSync("docker", [
          "create",
          "--name",
          name,
          "--label",
          `${ROOT_LABEL}=${label}`,
          "--entrypoint",
          "/bin/sleep",
          image,
          "300",
        ]);
        if (name !== ownCreated) execFileSync("docker", ["start", name]);
      }
      assert.throws(
        () => new Runner(base, m, proxy, environment),
        /already active/,
      );
      assert.equal(
        execFileSync(
          "docker",
          ["inspect", mine, "--format", "{{.State.Running}}"],
          { encoding: "utf8" },
        ).trim(),
        "true",
      );
      // A dead runner leaves the same Docker state; release only its host lock.
      execFileSync("docker", ["stop", "--time", "0", mine]);
      runner.close();
      runner = new Runner(base, m, proxy, environment);
      await runner.run(harness);
      assert.equal(
        execFileSync(
          "docker",
          ["ps", "-a", "--filter", `name=${mine}`, "--format", "{{.Names}}"],
          { encoding: "utf8" },
        ).trim(),
        "",
      );
      assert.equal(
        execFileSync(
          "docker",
          ["inspect", other, "--format", "{{.State.Running}}"],
          { encoding: "utf8" },
        ).trim(),
        "true",
      );
      const removals = runner.record
        .events("infrastructure")
        .filter((e) => e.data.action === "orphan_container_removed");
      assert.equal(removals.length, 0);
      const removalLogs = logs
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line))
        .filter((e) => e.action === "orphan_container_removed");
      assert.equal(removalLogs.length, 3);
      assert.deepEqual(
        new Set(removalLogs.map((e) => e.name)),
        new Set([mine, ownRunning, ownCreated]),
      );
      assert.equal(
        removalLogs.find((e) => e.name === mine).runRoot,
        realpathSync(idleRoot),
      );
      for (const name of [ownRunning, ownCreated])
        assert.equal(
          execFileSync(
            "docker",
            ["ps", "-a", "--filter", `name=${name}`, "--format", "{{.Names}}"],
            { encoding: "utf8" },
          ).trim(),
          "",
        );
    } finally {
      runner.close();
      await proxy.close();
      for (const name of [mine, other, ownRunning, ownCreated])
        try {
          execFileSync("docker", ["rm", "--force", name], { stdio: "ignore" });
        } catch {}
      rmSync(base, { recursive: true, force: true });
    }
  },
);

dockerTest(
  "Pi executes only through the metered research sandbox in both phases",
  async () => {
    const { piHarness } = await import("../src/harness/pi.js");
    const { harnessConfig } = await import("../src/harness/version.js");
    const { sessionEnvironment } = await import("../src/env/session.js");
    const { Runner } = await import("../src/runner/runner.js");
    const { manifest } = await import("../src/runner/config.js");
    const { MeteringProxy } = await import("../src/runner/proxy.js");
    const s = fixture();
    Object.assign(s.f.config.budget.sandbox, {
      perCallSeconds: 5,
      cpu: 1,
      memoryBytes: limits.memoryBytes,
      stdoutBytes: 4096,
    });
    s.f.config.harness = harnessConfig({
      implementation: "pi",
      memory: s.f.config.profile.memory,
      effort: "high",
      thinking: "adaptive",
      sandboxImage: s.f.config.harness.sandboxImage,
      codeRevision: "test",
    });
    let calls = 0;
    const proxy = new MeteringProxy({
      count: async () => 5,
      create: async (request) => {
        const first = request.messages.length === 1;
        const post = JSON.stringify(request.messages[0]).includes("postgame");
        const content = first
          ? [
              {
                type: "tool_use",
                id: `code_${++calls}`,
                name: "execute_code",
                input: {
                  program: post
                    ? "print(open('/workspace/pi.txt').read())"
                    : "open('/workspace/pi.txt','w').write('pi-memory'); print('ok')",
                },
              },
            ]
          : [{ type: "text", text: "done" }];
        return {
          id: "fixture",
          type: "message",
          role: "assistant",
          model: request.model,
          content,
          stop_reason: first ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: 5,
            output_tokens: 10,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        } as any;
      },
    });
    await proxy.listen();
    const runner = new Runner(
      s.root,
      manifest(s.f.config, [s.f.game]),
      proxy,
      sessionEnvironment(s.f.config, s.f.source),
    );
    try {
      await runner.run(piHarness({ model: "claude-opus-4-6" }));
      assert.deepEqual(runner.record.events("session_error"), []);
      const results = runner.record.events("code_result");
      assert.equal(results.length, 2);
      assert.ok(
        results.every(
          (e) => e.data.exitStatus === 0 && e.data.computeSeconds > 0,
        ),
      );
      assert.match(results[1].data.stdout, /pi-memory/);
      assert.ok(
        runner.record
          .events("phase_end")
          .every((e) => e.data.status === "completed"),
      );
      assert.ok(runner.record.events("harness_history").length >= 2);
    } finally {
      runner.close();
      await proxy.close();
      await s.session.close();
      s.clean();
    }
  },
);

dockerTest(
  "v3 M0-M3 gates are identical through workspace tools and the research mount",
  async () => {
    const { memoryVariant } = await import("../src/env/memory.js");
    for (const variant of ["M0", "M1", "M2", "M3"] as const) {
      const s = fixture(),
        memory = memoryVariant(variant);
      s.f.config.profile.memory = memory;
      s.f.config.budget.memory = {
        tokenCap: 50000,
        countProtocol: "analyst-count-snapshot-v1",
      };
      const workspace = join(s.root, "workspace");
      for (const path of [
        "memory/coach_profile.md",
        "memory/coach/a",
        "memory/best_practices.md",
        "memory/practices/a",
        "skills/a",
        "packages/old/a",
      ]) {
        mkdirSync(join(workspace, path, ".."), { recursive: true });
        writeFileSync(join(workspace, path), "planted");
      }
      const session = new Session(
        s.f.config,
        s.f.game,
        "pregame",
        s.f.game.scheduledStart,
        s.f.source,
        workspace,
        s.root,
        undefined,
        async (files) =>
          Object.values(files).reduce((n, text) => n + text.length, 0),
      );
      const sandbox = new DockerSandbox(
        s.f.config,
        (directory, abort) => session.exportTo(directory, abort),
        session.workspaceForSandbox(),
        s.root,
      );
      try {
        const allowed = [
          ...(memory.coachProfile.read
            ? ["memory/coach_profile.md", "memory/coach/a"]
            : []),
          ...(memory.bestPractices.read
            ? ["memory/best_practices.md", "memory/practices/a"]
            : []),
        ];
        const result = await sandbox.execute(
          `import os, json
allowed = ${JSON.stringify(allowed)}
paths = ['memory/coach_profile.md','memory/coach/a','memory/best_practices.md','memory/practices/a','skills/a','packages/old/a']
for path in paths:
    full = '/workspace/' + path
    if path in allowed:
        assert open(full).read() == 'planted'
    else:
        assert not os.path.exists(full), path
        for mode in ['r','w','a']:
            try:
                with open(full,mode) as f:
                    if mode != 'r': f.write('bad')
            except OSError: pass
            else: raise AssertionError(path + ':' + mode)
assert ('memory' in os.listdir('/workspace')) == bool(allowed)
assert 'skills' not in os.listdir('/workspace')
open('/workspace/scratch/session.txt','w').write('scratch')
open('/workspace/packages/current/a','w').write('current')
print('gate checks passed')`,
          limits,
          signal(),
        );
        assert.equal(result.exitStatus, 0, result.stderr);
        assert.match(result.stdout, /gate checks passed/);
        assert.equal(
          (
            await session.call(
              "workspace_read",
              { path: "scratch/session.txt" },
              signal(),
            )
          ).content,
          "scratch",
        );
        if (variant === "M3") {
          await session.call(
            "workspace_write",
            { path: "memory/coach_profile.md", content: "x".repeat(49979) },
            signal(),
          ); // three remaining planted files: 21 tokens
          const result = await sandbox.execute(
            "with open('/workspace/memory/coach_profile.md','a') as f: f.write('x')",
            limits,
            signal(),
          );
          assert.match(
            result.stderr,
            /current 50000 tokens; proposed 50001; cap 50000/,
          );
          assert.equal(
            (
              await session.call(
                "workspace_read",
                { path: "memory/coach_profile.md" },
                signal(),
              )
            ).bytes,
            49979,
          );
        }
      } finally {
        await sandbox.close();
        await session.close();
        await s.session.close();
        s.clean();
      }
    }
  },
);
