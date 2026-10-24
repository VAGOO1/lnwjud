/**
 * PANYA R13 — SYNTHETIC STAGING ONLY, MIT.
 * A bounded pure-data manifest inspector. It never reads Host files, verifies
 * real Windows attestation, releases reservations, writes SQLite, or mutates
 * the installed Host. Input is a JSON STRING with synthetic fixture claims;
 * the presence of flags or hashes does not establish authorization.
 */
import { createHash } from 'node:crypto';

type ItemStatus = 'HOLD' | 'SYNTHETIC_REVIEW_READY';
export interface R13Item {
  readonly taskId: string;
  readonly markerFile: string;
  readonly sourceFingerprintSha256?: string;
  readonly mutationKind: string;
  readonly ownerWorkspaceId?: string;
  readonly status: ItemStatus;
  readonly reason: string;
  readonly nativeTaskOutcome: 'UNKNOWN_UNVERIFIED';
  readonly nativeZeroDescendantsVerified: false;
  readonly canReleaseReservation: false;
}
export interface R13Report {
  readonly mode: 'R13_SYNTHETIC_STAGING_ONLY';
  readonly inputIntegrity: 'SYNTHETIC_SELF_CONSISTENCY_ONLY';
  readonly canMutateHost: false;
  readonly canReleaseReservation: false;
  readonly actualBootAttested: false;
  readonly completeInventoryClaim: boolean;
  readonly expectedCount: number;
  readonly observedCount: number;
  readonly readyForReview: number;
  readonly held: number;
  readonly status: 'HOLD' | 'SYNTHETIC_REVIEW_READY';
  readonly items: readonly R13Item[];
  readonly error?: string;
}
const HEX64 = /^[0-9a-f]{64}$/i;
const VALID_KIND = new Set(['opaque', 'opaque_uncontained', 'opaque_contained_process', 'repository_import']);
const digest = (input: string): string => createHash('sha256').update(input, 'utf8').digest('hex');
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const own = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);
const stringField = (value: Record<string, unknown>, key: string): string | undefined =>
  own(value, key) && typeof value[key] === 'string' ? value[key] as string : undefined;
const numField = (value: Record<string, unknown>, key: string): number | undefined =>
  own(value, key) && typeof value[key] === 'number' && Number.isSafeInteger(value[key]) ? value[key] as number : undefined;
const validName = (s: string | undefined): s is string => !!s && s.length <= 256 && !/[\\/\0]/.test(s) && s !== '.' && s !== '..';
const validTime = (s: string | undefined): number | undefined => {
  if (typeof s !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(s)) return undefined;
  const t = Date.parse(s); return Number.isSafeInteger(t) && new Date(t).toISOString().slice(0, 19) === s.slice(0, 19) ? t : undefined;
};
function globalHold(error: string, expected = 0, observed = 0): R13Report {
  return {
    mode: 'R13_SYNTHETIC_STAGING_ONLY', inputIntegrity: 'SYNTHETIC_SELF_CONSISTENCY_ONLY',
    canMutateHost: false, canReleaseReservation: false, actualBootAttested: false,
    completeInventoryClaim: false, expectedCount: expected, observedCount: observed,
    readyForReview: 0, held: observed, status: 'HOLD', items: [], error,
  };
}
/**
 * The canonical raw-marker bytes are hashed and checked against the manifest
 * expected digest. This proves only within-fixture consistency; a malicious
 * caller can forge both. Real Host fingerprints need independent host-owned
 * source-of-truth and secure file identity/ACL/reparse checks.
 */
export function previewR13SyntheticManifest(rawJson: unknown): R13Report {
  if (typeof rawJson !== 'string' || rawJson.length === 0 || rawJson.length > 512_000) {
    return globalHold('INVALID_OR_OVERSIZED_MANIFEST');
  }
  let data: unknown;
  try { data = JSON.parse(rawJson); } catch { return globalHold('MALFORMED_MANIFEST_JSON'); }
  if (!record(data) || data.version !== 1 || data.mode !== 'STAGING_SYNTHETIC_ONLY' ||
      typeof data.hostId !== 'string' || !data.hostId ||
      typeof data.targetWorkspaceId !== 'string' || !data.targetWorkspaceId ||
      data.inventoryComplete !== true || !Number.isSafeInteger(data.expectedCount) ||
      typeof data.expectedCount !== 'number' || data.expectedCount < 1 || data.expectedCount > 50 ||
      !Array.isArray(data.markers) || data.markers.length !== data.expectedCount ||
      !record(data.boot) || !Array.isArray(data.probes) || data.probes.length > 50 ||
      !record(data.review) || !Array.isArray(data.review.items) || data.review.items.length > 50) {
    return globalHold('MISSING_GLOBAL_INVENTORY_OR_HEADER');
  }
  const boot = data.boot;
  const prevBoot = stringField(boot, 'previousBootId');
  const currBoot = stringField(boot, 'currentBootId');
  const rebootAt = numField(boot, 'rebootAtMs');
  const bootPlausible = boot.source === 'synthetic_windows_native_fixture' &&
    stringField(boot, 'hostId') === data.hostId && prevBoot && currBoot &&
    prevBoot !== currBoot && rebootAt !== undefined && rebootAt > 0;
  const review = data.review;
  const reviewItems = review.items as unknown[];
  const probes = data.probes as unknown[];
  const markers = data.markers as unknown[];
  const taskCounts = new Map<string, number>();
  const markerCounts = new Map<string, number>();
  const reviewCounts = new Map<string, number>();
  for (const marker of markers) {
    if (record(marker)) {
      const id = stringField(marker, 'taskId') || '';
      const filename = stringField(marker, 'markerFile') || '';
      taskCounts.set(id, (taskCounts.get(id) ?? 0) + 1);
      markerCounts.set(filename, (markerCounts.get(filename) ?? 0) + 1);
    }
  }
  for (const reviewItem of reviewItems) {
    if (record(reviewItem)) {
      const id = stringField(reviewItem, 'taskId') || '';
      reviewCounts.set(id, (reviewCounts.get(id) ?? 0) + 1);
    }
  }
  const items: R13Item[] = markers.map((entry: unknown, index: number): R13Item => {
    const marker = record(entry) ? entry : {};
    const taskId = stringField(marker, 'taskId') || `__invalid_${index}`;
    const markerFile = stringField(marker, 'markerFile') || '';
    const fallback = (reason: string, kind = 'invalid', workspace?: string, hash?: string): R13Item => ({
      taskId, markerFile, mutationKind: kind, ownerWorkspaceId: workspace,
      ...(hash ? { sourceFingerprintSha256: hash } : {}), status: 'HOLD', reason,
      nativeTaskOutcome: 'UNKNOWN_UNVERIFIED', nativeZeroDescendantsVerified: false,
      canReleaseReservation: false,
    });
    if (!validName(taskId) || taskCounts.get(taskId) !== 1 ||
        markerCounts.get(markerFile) !== 1) return fallback('DUPLICATE_OR_INVALID_ID');
    const source = stringField(marker, 'rawMarkerJson');
    const expected = stringField(marker, 'expectedSha256');
    if (!source || source.length > 16_384 || !expected || !HEX64.test(expected)) return fallback('SOURCE_BYTES_OR_HASH_MISSING');
    const sourceHash = digest(source);
    if (sourceHash !== expected.toLowerCase() || markerFile !== `${digest(taskId)}.json`) {
      return fallback('MARKER_HASH_OR_FILENAME_MISMATCH', 'invalid', undefined, sourceHash);
    }
    let inner: unknown;
    try { inner = JSON.parse(source); } catch { return fallback('ORIGINAL_MARKER_INVALID_JSON', 'invalid', undefined, sourceHash); }
    if (!record(inner) || JSON.stringify(inner) !== source) return fallback('MARKER_NOT_CANONICAL_OR_DUPLICATE_KEYS', 'invalid', undefined, sourceHash);
    const kind = stringField(inner, 'mutationKind') ?? 'legacy';
    const workspace = stringField(inner, 'ownerWorkspaceId');
    const fail = (reason: string) => fallback(reason, kind, workspace, sourceHash);
    if (inner.version !== 1 || stringField(inner, 'taskId') !== taskId) return fail('MARKER_RECORD_ID_MISMATCH');
    if (inner.legacy === true || !VALID_KIND.has(kind)) return fail('LEGACY_OR_UNRECOGNIZED_KIND');
    if (workspace !== data.targetWorkspaceId || !workspace) return fail('OTHER_OR_UNKNOWN_WORKSPACE_OWNER');
    if (!stringField(inner, 'ownerClientId')) return fail('OWNER_CLIENT_UNKNOWN');
    if (!stringField(inner, 'requestDigest') || !HEX64.test(stringField(inner, 'requestDigest')!)) return fail('REQUEST_DIGEST_UNKNOWN');
    if (kind === 'opaque_contained_process' && !stringField(inner, 'nativeReceiptPath')) return fail('CONTAINED_RECEIPT_REFERENCE_UNKNOWN');
    const pid = numField(inner, 'launcherPid');
    const reservedAt = validTime(stringField(inner, 'reservedAt'));
    if (pid === undefined || pid <= 0 || reservedAt === undefined) return fail('LAUNCHER_OR_RESERVATION_TIMESTAMP_MISSING');
    // Upstream 5.8.7 does NOT persist these authenticated keys. They MUST NOT be
    // inferred from launcherStartedAt, file mtime, reboot date or PID reuse.
    const originalBoot = stringField(inner, 'originBootId');
    const originalHost = stringField(inner, 'originHostId');
    const originalOsStart = numField(inner, 'osProcessCreationMs');
    if (!originalBoot || !originalHost || originalOsStart === undefined || originalOsStart <= 0) return fail('ORIGINAL_WINDOWS_IDENTITY_NOT_PERSISTED');
    if (!bootPlausible || originalHost !== data.hostId || originalBoot !== prevBoot || rebootAt === undefined ||
        originalOsStart >= rebootAt || reservedAt >= rebootAt) return fail('BOOT_IDENTITY_CLAIM_NOT_CONSISTENT');
    if (review.scope !== 'staging_only' || review.approved !== true || reviewCounts.get(taskId) !== 1) return fail('EXACT_SYNTHETIC_OWNER_REVIEW_MISSING');
    const approval = reviewItems.find((r: unknown) => record(r) && stringField(r, 'taskId') === taskId);
    if (!record(approval) || stringField(approval, 'ownerWorkspaceId') !== workspace ||
        stringField(approval, 'sourceFingerprintSha256') !== sourceHash) return fail('EXACT_REVIEW_FINGERPRINT_MISMATCH');
    const found = probes.filter((p: unknown) => record(p) && numField(p, 'pid') === pid);
    if (found.length !== 1 || !record(found[0]) || stringField(found[0], 'currentBootId') !== currBoot) return fail('CURRENT_PROCESS_PROBE_NOT_UNIQUE');
    const probe = found[0];
    const state = stringField(probe, 'state');
    if (state !== 'absent' && state !== 'reused_pid') return fail('CURRENT_PROCESS_UNKNOWN_OR_LIVE');
    if (state === 'reused_pid' && (numField(probe, 'osCreationMs') === undefined ||
        numField(probe, 'osCreationMs')! <= rebootAt)) return fail('PID_REUSE_PROCESS_TIME_UNPROVEN');
    return {
      taskId, markerFile, mutationKind: kind, ownerWorkspaceId: workspace,
      sourceFingerprintSha256: sourceHash,
      status: 'SYNTHETIC_REVIEW_READY', reason: 'CLAIMED_PER_ITEM_EVIDENCE_COMPLETE_NOT_ATTESTED',
      nativeTaskOutcome: 'UNKNOWN_UNVERIFIED', nativeZeroDescendantsVerified: false,
      canReleaseReservation: false,
    };
  });
  const ready = items.filter(x => x.status === 'SYNTHETIC_REVIEW_READY').length;
  const held = items.length - ready;
  return {
    mode: 'R13_SYNTHETIC_STAGING_ONLY', inputIntegrity: 'SYNTHETIC_SELF_CONSISTENCY_ONLY',
    canMutateHost: false, canReleaseReservation: false, actualBootAttested: false,
    completeInventoryClaim: true, expectedCount: data.expectedCount,
    observedCount: items.length, readyForReview: ready, held,
    status: held === 0 ? 'SYNTHETIC_REVIEW_READY' : 'HOLD', items,
  };
}

export interface AuditSimulation {
  readonly mode: 'R13_NO_IO_SIMULATION';
  readonly canWriteLive: false;
  readonly mayReleaseReservation: false;
  readonly phase: 'HOLD' | 'SIMULATED_QUARANTINE_REVIEW_COMPLETE';
  readonly revision: number;
  readonly auditDigestSha256: string;
  readonly error?: string;
}
/** A deterministic hash-chained *illustration*, not a durable journal. */
export function simulateR13QuarantineAudit(item: R13Item, eventsJson: unknown): AuditSimulation {
  const initial = digest(`R13_ONLY|${item.taskId}|${item.sourceFingerprintSha256 ?? ''}`);
  const hold = (reason: string, revision: number, hash: string): AuditSimulation => ({
    mode: 'R13_NO_IO_SIMULATION', canWriteLive: false, mayReleaseReservation: false,
    phase: 'HOLD', revision, auditDigestSha256: hash, error: reason,
  });
  if (item.status !== 'SYNTHETIC_REVIEW_READY' || !item.sourceFingerprintSha256) return hold('ITEM_NOT_REVIEW_READY', 0, initial);
  if (typeof eventsJson !== 'string' || eventsJson.length > 8192) return hold('INVALID_AUDIT_EVENTS', 0, initial);
  let events: unknown;
  try { events = JSON.parse(eventsJson); } catch { return hold('MALFORMED_AUDIT_EVENTS', 0, initial); }
  if (!Array.isArray(events) || events.length !== 4) return hold('AUDIT_PHASE_COUNT_MISMATCH', 0, initial);
  const phases = ['LOCKED_PREVIEW','ORIGINAL_COPY_INSPECTED','OWNER_SCOPE_REVIEWED','QUARANTINE_SIMULATED'];
  let revision = 0, hash = initial;
  const ids = new Set<string>();
  for (let i=0;i<events.length;i++) {
    const step=events[i];
    if (!record(step) || stringField(step, 'phase') !== phases[i] ||
        numField(step, 'expectedRevision') !== revision ||
        stringField(step, 'taskId') !== item.taskId ||
        stringField(step, 'fingerprintSha256') !== item.sourceFingerprintSha256 ||
        !validName(stringField(step, 'eventId')) || ids.has(stringField(step,'eventId')!)) {
      return hold('AUDIT_CAS_OR_ITEM_MISMATCH', revision, hash);
    }
    ids.add(stringField(step,'eventId')!);
    hash = digest(`${hash}|${JSON.stringify(step)}`);
    revision++;
  }
  return { mode:'R13_NO_IO_SIMULATION', canWriteLive:false, mayReleaseReservation:false,
    phase:'SIMULATED_QUARANTINE_REVIEW_COMPLETE', revision, auditDigestSha256:hash };
}
