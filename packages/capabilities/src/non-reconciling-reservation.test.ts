import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DurableShellTaskIndex, type DurableTaskReservation, type DurableShellTaskIndexOptions } from './durable-shell-task-index.js';
import { SharedManagedWriterAdmission } from './shared-managed-writer-admission.js';
import { SqliteWorkspaceWriterLease } from './workspace-writer-lease.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const request = (taskId: string, mutationKind: DurableTaskReservation['mutationKind'] = 'opaque'): DurableTaskReservation => ({
  taskId, mutationKind, requestDigest: createHash('sha256').update(taskId).digest('hex'), ownerClientId: 'client', ownerWorkspaceId: 'workspace',
});
interface Fixture {
  root: string; base: string; active: string; index: DurableShellTaskIndex; options: DurableShellTaskIndexOptions;
  inspectTask: ReturnType<typeof vi.fn>; native: ReturnType<typeof vi.fn>; pid: ReturnType<typeof vi.fn>; loadLaunchRecord: ReturnType<typeof vi.fn>;
}
async function fixture(): Promise<Fixture> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'strict-reservation-'))); roots.push(root);
  const inspectTask = vi.fn().mockResolvedValue('terminal');
  const native = vi.fn().mockResolvedValue(true);
  const pid = vi.fn().mockReturnValue(true);
  const loadLaunchRecord = vi.fn().mockRejectedValue(new Error('MUST_NOT_LOAD_FOREIGN_HISTORY'));
  const options = { maxConcurrentTasks: 2, inspectTask, verifyContainedTermination: native, isProcessProvenGone: pid, loadLaunchRecord };
  const index = new DurableShellTaskIndex(root, options);
  const base = path.join(root, '.index', 'v1');
  return { root, base, active: path.join(base, 'active'), index, options, inspectTask, native, pid, loadLaunchRecord };
}
const markerPath = (active: string, id: string): string => path.join(active, createHash('sha256').update(id).digest('hex') + '.json');
async function seed(f: Fixture, kind: DurableTaskReservation['mutationKind'] = 'opaque'): Promise<{ input: DurableTaskReservation; filename: string }> {
  const input = request('foreign', kind);
  expect(await f.index.reserve(input)).toMatchObject({ ok: true });
  return { input, filename: markerPath(f.active, input.taskId) };
}
function noForeignProbes(f: Fixture): void {
  expect(f.inspectTask).not.toHaveBeenCalled(); expect(f.native).not.toHaveBeenCalled();
  expect(f.pid).not.toHaveBeenCalled(); expect(f.loadLaunchRecord).not.toHaveBeenCalled();
}

describe('non-reconciling writer reservation', () => {
  it.each(['opaque', 'repository_import', 'synchronous_mutation', 'opaque_uncontained', 'opaque_contained_process'] as const)('retains terminal-looking %s evidence and never asks for foreign proof', async kind => {
    const f = await fixture();
    const input = { ...request('foreign', kind), ...(kind === 'opaque_contained_process' ? { nativeReceiptPath: path.join(f.root, 'foreign', 'containment.receipt.json') } : {}) };
    expect(await f.index.reserve(input)).toMatchObject({ ok: true });
    const filename = markerPath(f.active, input.taskId);
    const value = JSON.parse(await fs.readFile(filename, 'utf8')) as Record<string, unknown>;
    await fs.writeFile(filename, JSON.stringify({ ...value, launcherPid: 2147483647, state: 'completed' }));
    const before = await fs.readFile(filename);
    expect(await f.index.reserve(request('probe', 'repository_import'))).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await fs.readFile(filename)).toEqual(before); noForeignProbes(f);
  });
  it('bootstraps only empty storage and exact release does not create missing storage', async () => {
    const f = await fixture(); const absent = path.join(f.root, 'missing');
    await new DurableShellTaskIndex(absent, f.options).release('not-there', 'a'.repeat(64));
    expect(existsSync(absent)).toBe(false);
    await seed(f); noForeignProbes(f);
    expect(JSON.parse(await fs.readFile(path.join(f.base, 'ready.json'), 'utf8'))).toMatchObject({ markerFormatVersion: 2 });
  });
  it.each(['missing_ready', 'old_ready', 'corrupt_ready', 'missing_active', 'missing_journal', 'partial_journal'])('refuses %s without repairing evidence', async kind => {
    const f = await fixture(); const { filename } = await seed(f);
    const ready = path.join(f.base, 'ready.json'); const journal = path.join(f.base, 'launches.jsonl');
    if (kind === 'missing_ready') await fs.rm(ready);
    if (kind === 'old_ready') await fs.writeFile(ready, JSON.stringify({ version: 1, readyAt: '2026-11-11T00:00:00Z' }));
    if (kind === 'corrupt_ready') await fs.writeFile(ready, '{');
    if (kind === 'missing_active') { await fs.rm(f.active, { recursive: true }); await fs.mkdir(path.join(f.root, 'surviving-task')); }
    if (kind === 'missing_journal') await fs.rm(journal);
    if (kind === 'partial_journal') await fs.writeFile(journal, 'partial foreign journal');
    const readyBefore = existsSync(ready) ? await fs.readFile(ready) : undefined;
    const markerBefore = existsSync(filename) ? await fs.readFile(filename) : undefined;
    const launch = request('new-task');
    const result = await f.index.reserve({ ...launch, launchRecord: { version: 1, taskId: launch.taskId, startedAt: new Date().toISOString(), ownerClientId: 'client', ownerSessionId: 'session' } });
    expect(result.ok).toBe(false); expect(existsSync(markerPath(f.active, launch.taskId))).toBe(false);
    if (readyBefore !== undefined) expect(await fs.readFile(ready)).toEqual(readyBefore); else expect(existsSync(ready)).toBe(false);
    if (markerBefore !== undefined) expect(await fs.readFile(filename)).toEqual(markerBefore);
    if (kind === 'missing_active') expect(existsSync(f.active)).toBe(false);
    if (kind === 'missing_journal') expect(existsSync(journal)).toBe(false);
    if (kind === 'partial_journal') expect(await fs.readFile(journal, 'utf8')).toBe('partial foreign journal');
    noForeignProbes(f);
  });
  it('does not initialize or inspect a nonempty legacy task root', async () => {
    const f = await fixture(); await fs.mkdir(path.join(f.root, 'old-task'));
    expect(await f.index.reserve(request('new-task'))).toMatchObject({ ok: false });
    expect(existsSync(path.join(f.root, '.index'))).toBe(false); noForeignProbes(f);
  });
  it.each(['missing_kind', 'missing_capacity', 'legacy', 'wrong_hash', 'stray_temp', 'nonregular', 'oversize', 'corrupt'])('retains %s evidence and blocks new capacity', async kind => {
    const f = await fixture(); const { filename } = await seed(f, 'repository_import');
    const value = JSON.parse(await fs.readFile(filename, 'utf8')) as Record<string, unknown>;
    if (kind === 'missing_kind') { delete value.mutationKind; await fs.writeFile(filename, JSON.stringify(value)); }
    if (kind === 'missing_capacity') { delete value.capacityClass; await fs.writeFile(filename, JSON.stringify(value)); }
    if (kind === 'legacy') await fs.writeFile(filename, JSON.stringify({ ...value, version: 1 }));
    if (kind === 'wrong_hash') await fs.rename(filename, path.join(f.active, 'f'.repeat(64) + '.json'));
    if (kind === 'stray_temp') { await f.index.release('foreign', request('foreign').requestDigest); await fs.writeFile(path.join(f.active, 'interrupted.tmp'), 'held'); }
    if (kind === 'nonregular') { await fs.rm(filename); await fs.mkdir(filename); }
    if (kind === 'oversize') await fs.writeFile(filename, ' '.repeat(65537));
    if (kind === 'corrupt') await fs.writeFile(filename, '{');
    const before = (await fs.readdir(f.active)).sort();
    expect(await f.index.reserve(request('new-task'))).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect((await fs.readdir(f.active)).sort()).toEqual(before); noForeignProbes(f);
  });
  it.each(['reserve', 'release'])('does not reclaim a dead stale lock during %s', async action => {
    const f = await fixture(); const { input, filename } = await seed(f);
    const lock = path.join(f.base, 'index.lock'); const contents = JSON.stringify({ version: 1, pid: 2147483647, acquiredAt: '1970-01-01T00:00:00Z' });
    await fs.writeFile(lock, contents); const before = await fs.readFile(filename);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('MUST_NOT_PROBE_FOREIGN_PID'); });
    const realNow = Date.now(); let tick = 0; vi.spyOn(Date, 'now').mockImplementation(() => realNow + tick++ * 11000);
    if (action === 'reserve') expect(await f.index.reserve(request('new-task'))).toMatchObject({ ok: false });
    else await f.index.release(input.taskId, input.requestDigest);
    expect(await fs.readFile(lock, 'utf8')).toBe(contents); expect(await fs.readFile(filename)).toEqual(before); noForeignProbes(f);
    expect(kill).not.toHaveBeenCalled();
  });
  it('does not remove a replaced lock on completion', async () => {
    const f = await fixture(); await seed(f);
    const lock = path.join(f.base, 'index.lock'); const foreignLock = JSON.stringify({ version: 1, token: 'other-lock-owner', pid: process.pid, acquiredAt: new Date().toISOString() });
    const racing = new DurableShellTaskIndex(f.root, { ...f.options, listActiveFiles: async (directory): Promise<string[]> => { await fs.writeFile(lock, foreignLock); return fs.readdir(directory); } });
    expect(await racing.reserve(request('new-task'))).toMatchObject({ ok: false });
    expect(await fs.readFile(lock, 'utf8')).toBe(foreignLock);
  });
  it('does not redispatch a reservation when an operation returns EEXIST', async () => {
    const f = await fixture(); await seed(f);
    const listing = vi.fn().mockRejectedValue(Object.assign(new Error('injected'), { code: 'EEXIST' }));
    expect(await new DurableShellTaskIndex(f.root, { ...f.options, listActiveFiles: listing }).reserve(request('new-task'))).toMatchObject({ ok: false });
    expect(listing).toHaveBeenCalledTimes(1);
  });
  it('compares canonical native binding values rather than property insertion order', async () => {
    const f = await fixture(); const base = request('native');
    const input = { ...base, nativeReceiptPath: path.join(f.root, 'native', 'containment.receipt.json'), nativeBinding: {
      workspaceId: 'workspace', ownerSessionId: 'session', ownerClientId: 'client', requestDigest: base.requestDigest,
      generation: 1, attemptId: 'attempt', reservationId: 'native', taskId: 'native',
    } };
    expect(await f.index.reserve(input)).toMatchObject({ ok: true, value: { created: true } });
    expect(await f.index.reserve(input)).toMatchObject({ ok: true, value: { created: false } });
    expect(await f.index.reserve({ ...input, nativeBinding: { ...input.nativeBinding, attemptId: 'other' } })).toMatchObject({ ok: false }); noForeignProbes(f);
  });
  it('refuses an idempotent match when any other entry is unreadable', async () => {
    const f = await fixture(); const { input } = await seed(f);
    await fs.writeFile(path.join(f.active, 'unknown.tmp'), 'preserve');
    expect(await f.index.reserve(input)).toMatchObject({ ok: false });
    expect(await fs.readFile(path.join(f.active, 'unknown.tmp'), 'utf8')).toBe('preserve'); noForeignProbes(f);
  });
  it('bounds the admission scan without using partial counts', async () => {
    const f = await fixture(); await seed(f);
    const index = new DurableShellTaskIndex(f.root, { ...f.options, listActiveFiles: async (): Promise<string[]> => Array.from({ length: 16385 }, () => 'a'.repeat(64) + '.json') });
    expect(await index.reserve(request('new-task'))).toMatchObject({ ok: false }); noForeignProbes(f);
  });
  it('retains an exact-owned native marker changed while proof was pending', async () => {
    const f = await fixture(); const base = request('native');
    const input = { ...base, mutationKind: 'opaque_contained_process' as const,
      nativeReceiptPath: path.join(f.root, 'native', 'containment.receipt.json'),
      nativeBinding: { taskId: 'native', reservationId: 'native', attemptId: 'attempt', generation: 1, requestDigest: base.requestDigest, ownerClientId: 'client', ownerSessionId: 'session', workspaceId: 'workspace' },
    };
    expect(await f.index.reserve(input)).toMatchObject({ ok: true });
    const filename = markerPath(f.active, 'native');
    f.native.mockImplementationOnce(async (): Promise<boolean> => {
      const value = JSON.parse(await fs.readFile(filename, 'utf8')) as Record<string, unknown>;
      await fs.writeFile(filename, JSON.stringify({ ...value, reservedAt: '2000-01-01T00:00:00Z' })); return true;
    });
    await f.index.release(input.taskId, input.requestDigest);
    expect(await f.index.hasReservation(input.taskId, input.requestDigest)).toBe(true);
    expect(f.native).toHaveBeenCalledExactlyOnceWith(input);
  });
  it('lease acquisition leaves another workspace lease and call rows unchanged without probing their PIDs', async () => {
    const f = await fixture(); const seeded = await seed(f); await f.index.release(seeded.input.taskId, seeded.input.requestDigest);
    const dbPath = path.join(f.root, 'leases.sqlite');
    const lease = new SqliteWorkspaceWriterLease(dbPath, Date.now, new SharedManagedWriterAdmission(f.root));
    const foreign = await lease.acquire('other-workspace', 'other-client', 'other-session', 600);
    expect(foreign.ok).toBe(true); if (!foreign.ok) return;
    expect(await lease.begin('other-workspace', 'other-client', 'other-session', 'foreign-call', foreign.value)).toMatchObject({ ok: true });
    const db = new DatabaseSync(dbPath);
    try {
      const before = { lease: db.prepare('SELECT * FROM workspace_writer_leases WHERE workspace_id=?').get('other-workspace'), calls: db.prepare('SELECT * FROM workspace_writer_calls WHERE workspace_id=?').all('other-workspace') };
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('MUST_NOT_PROBE_OTHER_WORKSPACE'); });
      expect(await lease.acquire('target-workspace', 'client', 'session', 600)).toMatchObject({ ok: true });
      expect({ lease: db.prepare('SELECT * FROM workspace_writer_leases WHERE workspace_id=?').get('other-workspace'), calls: db.prepare('SELECT * FROM workspace_writer_calls WHERE workspace_id=?').all('other-workspace') }).toEqual(before);
      expect(kill).not.toHaveBeenCalled();
    } finally { db.close(); }
  });
  it.each(['two_imports', 'import_vs_writer', 'capacity'])('serializes %s across independent index instances', async kind => {
    const f = await fixture();
    const options = { ...f.options, maxConcurrentTasks: 1 };
    const first = new DurableShellTaskIndex(f.root, options); const second = new DurableShellTaskIndex(f.root, options);
    const results = await Promise.all([
      first.reserve(request('a', kind === 'capacity' ? 'opaque' : 'repository_import')),
      second.reserve(request('b', kind === 'two_imports' ? 'repository_import' : 'opaque')),
    ]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok)).toHaveLength(1);
    expect(await fs.readdir(f.active)).toHaveLength(1); noForeignProbes(f);
  });
  it.skipIf(process.platform === 'win32')('rejects marker symlinks and root trailing-slash symlinks', async () => {
    const f = await fixture(); const { filename } = await seed(f);
    const target = path.join(f.root, 'foreign-secret'); await fs.rename(filename, target); await fs.symlink(target, filename);
    expect(await f.index.reserve(request('new-task'))).toMatchObject({ ok: false });
    const alias = path.join(f.root, 'root-link'); await fs.symlink(f.root, alias);
    expect(await new DurableShellTaskIndex(alias + '/', f.options).reserve(request('new-task'))).toMatchObject({ ok: false });
    expect((await fs.lstat(filename)).isSymbolicLink()).toBe(true); noForeignProbes(f);
  });
  it.skipIf(process.platform === 'win32')('exact release preserves a symlinked marker and its target as unknown', async () => {
    const f = await fixture(); const { input, filename } = await seed(f);
    const target = path.join(f.root, 'target'); await fs.rename(filename, target); await fs.symlink(target, filename);
    const before = await fs.readFile(target);
    await f.index.release(input.taskId, input.requestDigest);
    expect(await f.index.hasReservation(input.taskId, input.requestDigest)).toBe(true);
    expect((await fs.lstat(filename)).isSymbolicLink()).toBe(true); expect(await fs.readFile(target)).toEqual(before); noForeignProbes(f);
  });
});
