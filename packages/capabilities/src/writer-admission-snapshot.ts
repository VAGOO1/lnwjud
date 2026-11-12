import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseNativeAttemptBinding } from '@lnwjud/process';

const MAX_MARKERS = 4096;
const MAX_RECORD_BYTES = 65536;
const KINDS = ['opaque', 'repository_import', 'synchronous_mutation', 'opaque_uncontained', 'opaque_contained_process'] as const;
type MutationKind = typeof KINDS[number];
type SnapshotReason = 'observed' | 'not_initialized' | 'index_busy' | 'unreadable' | 'unsupported_schema' | 'changed_during_read' | 'limit_exceeded';

/** Observation only: neither zero markers nor repeated samples grant admission. */
export interface WriterAdmissionSnapshot {
  readonly scope: 'global_managed_writers';
  readonly basis: 'persisted_markers_only';
  readonly observedAt: string;
  readonly consistency: 'non_atomic';
  readonly status: 'observed' | 'unknown';
  readonly reason: SnapshotReason;
  readonly heldReservations: number | null;
  readonly reservationsByKind: Readonly<Record<MutationKind, number>> | null;
  readonly nativeEvidence: 'not_observed';
  readonly admission: 'not_evaluated';
}

class SnapshotUnavailable extends Error {
  constructor(readonly reason: SnapshotReason) { super(reason); }
}

/**
 * Read existing index bytes only. Deliberately independent of index initialization,
 * diagnostics, task hydration, SQLite, PID probes and native lifecycle RPCs.
 * All paths come from host configuration; no paths/IDs/credentials leave this reader.
 * Filesystem metadata checks detect observed races, not a multi-store transaction
 * or protection against hostile concurrent ancestor replacement. Host storage
 * must remain access-controlled. Windows no-follow guarantees require native QA.
 */
export async function readWriterAdmissionSnapshot(taskDirectory: string): Promise<WriterAdmissionSnapshot> {
  const base = {
    scope: 'global_managed_writers' as const, basis: 'persisted_markers_only' as const,
    observedAt: new Date().toISOString(), consistency: 'non_atomic' as const,
    nativeEvidence: 'not_observed' as const, admission: 'not_evaluated' as const,
  };
  try {
    // Use one lexical root for every check and read. A trailing separator can
    // make lstat follow a directory symlink before isSymbolicLink is checked.
    const root = path.resolve(taskDirectory);
    const ancestors: string[] = [];
    for (let parent = path.dirname(root);; parent = path.dirname(parent)) {
      ancestors.push(parent);
      if (path.dirname(parent) === parent) break;
    }
    const ancestorIdentities = await Promise.all(ancestors.map(ancestorIdentity));
    const index = path.join(root, '.index', 'v1');
    const active = path.join(index, 'active');
    const directories = [root, path.join(root, '.index'), index, active];
    const identities = await Promise.all(directories.map(directoryIdentity));
    await requireUnlocked(path.join(index, 'index.lock'));
    const ready = await readRecord(path.join(index, 'ready.json'));
    if (!record(ready.value) || ready.value.version !== 1 || ready.value.markerFormatVersion !== 2
      || typeof ready.value.readyAt !== 'string' || !Number.isFinite(Date.parse(ready.value.readyAt))) {
      throw new SnapshotUnavailable('unsupported_schema');
    }
    const names = await markerNames(active);
    const counts: Record<MutationKind, number> = { opaque: 0, repository_import: 0, synchronous_mutation: 0, opaque_uncontained: 0, opaque_contained_process: 0 };
    const fingerprints = new Map<string, string>();
    for (const name of names) {
      const marker = await readRecord(path.join(active, name));
      const kind = markerKind(marker.value, name);
      counts[kind] += 1;
      fingerprints.set(name, marker.identity);
    }
    // Never lock or repair to obtain a consistent-looking result. If the index
    // visibly changes, discard the counts rather than reporting empty capacity.
    if (JSON.stringify(await markerNames(active)) !== JSON.stringify(names)) throw new SnapshotUnavailable('changed_during_read');
    for (const [name, identity] of fingerprints) {
      if (await regularFileIdentity(path.join(active, name)) !== identity) throw new SnapshotUnavailable('changed_during_read');
    }
    if (await regularFileIdentity(path.join(index, 'ready.json')) !== ready.identity) throw new SnapshotUnavailable('changed_during_read');
    for (let i = 0; i < directories.length; i += 1) {
      if (await directoryIdentity(directories[i]!) !== identities[i]) throw new SnapshotUnavailable('changed_during_read');
    }
    for (let i = 0; i < ancestors.length; i += 1) {
      if (await ancestorIdentity(ancestors[i]!) !== ancestorIdentities[i]) throw new SnapshotUnavailable('changed_during_read');
    }
    await requireUnlocked(path.join(index, 'index.lock'));
    return { ...base, status: 'observed', reason: 'observed', heldReservations: names.length, reservationsByKind: counts };
  } catch (error) {
    const reason = error instanceof SnapshotUnavailable ? error.reason
      : record(error) && error.code === 'ENOENT' ? 'not_initialized' : 'unreadable';
    return { ...base, status: 'unknown', reason, heldReservations: null, reservationsByKind: null };
  }
}

function identity(info: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): string {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
}
async function ancestorIdentity(filename: string): Promise<string> {
  const info = await lstat(filename, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new SnapshotUnavailable('unreadable');
  // Unrelated siblings changing do not invalidate this trusted storage ancestor.
  return [info.dev, info.ino].join(':');
}
async function directoryIdentity(filename: string): Promise<string> {
  const info = await lstat(filename, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new SnapshotUnavailable('unreadable');
  return identity(info);
}
async function regularFileIdentity(filename: string): Promise<string> {
  const info = await lstat(filename, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink()) throw new SnapshotUnavailable('unreadable');
  return identity(info);
}
async function requireUnlocked(filename: string): Promise<void> {
  try { await lstat(filename); }
  catch (error) { if (record(error) && error.code === 'ENOENT') return; throw error; }
  throw new SnapshotUnavailable('index_busy');
}
async function markerNames(directory: string): Promise<string[]> {
  const names: string[] = [];
  const entries = await opendir(directory);
  for await (const entry of entries) {
    // An interrupted writer's temp file is uncertainty, not ignorable emptiness.
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) throw new SnapshotUnavailable('unreadable');
    names.push(entry.name);
    if (names.length > MAX_MARKERS) throw new SnapshotUnavailable('limit_exceeded');
  }
  return names.sort();
}
async function readRecord(filename: string): Promise<{ value: unknown; identity: string }> {
  const before = await regularFileIdentity(filename);
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || identity(info) !== before) throw new SnapshotUnavailable('changed_during_read');
    if (info.size > BigInt(MAX_RECORD_BYTES)) throw new SnapshotUnavailable('limit_exceeded');
    const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_RECORD_BYTES) throw new SnapshotUnavailable('limit_exceeded');
    if (BigInt(bytesRead) !== info.size || identity(await handle.stat({ bigint: true })) !== before
      || await regularFileIdentity(filename) !== before) throw new SnapshotUnavailable('changed_during_read');
    return { value: JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as unknown, identity: before };
  } finally { await handle.close(); }
}
function markerKind(value: unknown, filename: string): MutationKind {
  if (!record(value) || value.version !== 2 || value.legacy === true) throw new SnapshotUnavailable('unsupported_schema');
  if (typeof value.taskId !== 'string' || value.taskId.length === 0 || value.taskId.length > 256
    || value.taskId.includes('\0') || value.taskId.includes('/') || value.taskId.includes('\\') || value.taskId === '.' || value.taskId === '..'
    || filename !== createHash('sha256').update(value.taskId).digest('hex') + '.json'
    || typeof value.requestDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(value.requestDigest)
    || (value.capacityClass !== undefined && value.capacityClass !== 'durable_shell' && value.capacityClass !== 'managed_writer')
    || (value.mutationKind !== undefined && !KINDS.includes(value.mutationKind as MutationKind))) throw new SnapshotUnavailable('unreadable');
  if (value.nativeBinding !== undefined) {
    const binding = parseNativeAttemptBinding(value.nativeBinding);
    if (binding === undefined || binding.reservationId !== value.taskId || binding.requestDigest !== value.requestDigest
      || binding.ownerClientId !== value.ownerClientId || binding.workspaceId !== value.ownerWorkspaceId) throw new SnapshotUnavailable('unreadable');
  }
  return (value.mutationKind ?? 'opaque') as MutationKind;
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
