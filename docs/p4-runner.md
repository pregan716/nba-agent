# P4 runner and experiment record (SPO-780)

The runner in `src/runner/` controls configuration, chronological scheduling, phase budgets, model metering and the durable record. It consumes P3 through a typed adapter; P3's real temporal tools, submission validation and Docker lifecycle remain separate implementation work. The included adapter and harness are fixtures, not a production analyst or a completed acceptance gate.

## Run a fixture

Use Node 22.16 or later (the tested runtime is 22.22.3):

```sh
npm ci
npm run check
npm test
npm run runner:fixture
```

The fixture uses the pinned 82-game schedule with synthetic questions and tools. It writes SQLite, manifests, content-addressed workspace blobs and indexed checkpoints under `.cache/runner-fixture/fixture-v1/r1`. Re-running resumes the same record and does not duplicate submissions. It makes no live model calls, reads no R2 data and approves no budget numbers. All ten development game IDs appear in its output. The first complete fixture run produced 82 submissions and 164 completed sessions.

## Integration

```ts
const runManifest = manifest(config, schedule);
const proxy = new MeteringProxy(anthropicProvider(runnerOnlyApiKey));
await proxy.listen();
const runner = new Runner(storageRoot, runManifest, proxy, p3Factory, sink);
try {
  await runner.run(harness);
} finally {
  runner.close();
  await proxy.close();
}
```

`configSchema` rejects unknown configuration fields and requires phase budget numbers. Sandbox limits default to 60 seconds per call, 2 CPUs, 2 GiB memory and a 1 MiB output cap. `manifest()` normalizes and sorts the schedule, pins the first ten games as development, and derives a hash from every resolved harness component. Non-fixture runs must supply all 82 games. Pilot runs execute only the first ten. Only a scored run's successful, submitted games after the first ten are scoring-eligible. Scored mode requires an explicitly approved pilot budget, stored no-tool contamination probe, an AWS persistent-storage host declaration, and a checkpoint sink. These are configuration checks, not proof that the pilot, probe or infrastructure provisioning occurred.

The manifest stores all four run-profile axes, memory's three sub-axes, all three per-run descriptors, resolved SDK version, image digest, prompts, tools, loop configuration, price schedule, replicate, code revisions and policy. Changing any manifest field refuses resume; create a new run instead. v1 supports stateless and full-season memory. Intermediate windows and frozen-memory variants are intentionally not accepted as implemented modes.

### P3 and harness boundary

`EnvironmentFactory` receives the trusted workspace path, game, phase, cutoff, memory policy, source versions and any already-frozen submission. It returns `Environment`, with question construction, phase transition, generic capability calls, submission validation, bounded code execution and cleanup. P3 must enforce temporal filtering and memory revision rights; implement editable/append-only writes and Docker mounts/resource controls there. Calls must honor cancellation, and `close()` must terminate the session container and scratch state. The runner serializes environment calls, denies workspace tools for stateless runs, locks research and writes in commit, passes compute/CPU/memory/output limits to execution, and records its measured result.

The harness receives exactly three handles: a scoped session endpoint, a metered model endpoint (`baseURL`, scoped `apiKey`), and memory instructions. It calls `context`, permitted P3 capabilities, `begin_commit`, then `submit`. Once commit begins, only context, question listing and submission are available. Up to three validation attempts are persisted; identical normalized submissions return the same receipt. No postgame submission is accepted. P3 returns normalized probabilities, clip events and validation errors; P4 atomically records the canonical submission and its workspace checkpoint before returning a receipt.

The in-process harness is trusted application code, not an isolation boundary for hostile JavaScript with access to Node globals. Give it no closures over the runner/provider and no direct provider key in its environment. Only the trusted launcher constructs the Anthropic provider and R2 client. The scoped key cannot authenticate directly to Anthropic. Agent-produced code belongs in P3's no-network Docker sandbox, not in the runner process. The model proxy accepts only non-streaming Messages requests and refuses server tools, hosted files, remote/multimodal content and unrelated endpoints, so it cannot substitute for P3 evidence tools. P5 must create a fresh conversation per invocation and use this interface exclusively.

## Budget and model metering

Each game has independent pregame and postgame ledgers, with no rollover. Commit shares the pregame ledger. During research, the submission reserve is unavailable; `begin_commit` unlocks the remaining reserve while locking research tools. A pending model call prevents this transition. Context reports remaining tokens, compute, tools and the low-budget warning; a low model budget also emits a warning event. Model calls are serialized per scoped key and keys are revoked at session end.

The proxy pins `claude-opus-4-6`, the configured effort and thinking mode, and checks the installed SDK version against the manifest. Automatic SDK retries are disabled. It calls the SDK token-count endpoint, clamps `max_tokens` to the available allowance, and persists a reservation before sending the generation request. Settlement records the full SDK response, uncached input, output, cache reads, cache writes by TTL, and spend at the manifest's price schedule. Cache tokens count toward the cap. Reasoning is a subset of output and is never double-counted.

Two provider limitations are explicit:

- The token-count API is a preflight estimate. Actual usage is retained even if it exceeds that estimate; an overrun stops further spending and is recorded, never clipped to the configured cap. A remote provider cannot retroactively unspend an input-count discrepancy. See [Anthropic token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting).
- Opus usage does not expose a separate thinking-token count in the tested SDK response. `reasoning` is `null` (unavailable), while output includes thinking. No text-length estimate is substituted. See [Anthropic thinking documentation](https://platform.claude.com/docs/en/build-with-claude/extended-thinking).

On a transport error or process death, an unsettled model reservation stays fully charged because the provider may have generated an unseen answer. An interrupted code execution likewise retains its compute reservation. Resume does not reset either ledger. A recovered attempt's wall time runs from its start through its latest recorded event in the same scope. Outage time and unobserved time after that event are not charged; the interruption remains an infrastructure failure rather than consuming the session's wall-clock allowance.

Statuses are `completed`, `budget_exhausted`, `invalid_output`, `infrastructure_failure` and `skipped`. Every phase has a status and nullable terminating limit (`tokens`, `research_tokens`, `compute`, `tool_calls`, `wall_clock`, `submission_attempts`, `interrupted`, `infrastructure`). Invalid third submissions are invalid output, not budget exhaustion. Stateless postgame is explicitly skipped. Failed sessions remain visible and cannot become valid market-copy submissions.

## Record, recovery and checkpoints

Each run/replicate owns a directory, SQLite record and workspace. An exclusive host PID lock rejects simultaneous writers. SQLite uses full synchronous commits; events form a hash chain and database triggers reject updates/deletes. Unique indexes enforce one manifest and one submission per game. Hash-chain verification detects later edits; this is not protection against an administrator rewriting the entire database and its hashes.

Events contain the manifest, full questions, phase/clock transitions, requests and observations, model requests/responses/usage, validation attempts, immutable submissions/receipts/clips, execution programs/stdout/stderr/exit status/compute/truncation, errors and completion states. P6 can append outcome records with scorer version, source, resolution and release metadata through the trusted record API; those events are not an agent-visible tool. P3 remains responsible for released-results projection.

Before and after each session, files are captured as content-addressed blobs plus a path map. Session records include added/removed/changed paths; blob pairs allow content diffs. Symlinks, special files and hardlinks are refused. On restart, the workspace is reconstructed from the last durable snapshot. Partial writes from an interrupted attempt roll back; a committed submission restores its exact commit snapshot and skips pregame re-execution. The interrupted attempt remains recorded as an infrastructure failure. Tests exercise a real SIGKILL after submission and verify one receipt, one submission and preserved memory.

Each checkpoint uses SQLite online backup for `checkpoints/<seq>/record.sqlite` and stores its own `manifest.json`. Schema-v2 `index.json` lists these two files and every immutable blob needed by the archived record, including historical workspace snapshots and mutation journals. Blob bytes live only once locally, at `<runRoot>/blobs/<hash>`; checkpoints do not copy them. In R2 the layout under the explicitly configured sink prefix is:

```
<runId>/<replicateId>/blobs/<hash>
<runId>/<replicateId>/<seq>-<chainHash>/record.sqlite
<runId>/<replicateId>/<seq>-<chainHash>/manifest.json
<runId>/<replicateId>/<seq>-<chainHash>/index.json
```

`R2CheckpointSink` checks shared blobs with HEAD before PUT. Only a 404 means absent; permission and network errors stop publication. Each checkpoint index contains object keys, byte counts and SHA-256 checksums. A blob key is relative to the run/replicate prefix; database and manifest keys are relative to the checkpoint prefix. A local `prepared-index.json` freezes the exact backup bytes before upload, so even a lost publication acknowledgement can be retried without changing bytes beneath an already published marker. The remote index is uploaded last; the local index is atomically published after successful upload (or immediately for local-only checkpoints). Partial uploads are never new published checkpoints, and the next invocation retries before progressing. No bucket or credentials are inferred and no infrastructure is provisioned.

To move hosts, select a published index key and use the trusted host API:

```ts
await restoreCheckpoint(sink, "runId/r1/123-<chainHash>/index.json",
  "/new/storageRoot/runId/r1");
```

The sink implements both `get` and the upload operations. The destination must not exist. Restore downloads only indexed objects, verifies lengths, SHA-256, blob content addresses, the record hash chain and run identity in a temporary directory, then renames it to the fresh run root. It never restores a lock file or live workspace: opening `Runner` with the identical manifest reconstructs memory from blobs. A local `CheckpointSource.get` can map run-level blob keys to `<oldRoot>/blobs/` and checkpoint-level keys to `<oldRoot>/checkpoints/<seq>/`. Copying a schema-v2 checkpoint directory alone is insufficient. Schema-v1 published indexes are still readable (their blobs are under the checkpoint prefix); old local checkpoints are upgraded to v2 when republished. Existing historical v1 copies are not deleted automatically. Local and mocked-object-store tests cover restore and publication failure; live R2 delivery and AWS execution require deployment-specific credentials and are not claimed as tested here.

## Abandoned sandbox cleanup

Before creating a Docker sandbox, the trusted environment writes a durable `sandbox-owner` marker in the run root and labels the container with `nba-agent.run-root=<hash of canonical run-root path>`. On `Runner.run()` startup, after the constructor acquires the exclusive PID lock and before a new session starts, it lists matching `nba-session-<uuid>` containers, verifies their exact ownership label/name, and force-removes them. Under this lock no session from a previous runner for that root can still be live. Every successful removal appends an `infrastructure` event with action `orphan_container_removed`, container ID and name. Other roots and legacy unlabeled containers are left alone because their ownership cannot be established safely. Roots that have never created a managed sandbox need no Docker daemon for this check. Cleanup failures stop startup and are retried on the next invocation. The marker is host-local and is not part of a restored checkpoint.


Remaining user decisions: all production budget numbers and pilot effort remain open until the brief's pilot procedure. The fixture values are clearly labelled and are not usable as an approved scored budget.
