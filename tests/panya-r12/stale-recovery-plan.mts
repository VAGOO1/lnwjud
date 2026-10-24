/**
 * PANYA R12 — STAGING ONLY. Read-only candidate for planning recovery after a
 * verified Windows reboot. This module cannot release a writer lease, reserve
 * a slot, fabricate a Native Job receipt, or update a live SQLite database.
 * An authorized Host adapter must independently verify all proof inputs.
 * MIT licensed; no live/owner data is embedded.
 */
export type EntryKind = 'writer_call' | 'contained_process' | 'opaque' | 'legacy';
export type ProcessState = 'absent' | 'reused_pid' | 'same_process' | 'unknown';
export type Decision = 'HOLD' | 'QUARANTINE_CANDIDATE';

export interface RecoveryEntry {
  readonly id: string;
  readonly kind: EntryKind;
  readonly hostId: string;
  readonly workspaceId: string;
  readonly ownerClientId?: string;
  readonly pid?: number;
  readonly processStartedAtMs?: number;
  readonly recordedAtMs: number;
  /** The trusted boot ID recorded at task admission, NOT inferred afterward. */
  readonly originBootId?: string;
  /** SHA-256 over the exact original marker/call representation. */
  readonly fingerprintSha256?: string;
  readonly receiptVerified?: boolean;
}

export interface TrustedBootEvidence {
  readonly trusted: boolean;
  readonly source: 'native_os_boot_and_process_identity';
  readonly hostId: string;
  readonly previousBootId: string;
  readonly currentBootId: string;
  readonly rebootAtMs: number;
}

export interface ProcessObservation {
  readonly pid: number;
  readonly currentBootId: string;
  readonly state: ProcessState;
  readonly currentProcessStartedAtMs?: number;
  readonly trusted: boolean;
}

export interface OwnerReview {
  /** Staging fixture flag only; NOT a replacement for platform authorization. */
  readonly ownerApprovedRecorded: boolean;
  readonly scope: 'staging_only';
  readonly reviewedBy: string;
  readonly items: readonly {
    readonly id: string;
    readonly workspaceId: string;
    readonly expectedFingerprintSha256: string;
  }[];
}

export interface PreviewInput {
  readonly targetWorkspaceId: string;
  readonly entries: readonly RecoveryEntry[];
  readonly boot: TrustedBootEvidence;
  readonly processObservations: readonly ProcessObservation[];
  readonly review: OwnerReview;
}

export interface PreviewDecision {
  readonly id: string;
  readonly decision: Decision;
  readonly reason: string;
  readonly taskOutcome: 'UNKNOWN_UNVERIFIED';
  readonly nativeCompletionVerified: false;
  readonly sourceFingerprintSha256?: string;
}

export interface PreviewOutput {
  readonly mode: 'STAGING_READ_ONLY_PREVIEW';
  readonly canMutateLive: false;
  readonly mayReleaseReservation: false;
  readonly decisions: readonly PreviewDecision[];
  readonly eligibleCount: number;
  readonly holdCount: number;
}

const SHA256 = /^[0-9a-f]{64}$/i;
const nonempty = (value: string | undefined): boolean => !!value?.trim();
const finiteTime = (value: number | undefined): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/**
 * Conservative per-record preflight. No IO, no locks, no cleanup, no retries.
 * UNKNOWN is a HOLD; every eligible result is still only a candidate for an
 * entirely separate, fenced, owner-reviewed quarantine transaction.
 */
export function previewStaleAfterReboot(input: PreviewInput): PreviewOutput {
  const counts = new Map<string, number>();
  for (const entry of input.entries) counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
  const reviewCounts = new Map<string, number>();
  for (const item of input.review.items) reviewCounts.set(item.id, (reviewCounts.get(item.id) ?? 0) + 1);
  const proofCounts = new Map<number, number>();
  for (const item of input.processObservations) proofCounts.set(item.pid, (proofCounts.get(item.pid) ?? 0) + 1);

  const boot = input.boot;
  const trustedBoot = boot.trusted === true && boot.source === 'native_os_boot_and_process_identity' &&
    nonempty(boot.hostId) && nonempty(boot.previousBootId) && nonempty(boot.currentBootId) &&
    boot.previousBootId !== boot.currentBootId && finiteTime(boot.rebootAtMs);
  const reviewed = input.review.ownerApprovedRecorded === true && input.review.scope === 'staging_only' &&
    nonempty(input.review.reviewedBy) && nonempty(input.targetWorkspaceId);

  const decisions: PreviewDecision[] = input.entries.map(entry => {
    const hold = (reason: string): PreviewDecision => ({
      id: entry.id, decision: 'HOLD', reason, taskOutcome: 'UNKNOWN_UNVERIFIED',
      nativeCompletionVerified: false,
      ...(entry.fingerprintSha256 ? { sourceFingerprintSha256: entry.fingerprintSha256 } : {}),
    });
    if (!nonempty(entry.id) || counts.get(entry.id) !== 1) return hold('DUPLICATE_OR_EMPTY_ENTRY_ID');
    if (entry.kind === 'legacy') return hold('LEGACY_IDENTITY_UNPROVEN');
    if (entry.kind !== 'writer_call' && entry.kind !== 'contained_process' && entry.kind !== 'opaque') {
      return hold('ENTRY_KIND_UNRECOGNIZED');
    }
    if (!reviewed) return hold('OWNER_REVIEW_OR_SCOPE_MISSING');
    if (!trustedBoot || boot.hostId !== entry.hostId) return hold('TRUSTED_BOOT_PROOF_MISSING');
    if (!nonempty(entry.ownerClientId) || entry.workspaceId !== input.targetWorkspaceId) return hold('OWNERSHIP_SCOPE_UNPROVEN');
    if (!entry.originBootId || entry.originBootId !== boot.previousBootId) return hold('ORIGINAL_BOOT_ID_UNPROVEN');
    if (!finiteTime(entry.recordedAtMs) || entry.recordedAtMs >= boot.rebootAtMs ||
        !finiteTime(entry.processStartedAtMs) || entry.processStartedAtMs > entry.recordedAtMs) {
      return hold('ORIGINAL_PROCESS_TIME_UNPROVEN');
    }
    if (!Number.isSafeInteger(entry.pid) || (entry.pid ?? 0) <= 0) return hold('ORIGINAL_PID_UNPROVEN');
    if (!entry.fingerprintSha256 || !SHA256.test(entry.fingerprintSha256)) return hold('SOURCE_FINGERPRINT_MISSING');
    const matches = input.review.items.filter(item => item.id === entry.id);
    if (reviewCounts.get(entry.id) !== 1 || matches.length !== 1 ||
        matches[0].workspaceId !== entry.workspaceId ||
        matches[0].expectedFingerprintSha256.toLowerCase() !== entry.fingerprintSha256.toLowerCase()) {
      return hold('EXACT_ITEM_APPROVAL_OR_FINGERPRINT_MISMATCH');
    }
    if (proofCounts.get(entry.pid!) !== 1) return hold('PROCESS_PROBE_NOT_UNIQUE');
    const probe = input.processObservations.find(p => p.pid === entry.pid);
    if (probe?.trusted !== true || probe.currentBootId !== boot.currentBootId) return hold('CURRENT_PROCESS_PROOF_MISSING');
    if (probe.state !== 'absent' && probe.state !== 'reused_pid' &&
        probe.state !== 'same_process' && probe.state !== 'unknown') {
      return hold('PROCESS_STATE_UNRECOGNIZED');
    }
    if (probe.state === 'same_process' || probe.state === 'unknown') return hold('CURRENT_PROCESS_LIVENESS_UNVERIFIED');
    if (probe.state === 'reused_pid' &&
        (!finiteTime(probe.currentProcessStartedAtMs) || probe.currentProcessStartedAtMs <= boot.rebootAtMs)) {
      return hold('PID_REUSE_CREATION_TIME_UNVERIFIED');
    }
    return {
      id: entry.id,
      decision: 'QUARANTINE_CANDIDATE',
      reason: 'ATTESTED_OLD_BOOT_WITH_EXACT_SCOPE_AND_NONLIVE_ORIGINAL_PROCESS',
      taskOutcome: 'UNKNOWN_UNVERIFIED',
      nativeCompletionVerified: false,
      sourceFingerprintSha256: entry.fingerprintSha256,
    };
  });
  return {
    mode: 'STAGING_READ_ONLY_PREVIEW',
    canMutateLive: false,
    mayReleaseReservation: false,
    decisions,
    eligibleCount: decisions.filter(x => x.decision === 'QUARANTINE_CANDIDATE').length,
    holdCount: decisions.filter(x => x.decision === 'HOLD').length,
  };
}

export type JournalPhase = 'NOT_STARTED' | 'BARRIER_HELD' | 'ORIGINALS_ARCHIVED' |
  'LEDGER_FENCED' | 'INDEPENDENTLY_VERIFIED' | 'HOLD';
export type JournalEvent = 'acquire_barrier' | 'verify_archive' | 'fence_ledger' |
  'verify_independently' | 'fault';
export interface JournalSnapshot {
  readonly phase: JournalPhase;
  readonly revision: number;
  readonly admissionOpen: false;
  readonly reason?: string;
}

/** Pure rehearsal: an interrupted or out-of-order recovery NEVER opens admission. */
export function advanceStagingJournal(
  current: JournalSnapshot, expectedRevision: number, event: JournalEvent,
): JournalSnapshot {
  if (!Number.isSafeInteger(current.revision) || current.revision < 0 ||
      current.revision >= Number.MAX_SAFE_INTEGER ||
      !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    return { ...current, phase: 'HOLD', admissionOpen: false, reason: 'INVALID_JOURNAL_REVISION' };
  }
  if (current.revision !== expectedRevision) return { ...current, phase: 'HOLD', admissionOpen: false, reason: 'CAS_REVISION_CONFLICT' };
  if (event === 'fault') return { phase: 'HOLD', revision: current.revision + 1, admissionOpen: false, reason: 'FAULT_REQUIRES_MANUAL_RECONCILIATION' };
  const transition: Record<Exclude<JournalPhase, 'HOLD'>, Partial<Record<JournalEvent, JournalPhase>>> = {
    NOT_STARTED: { acquire_barrier: 'BARRIER_HELD' },
    BARRIER_HELD: { verify_archive: 'ORIGINALS_ARCHIVED' },
    ORIGINALS_ARCHIVED: { fence_ledger: 'LEDGER_FENCED' },
    LEDGER_FENCED: { verify_independently: 'INDEPENDENTLY_VERIFIED' },
    INDEPENDENTLY_VERIFIED: {},
  };
  const next = current.phase === 'HOLD' ||
    !Object.prototype.hasOwnProperty.call(transition, current.phase)
    ? undefined : transition[current.phase][event];
  if (!next) return { ...current, phase: 'HOLD', admissionOpen: false, reason: 'INVALID_OR_REPEATED_TRANSITION' };
  return { phase: next, revision: current.revision + 1, admissionOpen: false };
}
