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

The Dockerfile pins its Python 3.12 base by digest and installs pandas 2.2.3, NumPy
2.2.6, SciPy 1.15.3 and scikit-learn 1.6.1, plus the FUSE adapter. Pip/setuptools/wheel
are removed from the final image. The final immutable image ID pins the complete
resolved environment, including transitive packages and OS libraries.

## Filtered export

`/data/session.sqlite` is created from the same public projections as the tools:

- `session` and `questions` contain cutoff/phase, dataset descriptors and issued questions.
- The named game-history and player-reference tables contain their published columns.
- `unavailable` contains eligible coverage gaps only.
- `schedule`, `injuries`, `injury_team_snapshots`, `odds_history` and `odds_settlements`
  expose the corresponding tool projections. Static future schedule entries are
  intentionally permitted; future observations and unreleased settlements are not.
- `evidence`, `posts`, `transcripts`, `lineups` contain the filtered evidence index.
  `evidence.text_path` names the corresponding verbatim file under `/data/evidence/`.
- `released_results` contains flattened released questions, with no rationales or notes.

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
programs run Python and its preinstalled libraries directly.

Persistent `/workspace` is a FUSE filesystem, **not a writable host bind mount**.
A separate trusted root supervisor sends filesystem operations over its private
stdio channel to the existing `WorkspacePort`; every mutation uses P3e's live
policy and blob journal. Worker stdout/stderr have separate pipes and cannot forge
supervisor frames. Worker credentials cannot open the supervisor's `/proc/1/fd`.
The filesystem permits create/read/write/append/delete and directory creation;
rename, links, chmod/chown and directory deletion are refused. Empty directories
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
The trusted supervisor measures the cgroup CPU delta (including native threads),
kills the worker at the requested compute or wall limit and reports the observed
usage. Memory OOM is reported as `limit: "memory"`; this extends P3a's result enum.
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
