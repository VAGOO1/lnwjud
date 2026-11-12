import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WindowsNativeAuthority } from '@lnwjud/process';
import { readWriterAdmissionSnapshot } from './writer-admission-snapshot.js';
import { SharedManagedWriterAdmission } from './shared-managed-writer-admission.js';
import { SqliteWorkspaceWriterLease } from './workspace-writer-lease.js';
import { DurableShellTaskIndex } from './durable-shell-task-index.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), opendir: vi.fn(actual.opendir) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  const actual = await vi.importActual<typeof fs>('node:fs/promises');
  vi.mocked(fs.open).mockReset().mockImplementation(actual.open);
  vi.mocked(fs.opendir).mockReset().mockImplementation(actual.opendir);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
async function fixture(): Promise<{ root: string; index: string; active: string }> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'admission-snapshot-')));
  roots.push(root);
  const index = path.join(root, '.index', 'v1');
  const active = path.join(index, 'active');
  await fs.mkdir(active, { recursive: true });
  await fs.writeFile(path.join(index, 'ready.json'), JSON.stringify({ version: 1, markerFormatVersion: 2, readyAt: '2026-11-11T00:00:00Z' }));
  return { root, index, active };
}
async function marker(active: string, taskId: string, fields: Record<string, unknown> = {}): Promise<string> {
  const filename = path.join(active, createHash('sha256').update(taskId).digest('hex') + '.json');
  await fs.writeFile(filename, JSON.stringify({ version: 2, taskId, requestDigest: 'a'.repeat(64), mutationKind: 'opaque', ...fields }));
  return filename;
}
async function tree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const filename = path.join(root, entry.name);
    if (entry.isDirectory()) Object.assign(result, await tree(filename));
    else result[filename] = (await fs.readFile(filename)).toString('base64');
  }
  return result;
}

describe('pure admission snapshot', () => {
  it('does not create an absent task root or infer empty capacity', async () => {
    const f = await fixture(); const absent = path.join(f.root, 'missing', 'tasks');
    expect(await readWriterAdmissionSnapshot(absent)).toMatchObject({ status: 'unknown', reason: 'not_initialized', heldReservations: null, admission: 'not_evaluated' });
    expect(existsSync(path.join(f.root, 'missing'))).toBe(false);
  });
  it('reports empty observed metadata without granting admission', async () => {
    const f = await fixture(); const before = await tree(f.root);
    expect(await readWriterAdmissionSnapshot(f.root)).toMatchObject({ status: 'observed', heldReservations: 0, consistency: 'non_atomic', nativeEvidence: 'not_observed', admission: 'not_evaluated' });
    expect(await tree(f.root)).toEqual(before);
  });
  it.each(['opaque', 'repository_import', 'synchronous_mutation', 'opaque_uncontained', 'opaque_contained_process'])('retains foreign terminal-looking %s reservations without probing or releasing', async (kind) => {
    const f = await fixture();
    await marker(f.active, 'foreign-task-secret', { mutationKind: kind, ownerClientId: 'foreign-client-secret', ownerWorkspaceId: 'foreign-workspace-secret', launcherPid: 2147483647, state: 'completed', nativeReceiptPath: '/private/foreign/receipt-secret.json' });
    const before = await tree(f.root);
    const trapped = vi.spyOn(DurableShellTaskIndex.prototype, 'diagnostics').mockRejectedValue(new Error('MUST_NOT_CALL_DIAGNOSTICS'));
    const reserve = vi.spyOn(DurableShellTaskIndex.prototype, 'reserve').mockRejectedValue(new Error('MUST_NOT_RESERVE'));
    const release = vi.spyOn(DurableShellTaskIndex.prototype, 'release').mockRejectedValue(new Error('MUST_NOT_RELEASE'));
    const admission = new SharedManagedWriterAdmission(f.root);
    for (let i = 0; i < 3; i += 1) {
      const result = await admission.snapshot();
      expect(result).toMatchObject({ status: 'observed', heldReservations: 1, reservationsByKind: { [kind]: 1 } });
      expect(JSON.stringify(result)).not.toMatch(/foreign|2147483647|receipt-secret|[a-f0-9]{64}/);
    }
    expect(trapped).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled();
    expect(await tree(f.root)).toEqual(before);
  });
  it('does not call native authority for a fully bound attempt', async () => {
    const f = await fixture(); const taskId = 'secret-native-attempt';
    await marker(f.active, taskId, { ownerClientId: 'client-secret', ownerWorkspaceId: 'workspace-secret', mutationKind: 'opaque_contained_process', nativeBinding: {
      taskId, reservationId: taskId, attemptId: 'attempt-secret', generation: 1, requestDigest: 'a'.repeat(64), ownerClientId: 'client-secret', ownerSessionId: 'session-secret', workspaceId: 'workspace-secret',
    } });
    const before = await tree(f.root);
    const inspect = vi.spyOn(WindowsNativeAuthority.prototype, 'inspect').mockRejectedValue(new Error('MUST_NOT_INSPECT'));
    const abort = vi.spyOn(WindowsNativeAuthority.prototype, 'abortBeforeLaunch').mockRejectedValue(new Error('MUST_NOT_ABORT'));
    const cancel = vi.spyOn(WindowsNativeAuthority.prototype, 'cancel').mockRejectedValue(new Error('MUST_NOT_CANCEL'));
    const native = new WindowsNativeAuthority({ helper: { executable: path.join(f.root, 'unused.exe'), sha256: 'a'.repeat(64), buildId: 'lnwjud-containment-v2' }, pin: { modulePath: path.join(f.root, 'unused.node'), sha256: 'a'.repeat(64) }, profileDirectory: f.root });
    const result = await new SharedManagedWriterAdmission(f.root, native).snapshot();
    expect(inspect).not.toHaveBeenCalled(); expect(abort).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'observed', heldReservations: 1, nativeEvidence: 'not_observed' });
    expect(JSON.stringify(result)).not.toContain('secret'); expect(await tree(f.root)).toEqual(before);
  });
  it.each(['active', 'stale'])('does not acquire or reclaim an %s index lock', async (state) => {
    const f = await fixture(); await fs.writeFile(path.join(f.index, 'index.lock'), JSON.stringify({ pid: 2147483647, acquiredAt: state === 'stale' ? '1970-01-01T00:00:00Z' : new Date().toISOString() }));
    const before = await tree(f.root);
    expect(await readWriterAdmissionSnapshot(f.root)).toMatchObject({ status: 'unknown', reason: 'index_busy', heldReservations: null });
    expect(await tree(f.root)).toEqual(before);
  });
  it.each(['missing', 'malformed', 'legacy'])('preserves %s ready metadata', async (state) => {
    const f = await fixture(); const ready = path.join(f.index, 'ready.json');
    if (state === 'missing') await fs.rm(ready);
    else await fs.writeFile(ready, state === 'malformed' ? '{' : JSON.stringify({ version: 1, readyAt: '2026-11-11T00:00:00Z' }));
    const before = await tree(f.root);
    expect(await readWriterAdmissionSnapshot(f.root)).toMatchObject({ status: 'unknown', heldReservations: null });
    expect(await tree(f.root)).toEqual(before);
  });
  it.each(['legacy', 'corrupt', 'wrong_hash', 'oversized', 'unexpected_name'])('keeps %s marker evidence unknown without repair', async (state) => {
    const f = await fixture(); const filename = await marker(f.active, 'task');
    if (state === 'legacy') await fs.writeFile(filename, JSON.stringify({ version: 1, taskId: 'task' }));
    if (state === 'corrupt') await fs.writeFile(filename, '{');
    if (state === 'wrong_hash') await fs.rename(filename, path.join(f.active, 'b'.repeat(64) + '.json'));
    if (state === 'oversized') await fs.writeFile(filename, ' '.repeat(65537));
    if (state === 'unexpected_name') await fs.rename(filename, path.join(f.active, 'foreign-private-name.tmp'));
    const before = await tree(f.root); const result = await readWriterAdmissionSnapshot(f.root);
    expect(result).toMatchObject({ status: 'unknown', heldReservations: null });
    expect(JSON.stringify(result)).not.toContain('foreign-private-name'); expect(await tree(f.root)).toEqual(before);
  });
  it('fails closed on access denial and preserves the evidence', async () => {
    const f = await fixture(); const before = await tree(f.root);
    vi.mocked(fs.open).mockRejectedValueOnce(Object.assign(new Error('PRIVATE_PATH_MUST_NOT_ESCAPE'), { code: 'EACCES' }));
    const result = await readWriterAdmissionSnapshot(f.root);
    expect(result).toMatchObject({ status: 'unknown', reason: 'unreadable', heldReservations: null });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_PATH'); expect(await tree(f.root)).toEqual(before);
  });
  it.skipIf(process.platform === 'win32')('rejects symlinked files and directories rather than following them', async () => {
    const f = await fixture(); const secret = path.join(f.root, 'outside-secret'); await fs.writeFile(secret, 'private');
    const linked = path.join(f.active, 'a'.repeat(64) + '.json'); await fs.symlink(secret, linked);
    expect(await readWriterAdmissionSnapshot(f.root)).toMatchObject({ status: 'unknown', reason: 'unreadable' });
    await fs.rm(linked); await fs.rmdir(f.active); await fs.symlink(path.dirname(secret), f.active);
    expect(await readWriterAdmissionSnapshot(f.root)).toMatchObject({ status: 'unknown', reason: 'unreadable' });
    expect(await fs.readFile(secret, 'utf8')).toBe('private');
  });
  it.skipIf(process.platform === 'win32').each(['', '/', '///'])('rejects a symlinked task root with suffix %j before opening evidence', async (suffix) => {
    const f = await fixture();
    const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'admission-root-link-'))); roots.push(parent);
    const linkedRoot = path.join(parent, 'link'); await fs.symlink(f.root, linkedRoot);
    const before = await tree(f.root);
    expect(await readWriterAdmissionSnapshot(linkedRoot + suffix)).toMatchObject({ status: 'unknown', reason: 'unreadable', heldReservations: null });
    expect(fs.open).not.toHaveBeenCalled(); expect(fs.opendir).not.toHaveBeenCalled();
    expect(await tree(f.root)).toEqual(before);
  });
  it.each(['absolute', 'relative'])('uses one normalized %s root for directory checks and evidence reads', async (form) => {
    const f = await fixture(); const before = await tree(f.root);
    const root = form === 'relative' ? path.relative(process.cwd(), f.root) : f.root;
    expect(await readWriterAdmissionSnapshot(root + path.sep)).toMatchObject({ status: 'observed', heldReservations: 0, admission: 'not_evaluated' });
    expect(await tree(f.root)).toEqual(before);
  });
  it('discards counts when a marker changes between directory samples', async () => {
    const f = await fixture(); const filename = await marker(f.active, 'task');
    const realOpenDir = (await vi.importActual<typeof fs>('node:fs/promises')).opendir; let calls = 0;
    vi.mocked(fs.opendir).mockImplementation(async (...args: Parameters<typeof fs.opendir>): Promise<Awaited<ReturnType<typeof fs.opendir>>> => {
      calls += 1; if (calls === 2) await fs.writeFile(filename, JSON.stringify({ version: 2, taskId: 'task', requestDigest: 'b'.repeat(64) }));
      return realOpenDir(...args);
    });
    expect(await readWriterAdmissionSnapshot(f.root)).toMatchObject({ status: 'unknown', reason: 'changed_during_read', heldReservations: null });
  });
  it.each(['file_replacement', 'file_deletion', 'file_growth', 'new_lock', 'directory_replacement'])('fails closed on %s between samples without repairing evidence', async (change) => {
    const f = await fixture(); const filename = await marker(f.active, 'task');
    const realOpenDir = (await vi.importActual<typeof fs>('node:fs/promises')).opendir;
    let calls = 0; let changedTree: Record<string, string> | undefined;
    vi.mocked(fs.opendir).mockImplementation(async (...args: Parameters<typeof fs.opendir>): Promise<Awaited<ReturnType<typeof fs.opendir>>> => {
      calls += 1;
      if (calls === 2) {
        if (change === 'file_replacement') {
          const replacement = path.join(f.root, 'replacement'); await fs.copyFile(filename, replacement); await fs.rename(replacement, filename);
        } else if (change === 'file_deletion') await fs.rm(filename);
        else if (change === 'file_growth') await fs.appendFile(filename, ' '.repeat(65537));
        else if (change === 'new_lock') await fs.writeFile(path.join(f.index, 'index.lock'), 'foreign lock must remain');
        else {
          const retired = path.join(f.root, 'retired-active'); await fs.rename(f.active, retired); await fs.mkdir(f.active);
          await fs.copyFile(path.join(retired, path.basename(filename)), filename);
        }
        changedTree = await tree(f.root);
      }
      return realOpenDir(...args);
    });
    expect(await readWriterAdmissionSnapshot(f.root)).toMatchObject({ status: 'unknown', heldReservations: null, reservationsByKind: null, admission: 'not_evaluated' });
    expect(changedTree).toBeDefined(); expect(await tree(f.root)).toEqual(changedTree);
  });
  it('retains a missing active directory as unknown without creating it', async () => {
    const f = await fixture(); await fs.rmdir(f.active);
    expect(await readWriterAdmissionSnapshot(f.root)).toMatchObject({ status: 'unknown', reason: 'not_initialized', heldReservations: null });
    expect(existsSync(f.active)).toBe(false);
  });
  it('bounds marker enumeration without interpreting partial counts', async () => {
    const f = await fixture();
    for (let start = 0; start < 4097; start += 128) {
      await Promise.all(Array.from({ length: Math.min(128, 4097 - start) }, (_, offset) => fs.writeFile(path.join(f.active, (start + offset).toString(16).padStart(64, '0') + '.json'), '{}')));
    }
    expect(await readWriterAdmissionSnapshot(f.root)).toMatchObject({ status: 'unknown', reason: 'limit_exceeded', heldReservations: null });
    expect(await fs.readdir(f.active)).toHaveLength(4097);
  });
  it.skipIf(process.platform === 'win32')('rejects a symlinked ancestor of the configured task root', async () => {
    const f = await fixture(); const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'admission-link-'))); roots.push(parent);
    await fs.symlink(f.root, path.join(parent, 'link'));
    expect(await readWriterAdmissionSnapshot(path.join(parent, 'link', '.index'))).toMatchObject({ status: 'unknown', reason: 'unreadable' });
  });
  it('opens evidence only read-only and never invokes write helpers', async () => {
    const f = await fixture(); await marker(f.active, 'task');
    const writers = ['mkdir', 'writeFile', 'rm', 'rename', 'appendFile'] as const;
    const traps = writers.map((name) => vi.spyOn(fs, name).mockRejectedValue(new Error('MUST_NOT_WRITE')));
    const result = await readWriterAdmissionSnapshot(f.root);
    expect(result.status).toBe('observed');
    for (const trap of traps) expect(trap).not.toHaveBeenCalled();
    for (const call of vi.mocked(fs.open).mock.calls) {
      expect(typeof call[1]).toBe('number');
      // POSIX O_WRONLY/O_RDWR occupy the two low bits; O_RDONLY is zero.
      expect((Number(call[1]) & 3)).toBe(0);
    }
  });
  it('does not reopen or recreate SQLite when delegated through the lease port', async () => {
    const f = await fixture(); const db = path.join(f.root, 'lease.sqlite');
    const probe = vi.fn().mockRejectedValue(new Error('MUST_NOT_PROBE'));
    const lease = new SqliteWorkspaceWriterLease(db, Date.now, { holdExclusiveProbe: probe, snapshot: (): ReturnType<typeof readWriterAdmissionSnapshot> => readWriterAdmissionSnapshot(f.root) });
    await fs.rm(db);
    expect(await lease.admissionSnapshot('workspace')).toMatchObject({ ok: true, value: { status: 'observed' } });
    expect(existsSync(db)).toBe(false); expect(probe).not.toHaveBeenCalled();
    expect(await new SqliteWorkspaceWriterLease(path.join(f.root, 'other.sqlite')).admissionSnapshot('workspace')).toMatchObject({ ok: false });
  });
});
