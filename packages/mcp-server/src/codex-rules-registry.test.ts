import { afterEach, describe, expect, it, vi } from 'vitest';
import { ok } from '@lnwjud/domain';
import { permissionProfiles } from '@lnwjud/permissions';
import { HOST_MUTATION_APPROVAL_TIMEOUT_MS, ToolRegistry, type McpApplicationServices, type ToolRegistryOptions } from './tool-registry.js';

afterEach(() => vi.useRealTimers());

function setup(approve: NonNullable<ToolRegistryOptions['hostMutationApprovalProvider']>): { registry: ToolRegistry; inspect: ReturnType<typeof vi.fn>; rules: { inspect: ReturnType<typeof vi.fn>; approvalMetadata: ReturnType<typeof vi.fn> } } {
  const inspect = vi.fn(async (_owner: string, _target: unknown, authorization: unknown): Promise<ReturnType<typeof ok<{ snapshotId: string }>>> => {
    expect(authorization).toMatchObject({ applicationApproved: true, source: 'host_approval', bypassApplicationAuthorization: false, mode: 'standard' });
    return ok({ snapshotId: '11111111-1111-4111-8111-111111111111' });
  });
  const rules = { inspect, approvalMetadata: vi.fn(async (): Promise<ReturnType<typeof ok<{ canonicalPath: string; target: 'global' }>>> => ok({ canonicalPath: 'C:\\Owner\\.codex\\AGENTS.md', target: 'global' as const })) };
  const registry = new ToolRegistry({ codexRules: rules } as unknown as McpApplicationServices, { clientId: 'rules-owner', clientName: 'fixture' }, {
    profileProvider: (): typeof permissionProfiles.full => permissionProfiles.full, authorizationModeProvider: (): 'full_bypass' => 'full_bypass',
    codexToolsEnabled: false, hostMutationApprovalProvider: approve,
  });
  return { registry, inspect, rules };
}

describe('codex_rules exact-file native gate', () => {
  it('stays exposed with delegation disabled and still asks under Full Bypass', async () => {
    const native = vi.fn(async () => true), { registry, inspect } = setup(native);
    const response = await registry.invoke('codex_rules', { operation: 'inspect', userConfirmed: true });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expect(native).toHaveBeenCalledTimes(1); expect(inspect).toHaveBeenCalledTimes(1);
    expect(native.mock.calls[0]?.[0]).toBeDefined();
  });
  it('tool_batch children re-enter the same native gate', async () => {
    const native = vi.fn(async () => false), { registry, inspect } = setup(native);
    const response = await registry.invoke('tool_batch', { calls: [{ tool: 'codex_rules', arguments: { operation: 'inspect', userConfirmed: true } }] });
    expect(response.isError).toBe(true); expect(native).toHaveBeenCalledTimes(1); expect(inspect).not.toHaveBeenCalled();
  });
  it('rejects caller-supplied authorization fields before any service or approval', async () => {
    const native = vi.fn(async () => true), { registry, inspect } = setup(native);
    expect((await registry.invoke('codex_rules', { operation: 'inspect', source: 'host_approval', userConfirmed: true })).isError).toBe(true);
    expect(native).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled();
  });
  it('cannot dispatch a late approval after cancellation', async () => {
    let release!: (value: boolean) => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const { registry, inspect } = setup(async () => new Promise<boolean>(resolve => { release = resolve; entered(); }));
    const controller = new AbortController();
    const pending = registry.invoke('codex_rules', { operation: 'inspect', userConfirmed: true }, undefined, controller.signal);
    await started; controller.abort(); release(true);
    expect((await pending).isError).toBe(true); expect(inspect).not.toHaveBeenCalled();
  });
  it('expires a waiting native prompt without invoking inspection', async () => {
    vi.useFakeTimers(); let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const { registry, inspect } = setup(async (_request, context) => new Promise<boolean>(resolve => {
      context.signal.addEventListener('abort', () => resolve(false), { once: true }); entered();
    }));
    const pending = registry.invoke('codex_rules', { operation: 'inspect', userConfirmed: true });
    await started; await vi.advanceTimersByTimeAsync(HOST_MUTATION_APPROVAL_TIMEOUT_MS);
    expect((await pending).isError).toBe(true); expect(inspect).not.toHaveBeenCalled();
  });
});
