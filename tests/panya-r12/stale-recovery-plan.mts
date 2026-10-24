import { types as nodeTypes } from 'node:util';

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
const nonempty = (value: string | undefined): boolean =>
  typeof value === 'string' && value.trim().length > 0;
const finiteTime = (value: number | undefined): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Capture only OWN DATA properties of JSON-like objects.
 * Ignore neither sparse array holes nor accessor descriptors. Never call a getter
 * or read inherited evidence. This is a bounded local staging snapshot, not an
 * OS attestation or a substitute for the Host authorization boundary.
 */
const MALFORMED = Symbol('MALFORMED_STAGING_INPUT');
function snapshotOwnData(raw: unknown): unknown | typeof MALFORMED {
  const visited = new WeakSet<object>();
  let nodes = 0;
  function copy(value: unknown, depth: number): unknown | typeof MALFORMED {
    if (++nodes > 20000 || depth > 12) return MALFORMED;
    if (value === null || value === undefined || typeof value === 'string' ||
        typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value !== 'object' || nodeTypes.isProxy(value) || visited.has(value)) return MALFORMED;
    visited.add(value);
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype :
        (prototype !== Object.prototype && prototype !== null)) return MALFORMED;
    const props = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(props);
    if (keys.length > 20000 || keys.some(key => typeof key !== 'string')) return MALFORMED;
    if (array) {
      const length = props.length?.value;
      if (!Number.isSafeInteger(length) || length > 1000 || length < 0 ||
          keys.length !== length + 1) return MALFORMED;
      const copied: unknown[] = [];
      for (let i = 0; i < length; i++) {
        const descriptor = props[String(i)];
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return MALFORMED;
        const child = copy(descriptor.value, depth + 1);
        if (child === MALFORMED) return MALFORMED;
        copied.push(child);
      }
      return copied;
    }
    const copied: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      const descriptor = props[key as string];
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return MALFORMED;
      const child = copy(descriptor.value, depth + 1);
      if (child === MALFORMED) return MALFORMED;
      copied[key as string] = child;
    }
    return copied;
  }
  try { return copy(raw, 0); } catch { return MALFORMED; }
}
const own = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);
const required = (value: Record<string, unknown>, key: string, kind: 'string' | 'number' | 'boolean'): boolean =>
  own(value, key) && typeof value[key] === kind;
const optional = (value: Record<string, unknown>, key: string, kind: 'string' | 'number' | 'boolean'): boolean =>
  !own(value, key) || value[key] === undefined || typeof value[key] === kind;

/** Validate the complete JSON-like envelope before evaluating ANY candidate.
 * A malformed sibling record blocks the whole batch; never produce partial GO.
 * This remains a staging-only schema check, not trusted OS evidence.
 */
function isPreviewEnvelope(value: unknown): value is PreviewInput {
  if (!isRecord(value) || !required(value, 'targetWorkspaceId', 'string') ||
      !Array.isArray(value.entries) || value.entries.length === 0 || value.entries.length > 1000 ||
      !Array.isArray(value.processObservations) || value.processObservations.length > 1000 ||
      !isRecord(value.boot) || !isRecord(value.review)) return false;
  const boot = value.boot;
  const review = value.review;
  if (!required(boot, 'trusted', 'boolean') ||
      !required(boot, 'source', 'string') || !required(boot, 'hostId', 'string') ||
      !required(boot, 'previousBootId', 'string') || !required(boot, 'currentBootId', 'string') ||
      !required(boot, 'rebootAtMs', 'number') ||
      !required(review, 'ownerApprovedRecorded', 'boolean') ||
      !required(review, 'scope', 'string') || !required(review, 'reviewedBy', 'string') ||
      !Array.isArray(review.items) || review.items.length > 1000) return false;
  return value.entries.every((entry: unknown) => isRecord(entry) &&
      required(entry, 'id', 'string') && required(entry, 'kind', 'string') &&
      required(entry, 'hostId', 'string') && required(entry, 'workspaceId', 'string') &&
      required(entry, 'recordedAtMs', 'number') &&
      optional(entry, 'ownerClientId', 'string') && optional(entry, 'pid', 'number') &&
      optional(entry, 'originBootId', 'string') && optional(entry, 'processStartedAtMs', 'number') &&
      optional(entry, 'fingerprintSha256', 'string') && optional(entry, 'receiptVerified', 'boolean')) &&
    value.processObservations.every((probe: unknown) => isRecord(probe) &&
      required(probe, 'pid', 'number') && required(probe, 'currentBootId', 'string') &&
      required(probe, 'state', 'string') && required(probe, 'trusted', 'boolean') &&
      optional(probe, 'currentProcessStartedAtMs', 'number')) &&
    review.items.every((item: unknown) => isRecord(item) &&
      required(item, 'id', 'string') && required(item, 'workspaceId', 'string') &&
      required(item, 'expectedFingerprintSha256', 'string'));
}
function invalidPreview(): PreviewOutput {
  return {
    mode: 'STAGING_READ_ONLY_PREVIEW', canMutateLive: false, mayReleaseReservation: false,
    decisions: [{ id: '__invalid_input__', decision: 'HOLD', reason: 'MALFORMED_PREVIEW_INPUT',
      taskOutcome: 'UNKNOWN_UNVERIFIED', nativeCompletionVerified: false }],
    eligibleCount: 0, holdCount: 1,
  };
}

/**
 * Conservative per-record preflight. No IO, no locks, no cleanup, no retries.
 * UNKNOWN is a HOLD; every eligible result is still only a candidate for an
 * entirely separate, fenced, owner-reviewed quarantine transaction.
 */
export function previewStaleAfterReboot(input: PreviewInput): PreviewOutput {
  const snapshot = snapshotOwnData(input);
  if (snapshot === MALFORMED || !isPreviewEnvelope(snapshot)) return invalidPreview();
  input = snapshot;
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
  const snapshot = snapshotOwnData(current);
  if (snapshot === MALFORMED || !isRecord(snapshot) || !own(snapshot, 'phase') ||
      !own(snapshot, 'revision') || !own(snapshot, 'admissionOpen')) {
    return { phase: 'HOLD', revision: 0, admissionOpen: false, reason: 'INVALID_JOURNAL_SNAPSHOT' };
  }
  current = snapshot as unknown as JournalSnapshot;
  const revision = isRecord(current) && Number.isSafeInteger(current.revision) &&
    (current.revision as number) >= 0 && (current.revision as number) < Number.MAX_SAFE_INTEGER
    ? current.revision as number : 0;
  const hold = (reason: string): JournalSnapshot => ({ phase: 'HOLD', revision, admissionOpen: false, reason });
  if (!isRecord(current) || current.admissionOpen !== false ||
      typeof current.phase !== 'string') return hold('INVALID_JOURNAL_SNAPSHOT');
  if (!Number.isSafeInteger(current.revision) || current.revision < 0 ||
      current.revision >= Number.MAX_SAFE_INTEGER ||
      !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    return hold('INVALID_JOURNAL_REVISION');
  }
  if (current.revision !== expectedRevision) return hold('CAS_REVISION_CONFLICT');
  if (event === 'fault') return { phase: 'HOLD', revision: revision + 1, admissionOpen: false, reason: 'FAULT_REQUIRES_MANUAL_RECONCILIATION' };
  const transition: Record<Exclude<JournalPhase, 'HOLD'>, Partial<Record<JournalEvent, JournalPhase>>> = {
    NOT_STARTED: { acquire_barrier: 'BARRIER_HELD' },
    BARRIER_HELD: { verify_archive: 'ORIGINALS_ARCHIVED' },
    ORIGINALS_ARCHIVED: { fence_ledger: 'LEDGER_FENCED' },
    LEDGER_FENCED: { verify_independently: 'INDEPENDENTLY_VERIFIED' },
    INDEPENDENTLY_VERIFIED: {},
  };
  if (current.phase === 'HOLD' ||
      !Object.prototype.hasOwnProperty.call(transition, current.phase)) return hold('INVALID_OR_REPEATED_TRANSITION');
  const row = transition[current.phase as Exclude<JournalPhase, 'HOLD'>];
  const next = typeof event === 'string' && Object.prototype.hasOwnProperty.call(row, event)
    ? row[event] : undefined;
  if (typeof next !== 'string') return hold('INVALID_OR_REPEATED_TRANSITION');
  return { phase: next, revision: revision + 1, admissionOpen: false };
}
