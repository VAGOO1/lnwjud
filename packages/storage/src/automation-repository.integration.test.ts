import { describe, expect, it } from 'vitest';
import { SqliteDatabase } from './database.js';
import { SqliteGoalRepository } from './goal-repository.js';
import { SqliteAutomationRepository, type CreateAutomationRunRequest } from './automation-repository.js';

const now = '2026-09-20T10:00:00.000Z';

describe('SqliteAutomationRepository', () => {
  it('creates and loads an owner-scoped run while enforcing one non-terminal run per goal', async () => {
    const fixture = await createFixture();
    try {
      const created = fixture.repository.create(runInput('run-a'));
      expect(created).toMatchObject({
        ok: true,
        value: {
          run: { id: 'run-a', goalId: 'goal-a', workspaceId: 'workspace-a', ownerClientId: 'client-a', status: 'active', revision: 0 },
          milestones: [{ id: 'build', status: 'pending', role: 'blocking_job', cancelWithGoal: true }],
          attempts: [],
        },
      });
      expect(fixture.repository.getOwned('run-a', 'other-client', 'workspace-a')).toEqual({ ok: true, value: undefined });
      expect(fixture.repository.getOwned('run-a', 'client-a', 'other-workspace')).toEqual({ ok: true, value: undefined });
      expect(fixture.repository.create(runInput('run-b'))).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    } finally {
      fixture.database.close();
    }
  });

  it('applies revision CAS and appends each transition event atomically', async () => {
    const fixture = await createFixture();
    try {
      expect(fixture.repository.create(runInput('run-a')).ok).toBe(true);
      const paused = fixture.repository.transitionRun({
        runId: 'run-a', ownerClientId: 'client-a', workspaceId: 'workspace-a', expectedRevision: 0,
        status: 'paused', updatedAt: '2026-09-20T10:01:00.000Z',
        event: { kind: 'run_paused', payload: { reason: 'operator' } },
      });
      expect(paused).toMatchObject({ ok: true, value: { run: { status: 'paused', revision: 1 } } });

      const stale = fixture.repository.transitionRun({
        runId: 'run-a', ownerClientId: 'client-a', workspaceId: 'workspace-a', expectedRevision: 0,
        status: 'cancelled', updatedAt: '2026-09-20T10:02:00.000Z',
        event: { kind: 'stale_cancel', payload: {} },
      });
      expect(stale).toMatchObject({ ok: false, error: { code: 'CONFLICT', recoverable: true } });
      expect(fixture.repository.getOwned('run-a', 'client-a', 'workspace-a')).toMatchObject({
        ok: true,
        value: { run: { status: 'paused', revision: 1 } },
      });
      expect(fixture.repository.listEvents('run-a', 'client-a', 'workspace-a', { limit: 10 })).toMatchObject({
        ok: true,
        value: { events: [{ sequence: 0, kind: 'run_created' }, { sequence: 1, kind: 'run_paused' }] },
      });
    } finally {
      fixture.database.close();
    }
  });

  it('reserves immutable attempts and rolls back the entire mutation on an identity collision', async () => {
    const fixture = await createFixture();
    try {
      expect(fixture.repository.create(runInput('run-a')).ok).toBe(true);
      expect(fixture.repository.transitionMilestone({
        runId: 'run-a', ownerClientId: 'client-a', workspaceId: 'workspace-a', expectedRevision: 0,
        milestoneId: 'build', status: 'ready', updatedAt: '2026-09-20T10:01:00.000Z',
        event: { kind: 'milestone_ready', milestoneId: 'build', payload: {} },
      })).toMatchObject({ ok: true, value: { run: { revision: 1 } } });

      const reserved = fixture.repository.reserveAttempt({
        runId: 'run-a', ownerClientId: 'client-a', workspaceId: 'workspace-a', expectedRevision: 1,
        milestoneId: 'build', attemptId: 'attempt-a', ordinal: 1,
        taskId: 'automation-run-a-build-1', requestDigest: 'a'.repeat(64),
        updatedAt: '2026-09-20T10:02:00.000Z',
        event: { kind: 'attempt_reserved', milestoneId: 'build', attemptId: 'attempt-a', payload: {} },
      });
      expect(reserved).toMatchObject({
        ok: true,
        value: {
          run: { revision: 2 },
          milestones: [{ id: 'build', status: 'dispatching', attemptCount: 1 }],
          attempts: [{ id: 'attempt-a', milestoneId: 'build', ordinal: 1, dispatchStatus: 'reserved' }],
        },
      });

      const collision = fixture.repository.reserveAttempt({
        runId: 'run-a', ownerClientId: 'client-a', workspaceId: 'workspace-a', expectedRevision: 2,
        milestoneId: 'build', attemptId: 'attempt-a', ordinal: 2,
        taskId: 'automation-run-a-build-2', requestDigest: 'b'.repeat(64),
        updatedAt: '2026-09-20T10:03:00.000Z',
        event: { kind: 'attempt_reserved_again', milestoneId: 'build', attemptId: 'attempt-a', payload: {} },
      });
      expect(collision).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      expect(fixture.repository.getOwned('run-a', 'client-a', 'workspace-a')).toMatchObject({
        ok: true,
        value: { run: { revision: 2 }, milestones: [{ attemptCount: 1 }], attempts: [{ id: 'attempt-a', ordinal: 1 }] },
      });
      expect(fixture.repository.listEvents('run-a', 'client-a', 'workspace-a', { limit: 10 })).toMatchObject({
        ok: true,
        value: { events: [{ sequence: 0 }, { sequence: 1 }, { sequence: 2 }] },
      });
    } finally {
      fixture.database.close();
    }
  });

  it('records verification evidence and the milestone result in one CAS mutation', async () => {
    const fixture = await createFixture();
    try {
      expect(fixture.repository.create(runInput('run-a')).ok).toBe(true);
      expect(fixture.repository.transitionMilestone({
        runId: 'run-a', ownerClientId: 'client-a', workspaceId: 'workspace-a', expectedRevision: 0,
        milestoneId: 'build', status: 'ready', updatedAt: '2026-09-20T10:01:00.000Z',
        event: { kind: 'milestone_ready', milestoneId: 'build', payload: {} },
      }).ok).toBe(true);
      expect(fixture.repository.reserveAttempt({
        runId: 'run-a', ownerClientId: 'client-a', workspaceId: 'workspace-a', expectedRevision: 1,
        milestoneId: 'build', attemptId: 'attempt-a', ordinal: 1,
        taskId: 'automation-run-a-build-1', requestDigest: 'a'.repeat(64),
        updatedAt: '2026-09-20T10:02:00.000Z',
        event: { kind: 'attempt_reserved', milestoneId: 'build', attemptId: 'attempt-a', payload: {} },
      }).ok).toBe(true);
      expect(fixture.repository.updateAttempt({
        runId: 'run-a', ownerClientId: 'client-a', workspaceId: 'workspace-a', expectedRevision: 2,
        attemptId: 'attempt-a', dispatchStatus: 'launched', milestoneStatus: 'running',
        updatedAt: '2026-09-20T10:03:00.000Z',
        event: { kind: 'dispatch_observed', milestoneId: 'build', attemptId: 'attempt-a', payload: {} },
      }).ok).toBe(true);
      expect(fixture.repository.updateAttempt({
        runId: 'run-a', ownerClientId: 'client-a', workspaceId: 'workspace-a', expectedRevision: 3,
        attemptId: 'attempt-a', dispatchStatus: 'terminal', milestoneStatus: 'verifying', terminalState: 'completed:0',
        updatedAt: '2026-09-20T10:04:00.000Z',
        event: { kind: 'dispatch_terminal', milestoneId: 'build', attemptId: 'attempt-a', payload: {} },
      }).ok).toBe(true);

      const verified = fixture.repository.recordVerification({
        runId: 'run-a', ownerClientId: 'client-a', workspaceId: 'workspace-a', expectedRevision: 4,
        attemptId: 'attempt-a', milestoneStatus: 'completed',
        evidence: [{
          requirementId: 'build-exit', kind: 'command_exit', status: 'verified',
          observedAt: '2026-09-20T10:05:00.000Z', observedDigest: 'a'.repeat(64),
          observedTaskId: 'automation-run-a-build-1', observedExitCode: 0, detail: 'completed',
        }],
        updatedAt: '2026-09-20T10:05:00.000Z',
        event: { kind: 'verification_recorded', milestoneId: 'build', attemptId: 'attempt-a', payload: { status: 'verified' } },
      });
      expect(verified).toMatchObject({
        ok: true,
        value: {
          run: { revision: 5 },
          milestones: [{ id: 'build', status: 'completed' }],
          attempts: [{ id: 'attempt-a', evidence: [{ requirementId: 'build-exit', status: 'verified' }] }],
        },
      });
      expect(fixture.repository.listEvents('run-a', 'client-a', 'workspace-a', { limit: 10 })).toMatchObject({
        ok: true,
        value: { events: [{ sequence: 0 }, { sequence: 1 }, { sequence: 2 }, { sequence: 3 }, { sequence: 4 }, { sequence: 5, kind: 'verification_recorded' }] },
      });

      const stale = fixture.repository.recordVerification({
        runId: 'run-a', ownerClientId: 'client-a', workspaceId: 'workspace-a', expectedRevision: 4,
        attemptId: 'attempt-a', milestoneStatus: 'failed',
        evidence: [{ requirementId: 'build-exit', kind: 'command_exit', status: 'failed', observedAt: '2026-09-20T10:06:00.000Z' }],
        updatedAt: '2026-09-20T10:06:00.000Z',
        event: { kind: 'stale_verification', milestoneId: 'build', attemptId: 'attempt-a', payload: {} },
      });
      expect(stale).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      expect(fixture.repository.getOwned('run-a', 'client-a', 'workspace-a')).toMatchObject({
        ok: true,
        value: { run: { revision: 5 }, milestones: [{ status: 'completed' }], attempts: [{ evidence: [{ status: 'verified' }] }] },
      });
    } finally {
      fixture.database.close();
    }
  });

  it('bounds and redacts event payloads and fails closed on corrupt stored definitions', async () => {
    const fixture = await createFixture();
    try {
      expect(fixture.repository.create(runInput('run-a')).ok).toBe(true);
      const transitioned = fixture.repository.transitionRun({
        runId: 'run-a', ownerClientId: 'client-a', workspaceId: 'workspace-a', expectedRevision: 0,
        status: 'paused', updatedAt: '2026-09-20T10:01:00.000Z',
        event: { kind: 'run_paused', payload: { token: 'super-secret', detail: 'x'.repeat(2_000) } },
      });
      expect(transitioned.ok).toBe(true);
      const events = fixture.repository.listEvents('run-a', 'client-a', 'workspace-a', { afterSequence: 0, limit: 1 });
      expect(events).toMatchObject({
        ok: true,
        value: { events: [{ sequence: 1, payload: { token: '[redacted]', detail: expect.any(String) } }] },
      });
      if (events.ok) expect(String(events.value.events[0]?.payload.detail).length).toBeLessThanOrEqual(1_024);

      fixture.database.connection.prepare("UPDATE automation_milestones SET dispatch_json = '{bad' WHERE run_id = ?").run('run-a');
      expect(fixture.repository.getOwned('run-a', 'client-a', 'workspace-a')).toMatchObject({
        ok: false,
        error: { code: 'INTERNAL_ERROR', recoverable: true },
      });
    } finally {
      fixture.database.close();
    }
  });

  it('never persists command descriptors that advertise credential-bearing arguments', async () => {
    const fixture = await createFixture();
    try {
      const unsafe = runInput('run-secret');
      const milestone = unsafe.plan.milestones[0]!;
      const created = fixture.repository.create({
        ...unsafe,
        plan: {
          milestones: [{
            ...milestone,
            dispatch: { ...milestone.dispatch, arguments: ['--token', 'should-never-be-stored'] },
          }],
        },
      });
      expect(created).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      expect(fixture.database.connection.prepare('SELECT COUNT(*) AS count FROM automation_runs').get()).toEqual({ count: 0 });
    } finally {
      fixture.database.close();
    }
  });
});

async function createFixture(): Promise<{ database: SqliteDatabase; repository: SqliteAutomationRepository }> {
  const database = new SqliteDatabase(':memory:');
  database.connection.prepare(`INSERT INTO workspaces (id, display_name, root_path, real_root_path, created_at)
    VALUES (?, ?, ?, ?, ?)`).run('workspace-a', 'Workspace A', 'C:\\workspace-a', 'C:\\workspace-a', now);
  const goals = new SqliteGoalRepository(database);
  await goals.acquire({
    goalId: 'goal-a', workspaceId: 'workspace-a', goalKey: 'goal-key-a', ownerClientId: 'client-a', ownerSessionId: 'session-a',
    objective: 'Build safely', plan: { steps: [{ id: 'goal-build', title: 'Build', status: 'pending' }] },
    leaseTokenHash: 'lease-hash', leaseSeconds: 600, now,
  });
  return { database, repository: new SqliteAutomationRepository(database) };
}

function runInput(id: string): CreateAutomationRunRequest {
  return {
    id,
    goalId: 'goal-a',
    workspaceId: 'workspace-a',
    ownerClientId: 'client-a',
    createdAt: now,
    plan: {
      milestones: [{
        id: 'build', title: 'Build', goalStepId: 'goal-build', dependsOn: [], provider: 'shell',
        role: 'blocking_job', cancelWithGoal: true,
        dispatch: {
          executable: 'node', arguments: ['--version'], cwd: 'C:\\workspace-a', timeoutSeconds: 60,
          maxOutputBytes: 1024, includeStdout: true, includeStderr: true,
        },
        verification: [{ id: 'build-exit', kind: 'command_exit', expectedExitCode: 0 }],
      }],
    },
  } as const;
}
