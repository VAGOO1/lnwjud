# Non-mutating writer admission observation

`workspace_writer_admission_snapshot` is a READ-only MCP tool with required
`workspaceId`. The registry also accepts the common optional `userConfirmed`
boolean envelope; it is not required or used by this snapshot handler, does not
change the observation scope, and never grants admission. The exported input
schema permits only those two keys and rejects other properties. It reads the
host-configured, **global** managed-writer marker index, not just that workspace.
The result contains aggregate counts only. It never accepts a filesystem path or
returns task/client/session/workspace identities, marker names, digests, PIDs,
command lines or receipt paths. Metadata ownership is not authenticated by this
observation.

## Contract

- `basis: persisted_markers_only`, `nativeEvidence: not_observed`.
- `consistency: non_atomic` and `admission: not_evaluated` on every result.
- `status: observed` means recognized on-disk records were read without a detected
  change. `heldReservations: 0` does **not** mean admission is available or that
  native processes, leases or import holds are absent.
- `status: unknown` uses null counts. Reasons include `not_initialized`,
  `index_busy`, `unreadable`, `unsupported_schema`, `changed_during_read`, and
  `limit_exceeded`. No missing, denied, malformed or ambiguous evidence becomes
  an empty-capacity answer. A disappearing file can be reported as
  `not_initialized`; it still gives no admission decision.
- Enumeration is bounded to 4,096 markers and 65,536 bytes per record. Unknown or
  unexpected directory entries, unrecognized ready/marker formats and mismatched
  marker hashes fail closed. Legacy data is not upgraded by this tool.

The reader normalizes the configured root once with `path.resolve` and uses
that same lexical path for every check and read, so a trailing separator cannot
make the root symlink check follow its target. It does not resolve filesystem
symlinks with `realpath`. The reader opens existing regular files read-only, checks existing directories,
rejects observed links/nonregular files, and detects observable directory/file
changes before returning. It does not create directories, open SQLite, initialize
or migrate an index, acquire/reclaim a lock, inspect tasks/PIDs/native processes,
abort/release reservations, repair files, clean retention, or spawn processes.
The optional lease port delegates directly to this reader and has no fallback to
legacy `inspect`, diagnostics, acquisition or recovery. Missing wiring returns an
error. Normal MCP request audit/telemetry remains enabled; this contract concerns
operational admission/task/process state, not disabling request audit logs.

## Concurrency and platform limits

A read of multiple files is not an atomic snapshot. Directory/handle identity,
record size and timestamp checks detect observed changes but cannot rule out all
ABA or hostile ancestor replacement. Storage must remain host-controlled and
access-controlled. No-follow/nonblocking flags are used where the platform
provides them; Windows junction/reparse and native runtime behavior require
Windows staging validation. A configured root beneath a symlinked ancestor also returns unknown (including
macOS /var or /tmp aliases); hosts should supply their trusted canonical storage
path rather than asking the reader to follow links. Nothing in this patch validates an installed binary
or native helper, nor changes their authority.

Linux regression fixtures cover symlink roots with zero, one and multiple
trailing separators, as well as deterministic file replacement/deletion/growth,
new locks and directory replacement between samples. These tests verify observed
changes fail closed without reader repair; they do not prove all race schedules
safe. POSIX symlink tests are skipped on Windows. Windows junction/reparse,
trailing-separator aliases and no-follow behavior remain untested and must be
validated in isolated Windows staging before deployment.

## Admission and lifecycle boundaries

New reservations now use the non-reconciling admission contract described in
`NON_RECONCILING_WRITER_ADMISSION.md`. The snapshot is still not an admission
token: acquire and every downstream writer independently validate under the
shared index lock. No snapshot sample removes a blocker or bypasses a gate.

Task-list/status/goal-liveness and explicit recovery remain separate mutating
surfaces. Native service startup/shutdown can affect all service-owned attempts,
and older running hosts can still reconcile shared markers. The new-invocation
contract is not a claim of whole-system immutability. Deploy/install/restart and
live-work acceptance remain separate decisions requiring verified installed
app/helper provenance and isolated Windows validation.
