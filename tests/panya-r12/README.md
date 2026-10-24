# PANYA R12 — stale-boot recovery (isolated candidate)

**Status:** Candidate staging source + unit tests only. **NOT a Host patch, not installed, not approved for live repair.**

Scope:
- Read-only previewStaleAfterReboot() for evidence/ownership checks across original boot and current boot;
- Pure immutable advanceStagingJournal() contract to fail closed on replay, CAS revision mismatch and partial faults;
- Ten deterministic tests, including the six R11 acceptance categories;
- No filesystem writes, SQLite access, process control, Native Job receipt generation, writer recovery, quarantine implementation or reservation-release code.

The functions intentionally cannot recover old records missing trustworthy original boot/process identities. Most 5.8.7 existing markers are legacy/opaque and therefore HOLD, even with an owner-issued general Pro authorization. A future Host implementation must obtain a per-item manifest, trusted boot and process-start evidence from a sanctioned Windows-native adapter, prove exact original fingerprint and authority, preserve an encrypted evidence backup, implement locking and atomic phase-barrier/quarantine with durable rollback, and pass independent source/security review. Only then may a separately approved maintenance operation be considered.

Test locally with Node 22+: node --experimental-strip-types --test tests/panya-r12/stale-recovery-plan.test.mts ; on Node 24+: node --test tests/panya-r12/stale-recovery-plan.test.mts . Branch-only Windows GitHub Actions workflow runs no build or deployment and has contents: read only.

If the implementation ever changes canMutateLive: false, mayReleaseReservation: false, or immutable journal admissionOpen: false, block and review it as a different high-risk change, not part of R12.
