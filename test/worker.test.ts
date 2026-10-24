import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const worker = fileURLToPath(
  new URL("../scripts/r2-worker.mjs", import.meta.url),
);
const fixture = {
  DOPPLER_PROJECT: "nba-agent",
  DOPPLER_CONFIG: "prd",
  R2_ENDPOINT_URL: `https://${"a".repeat(32)}.r2.cloudflarestorage.com/`,
  R2_ACCESS_KEY_ID: "fixture-only",
  R2_SECRET_ACCESS_KEY: "fixture-only",
};
function run(
  bucket: string,
  overrides: Record<string, string | undefined> = {},
  project = "nba-agent",
  config = "prd",
) {
  // EOF immediately after initialization: tests never make an R2 request.
  return spawnSync(process.execPath, [worker, bucket, project, config], {
    env: { ...fixture, ...overrides },
    input: "",
    encoding: "utf8",
  });
}
test("reader uses one expected Doppler project/config across all allowed buckets", () => {
  for (const bucket of [
    "pm-data-platform",
    "sports-nba-data",
    "sports-text",
    "sports-transcription",
  ]) {
    const result = run(bucket);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  }
  assert.equal(
    run(
      "sports-text",
      { DOPPLER_PROJECT: "reader", DOPPLER_CONFIG: "stg" },
      "reader",
      "stg",
    ).status,
    0,
  );
});
test("reader refuses mismatched injection, unknown buckets, and endpoint fallback", () => {
  for (const overrides of [
    { DOPPLER_PROJECT: "sports-text" },
    { DOPPLER_CONFIG: "dev" },
    { R2_ENDPOINT_URL: undefined, R2_ENDPOINT: fixture.R2_ENDPOINT_URL },
    { R2_ENDPOINT_URL: "https://attacker.invalid/" },
    { R2_SECRET_ACCESS_KEY: " whitespace" },
  ]) {
    const result = run("sports-text", overrides);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
  }
  assert.equal(run("unapproved-bucket").status, 1);
});
