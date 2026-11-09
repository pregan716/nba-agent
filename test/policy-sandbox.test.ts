import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  cpSync,
  readdirSync,
  lstatSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerAssembler } from "../src/policy/sandbox.js";
import { PackageStore } from "../src/policy/package.js";
import { assembleRequest } from "../src/policy/replay.js";
import { sha256 } from "../src/data/store.js";
import type { ObservableState } from "../src/replay/types.js";
const image = process.env.ASSEMBLER_IMAGE;
const signal = () => new AbortController().signal;
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
const limits = {
  wallSeconds: 15,
  memoryBytes: 128 * 1024 * 1024,
  outputBytes: 128000,
};
test(
  "real assembler: isolation, readonly package, fresh scratch, determinism and timeout",
  { skip: !image },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "assembler-gate-")),
      p = join(root, "package");
    mkdirSync(p);
    writeFileSync(join(root, "future-secret"), "PLANTED_FUTURE_RECORD");
    const sandbox = new DockerAssembler(image!, limits);
    const previousKey = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = "PLANTED_RUNNER_CREDENTIAL";
    try {
      writeFileSync(
        join(p, "assemble.py"),
        `import os, socket\ndef assemble(state):\n blocked = []\n for path in ['/workspace/future', '/data/session.sqlite', ${JSON.stringify(join(root, "future-secret"))}]:\n  try: open(path).read()\n  except OSError: blocked.append(path)\n try:\n  socket.create_connection(('1.1.1.1',443),0.1)\n  network = True\n except OSError: network = False\n try:\n  open('/package/changed','w').write('bad')\n  writable = True\n except OSError: writable = False\n fresh = not os.path.exists('/scratch/previous')\n open('/scratch/previous','w').write('ok')\n return {'blocked':len(blocked),'network':network,'writable':writable,'fresh':fresh,'credential':os.environ.get('TYPESAFE_API_KEY')}\n`,
      );
      const expected = {
        blocked: 3,
        network: false,
        writable: false,
        fresh: true,
        credential: null,
      };
      assert.deepEqual((await sandbox.run(p, {}, signal())).value, expected);
      assert.deepEqual((await sandbox.run(p, {}, signal())).value, expected);
      writeFileSync(
        join(p, "assemble.py"),
        "def assemble(state):\n while True: pass\n",
      );
      await assert.rejects(
        new DockerAssembler(image!, { ...limits, wallSeconds: 2 }).run(
          p,
          {},
          signal(),
        ),
        /wall-clock/,
      );
      writeFileSync(
        join(p, "assemble.py"),
        "def assemble(state): return bytearray(1024*1024*1024)\n",
      );
      await assert.rejects(sandbox.run(p, {}, signal()), /Assembler failed/);
      cpSync("examples/policy", p, { recursive: true });
      const store = new PackageStore(join(root, "frozen"));
      const receipt = await store.freeze(
        "g",
        p,
        () => "2025-01-01T00:00:00Z",
        "2025-01-02T00:00:00Z",
        sandbox,
        signal(),
      );
      const state = {
        gameId: "g",
        celtics: ["a", "b", "c", "d", "e"],
        eligibleBench: ["f"],
      } as ObservableState;
      const a = await assembleRequest(
        sandbox,
        join(store.path("g"), "package"),
        receipt,
        state,
        join(root, "cache"),
        signal(),
      );
      const b = await assembleRequest(
        sandbox,
        join(store.path("g"), "package"),
        receipt,
        state,
        join(root, "cache"),
        signal(),
      );
      assert.deepEqual(a.request, b.request);
      assert.equal(b.cacheHit, true);
    } finally {
      if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previousKey;
      remove(root);
    }
  },
);

test(
  "batch assembler isolates module and scratch state and bounds each item",
  { skip: !image },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "assembler-batch-"));
    // Linux bind mounts retain host modes; the container runs as uid 65534.
    chmodSync(root, 0o755);
    const sandbox = new DockerAssembler(image!, { ...limits, wallSeconds: 1 });
    try {
      writeFileSync(
        join(root, "assemble.py"),
        `import os, random
count = 0
def assemble(state):
 global count
 count += 1
 fresh = not os.path.exists('/scratch/marker')
 open('/scratch/marker','w').write('present')
 if state.get('hang'):
  while True: pass
 if state.get('large'): return 'x' * 200000
 return {'count':count,'fresh':fresh,'random':random.random(),'id':state['id']}
`,
      );
      const states = [{ id: 1 }, { id: 2 }];
      const individual = [];
      for (const state of states)
        individual.push({
          value: (await sandbox.run(root, state, signal())).value,
        });
      assert.deepEqual(
        await sandbox.runBatch(root, states, signal()),
        individual,
      );
      const results = await sandbox.runBatch(
        root,
        [{ hang: true }, { large: true }, { id: 3 }],
        signal(),
      );
      assert.match(results[0].error!, /wall-clock/);
      assert.match(results[1].error!, /output limit/);
      assert.deepEqual(results[2].value, {
        ...(individual[0].value as object),
        id: 3,
      });
      await assert.rejects(
        sandbox.runBatch(root, [{ hang: true }], AbortSignal.timeout(100)),
        /abort|timeout/i,
      );
    } finally {
      remove(root);
    }
  },
);

test(
  "shared-memory files cannot carry states between batch children",
  { skip: !image },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "assembler-shm-"));
    // Linux bind mounts retain host modes; the container runs as uid 65534.
    chmodSync(root, 0o755);
    const sandbox = new DockerAssembler(image!, limits);
    try {
      writeFileSync(
        join(root, "assemble.py"),
        `from pathlib import Path
def assemble(state):
 p = Path('/dev/shm/seen')
 before = p.read_text().splitlines() if p.exists() else []
 try:
  with p.open('a') as f: f.write(str(state['i']) + '\\n')
  writable = True
 except OSError:
  writable = False
 return {'i': state['i'], 'seenBefore':before, 'writable':writable}
`,
      );
      const states = [{ i: 1 }, { i: 2 }, { i: 3 }];
      const batch = await sandbox.runBatch(root, states, signal());
      assert.deepEqual(
        batch,
        states.map((s) => ({
          value: { ...s, seenBefore: [], writable: false },
        })),
      );
      for (let i = 0; i < states.length; i++)
        assert.deepEqual(
          (await sandbox.run(root, states[i], signal())).value,
          batch[i].value,
        );
    } finally {
      remove(root);
    }
  },
);

test(
  "parallel batches retain fresh children and no shared memory; abort joins every container",
  { skip: !image },
  async () => {
    const { execFileSync } = await import("node:child_process");
    const root = mkdtempSync(join(tmpdir(), "parallel-assembler-"));
    chmodSync(root, 0o755);
    const assembler = new DockerAssembler(image!, limits);
    try {
      writeFileSync(
        join(root, "assemble.py"),
        `import os, time\ncounter=0\ndef assemble(state):\n global counter\n counter+=1\n if state.get('hang'): time.sleep(60)\n assert not os.path.exists('/scratch/previous')\n open('/scratch/previous','w').write('yes')\n try:\n  open('/dev/shm/carry','w').write('secret')\n  raise RuntimeError('shared memory writable')\n except OSError: pass\n return counter\n`,
      );
      const result = await Promise.all(
        Array.from({ length: 4 }, () =>
          assembler.runBatch(root, [{}, {}], signal()),
        ),
      );
      assert.deepEqual(
        result,
        Array.from({ length: 4 }, () => [{ value: 1 }, { value: 1 }]),
      );
      for (const abort of [
        AbortSignal.timeout(1500),
        AbortSignal.timeout(300),
      ]) {
        const cancelled = await Promise.allSettled(
          Array.from({ length: 4 }, () =>
            assembler.runBatch(root, [{ hang: true }], abort),
          ),
        );
        assert.ok(cancelled.every((r) => r.status === "rejected"));
        assert.equal(
          execFileSync(
            "docker",
            ["ps", "-aq", "--filter", `label=nba-assembler-package=${root}`],
            { encoding: "utf8" },
          ).trim(),
          "",
        );
      }
    } finally {
      remove(root);
    }
  },
);
