# P3e workspace tools and memory policy

SPO-790 adds list/read/write/append/delete to the production session. Paths and
file contents are the only workspace data exposed to the harness. A list contains
immediate children, with workspace-relative paths and UTF-8 byte counts for files.
Writes create parent directories; deletes remove files, not directories.

`WorkspacePolicy` is shared by the runner, session tools and the trusted P3f
`Environment.workspace` port. Append-only permits creating a new file and
appending bytes, but refuses replacement and deletion. Revised scripts therefore
use a new filename. All workspace operations are locked during commit and after
close, and stateless workspace tools remain disabled under P3a's contract.
Capability checks remain at the session boundary; no mount port is supplied when
the workspace capability is disabled.

The service rejects absolute paths, drive paths, backslashes, empty components,
`.`/`..`, NUL, symlinks, hard links and nonordinary filesystem nodes. Errors do not
include host paths. Files are opened without following links, and descriptors are
checked before use. Calls are synchronous and serialized; the workspace directory
must have no independent writer.

P3f integration: use the bound binary `readBytes`, `mutate` and `list` operations
from `Environment.workspace` for a mediated mount. Do **not** bind-mount the host
workspace writable: such a mount would bypass both policy and mutation accounting.
Rename, link, truncate and mmap must be refused unless translated into supported
operations with equivalent policy enforcement. The Docker/FUSE adapter in SPO-791 uses these bound operations; see
[p3-sandbox.md](p3-sandbox.md). Directory creation is also mediated; empty directories
are not part of file snapshots.

P4 still captures content-addressed snapshots and per-session added/changed/removed
file diffs. The service also records successful binary mutations as blob hashes in
`workspaceChanges` (`{ operation, path, sha256? }`), captured atomically with a frozen submission and at session
end. Bytes live once in the run’s content-addressed `blobs/` directory; an append
references only its appended bytes. Window reconstruction verifies each blob’s
hash before replaying it. Journals contain no inline file content. A crash after commit preserves the journal with the receipt and workspace;
interrupted uncommitted work is rolled back with the existing P4 snapshot recovery.

Memory horizons:

- `stateless`: P4 restores an empty workspace at each fresh pregame start.
- `season`: P4 carries forward the previous session's workspace.
- `window`, with required `windowGames` (integer 1–82): at each fresh pregame,
  reconstruct from mutations made during the previous k games, pregame then
  postgame. Appending a note carries only those new bytes, not an expired prefix.
  Replacing a file carries the complete replacement; explicitly copying old content
  into a new write counts as a new write. A resumed session restores its checkpoint
  instead of resetting again. Other horizons must omit `windowGames`.

The context tool reports `window_games` only for window configurations. Window
runs require an environment mutation journal; silently using uninstrumented writes
is refused. Failed sessions retain their observed writes in the same way P4 retains
their workspace snapshots, but rolled-back interrupted attempts are excluded.

Tests cover path/link attacks, special filenames, byte counts, shared mount-policy
locking, append-only creation versus replacement, stateless reset, season carry,
window prefix expiry, recorded diffs and SIGKILL recovery with the real service.
