import test from "node:test";
import assert from "node:assert/strict";
import { verifyLaunchImages } from "../src/launch/images.js";
const id = `sha256:${"a".repeat(64)}`;
const local = `local@${id}`;
const remote = `registry.example/sandbox@sha256:${"b".repeat(64)}`;

test("image preflight checks local IDs and registry digest references without pulling", () => {
  const seen: string[] = [];
  verifyLaunchImages({ projection: local, sandbox: remote }, (image) => {
    seen.push(image);
    return id + "\n";
  });
  assert.deepEqual(seen, [id, remote]);
  for (const missing of [id, remote]) {
    assert.throws(
      () =>
        verifyLaunchImages({ projection: local, sandbox: remote }, (image) => {
          if (image === missing) throw Error("No such image");
          return id;
        }),
      new RegExp(
        `Cannot resolve pinned ${missing === id ? "projection" : "sandbox"} image locally`,
      ),
    );
  }
  assert.throws(
    () => verifyLaunchImages({ projection: local }, () => "garbage"),
    /Cannot resolve/,
  );
  assert.throws(
    () => verifyLaunchImages({ projection: "latest" }),
    /immutable digest/,
  );
  const only: string[] = [];
  verifyLaunchImages({ projection: local, sandbox: null }, (image) => {
    only.push(image);
    return id;
  });
  assert.deepEqual(only, [id]);
});

test("launcher refuses missing images before data access or provider setup", async () => {
  const {
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    readFileSync,
    rmSync,
    existsSync,
  } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const script = resolve("scripts/forecast-run.ts");
  for (const role of ["projection", "sandbox"]) {
    const root = mkdtempSync(join(tmpdir(), "nba-preflight-"));
    try {
      writeFileSync(
        join(root, "docker"),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> '${root}/inspected'\nif [ "$3" = '${role === "projection" ? id : remote}' ]; then exit 1; fi\nprintf '%s\\n' '${id}'\n`,
        { mode: 0o700 },
      );
      const launch = () =>
        spawnSync(
          process.execPath,
          [
            "--import",
            import.meta.resolve("tsx"),
            script,
            "no-memory",
            "fixture",
            "r1",
            remote,
            local,
            join(root, "run"),
          ],
          {
            cwd: root,
            encoding: "utf8",
            timeout: 15000,
            env: {
              ...process.env,
              ANTHROPIC_API_KEY: "fixture",
              PATH: `${root}:${process.env.PATH}`,
            },
          },
        );
      const result = launch();
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        new RegExp(`Cannot resolve pinned ${role} image locally`),
      );
      assert.match(result.stderr, /no model calls have been started/);
      assert.equal(existsSync(join(root, "run")), false);
      // A resume invocation must run preflight again before reading run data.
      mkdirSync(join(root, "run"));
      writeFileSync(join(root, "run", "sentinel"), "existing run");
      const resumed = launch();
      assert.notEqual(resumed.status, 0);
      assert.match(
        resumed.stderr,
        new RegExp(`Cannot resolve pinned ${role} image locally`),
      );
      assert.equal(
        readFileSync(join(root, "run", "sentinel"), "utf8"),
        "existing run",
      );
      const inspected = readFileSync(join(root, "inspected"), "utf8")
        .trim()
        .split("\n");
      assert.equal(inspected.length, role === "sandbox" ? 4 : 2);
      assert.ok(inspected.every((line) => line.startsWith("image inspect ")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
