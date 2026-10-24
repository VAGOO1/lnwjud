import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceStagingJournal, previewStaleAfterReboot,
  type PreviewInput, type RecoveryEntry,
} from './stale-recovery-plan.mts';

const F = 'a'.repeat(64);
const entry: RecoveryEntry = {
  id: 'writer-01', kind: 'contained_process', hostId: 'HOST-A', workspaceId: 'workspace-1',
  ownerClientId: 'client-a', pid: 50000, originBootId: 'boot-before',
  processStartedAtMs: 1000, recordedAtMs: 2000, fingerprintSha256: F,
};
function fixture(overrides: Partial<PreviewInput> = {}): PreviewInput {
  return {
    targetWorkspaceId: 'workspace-1', entries: [entry],
    boot: { trusted: true, source: 'native_os_boot_and_process_identity', hostId: 'HOST-A',
      previousBootId: 'boot-before', currentBootId: 'boot-after', rebootAtMs: 5000 },
    processObservations: [{ pid: 50000, currentBootId: 'boot-after', state: 'absent', trusted: true }],
    review: { ownerApprovedRecorded: true, scope: 'staging_only', reviewedBy: 'owner',
      items: [{ id: entry.id, workspaceId: entry.workspaceId, expectedFingerprintSha256: F }] },
    ...overrides,
  };
}
const one = (input: PreviewInput) => previewStaleAfterReboot(input).decisions[0];

test('01 PID reuse is safe only with a trusted NEW process creation time after reboot', () => {
  const f = fixture({ processObservations: [{ pid: 50000, currentBootId: 'boot-after',
    state: 'reused_pid', currentProcessStartedAtMs: 8000, trusted: true }] });
  assert.equal(one(f).decision, 'QUARANTINE_CANDIDATE');
  assert.equal(one(f).nativeCompletionVerified, false);
  assert.equal(one(f).taskOutcome, 'UNKNOWN_UNVERIFIED');
  assert.equal(one(fixture({ processObservations: [{ pid: 50000, currentBootId: 'boot-after',
    state: 'reused_pid', currentProcessStartedAtMs: 3000, trusted: true }] })).decision, 'HOLD');
});

test('02 previous boot must be attested, match original identity, and predate reboot', () => {
  assert.equal(one(fixture()).decision, 'QUARANTINE_CANDIDATE');
  assert.equal(one(fixture({ boot: { ...fixture().boot, trusted: false } })).decision, 'HOLD');
  assert.equal(one(fixture({ entries: [{ ...entry, originBootId: undefined }] })).decision, 'HOLD');
  assert.equal(one(fixture({ entries: [{ ...entry, recordedAtMs: 5000 }] })).decision, 'HOLD');
});

test('03 an owner observed alive or with uncertain liveness is never retired', () => {
  for (const state of ['same_process', 'unknown'] as const) {
    assert.equal(one(fixture({ processObservations: [{ pid: 50000, currentBootId: 'boot-after', state, trusted: true }] })).decision, 'HOLD');
  }
});

test('04 missing Native receipt never becomes a forged completion or exit code', () => {
  const result = previewStaleAfterReboot(fixture({ entries: [{ ...entry, receiptVerified: false }] }));
  assert.equal(result.eligibleCount, 1);
  assert.equal(result.mayReleaseReservation, false);
  assert.equal(result.canMutateLive, false);
  assert.equal(result.decisions[0].nativeCompletionVerified, false);
  assert.equal(result.decisions[0].taskOutcome, 'UNKNOWN_UNVERIFIED');
  assert.equal(one(fixture({ entries: [{ ...entry, originBootId: 'boot-after' }] })).decision, 'HOLD');
});

test('05 legacy marker with missing owner, digest or original boot remains HOLD', () => {
  assert.equal(one(fixture({ entries: [{ ...entry, kind: 'legacy', originBootId: undefined }] })).reason, 'LEGACY_IDENTITY_UNPROVEN');
  assert.equal(one(fixture({ entries: [{ ...entry, kind: 'opaque', ownerClientId: undefined }] })).decision, 'HOLD');
});

test('06 fault, replay and CAS conflict keep admission closed in pure journal', () => {
  const start = { phase: 'NOT_STARTED' as const, revision: 0, admissionOpen: false as const };
  const locked = advanceStagingJournal(start, 0, 'acquire_barrier');
  const archived = advanceStagingJournal(locked, 1, 'verify_archive');
  const crashed = advanceStagingJournal(archived, 2, 'fault');
  assert.equal(crashed.phase, 'HOLD');
  assert.equal(crashed.admissionOpen, false);
  assert.equal(advanceStagingJournal(crashed, 3, 'fence_ledger').phase, 'HOLD');
  assert.equal(advanceStagingJournal(archived, 1, 'fence_ledger').reason, 'CAS_REVISION_CONFLICT');
  const fenced = advanceStagingJournal(archived, 2, 'fence_ledger');
  const verified = advanceStagingJournal(fenced, 3, 'verify_independently');
  assert.equal(verified.phase, 'INDEPENDENTLY_VERIFIED');
  assert.equal(verified.admissionOpen, false);
});

test('07 unapproved, fingerprint mismatch and out-of-scope records are blocked', () => {
  assert.equal(one(fixture({ review: { ...fixture().review, ownerApprovedRecorded: false } })).decision, 'HOLD');
  assert.equal(one(fixture({ review: { ...fixture().review, items: [{ ...fixture().review.items[0], expectedFingerprintSha256: 'b'.repeat(64) }] } })).decision, 'HOLD');
  assert.equal(one(fixture({ entries: [{ ...entry, workspaceId: 'workspace-other' }] })).decision, 'HOLD');
});

test('08 duplicate original record IDs or duplicate approval items are rejected', () => {
  assert.equal(previewStaleAfterReboot(fixture({ entries: [entry, entry] })).eligibleCount, 0);
  assert.equal(one(fixture({ review: { ...fixture().review, items: [fixture().review.items[0], fixture().review.items[0]] } })).decision, 'HOLD');
});

test('09 ambiguous current process probe is HOLD', () => {
  assert.equal(one(fixture({ processObservations: [] })).decision, 'HOLD');
  assert.equal(one(fixture({ processObservations: [fixture().processObservations[0], fixture().processObservations[0]] })).decision, 'HOLD');
});

test('10 every output remains a staging-only preview, never a live repair authorization', () => {
  const result = previewStaleAfterReboot(fixture());
  assert.equal(result.mode, 'STAGING_READ_ONLY_PREVIEW');
  assert.equal(result.canMutateLive, false);
  assert.equal(result.mayReleaseReservation, false);
  assert.equal(result.holdCount, 0);
});
