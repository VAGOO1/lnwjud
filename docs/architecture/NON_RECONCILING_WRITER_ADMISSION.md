# Non-reconciling new-writer admission

## Scope and design

`DurableShellTaskIndex.reserve` is non-reconciling for every caller. There is no
optional flag, alternate permissive fallback or new authorization mechanism.
Workspace lease acquire/release/revoke use its exclusive probe. File, Git,
Process and Codex mutations use `SharedManagedWriterAdmission.enter`. Durable
shell and repository-import launches use the same index through the task store.
Existing permission, workspace, session, lease, native identity and capacity gates
remain required. A metadata snapshot never grants admission.

For a new invocation, the global reservation gate may write its own reservation and launch-journal
entry, acquire/release its shared coordination lock, and bootstrap genuinely empty
host storage. It never inspects or modifies another task's state or calls native
inspection/abort/cancel or PID liveness to recover capacity. Other marker records
remain held even if they look terminal or their owner looks dead. Ordinary native
launches still create their own exact attempt; native persistence can rewrite a
shared document while leaving other attempt values unchanged. The existing
SQLite lease transaction still fences the requested workspace and can probe and
clear verified-dead call rows for that workspace. It does not scan or change
other workspaces' lease/call rows. This patch does not make lease acquisition
itself read-only or prohibit those target-workspace checks.

## Admission invariants

- Check existing directories without following observed links. Normalize the
  configured root once. Existing nonempty, uninitialized storage is refused
  before creating an index skeleton. Empty bootstrap is checked again under lock.
- An initialized index with a missing directory is lost evidence, not a fresh
  install. Missing/old/corrupt ready metadata is not migrated or rebuilt.
- Scan all active entries under the existing exclusive lock. Refuse noncanonical
  names, symlinks/nonregular files, stray temporary files, unsupported/malformed
  records, missing kind/capacity fields, task/hash mismatch and bounded-read
  failures. Record reads are limited to 65,536 bytes; scans to 16,384 entries.
- Count every holder. Keep independent managed-writer/durable-shell budgets and
  the existing repository-import exclusivity rules. No foreign record is removed.
- Retry identity must match task/digest, kind, capacity, owner/workspace, receipt
  and canonical native binding. Validate all records before accepting an
  idempotent match.
- Acquire and exact-owned release never steal a stale lock. Busy/unknown locks
  stay blocked. New lock files contain a unique token; release refuses a changed
  token. Errors from the operation are not retried as lock acquisition failures.
- New durable execution requires an existing regular, newline-complete launch
  journal. Admission never rebuilds old history. Failed publication may leave
  conservative blockers requiring explicit owner recovery rather than guessing
  that capacity is free.
- Release reads only the nominated marker using bounded, no-follow reads. Native
  termination proof is for that record's binding. The record is compared again
  under lock before removal. Unknown proof or readback retains its reservation.

## Availability tradeoff and recovery

Previously, an unrelated acquire could reconcile a terminal marker or abort an
undispatched native attempt. It now refuses when that reservation blocks admission.
This is an intentional availability change, not a request to force-unlock or skip
checks. Use a separately authorized exact-owner status/cancel/release workflow
with valid task/process identity and native proof. An expired workspace lease or
`recoverAbandoned: true` is not permission to recover unrelated reservations.
Legacy/corrupt index state and abandoned locks require separate maintenance with
its own scope and evidence. No new automatic recovery endpoint is added here.

## Explicit exclusions

This contract applies to a **new invocation**, not all operations in the system:

- Index `initialize`, `diagnostics` and `listLaunches`, shell task listing,
  selected task status/wait and goal-liveness paths may still reconcile state.
  Some existing task-inspection ownership rules intentionally span sessions.
- A retry of an existing owned task can reconcile that exact task after the
  existing owner/digest checks. Repository-import status may recover its own
  failed publication. These are not new-task admission.
- Windows service startup rewrites/reconciles held unknown attempts; service
  shutdown affects its service-owned processes. The client does not auto-start
  or restart that service. This patch does not change its lifecycle contract.
- Old running versions or noncooperating writers can still mutate shared storage.
  Storage must be access-controlled and host-owned. Token/path checks are not
  an atomic pathname CAS against hostile ABA or ancestor replacement. Journal
  validation and append are separate opens under the cooperative index lock.
- The TypeScript index is global within one configured task root. It is not a
  complete view of machine-wide native reservations or processes.

## Verification and rollout requirements

Offline tests cover all admission families with mocked native/process seams,
foreign-record preservation, missing/legacy/corrupt evidence, failed publication,
owner cleanup, lock contention/replacement, native binding idempotency, competing
imports and capacity races. Real Linux durable-worker tests require the standard
`prepare-containment-runtime.mjs` build prerequisite. Test reports distinguish
focused runs, broader suites and skipped platform tests.

Windows junction/reparse, native service integration, installed app/helper
provenance and rollout effects remain unverified in this Linux workspace. POSIX
symlink tests are skipped on Windows. Before live execution, review and stage the
actual packaged app/helper versions on an isolated Windows setup. Do not infer
installation, a safe service restart, empty native state or live acceptance from
this patch or its Linux test results.
