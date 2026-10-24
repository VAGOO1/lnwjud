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


test('11 malformed entry kind is denied even if runtime input bypasses TypeScript checks', () => {
  const malicious = { ...entry, kind: 'unrecognized_record_type' } as unknown as RecoveryEntry;
  assert.equal(one(fixture({ entries: [malicious] })).reason, 'ENTRY_KIND_UNRECOGNIZED');
});

test('12 malformed process liveness state is denied rather than assuming absent', () => {
  const unknown = { pid: 50000, currentBootId: 'boot-after', state: 'alive_or_new_value', trusted: true };
  assert.equal(one(fixture({ processObservations: [unknown as PreviewInput['processObservations'][number]] })).reason, 'PROCESS_STATE_UNRECOGNIZED');
});
test('13 string false flags from untrusted JSON cannot authorize any candidate', () => {
  assert.equal(one(fixture({ boot: { ...fixture().boot, trusted: 'false' as unknown as boolean } })).decision, 'HOLD');
  assert.equal(one(fixture({ review: { ...fixture().review, ownerApprovedRecorded: 'false' as unknown as boolean } })).decision, 'HOLD');
  const forgedProbe = { ...fixture().processObservations[0], trusted: 'false' as unknown as boolean };
  assert.equal(one(fixture({ processObservations: [forgedProbe] })).decision, 'HOLD');
});

test('14 invalid journal phase from persisted input must HOLD without throwing', () => {
  const bad = { phase: 'FORGED_PHASE' as 'NOT_STARTED', revision: 0, admissionOpen: false as const };
  const result = advanceStagingJournal(bad, 0, 'acquire_barrier');
  assert.equal(result.phase, 'HOLD');
  assert.equal(result.admissionOpen, false);
});

test('15 negative and unsafe journal revisions must HOLD', () => {
  const bad = { phase: 'NOT_STARTED' as const, revision: -1, admissionOpen: false as const };
  assert.equal(advanceStagingJournal(bad, -1, 'acquire_barrier').reason, 'INVALID_JOURNAL_REVISION');
  assert.equal(advanceStagingJournal({ ...bad, revision: Number.MAX_SAFE_INTEGER }, Number.MAX_SAFE_INTEGER, 'acquire_barrier').phase, 'HOLD');
});


test('16 inherited journal event keys never pass as real transitions', () => {
  const start = { phase: 'NOT_STARTED' as const, revision: 0, admissionOpen: false as const };
  for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const result = advanceStagingJournal(start, 0, key as 'acquire_barrier');
    assert.equal(result.phase, 'HOLD');
    assert.equal(result.admissionOpen, false);
    assert.equal(result.reason, 'INVALID_OR_REPEATED_TRANSITION');
  }
});

test('17 malformed input containers return a single global HOLD rather than throw', () => {
  for (const bad of [null, undefined, false, 'data', {}, { ...fixture(), entries: null },
    { ...fixture(), entries: [null] }, { ...fixture(), boot: null },
    { ...fixture(), review: null }, { ...fixture(), processObservations: null },
    { ...fixture(), review: { ...fixture().review, items: null } }]) {
    const result = previewStaleAfterReboot(bad as PreviewInput);
    assert.equal(result.eligibleCount, 0);
    assert.equal(result.holdCount, 1);
    assert.equal(result.decisions[0].reason, 'MALFORMED_PREVIEW_INPUT');
    assert.equal(result.canMutateLive, false);
  }
});

test('18 incorrect entry identifier types and missing approval fingerprint fail closed', () => {
  const badInputs: unknown[] = [
    fixture({ entries: [{ ...entry, id: 17 as unknown as string }] }),
    fixture({ entries: [{ ...entry, ownerClientId: 17 as unknown as string }] }),
    fixture({ review: { ...fixture().review, items: [{ id: entry.id, workspaceId: entry.workspaceId }] as unknown as PreviewInput['review']['items'] } }),
    fixture({ review: { ...fixture().review, items: [{ id: entry.id, workspaceId: entry.workspaceId, expectedFingerprintSha256: null as unknown as string }] } }),
  ];
  for (const bad of badInputs) {
    const result = previewStaleAfterReboot(bad as PreviewInput);
    assert.equal(result.eligibleCount, 0);
    assert.equal(result.decisions[0].decision, 'HOLD');
  }
});

test('19 a malformed sibling denies the whole batch without partial eligibility', () => {
  const result = previewStaleAfterReboot(fixture({ entries: [entry, { ...entry, id: 123 as unknown as string }] }));
  assert.equal(result.eligibleCount, 0);
  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].reason, 'MALFORMED_PREVIEW_INPUT');
});

test('20 journal malformed snapshots and runtime event types preserve HOLD', () => {
  const start = { phase: 'NOT_STARTED' as const, revision: 0, admissionOpen: false as const };
  for (const invalid of [null, undefined, {}, { ...start, admissionOpen: true },
    { ...start, phase: '__proto__' }, { ...start, revision: '0' }]) {
    const result = advanceStagingJournal(invalid as typeof start, 0, 'acquire_barrier');
    assert.equal(result.phase, 'HOLD');
    assert.equal(result.admissionOpen, false);
  }
  assert.equal(advanceStagingJournal(start, 0, null as unknown as 'acquire_barrier').phase, 'HOLD');
  assert.equal(advanceStagingJournal(start, 0, {} as 'acquire_barrier').phase, 'HOLD');
});

test('21 no current process evidence or non-boolean approval can ever grant eligibility', () => {
  const a = fixture({ processObservations: [{} as PreviewInput['processObservations'][number]] });
  assert.equal(previewStaleAfterReboot(a).eligibleCount, 0);
  const b = fixture({ review: { ...fixture().review, ownerApprovedRecorded: 'false' as unknown as boolean } });
  assert.equal(previewStaleAfterReboot(b).eligibleCount, 0);
});


test('22 inherited ownership and process identity are never accepted as record evidence', () => {
  const spoofed = Object.assign(Object.create({ ownerClientId: entry.ownerClientId,
    pid: entry.pid, originBootId: entry.originBootId,
    processStartedAtMs: entry.processStartedAtMs, fingerprintSha256: entry.fingerprintSha256 }),
    { id: entry.id, kind: entry.kind, hostId: entry.hostId,
      workspaceId: entry.workspaceId, recordedAtMs: entry.recordedAtMs });
  const result = previewStaleAfterReboot(fixture({ entries: [spoofed] }));
  assert.equal(result.eligibleCount, 0);
  assert.equal(result.decisions[0].decision, 'HOLD');
});

test('23 a sparse array is rejected before any iteration can throw', () => {
  const result = previewStaleAfterReboot(fixture({ entries: new Array(1) as RecoveryEntry[] }));
  assert.equal(result.eligibleCount, 0);
  assert.equal(result.decisions[0].reason, 'MALFORMED_PREVIEW_INPUT');
});

test('24 accessor-backed evidence is rejected without evaluating getters', () => {
  let calls = 0;
  const object = { ...entry };
  Object.defineProperty(object, 'ownerClientId', { enumerable: true,
    get() { calls++; return 'client-a'; } });
  const result = previewStaleAfterReboot(fixture({ entries: [object] }));
  assert.equal(result.eligibleCount, 0);
  assert.equal(calls, 0);
  assert.equal(result.decisions[0].decision, 'HOLD');
});

test('25 journal rejects inherited and accessor fields without invoking getters', () => {
  const inherited = Object.create({ phase: 'NOT_STARTED', revision: 0, admissionOpen: false });
  assert.equal(advanceStagingJournal(inherited, 0, 'acquire_barrier').phase, 'HOLD');
  let calls = 0;
  const accessor = { phase: 'NOT_STARTED', revision: 0, admissionOpen: false };
  Object.defineProperty(accessor, 'phase', { enumerable: true,
    get() { calls++; return 'NOT_STARTED'; } });
  assert.equal(advanceStagingJournal(accessor, 0, 'acquire_barrier').phase, 'HOLD');
  assert.equal(calls, 0);
});

test('26 cyclic, proxy-like and sparse owner input fails closed without partial pass', () => {
  const cyclic: Record<string, unknown> = { ...entry };
  cyclic.self = cyclic;
  assert.equal(previewStaleAfterReboot(fixture({ entries: [entry, cyclic as RecoveryEntry] })).eligibleCount, 0);
  const broken = new Proxy({ ...entry }, { ownKeys() { throw Error('PROXY_TRAP_DENIED'); } });
  const result = previewStaleAfterReboot(fixture({ entries: [broken] }));
  assert.equal(result.decisions[0].decision, 'HOLD');
  assert.equal(result.canMutateLive, false);
});


test('27 a Proxy cannot cause getter evaluation through own-property reflection', () => {
  let getterCalls = 0;
  let trapCalls = 0;
  const backing = { ...entry };
  Object.defineProperty(backing, 'ownerClientId', { configurable: true, enumerable: true,
    get() { getterCalls++; return 'client-a'; } });
  const proxied = new Proxy(backing, {
    getOwnPropertyDescriptor(target, key) {
      trapCalls++;
      return { configurable: true, enumerable: true, writable: true, value: Reflect.get(target, key) };
    },
  });
  const decision = previewStaleAfterReboot(fixture({ entries: [proxied] }));
  assert.equal(decision.eligibleCount, 0);
  assert.equal(decision.decisions[0].decision, 'HOLD');
  assert.equal(getterCalls, 0);
  assert.equal(trapCalls, 0);
});

test('28 two separate record objects with duplicate IDs fail closed', () => {
  const result = previewStaleAfterReboot(fixture({ entries: [entry, { ...entry }] }));
  assert.equal(result.eligibleCount, 0);
  assert.equal(result.holdCount, 2);
  assert.equal(result.decisions[0].reason, 'DUPLICATE_OR_EMPTY_ENTRY_ID');
});
