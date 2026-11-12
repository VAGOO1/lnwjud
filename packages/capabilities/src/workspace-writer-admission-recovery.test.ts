import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WindowsNativeAuthority, type NativeAttemptBinding, type WindowsContainmentRpcRequest, type WindowsContainmentServiceClient } from '@lnwjud/process';
import { DurableShellTaskStore, durableShellNativeBinding, type DurableTaskMetadata, type DurableShellTaskState } from './durable-shell-task-store.js';
import type { DurableShellTaskIndex } from './durable-shell-task-index.js';
import { SharedManagedWriterAdmission } from './shared-managed-writer-admission.js';
import { SqliteWorkspaceWriterLease } from './workspace-writer-lease.js';
import { ShellCapabilityBackend } from './shell-backend.js';
import type { CapabilityTaskOwner } from './task-ownership.js';

const temporaryRoots: string[] = [];
const WINDOWS_WRITER_IO_TEST_TIMEOUT_MS = process.platform === 'win32' ? 20_000 : 5_000;
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

interface MockAuthorityContext {
  readonly authority: WindowsNativeAuthority;
  readonly setPhase: (phase: number, details?: { outcome?: number; exitCode?: number; targetPid?: number; reason?: string }) => void;
  readonly setAttemptLost: (lost: boolean) => void;
  readonly getCancelledAttempts: () => readonly string[];
  readonly getRequests: () => readonly WindowsContainmentRpcRequest[];
}

function createMockAuthority(root: string): MockAuthorityContext {
  let currentPhase = 4;
  let currentOutcome = 0;
  let currentExitCode = 0;
  let currentTargetPid = 12345;
  let currentReason: string | undefined;
  let attemptLost = false;
  const cancelled: string[] = [];
  const requests: WindowsContainmentRpcRequest[] = [];

  const client: WindowsContainmentServiceClient = {
    async request<T>(request: WindowsContainmentRpcRequest): Promise<T> {
      requests.push(request);
      if (request.command === 'cancel') {
        cancelled.push(request.identity.attemptId);
        currentPhase = 4;
        currentOutcome = 1; // cancelled
        currentExitCode = -1;
        return { identity: request.identity, phase: 4, outcome: 1, exitCode: -1, activeProcesses: 0, reservationHeld: false } as T;
      }
      if (request.command === 'abort') {
        if (attemptLost) {
          attemptLost = false;
          currentPhase = 2; // service creates tombstone with LaunchNotStarted
          return { identity: request.identity, phase: 2, reservationHeld: false } as T;
        }
        if (currentPhase === 3 || currentPhase === 5) {
          return { identity: request.identity, phase: currentPhase, reason: currentReason ?? 'unverified', reservationHeld: true } as T;
        }
        currentPhase = 2;
        return { identity: request.identity, phase: 2, reservationHeld: false } as T;
      }
      if (request.command === 'inspect') {
        if (attemptLost) {
          throw new Error('SERVICE_OWNER_MISMATCH');
        }
        if (currentPhase === 0) {
          return { identity: request.identity, phase: 0, reservationHeld: true } as T;
        }
        if (currentPhase === 3) {
          return { identity: request.identity, phase: 3, targetPid: currentTargetPid } as T;
        }
        if (currentPhase === 4) {
          return { identity: request.identity, phase: 4, outcome: currentOutcome, exitCode: currentExitCode, activeProcesses: 0, reservationHeld: false } as T;
        }
        if (currentPhase === 5) {
          return { identity: request.identity, phase: 5, reason: currentReason ?? 'unverified', reservationHeld: true } as T;
        }
        return { identity: request.identity, phase: 2, reservationHeld: false } as T;
      }
      return { identity: request.identity, phase: currentPhase } as T;
    },
    async startWatcher(): Promise<void> {
      // test harness mock
    },
  };

  const authority = new WindowsNativeAuthority({
    helper: { executable: path.join(root, 'mock-helper.exe'), sha256: 'a'.repeat(64), buildId: 'lnwjud-containment-v2' },
    pin: { modulePath: path.join(root, 'mock-pin.node'), sha256: 'a'.repeat(64) },
    profileDirectory: path.join(root, 'profile'),
  }, client);

  return {
    authority,
    setPhase: (phase: number, details?: { outcome?: number; exitCode?: number; targetPid?: number; reason?: string }): void => {
      currentPhase = phase;
      if (details?.outcome !== undefined) currentOutcome = details.outcome;
      if (details?.exitCode !== undefined) currentExitCode = details.exitCode;
      if (details?.targetPid !== undefined) currentTargetPid = details.targetPid;
      if (details?.reason !== undefined) currentReason = details.reason;
    },
    setAttemptLost: (lost: boolean): void => {
      attemptLost = lost;
    },
    getCancelledAttempts: () => [...cancelled],
    getRequests: () => [...requests],
  };
}

function makeCanonicalMetadata(input: {
  taskId: string;
  clientId: string;
  sessionId: string;
  workspaceId: string;
  state: DurableShellTaskState;
  binding?: NativeAttemptBinding;
  exitCode?: number;
  workerPid?: number;
}): DurableTaskMetadata {
  const startedAt = new Date(10_000).toISOString();
  const isTerm = input.state === 'completed' || input.state === 'failed' || input.state === 'cancelled' || input.state === 'timed_out';
  return {
    version: 1,
    task_id: input.taskId,
    state: input.state,
    started_at: startedAt,
    ...(isTerm ? { finished_at: new Date(15_000).toISOString() } : {}),
    deadline_at: new Date(100_000).toISOString(),
    executable: 'node.exe',
    arguments: ['-e', '1'],
    cwd: 'C:\\test',
    timeout_seconds: 30,
    max_output_bytes: 1024,
    include_stdout: true,
    include_stderr: true,
    owner_client_id: input.clientId,
    owner_session_id: input.sessionId,
    owner_workspace_id: input.workspaceId,
    request_digest: input.binding?.requestDigest ?? createHash('sha256').update(input.taskId).digest('hex'),
    exit_code: input.exitCode,
    worker_pid: input.workerPid ?? 99999999,
    worker_started_at: startedAt,
    ...(input.binding === undefined ? {} : { containment: 'windows_job_v2', containmentBinding: input.binding }),
  };
}

interface FixtureContext {
  readonly root: string;
  readonly taskDirectory: string;
  readonly mock: MockAuthorityContext;
  readonly admission: SharedManagedWriterAdmission;
  readonly lease: SqliteWorkspaceWriterLease;
  readonly store: DurableShellTaskStore;
  readonly index: DurableShellTaskIndex;
  readonly backend: ShellCapabilityBackend;
  readonly advanceTime: (ms: number) => void;
  readonly getTime: () => number;
}

async function fixture(currentTime = 10_000): Promise<FixtureContext> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-admission-recovery-'));
  temporaryRoots.push(root);
  const taskDirectory = path.join(root, 'tasks');
  const dbPath = path.join(root, 'leases.sqlite');
  let now = currentTime;
  const nowProvider = (): number => now;

  const mock = createMockAuthority(root);
  // Exercise mocked Windows containment consistently on every test host.
  const admission = new SharedManagedWriterAdmission(taskDirectory, mock.authority, 'win32');
  const lease = new SqliteWorkspaceWriterLease(dbPath, nowProvider, admission);
  const store = new DurableShellTaskStore(taskDirectory, { windowsNativeAuthority: mock.authority });
  const index = (store as unknown as { activeIndex: DurableShellTaskIndex }).activeIndex;
  // Initialize empty storage before installing artificial task evidence. Admission
  // must not bootstrap or reconcile a nonempty, uninitialized task root.
  await index.initialize();
  const backend = new ShellCapabilityBackend({
    allowedRoots: [root],
    taskStateDirectory: taskDirectory,
    windowsNativeAuthority: mock.authority,
  });

  return {
    root,
    taskDirectory,
    mock,
    admission,
    lease,
    store,
    index,
    backend,
    advanceTime: (ms: number): void => { now += ms; },
    getTime: (): number => now,
  };
}

describe('Mandatory Regression Suite: Writer Admission & Task Recovery Lifecycle', () => {
  it('1. Expired Lease + Terminal Reservation: requires explicit owner status before lease recovery', async () => {
    const f = await fixture(10_000);
    const workspaceId = 'workspace-1';
    const clientId = 'client-1';

    const initial = await f.lease.acquire(workspaceId, clientId, 'session-1', 30);
    expect(initial.ok).toBe(true);

    f.mock.setPhase(4, { outcome: 0, exitCode: 0 }); // completed
    const taskId = randomUUID();
    const digest = createHash('sha256').update(taskId).digest('hex');
    const binding = durableShellNativeBinding({
      taskId,
      executable: 'node.exe',
      arguments: ['-e', '1'],
      cwd: f.root,
      timeoutSeconds: 30,
      maxOutputBytes: 1024,
      includeStdout: true,
      includeStderr: true,
      owner: { clientId, sessionId: 'session-1', workspaceId },
    }, digest);

    const taskDir = path.join(f.taskDirectory, taskId);
    await mkdir(taskDir, { recursive: true });
    const metadata = makeCanonicalMetadata({
      taskId,
      clientId,
      sessionId: 'session-1',
      workspaceId,
      state: 'completed',
      exitCode: 0,
      binding,
      workerPid: 99999999,
    });
    await writeFile(path.join(taskDir, 'task.json'), JSON.stringify(metadata));

    expect(await f.index.reserve({
      taskId,
      capacityClass: 'durable_shell',
      requestDigest: digest,
      mutationKind: 'opaque',
      nativeBinding: binding,
      nativeReceiptPath: path.join(taskDir, 'containment.receipt.json'),
      ownerClientId: clientId,
      ownerWorkspaceId: workspaceId,
    })).toMatchObject({ ok: true, value: { created: true } });

    f.advanceTime(35_000); // Expire lease

    expect(await f.lease.acquire(workspaceId, clientId, 'session-2', 60, true)).toMatchObject({
      ok: false, error: { code: 'CONFLICT' },
    });
    expect(f.mock.getRequests()).toEqual([]);
    expect(await f.index.hasReservation(taskId, digest)).toBe(true);
    expect(await readFile(path.join(taskDir, 'task.json'), 'utf8')).toBe(JSON.stringify(metadata));

    expect(await f.store.snapshot(taskId, undefined, { clientId, sessionId: 'session-2', workspaceId }))
      .toMatchObject({ ok: true, value: { state: 'completed', exit_code: 0 } });
    expect(await f.index.hasReservation(taskId, digest)).toBe(false);
    expect(f.mock.getRequests().length).toBeGreaterThan(0);
    expect(f.mock.getRequests().every((request) => request.command === 'inspect' && request.identity.attemptId === binding.attemptId)).toBe(true);
    const requestsAfterRecovery = f.mock.getRequests();

    const recovered = await f.lease.acquire(workspaceId, clientId, 'session-2', 60, true);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.value.generation).toBe(initial.ok ? initial.value.generation + 1 : 2);
    expect(f.mock.getRequests()).toEqual(requestsAfterRecovery);
  }, WINDOWS_WRITER_IO_TEST_TIMEOUT_MS);

  it('2. Expired Lease + Active Worker: refuses lease takeover while worker is running', async () => {
    const f = await fixture(10_000);
    const workspaceId = 'workspace-1';
    const clientId = 'client-1';

    const initial = await f.lease.acquire(workspaceId, clientId, 'session-1', 30);
    expect(initial.ok).toBe(true);

    f.mock.setPhase(3, { targetPid: 12345 }); // running
    const taskId = randomUUID();
    const digest = createHash('sha256').update(taskId).digest('hex');
    const binding = durableShellNativeBinding({
      taskId,
      executable: 'node.exe',
      arguments: ['-e', '1'],
      cwd: f.root,
      timeoutSeconds: 30,
      maxOutputBytes: 1024,
      includeStdout: true,
      includeStderr: true,
      owner: { clientId, sessionId: 'session-1', workspaceId },
    }, digest);

    const taskDir = path.join(f.taskDirectory, taskId);
    await mkdir(taskDir, { recursive: true });
    const metadata = makeCanonicalMetadata({
      taskId,
      clientId,
      sessionId: 'session-1',
      workspaceId,
      state: 'running',
      binding,
      workerPid: 12345,
    });
    await writeFile(path.join(taskDir, 'task.json'), JSON.stringify(metadata));

    expect(await f.index.reserve({
      taskId,
      capacityClass: 'durable_shell',
      requestDigest: digest,
      mutationKind: 'opaque',
      nativeBinding: binding,
      nativeReceiptPath: path.join(taskDir, 'containment.receipt.json'),
      ownerClientId: clientId,
      ownerWorkspaceId: workspaceId,
    })).toMatchObject({ ok: true, value: { created: true } });

    f.advanceTime(35_000);

    const attempt = await f.lease.acquire(workspaceId, clientId, 'session-2', 60, true);
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) {
      expect(attempt.error.code).toBe('CONFLICT');
      expect(attempt.error.details).toMatchObject({ blocker_state: 'held', recovery_requirement: 'explicit_owner_scoped_recovery' });
    }
    expect(f.mock.getRequests()).toEqual([]);
    expect(await f.index.hasReservation(taskId, digest)).toBe(true);
    expect(await readFile(path.join(taskDir, 'task.json'), 'utf8')).toBe(JSON.stringify(metadata));
  }, WINDOWS_WRITER_IO_TEST_TIMEOUT_MS);

  it('3. Expired Lease + Unknown Worker: refuses lease takeover without verified proof', async () => {
    const f = await fixture(10_000);
    const workspaceId = 'workspace-1';
    const clientId = 'client-1';

    await f.lease.acquire(workspaceId, clientId, 'session-1', 30);

    f.mock.setPhase(5, { reason: 'unverified' });
    const taskId = randomUUID();
    const digest = createHash('sha256').update(taskId).digest('hex');
    const binding = durableShellNativeBinding({
      taskId,
      executable: 'node.exe',
      arguments: ['-e', '1'],
      cwd: f.root,
      timeoutSeconds: 30,
      maxOutputBytes: 1024,
      includeStdout: true,
      includeStderr: true,
      owner: { clientId, sessionId: 'session-1', workspaceId },
    }, digest);

    const taskDir = path.join(f.taskDirectory, taskId);
    await mkdir(taskDir, { recursive: true });
    const metadata = makeCanonicalMetadata({
      taskId,
      clientId,
      sessionId: 'session-1',
      workspaceId,
      state: 'termination_unverified',
      binding,
      workerPid: 99999999,
    });
    await writeFile(path.join(taskDir, 'task.json'), JSON.stringify(metadata));

    expect(await f.index.reserve({
      taskId,
      capacityClass: 'durable_shell',
      requestDigest: digest,
      mutationKind: 'opaque',
      nativeBinding: binding,
      nativeReceiptPath: path.join(taskDir, 'containment.receipt.json'),
      ownerClientId: clientId,
      ownerWorkspaceId: workspaceId,
    })).toMatchObject({ ok: true, value: { created: true } });

    f.advanceTime(35_000);

    const attempt = await f.lease.acquire(workspaceId, clientId, 'session-2', 60, true);
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) {
      expect(attempt.error.code).toBe('CONFLICT');
      // Admission reports the held marker, not an unperformed liveness probe.
      expect(attempt.error.details).toMatchObject({ blocker_state: 'held', recovery_requirement: 'explicit_owner_scoped_recovery' });
    }
    expect(f.mock.getRequests()).toEqual([]);
    expect(await f.index.hasReservation(taskId, digest)).toBe(true);
    expect(await readFile(path.join(taskDir, 'task.json'), 'utf8')).toBe(JSON.stringify(metadata));

    expect(await f.store.snapshot(taskId, undefined, { clientId, sessionId: 'session-2', workspaceId }))
      .toMatchObject({ ok: true, value: { state: 'termination_unverified' } });
    expect(await f.index.hasReservation(taskId, digest)).toBe(true);
    const requestsAfterRecovery = f.mock.getRequests();
    expect(requestsAfterRecovery.length).toBeGreaterThan(0);
    expect(requestsAfterRecovery.every((request) => request.identity.attemptId === binding.attemptId)).toBe(true);
    expect(await f.admission.holdExclusiveProbe(workspaceId)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(f.mock.getRequests()).toEqual(requestsAfterRecovery);
  }, WINDOWS_WRITER_IO_TEST_TIMEOUT_MS);

  it.each(['missing', 'corrupt'])('4. %s Task Metadata: safely blocks without silently dropping reservation', async (metadataState) => {
    const f = await fixture(10_000);
    const workspaceId = 'workspace-1';
    const clientId = 'client-1';

    const taskId = randomUUID();
    const digest = createHash('sha256').update(taskId).digest('hex');
    const taskDir = path.join(f.taskDirectory, taskId);
    await mkdir(taskDir, { recursive: true });
    if (metadataState === 'corrupt') await writeFile(path.join(taskDir, 'task.json'), 'CORRUPT_NOT_JSON');

    expect(await f.index.reserve({
      taskId,
      capacityClass: 'durable_shell',
      requestDigest: digest,
      mutationKind: 'opaque',
      ownerClientId: clientId,
      ownerWorkspaceId: workspaceId,
    })).toMatchObject({ ok: true, value: { created: true } });

    const probe = await f.admission.holdExclusiveProbe(workspaceId);
    expect(probe.ok).toBe(false);
    if (!probe.ok) {
      expect(probe.error.code).toBe('CONFLICT');
    }
    expect(f.mock.getRequests()).toEqual([]);
    expect(await f.index.hasReservation(taskId, digest)).toBe(true);
  });

  it('5. Cross-Session Recovery: allows same client to inspect and cancel across sessions', async () => {
    const f = await fixture(10_000);
    const workspaceId = 'workspace-1';
    const clientId = 'client-1';
    const taskId = randomUUID();
    const digest = createHash('sha256').update(taskId).digest('hex');

    const binding = durableShellNativeBinding({
      taskId,
      executable: 'node.exe',
      arguments: ['-e', '1'],
      cwd: f.root,
      timeoutSeconds: 30,
      maxOutputBytes: 1024,
      includeStdout: true,
      includeStderr: true,
      owner: { clientId, sessionId: 'session-1', workspaceId },
    }, digest);

    f.mock.setPhase(3, { targetPid: 4567 }); // running initially
    const taskDir = path.join(f.taskDirectory, taskId);
    await mkdir(taskDir, { recursive: true });
    const metadata = makeCanonicalMetadata({
      taskId,
      clientId,
      sessionId: 'session-1',
      workspaceId,
      state: 'running',
      binding,
      workerPid: 99999999,
    });
    await writeFile(path.join(taskDir, 'task.json'), JSON.stringify(metadata));

    expect(await f.index.reserve({
      taskId,
      capacityClass: 'durable_shell',
      requestDigest: digest,
      mutationKind: 'opaque',
      nativeBinding: binding,
      nativeReceiptPath: path.join(taskDir, 'containment.receipt.json'),
      ownerClientId: clientId,
      ownerWorkspaceId: workspaceId,
    })).toMatchObject({ ok: true, value: { created: true } });

    const session2Owner: CapabilityTaskOwner = { clientId, sessionId: 'session-2', workspaceId };
    expect(await f.admission.holdExclusiveProbe(workspaceId)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(f.mock.getRequests()).toEqual([]);
    expect(await f.index.hasReservation(taskId, digest)).toBe(true);
    const snapshot = await f.store.snapshot(taskId, undefined, session2Owner);
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(snapshot.value.task_id).toBe(taskId);
      expect(snapshot.value.state).toBe('running');
    }

    const list = await f.store.list(session2Owner);
    expect(list.some((t) => t.task_id === taskId)).toBe(true);

    const cancelled = await f.store.cancel(taskId, session2Owner);
    expect(cancelled.ok).toBe(true);
    if (cancelled.ok) {
      expect(cancelled.value.state).toBe('cancelled');
    }
    expect(f.mock.getCancelledAttempts()).toContain(binding.attemptId);
    expect(await f.index.hasReservation(taskId, digest)).toBe(false);
    expect(f.mock.getRequests().every((request) => request.identity.attemptId === binding.attemptId)).toBe(true);
    const requestsAfterCancellation = f.mock.getRequests();

    const probe = await f.admission.holdExclusiveProbe(workspaceId);
    expect(probe.ok).toBe(true);
    if (probe.ok) await probe.value.releaseAfterVerifiedTermination();
    expect(f.mock.getRequests()).toEqual(requestsAfterCancellation);
  }, WINDOWS_WRITER_IO_TEST_TIMEOUT_MS);

  it('6. Ownership Rejection: strictly rejects foreign client and foreign workspace', async () => {
    const f = await fixture(10_000);
    const taskId = randomUUID();
    const digest = createHash('sha256').update(taskId).digest('hex');

    const binding = durableShellNativeBinding({
      taskId,
      executable: 'node.exe',
      arguments: ['-e', '1'],
      cwd: f.root,
      timeoutSeconds: 30,
      maxOutputBytes: 1024,
      includeStdout: true,
      includeStderr: true,
      owner: { clientId: 'client-1', sessionId: 'session-1', workspaceId: 'workspace-1' },
    }, digest);

    const taskDir = path.join(f.taskDirectory, taskId);
    await mkdir(taskDir, { recursive: true });
    const metadata = makeCanonicalMetadata({
      taskId,
      clientId: 'client-1',
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      state: 'running',
      binding,
      workerPid: 99999999,
    });
    await writeFile(path.join(taskDir, 'task.json'), JSON.stringify(metadata));

    expect(await f.index.reserve({
      taskId,
      capacityClass: 'durable_shell',
      requestDigest: digest,
      mutationKind: 'opaque',
      nativeBinding: binding,
      nativeReceiptPath: path.join(taskDir, 'containment.receipt.json'),
      ownerClientId: 'client-1',
      ownerWorkspaceId: 'workspace-1',
    })).toMatchObject({ ok: true, value: { created: true } });

    const foreignClientOwner: CapabilityTaskOwner = { clientId: 'attacker-client', sessionId: 'session-1', workspaceId: 'workspace-1' };
    expect(await f.store.snapshot(taskId, undefined, foreignClientOwner)).toMatchObject({
      ok: false, error: { code: 'PERMISSION_DENIED' },
    });
    expect(await f.store.cancel(taskId, foreignClientOwner)).toMatchObject({
      ok: false, error: { code: 'PERMISSION_DENIED' },
    });
    const foreignList = await f.store.list(foreignClientOwner);
    expect(foreignList).toHaveLength(0);

    const foreignWorkspaceOwner: CapabilityTaskOwner = { clientId: 'client-1', sessionId: 'session-2', workspaceId: 'foreign-workspace' };
    expect(await f.store.snapshot(taskId, undefined, foreignWorkspaceOwner)).toMatchObject({
      ok: false, error: { code: 'PERMISSION_DENIED' },
    });
    expect(await f.store.cancel(taskId, foreignWorkspaceOwner)).toMatchObject({
      ok: false, error: { code: 'PERMISSION_DENIED' },
    });
    expect(f.mock.getRequests()).toEqual([]);
    expect(await f.index.hasReservation(taskId, digest)).toBe(true);
    expect(await readFile(path.join(taskDir, 'task.json'), 'utf8')).toBe(JSON.stringify(metadata));
  });

  it('7. Concurrent Recovery Race: guarantees fencing serialization and distinct generation', async () => {
    const f = await fixture(10_000);
    const workspaceId = 'workspace-1';

    const first = await f.lease.acquire(workspaceId, 'client-1', 'session-1', 30);
    expect(first.ok).toBe(true);

    f.advanceTime(35_000);

    const [raceA, raceB] = await Promise.all([
      f.lease.acquire(workspaceId, 'client-2', 'session-2', 30, true),
      f.lease.acquire(workspaceId, 'client-3', 'session-3', 30, true),
    ]);

    const winners = [raceA, raceB].filter((r) => r.ok);
    expect(winners.length).toBeGreaterThanOrEqual(1);
    if (raceA.ok && raceB.ok) {
      expect(raceA.value.generation).not.toBe(raceB.value.generation);
      expect(raceA.value.leaseToken).not.toBe(raceB.value.leaseToken);
    }
  }, WINDOWS_WRITER_IO_TEST_TIMEOUT_MS);

  it('8. Application Restart: state persists and recovers seamlessly on reopen', async () => {
    const f = await fixture(10_000);
    const workspaceId = 'workspace-1';
    const clientId = 'client-1';

    const acquired1 = await f.lease.acquire(workspaceId, clientId, 'session-1', 30);
    expect(acquired1.ok).toBe(true);

    f.advanceTime(35_000);

    const reopenedLease = new SqliteWorkspaceWriterLease(path.join(f.root, 'leases.sqlite'), f.getTime, f.admission);
    const inspected = await reopenedLease.inspect(workspaceId);
    expect(inspected.ok).toBe(true);
    if (inspected.ok) {
      expect(inspected.value.state).toBe('expired');
      expect(inspected.value.generation).toBe(1);
    }

    const acquired2 = await reopenedLease.acquire(workspaceId, clientId, 'session-restart', 60, true);
    expect(acquired2.ok).toBe(true);
    if (acquired2.ok) {
      expect(acquired2.value.generation).toBe(2);
    }
  }, WINDOWS_WRITER_IO_TEST_TIMEOUT_MS);

  it('9. Process Crash: explicit owner status releases only after verified native proof', async () => {
    const f = await fixture(10_000);
    const workspaceId = 'workspace-1';
    const clientId = 'client-1';
    const taskId = randomUUID();
    const digest = createHash('sha256').update(taskId).digest('hex');

    const binding = durableShellNativeBinding({
      taskId,
      executable: 'node.exe',
      arguments: ['-e', '1'],
      cwd: f.root,
      timeoutSeconds: 30,
      maxOutputBytes: 1024,
      includeStdout: true,
      includeStderr: true,
      owner: { clientId, sessionId: 'session-1', workspaceId },
    }, digest);

    f.mock.setPhase(4, { outcome: 0, exitCode: 1 }); // failed
    const taskDir = path.join(f.taskDirectory, taskId);
    await mkdir(taskDir, { recursive: true });
    const metadata = makeCanonicalMetadata({
      taskId,
      clientId,
      sessionId: 'session-1',
      workspaceId,
      state: 'running',
      binding,
      workerPid: 99999999, // gone
    });
    await writeFile(path.join(taskDir, 'task.json'), JSON.stringify(metadata));

    expect(await f.index.reserve({
      taskId,
      capacityClass: 'durable_shell',
      requestDigest: digest,
      mutationKind: 'opaque',
      nativeBinding: binding,
      nativeReceiptPath: path.join(taskDir, 'containment.receipt.json'),
      ownerClientId: clientId,
      ownerWorkspaceId: workspaceId,
    })).toMatchObject({ ok: true, value: { created: true } });

    expect(await f.admission.holdExclusiveProbe(workspaceId)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(f.mock.getRequests()).toEqual([]);
    expect(await f.index.hasReservation(taskId, digest)).toBe(true);
    expect(await readFile(path.join(taskDir, 'task.json'), 'utf8')).toBe(JSON.stringify(metadata));

    const snap = await f.store.snapshot(taskId, undefined, { clientId, sessionId: 'session-2', workspaceId });
    expect(snap.ok).toBe(true);
    if (snap.ok) {
      expect(snap.value.state).toBe('failed');
      expect(snap.value.exit_code).toBe(1);
    }
    expect(await f.index.hasReservation(taskId, digest)).toBe(false);
    expect(f.mock.getRequests().every((request) => request.command === 'inspect' && request.identity.attemptId === binding.attemptId)).toBe(true);
    const requestsAfterRecovery = f.mock.getRequests();

    const probe = await f.admission.holdExclusiveProbe(workspaceId);
    expect(probe.ok).toBe(true);
    if (probe.ok) await probe.value.releaseAfterVerifiedTermination();
    expect(f.mock.getRequests()).toEqual(requestsAfterRecovery);
  });

  it('10. Repository Import Conflict: exclusive repository import blocks and unblocks correctly', async () => {
    const f = await fixture(10_000);
    const workspaceId = 'workspace-1';

    const probe1 = await f.admission.holdExclusiveProbe(workspaceId);
    expect(probe1.ok).toBe(true);

    const probe2 = await f.admission.holdExclusiveProbe(workspaceId);
    expect(probe2.ok).toBe(false);

    if (probe1.ok) await probe1.value.releaseAfterVerifiedTermination();

    const probe3 = await f.admission.holdExclusiveProbe(workspaceId);
    expect(probe3.ok).toBe(true);
    if (probe3.ok) await probe3.value.releaseAfterVerifiedTermination();
  });

  it('11. Goal Resume: cancelForGoal recovers cross-session tasks for same client and workspace', async () => {
    const f = await fixture(10_000);
    const workspaceId = 'workspace-1';
    const clientId = 'client-1';
    const taskId = randomUUID();
    const digest = createHash('sha256').update(taskId).digest('hex');

    const binding = durableShellNativeBinding({
      taskId,
      executable: 'node.exe',
      arguments: ['-e', '1'],
      cwd: f.root,
      timeoutSeconds: 30,
      maxOutputBytes: 1024,
      includeStdout: true,
      includeStderr: true,
      owner: { clientId, sessionId: 'session-old', workspaceId },
    }, digest);

    f.mock.setPhase(3, { targetPid: 3456 }); // running
    const taskDir = path.join(f.taskDirectory, taskId);
    await mkdir(taskDir, { recursive: true });
    const metadata = makeCanonicalMetadata({
      taskId,
      clientId,
      sessionId: 'session-old',
      workspaceId,
      state: 'running',
      binding,
      workerPid: 99999999,
    });
    await writeFile(path.join(taskDir, 'task.json'), JSON.stringify(metadata));

    expect(await f.index.reserve({
      taskId,
      capacityClass: 'durable_shell',
      requestDigest: digest,
      mutationKind: 'opaque',
      nativeBinding: binding,
      nativeReceiptPath: path.join(taskDir, 'containment.receipt.json'),
      ownerClientId: clientId,
      ownerWorkspaceId: workspaceId,
    })).toMatchObject({ ok: true, value: { created: true } });

    expect(await f.admission.holdExclusiveProbe(workspaceId)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(f.mock.getRequests()).toEqual([]);
    expect(await f.index.hasReservation(taskId, digest)).toBe(true);

    const cancelled = await f.backend.cancelForGoal(clientId, workspaceId, taskId);
    expect(cancelled.ok).toBe(true);
    if (cancelled.ok) {
      expect(cancelled.value.matched).toBe(true);
      expect(cancelled.value.state).toBe('cancelled');
    }
    expect(f.mock.getCancelledAttempts()).toEqual([binding.attemptId]);
    expect(await f.index.hasReservation(taskId, digest)).toBe(false);
    expect(f.mock.getRequests().every((request) => request.identity.attemptId === binding.attemptId)).toBe(true);
    const requestsAfterCancellation = f.mock.getRequests();

    const probe = await f.admission.holdExclusiveProbe(workspaceId);
    expect(probe.ok).toBe(true);
    if (probe.ok) await probe.value.releaseAfterVerifiedTermination();
    expect(f.mock.getRequests()).toEqual(requestsAfterCancellation);
  });

  it('12. Lease Generation Fencing: rejects mutations with stale generation or invalid token', async () => {
    const f = await fixture(10_000);
    const workspaceId = 'workspace-1';
    const clientId = 'client-1';

    const lease1 = await f.lease.acquire(workspaceId, clientId, 'session-1', 30);
    expect(lease1.ok).toBe(true);
    if (!lease1.ok) return;

    const validBegin = await f.lease.begin(workspaceId, clientId, 'session-1', 'call-1', lease1.value);
    expect(validBegin.ok).toBe(true);
    await f.lease.end(workspaceId, 'call-1', lease1.value.generation);

    f.advanceTime(35_000); // Expire lease 1

    const lease2 = await f.lease.acquire(workspaceId, clientId, 'session-2', 60, true);
    expect(lease2.ok).toBe(true);
    if (!lease2.ok) return;
    expect(lease2.value.generation).toBe(2);

    const staleBegin = await f.lease.begin(workspaceId, clientId, 'session-1', 'call-stale', lease1.value);
    expect(staleBegin.ok).toBe(false);
    if (!staleBegin.ok) {
      expect(staleBegin.error.code).toBe('CONFLICT');
    }

    const gen2Begin = await f.lease.begin(workspaceId, clientId, 'session-2', 'call-gen2', lease2.value);
    expect(gen2Begin.ok).toBe(true);
    await f.lease.end(workspaceId, 'call-gen2', lease2.value.generation);
  }, WINDOWS_WRITER_IO_TEST_TIMEOUT_MS);

  it('13. Service Restart Recovery: only explicit owner status recovers an attempt lost from service memory', async () => {
    const f = await fixture(10_000);
    const workspaceId = 'workspace-1';
    const clientId = 'client-1';

    await f.lease.acquire(workspaceId, clientId, 'session-1', 30);

    const taskId = randomUUID();
    const digest = createHash('sha256').update(taskId).digest('hex');
    const binding = durableShellNativeBinding({
      taskId,
      executable: 'node.exe',
      arguments: ['-e', '1'],
      cwd: f.root,
      timeoutSeconds: 30,
      maxOutputBytes: 1024,
      includeStdout: true,
      includeStderr: true,
      owner: { clientId, sessionId: 'session-1', workspaceId },
    }, digest);

    const taskDir = path.join(f.taskDirectory, taskId);
    await mkdir(taskDir, { recursive: true });
    const metadata = makeCanonicalMetadata({
      taskId,
      clientId,
      sessionId: 'session-1',
      workspaceId,
      state: 'termination_unverified',
      binding,
      workerPid: 99999999, // gone
    });
    await writeFile(path.join(taskDir, 'task.json'), JSON.stringify(metadata));

    expect(await f.index.reserve({
      taskId,
      capacityClass: 'durable_shell',
      requestDigest: digest,
      mutationKind: 'opaque',
      nativeBinding: binding,
      nativeReceiptPath: path.join(taskDir, 'containment.receipt.json'),
      ownerClientId: clientId,
      ownerWorkspaceId: workspaceId,
    })).toMatchObject({ ok: true, value: { created: true } });

    // Simulate service restart: attempt is lost from service memory
    f.mock.setAttemptLost(true);
    f.advanceTime(35_000); // Expire lease

    expect(await f.lease.acquire(workspaceId, clientId, 'session-2', 60, true))
      .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(f.mock.getRequests()).toEqual([]);
    expect(await f.index.hasReservation(taskId, digest)).toBe(true);
    expect(await readFile(path.join(taskDir, 'task.json'), 'utf8')).toBe(JSON.stringify(metadata));

    // Exact-owned status, not lease admission, may obtain the abort tombstone.
    const snapshot = await f.store.snapshot(taskId, undefined, { clientId, sessionId: 'session-2', workspaceId });
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(snapshot.value.state).toBe('failed');
      expect(snapshot.value.exit_code).toBe(-1);
    }
    expect(await f.index.hasReservation(taskId, digest)).toBe(false);
    expect(f.mock.getRequests().filter((request) => request.command === 'abort'))
      .toMatchObject([{ identity: { attemptId: binding.attemptId } }]);
    expect(f.mock.getRequests().every((request) => request.identity.attemptId === binding.attemptId)).toBe(true);
    const requestsAfterRecovery = f.mock.getRequests();
    expect(await f.lease.acquire(workspaceId, clientId, 'session-2', 60, true))
      .toMatchObject({ ok: true, value: { generation: 2 } });
    expect(f.mock.getRequests()).toEqual(requestsAfterRecovery);
  }, WINDOWS_WRITER_IO_TEST_TIMEOUT_MS);

  it('14. Managed Writer Undispatched Attempt Recovery: admission waits for an explicit owner abort', async () => {
    const f = await fixture(10_000);
    const workspaceId = 'workspace-1';
    const clientId = 'client-1';

    expect(await f.lease.acquire(workspaceId, clientId, 'session-1', 30)).toMatchObject({ ok: true });
    f.mock.setPhase(0);
    const taskId = randomUUID();
    const taskDir = path.join(f.taskDirectory, taskId);
    await mkdir(taskDir, { recursive: true });
    const writer = await f.admission.enter({
      actorClientId: clientId,
      actorSessionId: 'session-1',
      nativeTaskId: taskId,
      workspaceId,
      kind: 'contained_process',
      nativeReceiptPath: path.join(taskDir, 'containment.receipt.json'),
    });
    expect(writer.ok).toBe(true);
    if (!writer.ok) return;
    const binding = writer.value.nativeBinding!;
    expect(binding).toBeDefined();

    f.advanceTime(35_000);
    expect(await f.lease.acquire(workspaceId, clientId, 'session-2', 60, true))
      .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await f.admission.holdExclusiveProbe(workspaceId)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(f.mock.getRequests()).toEqual([]);
    expect(await f.index.hasReservation(writer.value.id, binding.requestDigest)).toBe(true);

    expect(writer.value.abortBeforeLaunch).toBeDefined();
    await writer.value.abortBeforeLaunch!();
    expect(await f.index.hasReservation(writer.value.id, binding.requestDigest)).toBe(false);
    expect(f.mock.getRequests().filter((request) => request.command === 'abort'))
      .toMatchObject([{ identity: { attemptId: binding.attemptId } }]);
    expect(f.mock.getRequests().every((request) => request.identity.attemptId === binding.attemptId)).toBe(true);
    const requestsAfterRecovery = f.mock.getRequests();
    expect(await f.lease.acquire(workspaceId, clientId, 'session-2', 60, true))
      .toMatchObject({ ok: true, value: { generation: 2 } });
    expect(f.mock.getRequests()).toEqual(requestsAfterRecovery);
  }, WINDOWS_WRITER_IO_TEST_TIMEOUT_MS);

  it('15. Managed Writer Live Descendants: admission and explicit owner release keep unverified descendants fenced', async () => {
    const f = await fixture(10_000);
    const workspaceId = 'workspace-1';
    const clientId = 'client-1';

    expect(await f.lease.acquire(workspaceId, clientId, 'session-1', 30)).toMatchObject({ ok: true });
    f.mock.setPhase(5, { reason: 'ACTIVE_PROCESSES_REMAIN' });
    const taskId = randomUUID();
    const taskDir = path.join(f.taskDirectory, taskId);
    await mkdir(taskDir, { recursive: true });
    const writer = await f.admission.enter({
      actorClientId: clientId,
      actorSessionId: 'session-1',
      nativeTaskId: taskId,
      workspaceId,
      kind: 'contained_process',
      nativeReceiptPath: path.join(taskDir, 'containment.receipt.json'),
    });
    expect(writer.ok).toBe(true);
    if (!writer.ok) return;
    const binding = writer.value.nativeBinding!;
    expect(binding).toBeDefined();

    f.advanceTime(35_000);
    expect(await f.lease.acquire(workspaceId, clientId, 'session-2', 60, true)).toMatchObject({
      ok: false, error: { code: 'CONFLICT', details: { blocker_state: 'held', recovery_requirement: 'explicit_owner_scoped_recovery' } },
    });
    expect(f.mock.getRequests()).toEqual([]);
    expect(await f.index.hasReservation(writer.value.id, binding.requestDigest)).toBe(true);

    await expect(writer.value.abortBeforeLaunch!()).rejects.toThrow('MANAGED_WRITER_ABORT_UNVERIFIED');
    await expect(writer.value.releaseAfterVerifiedTermination()).rejects.toThrow('MANAGED_WRITER_RELEASE_UNVERIFIED');
    expect(await f.index.hasReservation(writer.value.id, binding.requestDigest)).toBe(true);
    expect(f.mock.getRequests().every((request) => request.identity.attemptId === binding.attemptId)).toBe(true);
    const requestsAfterRecovery = f.mock.getRequests();
    expect(await f.lease.acquire(workspaceId, clientId, 'session-2', 60, true))
      .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(f.mock.getRequests()).toEqual(requestsAfterRecovery);
  }, WINDOWS_WRITER_IO_TEST_TIMEOUT_MS);

  it('16. Crash After Dispatch + Terminal Proof: admission waits for an explicit owner release', async () => {
    const f = await fixture(10_000);
    const workspaceId = 'workspace-1';
    const clientId = 'client-1';

    expect(await f.lease.acquire(workspaceId, clientId, 'session-1', 30)).toMatchObject({ ok: true });
    f.mock.setPhase(4, { outcome: 0, exitCode: 0 });
    const taskId = randomUUID();
    const taskDir = path.join(f.taskDirectory, taskId);
    await mkdir(taskDir, { recursive: true });
    const writer = await f.admission.enter({
      actorClientId: clientId,
      actorSessionId: 'session-1',
      nativeTaskId: taskId,
      workspaceId,
      kind: 'contained_process',
      nativeReceiptPath: path.join(taskDir, 'containment.receipt.json'),
    });
    expect(writer.ok).toBe(true);
    if (!writer.ok) return;
    const binding = writer.value.nativeBinding!;
    expect(binding).toBeDefined();

    f.advanceTime(35_000);
    expect(await f.lease.acquire(workspaceId, clientId, 'session-2', 60, true))
      .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(f.mock.getRequests()).toEqual([]);
    expect(await f.index.hasReservation(writer.value.id, binding.requestDigest)).toBe(true);

    await writer.value.releaseAfterVerifiedTermination();
    expect(await f.index.hasReservation(writer.value.id, binding.requestDigest)).toBe(false);
    expect(f.mock.getRequests()).toMatchObject([{ command: 'inspect', identity: { attemptId: binding.attemptId } }]);
    const requestsAfterRecovery = f.mock.getRequests();
    expect(await f.lease.acquire(workspaceId, clientId, 'session-2', 60, true))
      .toMatchObject({ ok: true, value: { generation: 2 } });
    expect(f.mock.getRequests()).toEqual(requestsAfterRecovery);
  }, WINDOWS_WRITER_IO_TEST_TIMEOUT_MS);

  it('17. Idempotent Recovery: repeated recovery calls yield identical generation and valid lease', async () => {
    const f = await fixture(10_000);
    const workspaceId = 'workspace-1';
    const clientId = 'client-1';

    await f.lease.acquire(workspaceId, clientId, 'session-1', 30);
    f.advanceTime(35_000);

    const recovered1 = await f.lease.acquire(workspaceId, clientId, 'session-2', 60, true);
    expect(recovered1.ok).toBe(true);
    if (!recovered1.ok) return;
    expect(recovered1.value.generation).toBe(2);

    // Active lease can be renewed cleanly
    const renewed = await f.lease.renew(workspaceId, clientId, 'session-2', recovered1.value, 60);
    expect(renewed.ok).toBe(true);

    // Inspect confirms active state and generation 2
    const inspected = await f.lease.inspect(workspaceId);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.value.state).toBe('active');
    expect(inspected.value.generation).toBe(2);
  }, WINDOWS_WRITER_IO_TEST_TIMEOUT_MS);

  it('18. Exact-Owned Recovery: terminal status releases its own marker without touching another owner', async () => {
    const f = await fixture();
    f.mock.setPhase(4, { outcome: 0, exitCode: 0 });
    const tasks = await Promise.all(['first', 'second'].map(async (name) => {
      const taskId = randomUUID();
      const digest = createHash('sha256').update(taskId).digest('hex');
      const owner = { clientId: `${name}-client`, sessionId: `${name}-session`, workspaceId: `${name}-workspace` } satisfies CapabilityTaskOwner;
      const binding = durableShellNativeBinding({
        taskId,
        executable: 'node.exe',
        arguments: ['-e', '1'],
        cwd: f.root,
        timeoutSeconds: 30,
        maxOutputBytes: 1024,
        includeStdout: true,
        includeStderr: true,
        owner,
      }, digest);
      const taskDir = path.join(f.taskDirectory, taskId);
      await mkdir(taskDir, { recursive: true });
      const metadataPath = path.join(taskDir, 'task.json');
      await writeFile(metadataPath, JSON.stringify(makeCanonicalMetadata({
        taskId, clientId: owner.clientId, sessionId: owner.sessionId, workspaceId: owner.workspaceId,
        state: 'completed', exitCode: 0, binding,
      })));
      const reserved = await f.index.reserve({
        taskId, requestDigest: digest, capacityClass: 'durable_shell', mutationKind: 'opaque',
        nativeBinding: binding, nativeReceiptPath: path.join(taskDir, 'containment.receipt.json'),
        ownerClientId: owner.clientId, ownerWorkspaceId: owner.workspaceId,
      });
      expect(reserved.ok).toBe(true);
      if (!reserved.ok) throw new Error('Test reservation was not established');
      return { taskId, digest, owner, binding, metadataPath, markerPath: reserved.value.markerPath };
    }));
    const [first, second] = tasks;
    if (first === undefined || second === undefined) throw new Error('Both test tasks must be established');
    const secondMarker = await readFile(second.markerPath, 'utf8');
    const secondMetadata = await readFile(second.metadataPath, 'utf8');

    expect(await f.admission.holdExclusiveProbe(first.owner.workspaceId))
      .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(f.mock.getRequests()).toEqual([]);

    expect(await f.store.snapshot(first.taskId, undefined, first.owner))
      .toMatchObject({ ok: true, value: { state: 'completed', exit_code: 0 } });
    expect(await f.index.hasReservation(first.taskId, first.digest)).toBe(false);
    expect(await f.index.hasReservation(second.taskId, second.digest)).toBe(true);
    expect(await readFile(second.markerPath, 'utf8')).toBe(secondMarker);
    expect(await readFile(second.metadataPath, 'utf8')).toBe(secondMetadata);
    expect(f.mock.getRequests().length).toBeGreaterThan(0);
    expect(f.mock.getRequests().every((request) => request.command === 'inspect' && request.identity.attemptId === first.binding.attemptId)).toBe(true);
    const requestsAfterFirstRecovery = f.mock.getRequests();

    expect(await f.store.snapshot(second.taskId, undefined, first.owner))
      .toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(await f.admission.holdExclusiveProbe(first.owner.workspaceId))
      .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(f.mock.getRequests()).toEqual(requestsAfterFirstRecovery);
    expect(await readFile(second.markerPath, 'utf8')).toBe(secondMarker);

    expect(await f.store.snapshot(second.taskId, undefined, second.owner))
      .toMatchObject({ ok: true, value: { state: 'completed', exit_code: 0 } });
    expect(await f.index.hasReservation(second.taskId, second.digest)).toBe(false);
    const secondRecoveryRequests = f.mock.getRequests().slice(requestsAfterFirstRecovery.length);
    expect(secondRecoveryRequests.length).toBeGreaterThan(0);
    expect(secondRecoveryRequests.every((request) => request.command === 'inspect' && request.identity.attemptId === second.binding.attemptId)).toBe(true);

    const requestsAfterSecondRecovery = f.mock.getRequests();
    expect(await f.lease.acquire(first.owner.workspaceId, first.owner.clientId, first.owner.sessionId, 60))
      .toMatchObject({ ok: true, value: { generation: 1 } });
    expect(f.mock.getRequests()).toEqual(requestsAfterSecondRecovery);
  }, WINDOWS_WRITER_IO_TEST_TIMEOUT_MS);
});
