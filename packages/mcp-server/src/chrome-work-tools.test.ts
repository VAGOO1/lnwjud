import { describe, expect, it } from 'vitest';
import { permissionProfiles } from '@lnwjud/permissions';
import { ToolRegistry, type McpApplicationServices, type WorkspaceScope } from './tool-registry.js';
import { inspectMutationOperation } from './mutation-policy.js';
import { buildMcpInstructions } from './server.js';
import type { Result } from '@lnwjud/domain';

const actor = { clientId: 'chrome-fixture', clientName: 'chrome-fixture' };
const scope = async (): Promise<WorkspaceScope | null> => ({ workspaceId: 'ws-a', rootPath: 'C:\\fixture' });
const request = (tab_id = 'tab-a'): { action: string; tab_id: string; parameters: { selector: string }; approval: 'use_policy' } => ({ action: 'query', tab_id, parameters: { selector: '#ready' }, approval: 'use_policy' });
const input = (tab_id = 'tab-a'): { workspaceId: string; tab_id: string; pageUrl: string; idempotencyKey: string; requests: ReturnType<typeof request>[] } => ({ workspaceId: 'ws-a', tab_id, pageUrl: 'https://fixture.invalid/form', idempotencyKey: 'chrome-fixture-1', requests: [request(tab_id)] });

function services(calls: string[] = []): McpApplicationServices {
  return { chromeWork: {
    prepare: async (_actor, plan): Promise<Result<unknown>> => { calls.push('prepare'); return { ok: true, value: { prepared: true, requestDigests: plan.requestDigests } }; },
    extend: async (_actor, _input, plan): Promise<Result<unknown>> => { calls.push('extend'); return { ok: true, value: { continued: true, requestDigests: plan.requestDigests } }; },
    status: async () => ({ ok: true, value: { status: 'registered' } }),
    reconnect: async () => ({ ok: true, value: { reconnected: true } }),
  } };
}

describe('Chrome work MCP bridge', () => {
  it('prepares through the registry without dispatching a capability', async () => {
    const registry = new ToolRegistry(services(), actor, { activeWorkspaceScopeProvider: scope, profileProvider: (): typeof permissionProfiles.full => permissionProfiles.full });
    const response = await registry.invoke('chrome_work_prepare', input(), undefined);
    expect(response.isError).not.toBe(true);
    expect(response).toMatchObject({ structuredContent: { prepared: true } });
    expect(registry.list().map((tool) => tool.name)).toContain('chrome_work_prepare');
  });

  it('validates exact extension requests before the host and keeps safe-profile confirmation', async () => {
    const calls: string[] = []; const inputPlan = { ...input(), primaryWorkId: 'work', continuityToken: 'opaque', expectedConnectionRevision: 1, expectedBudgetRevision: 1, expectedContinuationRevision: 0 };
    const registry = new ToolRegistry(services(calls), actor, { activeWorkspaceScopeProvider: scope, profileProvider: (): typeof permissionProfiles.full => permissionProfiles.full });
    expect(await registry.invoke('chrome_work_extend', inputPlan)).toMatchObject({ structuredContent: { continued: true } });
    expect(calls).toEqual(['extend']);
    await expect(registry.invoke('chrome_work_extend', { ...inputPlan, requests: [request('wrong')] })).resolves.toMatchObject({ isError: true });
    await expect(registry.invoke('chrome_work_extend', { ...inputPlan, requestDigests: ['f'.repeat(64)] })).resolves.toMatchObject({ isError: true });
    expect(calls).toEqual(['extend']);
    const safe = new ToolRegistry(services(calls), actor, { activeWorkspaceScopeProvider: scope, profileProvider: (): typeof permissionProfiles.safe => permissionProfiles.safe });
    await expect(safe.invoke('chrome_work_extend', inputPlan)).resolves.toMatchObject({ isError: true });
    expect(calls).toEqual(['extend']);
  });

  it('rejects a request that tries to change the proposal tab', async () => {
    const registry = new ToolRegistry(services(), actor, { activeWorkspaceScopeProvider: scope, profileProvider: (): typeof permissionProfiles.full => permissionProfiles.full });
    const response = await registry.invoke('chrome_work_prepare', { ...input('tab-a'), requests: [request('tab-b')] });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_INPUT' } } });
  });

  it('does not advertise or execute writes when the service is absent', async () => {
    const registry = new ToolRegistry({}, actor, { activeWorkspaceScopeProvider: scope, profileProvider: (): typeof permissionProfiles.full => permissionProfiles.full });
    expect(registry.list().some((tool) => tool.name === 'chrome_work_prepare')).toBe(false);
    await expect(registry.invoke('chrome_work_prepare', input())).resolves.toMatchObject({ isError: true });
  });

  it('rejects malformed URLs before the host service', async () => {
    const calls: string[] = [];
    const registry = new ToolRegistry(services(calls), actor, { activeWorkspaceScopeProvider: scope, profileProvider: (): typeof permissionProfiles.full => permissionProfiles.full });
    const response = await registry.invoke('chrome_work_prepare', { ...input(), pageUrl: 'https://fixture.invalid/form?secret=1' });
    expect(response).toMatchObject({ isError: true });
    expect(calls).toEqual([]);
  });

  it('requires WRITE confirmation for prepare and reconnect under the safe profile', async () => {
    const registry = new ToolRegistry(services(), actor, { activeWorkspaceScopeProvider: scope, profileProvider: (): typeof permissionProfiles.safe => permissionProfiles.safe });
    await expect(registry.invoke('chrome_work_prepare', input(), undefined)).resolves.toMatchObject({ isError: true });
    await expect(registry.invoke('chrome_work_reconnect', { workspaceId: 'ws-a', primaryWorkId: 'work-a', continuityToken: 'opaque', expectedConnectionRevision: 1 })).resolves.toMatchObject({ isError: true });
  });

  it('rejects forged plan authority fields and cancellation before service call', async () => {
    const calls: string[] = [];
    const registry = new ToolRegistry(services(calls), actor, { activeWorkspaceScopeProvider: scope, profileProvider: (): typeof permissionProfiles.full => permissionProfiles.full });
    const forged = { ...input(), primaryWorkId: 'forged', clientId: 'forged', sessionId: 'forged', requestDigests: ['f'.repeat(64)] };
    await expect(registry.invoke('chrome_work_prepare', forged, undefined)).resolves.toMatchObject({ isError: true });
    const controller = new AbortController(); controller.abort();
    await expect(registry.invoke('chrome_work_prepare', input(), undefined, controller.signal)).resolves.toMatchObject({ isError: true });
    expect(calls).toEqual([]);
  });

  it('keeps Chrome metadata bounded while unknown writes and DOM expressions stay opaque', () => {
    expect(inspectMutationOperation('chrome_work_extend', {}, 'WRITE').kind).toBe('bounded_write');
    expect(inspectMutationOperation('chrome_work_prepare', {}, 'WRITE').kind).toBe('bounded_write');
    expect(inspectMutationOperation('chrome_work_reconnect', {}, 'WRITE').kind).toBe('bounded_write');
    expect(inspectMutationOperation('future_write', {}, 'WRITE').kind).toBe('opaque_mutation');
    expect(inspectMutationOperation('dom_cdp', { action: 'evaluate' }, 'READ').kind).toBe('opaque_mutation');
  });

  it('adds the Chrome plan instruction only when the service is enabled', () => {
    expect(buildMcpInstructions('off', false, false)).not.toContain('chrome_work_prepare');
    expect(buildMcpInstructions('off', false, true)).toContain('chrome_work_prepare');
  });
});
