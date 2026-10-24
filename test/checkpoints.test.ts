import test from "node:test";
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
  ROOT_LABEL,
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
test("orphan sweep is scoped to registered root, verifies labels/names, logs only successful removals", async () => {
  const root = mkdtempSync(join(tmpdir(), "nba-orphans-"));
  try {
    const calls: string[][] = [],
      removed: string[] = [];
    await sweepOrphanContainers(
      root,
      () => assert.fail(),
      async () => {
        assert.fail("no Docker needed before any sandbox use");
      },
    );
    const owner = registerSandboxRoot(root),
      name = "nba-session-12345678-1234-1234-1234-123456789abc";
    const ids = ["a".repeat(12), "b".repeat(12), "c".repeat(12)];
    await sweepOrphanContainers(
      root,
      (id) => removed.push(id),
      async (args) => {
        calls.push(args);
        if (args[0] === "ps") {
          assert.ok(args.includes(`label=${ROOT_LABEL}=${owner}`));
          return ids
            .map((ID) => JSON.stringify({ ID, Names: name }))
            .join("\n");
        }
        if (args[0] === "inspect")
          return JSON.stringify([
            {
              Name: `/${name}`,
              Config: {
                Labels: {
                  [ROOT_LABEL]: args[1] === ids[1] ? "other-root" : owner,
                },
              },
            },
          ]);
        return "";
      },
    );
    assert.deepEqual(removed, [ids[0], ids[2]]);
    assert.equal(calls.filter((c) => c[0] === "rm").length, 2);
    await assert.rejects(
      sweepOrphanContainers(
        root,
        () => assert.fail(),
        async () => {
          throw Error("Docker unavailable");
        },
      ),
      /unavailable/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
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
