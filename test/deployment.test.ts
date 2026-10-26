import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildSandboxImage,
  type DockerCommand,
} from "../src/deployment/sandbox-image.js";
import { historyExportCacheDirectory } from "../src/env/cache.js";
const id = `sha256:${"a".repeat(64)}`;
const digest = `sha256:${"b".repeat(64)}`;
const tag = "registry.example:5000/nba/sandbox:release-1";
const pin = `registry.example:5000/nba/sandbox@${digest}`;
function dockerFixture(
  push = `release-1: digest: ${digest} size: 1234`,
  pulled = id,
) {
  const calls: string[][] = [];
  const docker: DockerCommand = (args) => {
    calls.push(args);
    if (args[0] === "push") return push;
    if (args[0] === "image") return args[2].includes("@") ? pulled : id;
    return "";
  };
  return { docker, calls };
}
test("local builds preserve the image-ID pin without pushing", () => {
  const f = dockerFixture();
  assert.equal(buildSandboxImage({}, f.docker), `local@${id}`);
  assert.deepEqual(f.calls, [
    ["build", "--tag", "nba-agent-sandbox:local", "sandbox"],
    ["image", "inspect", "nba-agent-sandbox:local", "--format", "{{.Id}}"],
  ]);
});
test("registry builds pin the pushed manifest digest and verify the exact pulled artifact", () => {
  const f = dockerFixture();
  assert.equal(
    buildSandboxImage({ push: tag, platform: "linux/amd64" }, f.docker),
    pin,
  );
  assert.deepEqual(f.calls, [
    ["build", "--platform", "linux/amd64", "--tag", tag, "sandbox"],
    ["image", "inspect", tag, "--format", "{{.Id}}"],
    ["push", tag],
    ["pull", "--platform", "linux/amd64", pin],
    ["image", "inspect", pin, "--format", "{{.Id}}"],
  ]);
});
test("publish refuses failed pushes, missing/ambiguous digests and mismatched images", () => {
  for (const output of [
    "",
    "digest: sha256:bad",
    `digest: ${digest}\ndigest: ${id}`,
  ]) {
    const f = dockerFixture(output);
    assert.throws(
      () => buildSandboxImage({ push: tag }, f.docker),
      /registry manifest (response|digests)/,
    );
    assert.ok(!f.calls.some((c) => c[0] === "pull"));
  }
  const mismatch = dockerFixture(undefined, digest);
  assert.throws(
    () => buildSandboxImage({ push: tag }, mismatch.docker),
    /does not identify/,
  );
  for (const stage of ["build", "push", "pull"]) {
    const f = dockerFixture();
    assert.throws(
      () =>
        buildSandboxImage({ push: tag }, (args) => {
          if (args[0] === stage) throw Error(`failed ${stage}`);
          return f.docker(args);
        }),
      new RegExp(`failed ${stage}`),
    );
  }
});
test("publish requires explicit registry/tag and one supported platform before running Docker", () => {
  for (const push of [
    "repo:latest",
    "registry.example/repo",
    pin,
    "-bad",
    "registry.example/repo:tag other",
  ]) {
    assert.throws(
      () =>
        buildSandboxImage({ push }, () => assert.fail("Docker must not run")),
      /explicit registry/,
    );
  }
  assert.throws(
    () =>
      buildSandboxImage({ platform: "linux/amd64,linux/arm64" }, () =>
        assert.fail("Docker must not run"),
      ),
    /one Linux/,
  );
});
test("invalid build arguments leave a previously recorded pin untouched", () => {
  const root = mkdtempSync(join(tmpdir(), "nba-build-cli-"));
  try {
    mkdirSync(join(root, ".cache"));
    const file = join(root, ".cache/sandbox-image.json");
    const saved = JSON.stringify({ image: pin });
    writeFileSync(file, saved);
    const result = spawnSync(
      resolve("node_modules/.bin/tsx"),
      [resolve("scripts/sandbox-build.ts"), "--push=invalid"],
      { cwd: root, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /explicit registry/);
    assert.equal(readFileSync(file, "utf8"), saved);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("persistent cache placement honors explicit path, deployment environment, and local default", () => {
  const saved = process.env.NBA_HISTORY_EXPORT_CACHE;
  try {
    delete process.env.NBA_HISTORY_EXPORT_CACHE;
    assert.equal(
      historyExportCacheDirectory(),
      resolve(".cache/history-export-v2"),
    );
    process.env.NBA_HISTORY_EXPORT_CACHE = "/mnt/nba/history-shards";
    assert.equal(historyExportCacheDirectory(), "/mnt/nba/history-shards");
    assert.equal(historyExportCacheDirectory("custom"), resolve("custom"));
    process.env.NBA_HISTORY_EXPORT_CACHE = "";
    assert.throws(
      () => historyExportCacheDirectory(),
      /must be an absolute path/,
    );
    process.env.NBA_HISTORY_EXPORT_CACHE = "history-export-v2";
    assert.throws(
      () => historyExportCacheDirectory(),
      /must be an absolute path/,
    );
    assert.equal(historyExportCacheDirectory("explicit"), resolve("explicit"));
    assert.throws(() => historyExportCacheDirectory(""), /must not be empty/);
  } finally {
    if (saved === undefined) delete process.env.NBA_HISTORY_EXPORT_CACHE;
    else process.env.NBA_HISTORY_EXPORT_CACHE = saved;
  }
});

test("non-classic push output resolves the structured remote manifest and verifies it", () => {
  const f = dockerFixture("pushed successfully");
  const calls: string[][] = [];
  assert.equal(
    buildSandboxImage({ push: tag }, (args) => {
      calls.push(args);
      return args[0] === "buildx"
        ? JSON.stringify({
            digest,
            mediaType: "application/vnd.oci.image.index.v1+json",
            manifests: [{ digest: id }],
          })
        : f.docker(args);
    }),
    pin,
  );
  assert.deepEqual(calls[3], [
    "buildx",
    "imagetools",
    "inspect",
    tag,
    "--format",
    "{{json .Manifest}}",
  ]);
  assert.deepEqual(calls[4], ["pull", pin]);
  const wrong = dockerFixture("pushed successfully", digest);
  assert.throws(
    () =>
      buildSandboxImage({ push: tag }, (args) =>
        args[0] === "buildx" ? JSON.stringify({ digest }) : wrong.docker(args),
      ),
    /does not identify/,
  );
  for (const output of [
    "not JSON",
    "null",
    "{}",
    JSON.stringify({ digest: "sha256:bad" }),
  ]) {
    const bad = dockerFixture("");
    assert.throws(
      () =>
        buildSandboxImage({ push: tag }, (args) =>
          args[0] === "buildx" ? output : bad.docker(args),
        ),
      /registry manifest/i,
    );
    assert.ok(!bad.calls.some((c) => c[0] === "pull"));
  }
  assert.throws(
    () =>
      buildSandboxImage({ push: tag }, (args) => {
        if (args[0] === "buildx") throw Error("buildx unavailable");
        return dockerFixture("").docker(args);
      }),
    /buildx unavailable/,
  );
});
