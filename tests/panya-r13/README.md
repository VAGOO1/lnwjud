# PANYA R13 — Per-marker evidence manifest (synthetic staging only)

**STATUS: SOURCE + SYNTHETIC UNIT TESTS ONLY. NOT A LIVE RECOVERY PATCH.**

R13 builds on the independently reviewed R12 pure preview and provides:

- `previewR13SyntheticManifest(JSON text)` — a bounded, read-only classification of marker evidence, including marker filename binding `sha256(taskId)`, canonical source bytes, exact source hash, record kind, digest, owner workspace/client, and *claimed* boot/process identities. Every record retains `UNKNOWN_UNVERIFIED` for Native completion and `canReleaseReservation=false`.
- `simulateR13QuarantineAudit(item, JSON events)` — a hash-chained **in-memory simulation** of four ordered review stages; it does not acquire a lock, archive anything, commit a database, verify a Native Job or grant live authority.
- Thirty deterministic R13 regression tests, plus twenty-eight existing R12 tests, runnable on isolated Windows GitHub runner. No live data or secrets are shipped.

## Crucial evidence boundary

The repository `lnwjud` v5.8.7 index stores marker ID/digest, mutationKind, ownerClient/workspace (optionally missing), `launcherPid`, and timestamps. It **does not** persist trusted `originHostId`, `originBootId` and real Windows `osProcessCreationMs` for the legacy entries. It would be wrong to backfill those from a later reboot or to treat `launcherStartedAt` as OS process creation time. Consequently, the current live records **cannot** pass the R13 evidence standard and remain HOLD.

The pure API takes only a JSON string; no Windows/native attestation exists here. Expected hash and marker contents supplied by the same caller establish only **synthetic internal consistency**; the caller can forge both. Even `SYNTHETIC_REVIEW_READY` is never a Host admission decision, independent proof, task outcome, receipt or quarantine permission.

A separate *trusted Host-native* read-only collector would need to establish: exact machine/boot provenance, process creation time and job ownership; secured file identity/reparse/ACL and SHA-256 of each original marker; registry consistency without a side-effecting reconcile; exact owner-approved per-record scope; independent encrypted rollback plus restore verification; and a durable multi-resource recovery transaction with a tested crash/rollback barrier. A new admin operation would require specific scoped authority and independent acceptance. Do not release all 20 legacy markers or turn missing Native receipts into successful completions.

## Run synthetic tests

Node.js 22: `node --experimental-strip-types --test tests/panya-r13/manifest-preflight.test.mts`

Node.js 24: `node --test tests/panya-r12/stale-recovery-plan.test.mts tests/panya-r13/manifest-preflight.test.mts`

CI is scoped to the exact R13 branch and GitHub Windows runner with read-only token, no deployment step, no downloads of real Host backups and no merging to `main` or `dev`.
