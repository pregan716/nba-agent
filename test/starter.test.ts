import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
const image = process.env.ASSEMBLER_IMAGE;
test(
  "starter: native probability parity, deterministic full refit and planted future cutoff",
  { skip: !image },
  () => {
    execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "-e",
        "OMP_NUM_THREADS=1",
        "-e",
        "OPENBLAS_NUM_THREADS=1",
        "-e",
        "PYTHONPATH=/code",
        "--mount",
        `type=bind,source=${resolve("starter")},target=/code,readonly`,
        "--mount",
        `type=bind,source=${resolve("test/starter_model.py")},target=/test_starter.py,readonly`,
        "--entrypoint",
        "python",
        image!.replace(/^local@/, ""),
        "/test_starter.py",
      ],
      { stdio: "pipe", timeout: 120000 },
    );
  },
);
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  chmodSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixtureStarter, starterState } from "./fixtures/starter.js";
import { DockerAssembler } from "../src/policy/sandbox.js";
test(
  "starter mount is read-only and batch children cannot mutate later predictions",
  { skip: !image },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "starter-test-"));
    chmodSync(root, 0o755);
    try {
      const mount = fixtureStarter(root),
        p = join(root, "package");
      mkdirSync(p);
      writeFileSync(
        join(p, "assemble.py"),
        `from nba_starter import predict, load\ndef assemble(state):\n result=predict(state)\n try:\n  open('/starter/model.json','w').write('corrupt')\n  raise RuntimeError('writable model')\n except OSError: pass\n load().models[1].spec['baseline']=[[99]]\n return result\n`,
      );
      const a = new DockerAssembler(
        image!,
        {
          wallSeconds: 15,
          memoryBytes: 512 * 1024 * 1024,
          outputBytes: 256000,
        },
        mount,
      );
      const signal = new AbortController().signal;
      const single = await a.run(p, starterState, signal);
      const batch = await a.runBatch(p, [starterState, starterState], signal);
      for (const row of batch) {
        assert.equal(row.error, undefined);
        assert.deepEqual(row.value, single.value);
      }
      assert.equal((single.value as any).timing, 0.5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
