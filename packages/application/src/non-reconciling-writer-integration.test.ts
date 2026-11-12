import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ok, type Result } from '@lnwjud/domain';
import { permissionProfiles } from '@lnwjud/permissions';
import type { ManagedProcess, ProcessManager, WindowsNativeAuthority } from '@lnwjud/process';
import type { Workspace, WorkspaceRepository } from '@lnwjud/workspace';
import { DurableShellTaskStore, type DurableShellLaunchRequest } from '../../capabilities/src/durable-shell-task-store.js';
import { SharedManagedWriterAdmission } from '../../capabilities/src/shared-managed-writer-admission.js';
import { SqliteWorkspaceWriterLease } from '../../capabilities/src/workspace-writer-lease.js';
import { CodexService, type CodexAdapterPort } from './codex-service.js';
import { FileService } from './file-service.js';
import { GitService } from './git-service.js';
import { ProcessService, type ProcessManagerPort } from './process-service.js';

// Never invoke Git, Codex, a durable worker, a PID probe, or a native helper.
// Mocks are at execution boundaries, not at the admission/services under test.
const subprocess = vi.hoisted(() => ({
  spawn: vi.fn((): never => { throw new Error('OFFLINE_WORKER_BOUNDARY'); }),
  execFile: vi.fn((): never => { throw new Error('OFFLINE_PID_PROBE_FORBIDDEN'); }),
}));
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(), ...subprocess,
}));

const roots: string[] = [];
const actor = { clientId: 'new-client', clientName: 'offline-test', sessionId: 'new-session' };
const authorization = { mode: 'standard', applicationApproved: true, bypassApplicationAuthorization: false, source: 'host_approval' } as const;
const foreignPid = 2_000_000_001;
const foreignTaskId = 'unrelated-durable-task';
const timestamp = '2020-01-01T00:00:00.000Z';
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');

type WriterFamily = 'file' | 'git' | 'process' | 'codex';
type MarkerKind = 'synchronous_mutation' | 'opaque_contained_process' | 'opaque' | 'repository_import';

beforeEach(() => {
  subprocess.spawn.mockClear();
  subprocess.execFile.mockClear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

async function fixture(): Promise<{
  root: string; tasks: string; active: string; workspace: Workspace; repository: WorkspaceRepository;
  admission: SharedManagedWriterAdmission; authority: WindowsNativeAuthority;
  inspect: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn>;
}> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'non-reconciling-writers-')));
  roots.push(root);
  const workspaceRoot = path.join(root, 'workspace');
  await mkdir(workspaceRoot);
  const workspace: Workspace = { id: 'workspace', displayName: 'Offline fixture', rootPath: workspaceRoot, realRootPath: workspaceRoot, createdAt: timestamp };
  const repository: WorkspaceRepository = {
    async list(): Promise<Workspace[]> { return [workspace]; },
    async get(id): Promise<Workspace | null> { return id === workspace.id ? workspace : null; },
    async insert(): Promise<void> {}, async delete(): Promise<void> {},
  };
  const inspect = vi.fn(async (): Promise<{ state: 'launch_not_started' }> => ({ state: 'launch_not_started' }));
  const abort = vi.fn(async (): Promise<{ state: 'launch_not_started' }> => ({ state: 'launch_not_started' }));
  const authority = { inspect, abortBeforeLaunch: abort } as unknown as WindowsNativeAuthority;
  const tasks = path.join(root, 'background-tasks');
  // Force the admission policy to Linux so these offline tests also run on macOS.
  // Windows application services can still pass fully bound contained requests.
  const admission = new SharedManagedWriterAdmission(tasks, authority, 'linux');
  return { root, tasks, active: path.join(tasks, '.index', 'v1', 'active'), workspace, repository, admission, authority, inspect, abort };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function initializeFixture(f: Fixture): Promise<void> {
  const probe = await f.admission.holdExclusiveProbe(f.workspace.id);
  expect(probe.ok).toBe(true);
  if (!probe.ok) throw new Error('Fresh fixture admission failed');
  await probe.value.releaseAfterVerifiedTermination();
}

async function seedMarker(f: Fixture, kind: MarkerKind, taskId = kind === 'opaque' ? foreignTaskId : 'foreign-' + kind): Promise<string> {
  const requestDigest = hash(taskId);
  const nativeTaskId = randomUUID();
  const marker = {
    version: 2, taskId, requestDigest, mutationKind: kind,
    capacityClass: kind === 'opaque' ? 'durable_shell' : 'managed_writer',
    ownerClientId: 'foreign-client', ownerWorkspaceId: 'foreign-workspace',
    reservedAt: timestamp, launcherPid: foreignPid, launcherStartedAt: timestamp,
    ...(kind !== 'opaque_contained_process' ? {} : {
      nativeReceiptPath: path.join(f.root, 'native', nativeTaskId, 'containment.receipt.json'),
      nativeBinding: { taskId: nativeTaskId, reservationId: taskId, attemptId: randomUUID(), generation: 1, requestDigest,
        ownerClientId: 'foreign-client', ownerSessionId: 'foreign-session', workspaceId: 'foreign-workspace' },
    }),
  };
  const filename = path.join(f.active, hash(taskId) + '.json');
  // Non-canonical whitespace catches a rewrite as well as deletion.
  await writeFile(filename, JSON.stringify(marker, null, 3) + '\n');
  if (kind === 'opaque') {
    await mkdir(path.join(f.tasks, taskId));
    await writeFile(path.join(f.tasks, taskId, 'task.json'), JSON.stringify({
      version: 2, task_id: taskId, request_digest: requestDigest, state: 'completed',
      containment: 'posix_group_v1', posix_launch_not_started: true, exit_code: 0,
      started_at: timestamp, finished_at: timestamp, deadline_at: timestamp,
      include_stdout: true, include_stderr: true, max_output_bytes: 4096,
      owner_client_id: 'foreign-client', owner_session_id: 'foreign-session', owner_workspace_id: 'foreign-workspace',
    }, null, 3) + '\n');
    await writeFile(path.join(f.tasks, taskId, 'stdout.log'), 'unrelated stdout\n');
  }
  return filename;
}

async function captureForeignBytes(f: Fixture): Promise<Map<string, Buffer>> {
  const filenames = (await readdir(f.active)).map((name) => path.join(f.active, name));
  filenames.push(path.join(f.tasks, '.index', 'v1', 'ready.json'));
  try {
    for (const name of await readdir(path.join(f.tasks, foreignTaskId))) filenames.push(path.join(f.tasks, foreignTaskId, name));
  } catch { /* The native and synchronous fixtures have no task sidecar. */ }
  return new Map(await Promise.all(filenames.map(async (name): Promise<[string, Buffer]> => [name, await readFile(name)])));
}

async function expectUnchanged(before: Map<string, Buffer>): Promise<void> {
  for (const [filename, bytes] of before) expect(await readFile(filename), filename).toEqual(bytes);
}

function observeReconciliation(): {
  taskInspection: MockInstance<DurableShellTaskStore['inspectForWriterAdmission']>;
  kill: MockInstance<typeof process.kill>;
} {
  const taskInspection = vi.spyOn(DurableShellTaskStore.prototype, 'inspectForWriterAdmission');
  const kill = vi.spyOn(process, 'kill').mockImplementation((): never => {
    throw Object.assign(new Error('Fixture owner is gone'), { code: 'ESRCH' });
  });
  return { taskInspection, kill };
}

function expectNoForeignReconciliation(f: Fixture, observed: ReturnType<typeof observeReconciliation>): void {
  expect(observed.taskInspection).not.toHaveBeenCalled();
  expect(observed.kill).not.toHaveBeenCalled();
  expect(subprocess.execFile).not.toHaveBeenCalled();
  for (const method of [f.inspect, f.abort]) {
    expect(method.mock.calls.filter((args) => (args[0] as { binding?: { ownerClientId?: string } } | undefined)?.binding?.ownerClientId === 'foreign-client')).toEqual([]);
  }
}

function executionFixture(f: Fixture): {
  processManager: ProcessManagerPort; adapter: CodexAdapterPort; starts: ReturnType<typeof vi.fn>;
} {
  const handle: ManagedProcess = { processId: randomUUID(), executable: 'offline-command', args: [], cwd: f.workspace.realRootPath, state: 'exited', exitCode: 0, startedAt: timestamp };
  const starts = vi.fn(async (): Promise<void> => {
    // A real on-disk own reservation must exist before the execution seam runs.
    const markers = await Promise.all((await readdir(f.active)).map(async (name): Promise<{ ownerClientId: string }> => JSON.parse(await readFile(path.join(f.active, name), 'utf8'))));
    expect(markers.filter((marker) => marker.ownerClientId === actor.clientId)).toHaveLength(1);
  });
  const processManager: ProcessManagerPort = {
    async start(_spec, _signal, onCreated, onVerifiedTermination): Promise<Result<ManagedProcess>> {
      await starts(); onCreated?.(handle); await onVerifiedTermination?.(); return ok(handle);
    },
    status(): Result<ManagedProcess> { return ok(handle); },
    logs(): ReturnType<ProcessManagerPort['logs']> { return ok({ entries: [], truncated: false, nextSequence: 1 }); },
    async stop(): Promise<Result<void>> { return ok(undefined); },
  };
  const adapter: CodexAdapterPort = {
    async status(): ReturnType<CodexAdapterPort['status']> { return ok({ installed: true, version: 'offline', capabilities: [] }); },
    async start(_cwd, _instruction, _signal, onCreated, _sandbox, _containment, onVerifiedTermination): Promise<Result<ManagedProcess>> {
      await starts(); onCreated?.(handle); await onVerifiedTermination?.(); return ok(handle);
    },
    statusProcess: processManager.status, logs: processManager.logs, stop: processManager.stop,
  };
  return { processManager, adapter, starts };
}

async function runWriter(family: WriterFamily, f: Fixture, approved = true): Promise<{ result: Result<unknown>; starts: ReturnType<typeof vi.fn> }> {
  const execution = executionFixture(f);
  const common = { writerAdmission: f.admission, nativeContainmentRoot: path.join(f.root, 'native'), nativeAuthority: f.authority };
  const auth = approved ? authorization : undefined;
  let result: Result<unknown>;
  if (family === 'file') {
    result = await new FileService(f.repository, undefined, undefined, { writerAdmission: f.admission, profile: approved ? permissionProfiles.full : permissionProfiles.safe })
      .writeFile(actor, f.workspace.id, { path: 'new.txt', content: 'new work', mode: 'create_new' }, undefined, auth);
  } else if (family === 'git') {
    result = await new GitService(f.repository, undefined, undefined, { ...common, processManager: execution.processManager as ProcessManager })
      .run(actor, { workspaceId: f.workspace.id, args: ['init'] }, undefined, auth);
  } else if (family === 'process') {
    result = await new ProcessService(f.repository, { ...common, processManager: execution.processManager })
      .start(actor, f.workspace.id, { executable: 'custom-offline-command', args: [] }, undefined, auth);
  } else {
    result = await new CodexService(f.repository, { ...common, adapter: execution.adapter })
      .run(actor, f.workspace.id, 'offline fixture only', undefined, false, auth);
  }
  return { result, starts: execution.starts };
}

async function durableFixture(f: Fixture, maxConcurrentTasks = 16): Promise<{ store: DurableShellTaskStore; request: DurableShellLaunchRequest }> {
  const runtime = path.join(f.root, 'offline-posix-runtime.mjs');
  await writeFile(runtime, '// Offline integrity fixture. Never imported or executed.\n');
  return {
    store: new DurableShellTaskStore(f.tasks, { maxConcurrentTasks, platform: 'linux', posixProcessRuntime: { modulePath: runtime, sha256: hash(await readFile(runtime, 'utf8')) } }),
    request: { taskId: 'new-durable-task', executable: 'never-executed', arguments: [], cwd: f.workspace.realRootPath,
      timeoutSeconds: 60, maxOutputBytes: 4096, includeStdout: true, includeStderr: true,
      owner: { clientId: actor.clientId, sessionId: actor.sessionId, workspaceId: f.workspace.id } },
  };
}

describe('new writer admission does not reconcile unrelated tasks', () => {
  it.each(['synchronous_mutation', 'opaque_contained_process', 'opaque'] as const)('workspace lease acquisition refuses a held %s marker without probing or rewriting it', async (kind) => {
    const f = await fixture(); await initializeFixture(f); await seedMarker(f, kind);
    const before = await captureForeignBytes(f); const observed = observeReconciliation();
    const lease = new SqliteWorkspaceWriterLease(path.join(f.root, 'leases.sqlite'), Date.now, f.admission);
    expect(await lease.acquire(f.workspace.id, actor.clientId, actor.sessionId, 60)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    await expectUnchanged(before); expect(await readdir(f.active)).toHaveLength(1);
    expectNoForeignReconciliation(f, observed); expect(f.inspect).not.toHaveBeenCalled(); expect(f.abort).not.toHaveBeenCalled();
  });

  it.each(['file', 'git', 'process', 'codex'] as const)('%s writes through real admission and preserves all unrelated holders', async (family) => {
    const f = await fixture(); await initializeFixture(f);
    for (const kind of ['synchronous_mutation', 'opaque_contained_process', 'opaque'] as const) await seedMarker(f, kind);
    const before = await captureForeignBytes(f); const observed = observeReconciliation();
    const { result, starts } = await runWriter(family, f);
    expect(result).toMatchObject({ ok: true });
    if (family === 'file') expect(await readFile(path.join(f.workspace.realRootPath, 'new.txt'), 'utf8')).toBe('new work');
    else expect(starts).toHaveBeenCalledOnce();
    await expectUnchanged(before); expect(await readdir(f.active)).toHaveLength(3);
    expectNoForeignReconciliation(f, observed); expect(subprocess.spawn).not.toHaveBeenCalled();
  });

  it.each(['file', 'git', 'process', 'codex'] as const)('%s still refuses an existing exclusive import reservation', async (family) => {
    const f = await fixture(); await initializeFixture(f); await seedMarker(f, 'repository_import');
    const before = await captureForeignBytes(f); const observed = observeReconciliation();
    const { result, starts } = await runWriter(family, f);
    expect(result).toMatchObject({ ok: false, error: { code: 'CONFLICT' } }); expect(starts).not.toHaveBeenCalled();
    await expect(readFile(path.join(f.workspace.realRootPath, 'new.txt'))).rejects.toThrow();
    await expectUnchanged(before); expect(await readdir(f.active)).toHaveLength(1); expectNoForeignReconciliation(f, observed);
  });

  it.each(['file', 'git', 'process', 'codex'] as const)('%s permission checks remain enforced without affecting unrelated holders', async (family) => {
    const f = await fixture(); await initializeFixture(f); await seedMarker(f, 'synchronous_mutation');
    const before = await captureForeignBytes(f); const enter = vi.spyOn(f.admission, 'enter');
    const { result, starts } = await runWriter(family, f, false);
    expect(result).toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    expect(enter).toHaveBeenCalledTimes(family === 'file' ? 1 : 0);
    expect(starts).not.toHaveBeenCalled();
    await expect(readFile(path.join(f.workspace.realRootPath, 'new.txt'))).rejects.toThrow();
    await expectUnchanged(before); expect(await readdir(f.active)).toHaveLength(1);
  });

  it.each(['corrupt', 'legacy', 'unready'] as const)('lease and every ordinary writer fail closed on a %s index without repairing it', async (state) => {
    const f = await fixture(); await initializeFixture(f);
    const markerPath = await seedMarker(f, 'synchronous_mutation');
    if (state === 'corrupt') await writeFile(markerPath, '{broken evidence\n');
    if (state === 'legacy') {
      const marker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>;
      await writeFile(markerPath, JSON.stringify({ ...marker, version: 1 }));
    }
    if (state === 'unready') await writeFile(path.join(f.tasks, '.index', 'v1', 'ready.json'), '{unready evidence\n');
    const before = await captureForeignBytes(f); const observed = observeReconciliation();
    const lease = new SqliteWorkspaceWriterLease(path.join(f.root, 'leases.sqlite'), Date.now, f.admission);
    expect(await lease.acquire(f.workspace.id, actor.clientId, actor.sessionId, 60)).toMatchObject({ ok: false });
    for (const family of ['file', 'git', 'process', 'codex'] as const) {
      const { result, starts } = await runWriter(family, f);
      expect(result).toMatchObject({ ok: false }); expect(starts).not.toHaveBeenCalled();
    }
    await expectUnchanged(before); expect(await readdir(f.active)).toHaveLength(1); expectNoForeignReconciliation(f, observed);
  });

  it.each(['process', 'codex'] as const)('%s keeps session ownership checks after non-reconciling admission', async (family) => {
    const f = await fixture(); await initializeFixture(f); await seedMarker(f, 'synchronous_mutation');
    const before = await captureForeignBytes(f); const observed = observeReconciliation();
    const execution = executionFixture(f);
    const common = { writerAdmission: f.admission, nativeContainmentRoot: path.join(f.root, 'native'), nativeAuthority: f.authority };
    const otherSession = { ...actor, sessionId: 'different-session' };
    if (family === 'process') {
      const service = new ProcessService(f.repository, { ...common, processManager: execution.processManager });
      const started = await service.start(actor, f.workspace.id, { executable: 'custom-offline-command', args: [] }, undefined, authorization);
      expect(started.ok).toBe(true); if (!started.ok) throw new Error('Expected offline process admission');
      expect(await service.status(otherSession, f.workspace.id, started.value.processId)).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
      expect(await service.status(actor, f.workspace.id, started.value.processId)).toMatchObject({ ok: true });
    } else {
      const service = new CodexService(f.repository, { ...common, adapter: execution.adapter });
      const started = await service.run(actor, f.workspace.id, 'offline only', undefined, false, authorization);
      expect(started.ok).toBe(true); if (!started.ok) throw new Error('Expected offline Codex admission');
      expect(await service.taskStatus(otherSession, f.workspace.id, started.value.codexTaskId)).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
      expect(await service.taskStatus(actor, f.workspace.id, started.value.codexTaskId)).toMatchObject({ ok: true });
    }
    await expectUnchanged(before); expect(await readdir(f.active)).toHaveLength(1); expectNoForeignReconciliation(f, observed);
  });

  it('fresh lease acquisition bootstraps an empty root and retains owner, session, and proof enforcement', async () => {
    const f = await fixture(); const observed = observeReconciliation();
    const lease = new SqliteWorkspaceWriterLease(path.join(f.root, 'leases.sqlite'), Date.now, f.admission);
    const acquired = await lease.acquire(f.workspace.id, actor.clientId, actor.sessionId, 60);
    expect(acquired.ok).toBe(true); if (!acquired.ok) throw new Error('Expected initial lease');
    expect(await readdir(f.active)).toEqual([]);
    expect(await lease.acquire(f.workspace.id, 'other-client', 'other-session', 60)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await lease.begin(f.workspace.id, actor.clientId, 'other-session', 'wrong-session', acquired.value)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await lease.begin(f.workspace.id, actor.clientId, actor.sessionId, 'missing-proof')).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await lease.begin(f.workspace.id, actor.clientId, actor.sessionId, 'own-call', acquired.value)).toMatchObject({ ok: true, value: { required: true } });
    await lease.end(f.workspace.id, 'own-call', acquired.value.generation);
    expect(await lease.release(f.workspace.id, actor.clientId, 'other-session', acquired.value)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await lease.release(f.workspace.id, actor.clientId, actor.sessionId, acquired.value)).toMatchObject({ ok: true });
    expectNoForeignReconciliation(f, observed);
  });

  it('durable-shell capacity counts a held terminal-looking reservation rather than reclaiming it', async () => {
    const f = await fixture(); await initializeFixture(f); await seedMarker(f, 'opaque');
    const before = await captureForeignBytes(f); const observed = observeReconciliation();
    const { store, request } = await durableFixture(f, 1);
    expect(await store.launch(request)).toMatchObject({ ok: false, error: { code: 'CONFLICT', details: { durable_shell_reservations: 1 } } });
    expect(subprocess.spawn).not.toHaveBeenCalled(); await expectUnchanged(before); expectNoForeignReconciliation(f, observed);
  });

  it.each(['synchronous_mutation', 'opaque_contained_process', 'opaque'] as const)('repository-import launch refuses a held %s marker before any process can start', async (kind) => {
    const f = await fixture(); await initializeFixture(f); await seedMarker(f, kind);
    const before = await captureForeignBytes(f); const observed = observeReconciliation();
    const { store, request } = await durableFixture(f);
    expect(await store.launch({ ...request, mutationKind: 'repository_import' })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(subprocess.spawn).not.toHaveBeenCalled(); await expectUnchanged(before); expectNoForeignReconciliation(f, observed);
  });

  it('durable-shell launch cannot claim a task owned by a different session or client', async () => {
    const f = await fixture(); await initializeFixture(f); await seedMarker(f, 'opaque');
    const before = await captureForeignBytes(f); const observed = observeReconciliation();
    const { store, request } = await durableFixture(f);
    for (const owner of [request.owner, { clientId: 'foreign-client', sessionId: 'different-session', workspaceId: 'foreign-workspace' }]) {
      expect(await store.launch({ ...request, taskId: foreignTaskId, owner })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    }
    expect(subprocess.spawn).not.toHaveBeenCalled(); await expectUnchanged(before); expectNoForeignReconciliation(f, observed);
  });

  it('a new durable-shell launch reaches only its own execution seam and preserves unrelated native and PID evidence', async () => {
    const f = await fixture(); await initializeFixture(f);
    for (const kind of ['synchronous_mutation', 'opaque_contained_process', 'opaque'] as const) await seedMarker(f, kind);
    const before = await captureForeignBytes(f); const observed = observeReconciliation();
    const { store, request } = await durableFixture(f, 2);
    // Deliberate local spawn failure proves admission happened, with no subprocess.
    expect(await store.launch(request)).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Durable task could not start' } });
    expect(subprocess.spawn).toHaveBeenCalledOnce();
    await expectUnchanged(before); expect(await readdir(f.active)).toHaveLength(3); expectNoForeignReconciliation(f, observed);
    const journal = await readFile(path.join(f.tasks, '.index', 'v1', 'launches.jsonl'), 'utf8');
    expect(JSON.parse(journal.trim())).toMatchObject({ taskId: request.taskId, ownerClientId: actor.clientId, ownerSessionId: actor.sessionId });
  });
});
