# P3f: session export and Docker execution

SPO-791 installs the production `execute_code` implementation in
`sessionEnvironment`. Export and container creation are lazy on the first call;
one container is reused for subsequent calls in that pregame or postgame session.
Closing the session revokes workspace access, removes the container and deletes the
export. Pregame scratch never reaches the separate postgame container.

## Build and pin

Docker Engine/Desktop with cgroup v2 and `/dev/fuse` in the Linux host/VM is required.
Run `npm run sandbox:build`, then copy the printed immutable `local@sha256:…` value
into `harness.sandboxImage`. The build also records that value under
`.cache/sandbox-image.json` for `npm run test:sandbox`. A registry digest reference
is also accepted, provided that exact image has already been pulled. There is no
fallback to a mutable tag and no runtime pull or package installation. The existing
manifest harness hash includes this image pin. Build/pin on the target architecture.
Local image IDs may differ across builders. AWS runs must push and pin a registry
manifest digest and pull that exact digest on each host for portable harness identity.
`npm run sandbox:build -- --push=registry.example.com/nba/sandbox:release-1 --platform=linux/amd64`
now writes the verified registry digest pin. See the [AWS prerequisites](aws-deployment-prerequisites.md)
for publishing, exact-image pulls and persistent-volume prewarming.

The Dockerfile pins its Python 3.12 base by digest and installs pandas 2.2.3, NumPy
2.2.6, SciPy 1.15.3 and scikit-learn 1.6.1, plus the FUSE adapter. Pip/setuptools/wheel
are removed from the final image. The final immutable image ID pins the complete
resolved environment, including transitive packages and OS libraries.

## Filtered export

`/data/session.sqlite` is created from the same public projections as the tools:

- `session` and `questions` contain cutoff/phase, dataset descriptors and issued questions.
- The player-reference tables contain their published columns and replay-date ages.
- `schedule`, `injuries`, `injury_team_snapshots`, `odds_history` and `odds_settlements`
  expose the corresponding tool projections. Static future schedule entries are
  intentionally permitted; future observations and unreleased settlements are not.
- `evidence`, `posts`, `transcripts`, `lineups` contain the filtered evidence index.
  `evidence.text_path` names the corresponding verbatim file under `/data/evidence/`.
- `released_results` contains flattened released questions, with no rationales or notes.

History lives in `/data/games/*.sqlite.gz`: one immutable, compressed SQLite shard
per game, keyed by pinned dataset manifests, the game envelope and export schema
version. The host cache defaults to `.cache/history-export-v2` (override with the absolute persistent-volume path in `NBA_HISTORY_EXPORT_CACHE`); only games passing the
release gate are copied into `/data`. The cache itself is never mounted. Cold
builds decode each relevant verified PBP partition once, apply the same published
column projector as the query tool, and insert rows with one prepared statement
per table batch in a transaction. Cache publication is atomic; cancelled builds
are not mounted. Pinned PBP records must satisfy their game's release boundary;
violations fail closed. Fixture/custom adapters without the pinned-release cache
contract also apply record-level visibility at the exact cutoff.

Each shard contains all history tables and an `unavailable` table with eligible
coverage gaps. Compression keeps the mounted corpus compact without dropping any
published columns. The image helper decodes one shard at a time in memory:

```python
import nba_data
boxes = nba_data.table("player_box_scores")  # all eligible games as a DataFrame
# SQL runs separately per game; aggregate returned counts/sums for season totals.
counts = nba_data.query("SELECT count(*) AS n FROM events")
total_events = counts.n.sum()
with nba_data.session() as db:
    questions = db.execute("SELECT * FROM questions").fetchall()
```

Tables are omitted when their source capability is disabled. Structured values are
JSON text in SQLite; booleans are integers. `_row` is an export-local row number.
History retains the public column whitelist, and filtering precedes export, file
creation and mounting. There is no archive directory or credential inside the
container. `/data` is mounted read-only. Unit tests compare complete exports with
and without adversarial future records and check the release boundary.

## Isolation and workspace

The container has no network, a read-only root filesystem, a bounded `/scratch`
tmpfs and no host mounts except the already-filtered `/data`. The Python worker runs
as uid/gid 1000 with zero effective capabilities and no-new-privileges. A kernel
seccomp filter additionally denies sockets, process execution, process creation
(native numerical threads remain allowed), link creation, ptrace, namespace changes
and mounts. Package installers and subprocess/shell execution are unavailable;
programs run Python and its preinstalled libraries directly. Scikit-learn/joblib
`n_jobs > 1` needs a threading backend; process backends cannot start workers.

Persistent `/workspace` is a FUSE filesystem, **not a writable host bind mount**.
A separate trusted root supervisor sends filesystem operations over its private
stdio channel to the existing `WorkspacePort`; every mutation uses P3e's live
policy and blob journal. Worker stdout/stderr have separate pipes and cannot forge
supervisor frames. Worker credentials cannot open the supervisor's `/proc/1/fd`.
The filesystem permits create/read/write/append/delete and directory creation;
rename, links, chmod/chown and directory deletion are refused. Sequential writes
are buffered until flush/close; a new file stream becomes one write mutation.
Explicit fsync/flush and path-based truncation are additional durability boundaries. Reads
cache file bytes for the open handle; writes invalidate or update that view. Append
uses the known size without a readback. Permission checks at truncation/open and
again at flush preserve append-only and live commit/close refusals. Buffered state
uses the container memory limit and is lost if the supervisor is killed. Empty directories
are session conveniences; P4 snapshots persist files and their parent paths.

FUSE requires `SYS_ADMIN`, `/dev/fuse` and an unconfined AppArmor profile for the
trusted supervisor. The untrusted worker drops to uid 1000, receives no capabilities
and installs the extra seccomp policy before executing any agent code. `/dev/fuse`
is root-only. This privilege separation is deliberate and tested. Docker's outer
seccomp policy and container namespaces remain enabled. See Docker's
[FUSE requirements](https://docs.docker.com/engine/containers/run/) and
[resource options](https://docs.docker.com/reference/cli/docker/container/run/).

Stateless runs get an empty ephemeral `/workspace` instead of the persistent mount;
it is discarded with the session. Disabled workspace capability similarly grants
no access to persistent memory. The workspace tools themselves retain P3a's
stateless refusal. Phase checks prevent execute-code calls during commit, and the
shared workspace policy independently rejects any mounted writes after commit/close.

## Limits and accounting

Missing sandbox resource fields default to 60 seconds per call, 2 CPUs, 2 GiB memory
and 1 MiB per stdout/stderr stream. Explicit run budgets override these defaults;
phase compute and wall budgets remain mandatory and pilot-approved for scored runs.
Docker enforces CPU quota, memory with no extra swap and 64 processes/threads.
The trusted supervisor measures the cgroup CPU delta (including native threads and FUSE supervisor work),
kills the worker at the requested compute or wall limit and reports the observed
usage. Memory OOM is reported as `limit: "memory"` when the supervisor survives; this
extends P3a's result enum. The supervisor shares the worker memory cgroup: if OOM
kills PID 1, the host checks Docker's OOM flag and exit status. A confirmed OOM
returns `limit: "memory"`, marks output truncated and charges the full reserved
compute allowance because the supervisor's final CPU measurement is unavailable.
The dead sandbox cannot execute another program. Exited containers are retained
until session cleanup so the host can inspect their final state; cleanup still
removes them. Other unexpected exits remain errors.
A negative exit status denotes termination by signal. Output is drained but retained
only up to the configured byte cap, with `truncated` set explicitly.

Export/startup count against the runner's session wall budget. The per-program wall
clock starts after setup; a host fallback watchdog destroys an unresponsive sandbox.
The runner charges measured CPU through its existing durable reservation/settlement
ledger and enforces the cumulative phase compute cap. Aborts and supervisor failures
retain the reservation rather than claiming zero compute. Cancellation waits for
container removal; cleanup failures are surfaced rather than reported as success.

## Verification

`npm test` runs export tests without Docker and explicitly skips the Docker cases.
`npm run sandbox:build && npm run test:sandbox` runs real-container isolation,
scientific-model round-trip, mount-policy, CPU/wall/memory/output, cancellation,
cleanup, scratch reset and full runner metering tests. CI runs both suites, building
its own immutable image on Linux. No model API or live corpus credentials are needed.

`npx tsx scripts/export-benchmark.ts` measures game 41 postgame with all data
capabilities against pinned live inputs. Every invocation uses a fresh shard cache,
then a new session sharing that cache for the warm pass. It prints elapsed seconds,
logical mounted bytes, session database bytes and shard count. The verified source
object cache may already be populated; this is a cold **shard** build, not a network
cold-start measurement. Benchmark files remain under the printed `.cache` path.

Prepare the persistent history cache **before** starting a budgeted run:
`npx tsx scripts/export-benchmark.ts .cache/history-export-v2 82`. This warms
history through game 82 using pinned inputs, then measures a second session; each
real session still selects only released games before mounting. The first build
can take minutes and consumes transient disk space for uncompressed SQLite files.
The default benchmark uses an isolated fresh cache instead, so its cold numbers
remain reproducible. Supplying a cache path labels the first pass “existing shard
cache” because it may already contain some or all games.

Measured on macOS arm64 with Docker 29.7.2, game 41 postgame at
`2026-01-18T14:00:00Z`, all data capabilities enabled:

| Measurement | Result |
| --- | --- |
| Cold shard build and complete session export (verified object cache populated) | 194.5 s |
| New session with warm shard cache | 19.7 s |
| Logical `/data` size, including 1,856 compressed game shards | 226,332,381 bytes (226.3 MB) |
| `session.sqlite` | 12,627,968 bytes |
| FUSE 8 MiB sequential write / read | 0.15 s / 0.13 s |
| FUSE 50 MiB sequential write / read | 0.81 s / 0.72 s |

Each newly created sequential file produces one write journal entry. Timing is a
local benchmark, not a CI performance threshold. The cold build temporarily uses
about 3.5 GB for uncompressed shards before compressing and publishing them.
