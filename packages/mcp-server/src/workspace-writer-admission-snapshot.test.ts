import { describe, expect, it, vi } from 'vitest';
import { ok } from '@lnwjud/domain';
import type { WorkspaceWriterLeasePort } from '@lnwjud/capabilities';
import { ToolRegistry } from './tool-registry.js';

const observation = {
  scope: 'global_managed_writers', basis: 'persisted_markers_only', observedAt: '2026-11-11T00:00:00Z',
  consistency: 'non_atomic', status: 'unknown', reason: 'not_initialized', heldReservations: null,
  reservationsByKind: null, nativeEvidence: 'not_observed', admission: 'not_evaluated',
} as const;
function fixture(): { registry: ToolRegistry; snapshot: ReturnType<typeof vi.fn>; mutation: ReturnType<typeof vi.fn> } {
  const snapshot = vi.fn().mockResolvedValue(ok(observation));
  const mutation = vi.fn().mockImplementation(() => { throw new Error('MUTATING_OR_LEGACY_PATH_CALLED'); });
  const lease: WorkspaceWriterLeasePort = {
    admissionSnapshot: snapshot, acquire: mutation, inspect: mutation, begin: mutation,
    heartbeat: mutation, end: mutation, renew: mutation, release: mutation,
    assessAbandonment: mutation, revokeAbandoned: mutation,
  };
  return { registry: new ToolRegistry({ workspaceWriterLease: lease }, { clientId: 'test-client', clientName: 'test', sessionId: 'test-session' }), snapshot, mutation };
}

describe('workspace_writer_admission_snapshot dispatch', () => {
  it('advertises a strict read-only tool and bypasses all mutation and legacy status paths', async () => {
    const f = fixture();
    const tool = f.registry.listAll().find((entry) => entry.name === 'workspace_writer_admission_snapshot');
    expect(tool).toMatchObject({ permission: 'READ', annotations: { readOnlyHint: true, destructiveHint: false } });
    const result = await f.registry.invoke('workspace_writer_admission_snapshot', { workspaceId: 'workspace-test' });
    expect(result.isError).not.toBe(true);
    expect(result).toMatchObject({ structuredContent: observation });
    expect(f.snapshot).toHaveBeenCalledExactlyOnceWith('workspace-test');
    expect(f.mutation).not.toHaveBeenCalled();
  });
  it('exports the required workspace identifier and optional common approval envelope only', () => {
    const schema = fixture().registry.describeInputJsonSchema('workspace_writer_admission_snapshot');
    expect(schema).toMatchObject({ required: ['workspaceId'], additionalProperties: false });
    expect(Object.keys(schema?.properties as Record<string, unknown>).sort()).toEqual(['userConfirmed', 'workspaceId']);
    expect(schema?.properties).toMatchObject({ userConfirmed: { type: 'boolean' }, workspaceId: { type: 'string', minLength: 1, maxLength: 128 } });
  });
  it.each([false, true])('accepts common userConfirmed=%j without changing snapshot scope or granting admission', async (userConfirmed) => {
    const f = fixture();
    expect(await f.registry.invoke('workspace_writer_admission_snapshot', { workspaceId: 'workspace-test', userConfirmed })).toMatchObject({ structuredContent: observation });
    expect(f.snapshot).toHaveBeenCalledExactlyOnceWith('workspace-test'); expect(f.mutation).not.toHaveBeenCalled();
  });
  it.each([{}, { workspaceId: '' }, { workspaceId: 'workspace-test', recoverAbandoned: true }, { workspaceId: 'workspace-test', path: '/private' }, { workspaceId: 'workspace-test', userConfirmed: 'true' }])('rejects invalid or expanded scope %j before dispatch', async (input) => {
    const f = fixture();
    expect(await f.registry.invoke('workspace_writer_admission_snapshot', input)).toMatchObject({ isError: true });
    expect(f.snapshot).not.toHaveBeenCalled(); expect(f.mutation).not.toHaveBeenCalled();
  });
  it('fails closed without falling back when the optional snapshot method is unavailable', async () => {
    const f = fixture();
    const registry = new ToolRegistry({}, { clientId: 'test-client', clientName: 'test' });
    expect(await registry.invoke('workspace_writer_admission_snapshot', { workspaceId: 'workspace-test' })).toMatchObject({ isError: true });
    expect(f.mutation).not.toHaveBeenCalled();
  });
});
