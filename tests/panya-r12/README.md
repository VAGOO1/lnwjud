# PANYA R12 — stale-boot recovery (isolated candidate)

**Status:** Candidate staging source + unit tests only. **NOT a Host patch, not installed, not approved for live repair.**

Scope:
- Read-only previewStaleAfterReboot() for evidence/ownership checks across original boot and current boot;
- Pure immutable advanceStagingJournal() contract to fail closed on replay, CAS revision mismatch and partial faults;
- Twenty-eight deterministic tests, including the six R11 acceptance categories;
- No filesystem writes, SQLite access, process control, Native Job receipt generation, writer recovery, quarantine implementation or reservation-release code.

The functions intentionally cannot recover old records missing trustworthy original boot/process identities. Most 5.8.7 existing markers are legacy/opaque and therefore HOLD, even with an owner-issued general Pro authorization. A future Host implementation must obtain a per-item manifest, trusted boot and process-start evidence from a sanctioned Windows-native adapter, prove exact original fingerprint and authority, preserve an encrypted evidence backup, implement locking and atomic phase-barrier/quarantine with durable rollback, and pass independent source/security review. Only then may a separately approved maintenance operation be considered.

Test locally with Node 22+: node --experimental-strip-types --test tests/panya-r12/stale-recovery-plan.test.mts ; on Node 24+: node --test tests/panya-r12/stale-recovery-plan.test.mts . Branch-only Windows GitHub Actions workflow runs no build or deployment and has contents: read only.

If the implementation ever changes canMutateLive: false, mayReleaseReservation: false, or immutable journal admissionOpen: false, block and review it as a different high-risk change, not part of R12.

Independent review R12: two MEDIUM findings (prototype-chain journal event lookup; malformed JSON input could throw) addressed in this staging preview with explicit validation and fail-closed regression cases 16–21. Workflow checkout/setup-node actions are pinned to upstream verified commit SHAs. This does not provide trusted native boot/identity attestation or implement a live Host quarantine, global slot release, Writer repair, atomic crash recovery, or installation. Only an independent Windows CI conclusion for the latest exact commit can establish the new staged test result.

Independent second review found that arbitrary runtime objects with inherited properties, accessors or sparse arrays could bypass shape checks or throw. R12 now snapshots only own JSON-like data properties using descriptors without invoking accessors; malformed, cyclic and sparse shapes fail closed. Tests 22–26 cover those cases. No trusted OS attestation or live recovery is introduced.

Runtime safety on Node-only staging also explicitly rejects JavaScript Proxy objects using Node built-in util.types.isProxy before reflecting on prototypes or descriptors. Tests 27–28 cover trap-backed getter evaluation and two distinct objects with the same record identity; still no live Host connection.
