import test from "node:test";
import { spawnSync } from "node:child_process";
import { Runner } from "../src/runner/runner.js";
import { MeteringProxy } from "../src/runner/proxy.js";
import { provider, environment } from "./fixtures/runner/support.js";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifest } from "../src/runner/config.js";
import { RecordStore, snapshot } from "../src/runner/record.js";
import {
  checkpoint,
  restoreCheckpoint,
  R2CheckpointSink,
} from "../src/runner/sync.js";
import { fixtureConfig } from "./fixtures/runner/support.js";
import {
  registerSandboxRoot,
  sweepOrphanContainers,
  sweepOwnOrphanContainers,
  sweepClaimHeld,
  ROOT_LABEL,
  sandboxLabels,
  SWEEP_LOCK,
} from "../src/runner/orphans.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nba-checkpoint-"));
  const record = new RecordStore(
    root,
    manifest(fixtureConfig(), [
      { gameId: "g", scheduledStart: "2025-11-01T23:00:00Z" },
    ]),
  );
  const work = join(root, "workspace");
  mkdirSync(work);
  writeFileSync(join(work, "model"), "model bytes");
  record.append("snapshot", "g", snapshot(root, work));
  const objects = new Map<string, Buffer>(),
    puts: string[] = [];
  const sink = {
    has: async (key: string) => objects.has(key),
    put: async (key: string, bytes: Buffer) => {
      puts.push(key);
      objects.set(key, Buffer.from(bytes));
    },
    get: async (key: string) => {
      const value = objects.get(key);
      if (!value) throw Error(`Missing ${key}`);
      return value;
    },
  };
  return {
    root,
    record,
    work,
    sink,
    objects,
    puts,
    close() {
      record.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test("three checkpoints share blob bytes locally and upload each immutable blob once", async () => {
  const f = setup();
  try {
    const indexes = [];
    for (let i = 0; i < 3; i++) {
      f.record.append("checkpoint_fixture", "g", { i });
      const dir = await checkpoint(f.record, f.sink);
      assert.equal(existsSync(join(dir, "blobs")), false);
      indexes.push(JSON.parse(readFileSync(join(dir, "index.json"), "utf8")));
    }
    assert.equal(f.puts.filter((k) => k.includes("/blobs/")).length, 1);
    const blobs = indexes.map((i) =>
      i.objects.filter((o: any) => o.key.startsWith("blobs/")),
    );
    assert.deepEqual(blobs[0], blobs[1]);
    assert.deepEqual(blobs[1], blobs[2]);
    assert.equal(readdirSync(join(f.root, "blobs")).length, 1);
    assert.equal(f.puts.filter((k) => k.endsWith("/index.json")).length, 3);
  } finally {
    f.close();
  }
});
test("failed marker upload retries after reopen, reuses uploaded blobs, and restores only indexed objects", async () => {
  const f = setup();
  let reopened: RecordStore | undefined;
  try {
    await assert.rejects(
      checkpoint(f.record, {
        has: f.sink.has,
        put: async (k, b) => {
          if (k.endsWith("/index.json")) throw Error("upload failed");
          await f.sink.put(k, b);
        },
      }),
      /upload failed/,
    );
    assert.equal(
      f.puts.some((k) => k.endsWith("/index.json")),
      false,
    );
    const seq = f.record.events().at(-1)!.seq;
    assert.equal(
      existsSync(join(f.root, "checkpoints", String(seq), "index.json")),
      false,
    );
    f.record.close();
    reopened = new RecordStore(f.root);
    await checkpoint(reopened, f.sink);
    assert.equal(f.puts.filter((k) => k.includes("/blobs/")).length, 1);
    const key = f.puts.at(-1)!;
    f.objects.set("fixture/r1/blobs/unreferenced", Buffer.from("unused"));
    const fetched: string[] = [];
    const target = join(f.root, "restored");
    await restoreCheckpoint(
      {
        get: async (k) => {
          fetched.push(k);
          return f.sink.get(k);
        },
      },
      key,
      target,
    );
    assert.equal(fetched.includes("fixture/r1/blobs/unreferenced"), false);
    assert.deepEqual(
      readdirSync(join(target, "blobs")),
      readdirSync(join(f.root, "blobs")),
    );
    assert.equal(existsSync(join(target, "runner.lock")), false);
    const restored = new RecordStore(target);
    restored.verify();
    restored.close();
    await assert.rejects(restoreCheckpoint(f.sink, key, target), /fresh/);
  } finally {
    reopened?.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
test("restore rejects corrupted bytes and unsafe index paths without publishing a partial root", async () => {
  const f = setup();
  try {
    await checkpoint(f.record, f.sink);
    const key = f.puts.at(-1)!;
    const blob = f.puts.find((k) => k.includes("/blobs/"))!;
    const original = f.objects.get(blob)!;
    f.objects.set(blob, Buffer.from("corrupt"));
    const target = join(f.root, "restored");
    await assert.rejects(restoreCheckpoint(f.sink, key, target), /integrity/);
    assert.equal(existsSync(target), false);
    f.objects.set(blob, original);
    const index = JSON.parse(f.objects.get(key)!.toString());
    index.objects[0].key = "../escape";
    f.objects.set(key, Buffer.from(JSON.stringify(index)));
    await assert.rejects(restoreCheckpoint(f.sink, key, target));
    assert.equal(existsSync(target), false);
  } finally {
    f.close();
  }
});
test("legacy v1 checkpoint restore and same-head checkpoint upgrade", async () => {
  const f = setup();
  try {
    const dir = await checkpoint(f.record, f.sink),
      key = f.puts.at(-1)!;
    const index = JSON.parse(f.objects.get(key)!.toString());
    index.schemaVersion = 1;
    const prefix = key.slice(0, -"index.json".length);
    for (const object of index.objects.filter((o: any) =>
      o.key.startsWith("blobs/"),
    ))
      f.objects.set(
        prefix + object.key,
        f.objects.get(`fixture/r1/${object.key}`)!,
      );
    f.objects.set(key, Buffer.from(JSON.stringify(index)));
    await restoreCheckpoint(f.sink, key, join(f.root, "legacy"));
    writeFileSync(join(dir, "index.json"), JSON.stringify(index));
    await checkpoint(f.record, f.sink);
    assert.equal(JSON.parse(f.objects.get(key)!.toString()).schemaVersion, 2);
  } finally {
    f.close();
  }
});
test("R2 blob existence distinguishes missing objects from permission/network failures", async () => {
  let status = 404;
  const sink = new R2CheckpointSink(
    {
      send: async () => {
        throw { $metadata: { httpStatusCode: status } };
      },
    } as any,
    "bucket",
    "prefix",
  );
  assert.equal(await sink.has("blob"), false);
  status = 403;
  await assert.rejects(sink.has("blob"));
  status = 500;
  await assert.rejects(sink.has("blob"));
});
test("host sweep removes only exited containers in verified idle roots and holds a cleanup claim", async () => {
  const base = mkdtempSync(join(tmpdir(), "nba-orphans-"));
  const root = join(base, "current", "one"),
    idle = join(base, "old", "one"),
    locked = join(base, "live", "one");
  for (const path of [root, idle, locked]) mkdirSync(path, { recursive: true });
  const labels = (path: string) =>
    Object.fromEntries(
      sandboxLabels(path).map((v) => {
        const i = v.indexOf("=");
        return [v.slice(0, i), v.slice(i + 1)];
      }),
    );
  try {
    const idleLabels = labels(idle),
      liveLabels = labels(locked);
    writeFileSync(join(locked, "runner.lock"), String(process.pid));
    const name = "nba-session-12345678-1234-1234-1234-123456789abc";
    const containers = [
      { labels: idleLabels, state: "exited" },
      { labels: liveLabels, state: "exited" },
      { labels: idleLabels, state: "running" },
      { labels: { [ROOT_LABEL]: registerSandboxRoot(idle) }, state: "exited" },
      { labels: { ...idleLabels, [ROOT_LABEL]: "unknown" }, state: "exited" },
      { labels: {}, state: "exited" },
      { labels: idleLabels, state: "created" },
      {
        labels: { ...idleLabels, "nba-agent.host": "another-host" },
        state: "exited",
      },
    ];
    const removed: string[] = [];
    await sweepOrphanContainers(
      root,
      (id) => removed.push(id),
      async (args) => {
        if (args[0] === "ps") {
          assert.ok(args.includes("status=exited"));
          assert.ok(args.includes(`label=${ROOT_LABEL}`));
          return containers
            .map((_, i) =>
              JSON.stringify({ ID: String(i).repeat(12), Names: name }),
            )
            .join("\n");
        }
        const c = containers[Number(args[1][0])];
        if (args[0] === "inspect")
          return JSON.stringify([
            {
              Name: `/${name}`,
              Config: { Labels: c.labels },
              State: { Status: c.state, Running: c.state === "running" },
            },
          ]);
        assert.deepEqual(args, ["rm", args[1]]);
        assert.equal(
          readFileSync(join(idle, SWEEP_LOCK), "utf8"),
          String(process.pid),
        );
        assert.equal(existsSync(join(idle, "runner.lock")), false);
        return "";
      },
    );
    assert.deepEqual(removed, ["0".repeat(12), "3".repeat(12)]);
    assert.equal(existsSync(join(idle, SWEEP_LOCK)), false);
    assert.equal(
      readFileSync(join(locked, "runner.lock"), "utf8"),
      String(process.pid),
    );
    // Invalid locks fail closed, and failed removals release the cleanup claim.
    const listing = JSON.stringify({ ID: "a".repeat(12), Names: name });
    const command = async (args: string[]) => {
      if (args[0] === "ps") return listing;
      if (args[0] === "inspect")
        return JSON.stringify([
          {
            Name: `/${name}`,
            Config: { Labels: idleLabels },
            State: { Status: "exited", Running: false },
          },
        ]);
      throw Error("container restarted");
    };
    writeFileSync(join(idle, "runner.lock"), "invalid");
    await sweepOrphanContainers(root, () => assert.fail(), command);
    const dead = spawnSync(
      process.execPath,
      ["-e", "console.log(process.pid)"],
      { encoding: "utf8" },
    ).stdout.trim();
    writeFileSync(join(idle, "runner.lock"), dead);
    writeFileSync(join(idle, SWEEP_LOCK), dead);
    await assert.rejects(
      sweepOrphanContainers(root, () => assert.fail(), command),
      /restarted/,
    );
    assert.equal(existsSync(join(idle, SWEEP_LOCK)), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("lost publication acknowledgement retries identical checkpoint bytes", async () => {
  const f = setup();
  try {
    await assert.rejects(
      checkpoint(f.record, {
        has: f.sink.has,
        put: async (k, b) => {
          await f.sink.put(k, b);
          if (k.endsWith("index.json")) throw Error("lost acknowledgement");
        },
      }),
      /lost acknowledgement/,
    );
    const original = new Map(f.objects);
    await checkpoint(f.record, f.sink);
    for (const [key, bytes] of original)
      assert.deepEqual(f.objects.get(key), bytes, key);
  } finally {
    f.close();
  }
});

test("runner refuses a root claimed for sandbox cleanup", () => {
  const base = mkdtempSync(join(tmpdir(), "nba-cleanup-lock-"));
  const m = manifest(fixtureConfig(), [
    { gameId: "g", scheduledStart: "2025-11-01T23:00:00Z" },
  ]);
  const root = join(base, m.config.runId, m.config.replicateId);
  mkdirSync(root, { recursive: true });
  try {
    writeFileSync(join(root, SWEEP_LOCK), String(process.pid));
    assert.throws(
      () => new Runner(base, m, new MeteringProxy(provider), environment),
      /cleanup holds/,
    );
    assert.equal(existsSync(join(root, "runner.lock")), false);
    writeFileSync(join(root, SWEEP_LOCK), "invalid");
    assert.equal(sweepClaimHeld(root), true);
    const dead = spawnSync(
      process.execPath,
      ["-e", "console.log(process.pid)"],
      { encoding: "utf8" },
    ).stdout.trim();
    writeFileSync(join(root, SWEEP_LOCK), dead);
    const runner = new Runner(
      base,
      m,
      new MeteringProxy(provider),
      environment,
    );
    runner.close();
    assert.equal(existsSync(join(root, SWEEP_LOCK)), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("own-root restart removes running, created and exited orphans under its runner lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "nba-own-orphans-"));
  try {
    const owner = registerSandboxRoot(root);
    writeFileSync(join(root, "runner.lock"), String(process.pid));
    const states = ["running", "created", "exited"];
    const name = "nba-session-12345678-1234-1234-1234-123456789abc";
    const removed: string[] = [];
    await sweepOwnOrphanContainers(
      root,
      (id) => removed.push(id),
      async (args) => {
        if (args[0] === "ps") {
          assert.ok(args.includes(`label=${ROOT_LABEL}=${owner}`));
          assert.ok(!args.some((v) => v.startsWith("status=")));
          return states
            .map((_, i) =>
              JSON.stringify({ ID: String(i).repeat(12), Names: name }),
            )
            .join("\n");
        }
        if (args[0] === "inspect")
          return JSON.stringify([
            {
              Name: `/${name}`,
              Config: { Labels: { [ROOT_LABEL]: owner } },
              State: { Status: states[Number(args[1][0])] },
            },
          ]);
        assert.deepEqual(args, ["rm", "--force", args[2]]);
        return "";
      },
    );
    assert.deepEqual(removed, ["0".repeat(12), "1".repeat(12), "2".repeat(12)]);
    await assert.rejects(
      sweepOwnOrphanContainers(
        root,
        () => assert.fail(),
        async () => {
          throw Error("Docker failed");
        },
      ),
      /Docker failed/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
