import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ok, type Result} from '@lnwjud/domain';
import {permissionProfiles} from '@lnwjud/permissions';
import {BrowserCdpBackend, type BrowserCdpProtocol, type BrowserCdpTab} from '../../capabilities/src/browser-cdp-backend.js';
import {ToolRegistry, type McpApplicationServices} from './tool-registry.js';

type Execute = NonNullable<McpApplicationServices['capabilities']>['execute'];
const actor = {clientId: 'dom-outcome-fixture', clientName: 'local fixture'};
const input = {action: 'evaluate', tab_id: 'fixture-tab', userConfirmed: true, parameters: {expression: 'inert fixture'}};
const unknown = {effectState: 'UNKNOWN', inspectionRequired: 1, automaticReplayAllowed: 0};
let temp: string;
beforeEach(async () => {temp = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-dom-outcome-'));});
afterEach(async () => {
  const resolved = path.resolve(temp);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('lnwjud-dom-outcome-')) throw new Error('Unsafe fixture cleanup');
  await rm(resolved, {recursive: true, force: true});
});
function create(execute: Execute, allow = true, maxToolDurationMs = 1000): ToolRegistry {
  return new ToolRegistry({capabilities: {execute}, runtimeStatePath: path.join(temp, 'runtime.json')}, actor, {
    profileProvider: () => permissionProfiles.full,
    activeWorkspaceScopeProvider: async () => ({workspaceId: 'fixture-workspace', rootPath: temp}),
    hostMutationApprovalProvider: async () => allow,
    maxToolDurationMs,
  });
}
function protocol(onRequest: () => unknown): BrowserCdpProtocol {
  return {
    async status(): Promise<{ready: boolean; port: number}> {return {ready: true, port: 0};},
    async listTabs(): Promise<readonly BrowserCdpTab[]> {return [{id: 'fixture-tab', title: 'Fixture', url: 'https://fixture.invalid/', webSocketDebuggerUrl: 'FAKE-NOT-OPENED'}];},
    async newTab(): Promise<never> {throw new Error('Not used');},
    async closeTab(): Promise<never> {throw new Error('Not used');},
    async request(): Promise<unknown> {return onRequest();},
  };
}

describe('public single DOM outcome contract', () => {
  it('preserves UNKNOWN/no-replay through the public MCP mapper after transport loss', async () => {
    let effects = 0;
    const backend = new BrowserCdpBackend({protocol: protocol(() => {effects++; throw new Error('Transport lost after effect');})});
    const response = await create((_tool, request, signal, authorization) => backend.execute(request, signal, authorization)).invoke('dom_cdp', input);
    expect(response).toMatchObject({isError: true, structuredContent: {error: {code: 'INTERNAL_ERROR', message: 'Operation failed', details: unknown}}});
    expect(effects).toBe(1);
  });

  it('reports UNKNOWN when the parent ends after dispatch and does not replay on late success', async () => {
    const controller = new AbortController();
    let entered!: () => void;
    let complete!: (result: Result<unknown>) => void;
    const ready = new Promise<void>(resolve => {entered = resolve;});
    let effects = 0;
    const registry = create(() => {
      effects++; entered();
      return new Promise(resolve => {complete = resolve;});
    });
    const pending = registry.invoke('dom_cdp', input, undefined, controller.signal);
    await ready;
    controller.abort();
    const response = await pending;
    complete(ok({ok: true}));
    expect(response).toMatchObject({isError: true, structuredContent: {error: {code: 'PROCESS_TIMEOUT', details: unknown}}});
    await Promise.resolve();
    expect(effects).toBe(1);
  });

  it('reports UNKNOWN when the response budget expires while an operation is unfinished', async () => {
    let complete!: (result: Result<unknown>) => void;
    let effects = 0;
    const registry = create(() => {effects++; return new Promise(resolve => {complete = resolve;});}, true, 15);
    const response = await registry.invoke('dom_cdp', input);
    complete(ok({ok: true}));
    expect(response).toMatchObject({isError: true, structuredContent: {error: {code: 'PROCESS_TIMEOUT', details: unknown}}});
    expect(effects).toBe(1);
  });

  it('handles abort inside the capability invocation without claiming nothing was dispatched', async () => {
    const controller = new AbortController();
    let effects = 0;
    const response = await create(() => {effects++; controller.abort(); return Promise.resolve(ok({ok: true}));})
      .invoke('dom_cdp', input, undefined, controller.signal);
    expect(response).toMatchObject({isError: true, structuredContent: {error: {code: 'PROCESS_TIMEOUT', details: unknown}}});
    expect(effects).toBe(1);
  });

  it('retains in-flight lifecycle after reentrant cancellation until the held operation settles', async () => {
    const controller = new AbortController();
    let complete!: (result: Result<unknown>) => void;
    let effects = 0;
    const registry = create(() => {
      effects++;
      controller.abort();
      return new Promise(resolve => {complete = resolve;});
    });
    const response = await registry.invoke('dom_cdp', input, undefined, controller.signal);
    expect(response).toMatchObject({isError: true, structuredContent: {error: {details: unknown}}});
    expect(registry.listInFlight()).toHaveLength(1);
    complete(ok({ok: true}));
    await vi.waitFor(() => {expect(registry.listInFlight()).toHaveLength(0);});
    expect(effects).toBe(1);
  });

  it('retains sanitized diagnostics and UNKNOWN when the capability rejects unexpectedly', async () => {
    let effects = 0;
    const response = await create(async () => {effects++; throw new Error('fixture private detail must not leak');}).invoke('dom_cdp', input);
    expect(response).toMatchObject({isError: true, structuredContent: {error: {code: 'INTERNAL_ERROR', details: unknown}}});
    expect(JSON.stringify(response)).not.toContain('fixture private detail must not leak');
    expect(effects).toBe(1);
  });

  it('retains sanitized UNKNOWN when the capability throws synchronously after an effect', async () => {
    let effects = 0;
    const response = await create(() => {effects++; throw new Error('private synchronous fixture detail');}).invoke('dom_cdp', input);
    expect(response).toMatchObject({isError: true, structuredContent: {error: {code: 'INTERNAL_ERROR', details: unknown}}});
    expect(JSON.stringify(response)).not.toContain('private synchronous fixture detail');
    expect(effects).toBe(1);
  });

  it('keeps a denied approval at zero dispatch with the original denial reason', async () => {
    let effects = 0;
    const response = await create(async () => {effects++; return ok({ok: true});}, false).invoke('dom_cdp', input);
    expect(response).toMatchObject({isError: true, structuredContent: {error: {code: 'PERMISSION_DENIED', details: {denialSource: 'host_approval_adapter'}}}});
    expect(effects).toBe(0);
  });

  it('keeps cancellation before approval at zero dispatch', async () => {
    const controller = new AbortController();
    controller.abort();
    let effects = 0;
    const response = await create(async () => {effects++; return ok({ok: true});}).invoke('dom_cdp', input, undefined, controller.signal);
    expect(response.isError).toBe(true);
    expect(effects).toBe(0);
  });

  it('does not change normal successful responses', async () => {
    let effects = 0;
    const response = await create(async () => {effects++; return ok({ok: true, fixtureId: 9});}).invoke('dom_cdp', input);
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toEqual({ok: true, fixtureId: 9});
    expect(effects).toBe(1);
  });

  it.each(['query', 'batch'])('keeps the existing %s response-budget contract', async mode => {
    let complete!: (result: Result<unknown>) => void;
    let calls = 0;
    const registry = create(() => {calls++; return new Promise(resolve => {complete = resolve;});}, true, 15);
    const request = mode === 'query'
      ? {action: 'query', tab_id: input.tab_id, parameters: {selector: 'main'}}
      : {tab_id: input.tab_id, userConfirmed: true, steps: [{action: 'evaluate', parameters: input.parameters}]};
    const response = await registry.invoke('dom_cdp', request);
    complete(ok({ok: true}));
    expect(response).toMatchObject({isError: true, structuredContent: {error: {code: 'PROCESS_TIMEOUT'}}});
    const error = response.structuredContent?.error as {details?: unknown};
    expect(error.details).toBeUndefined();
    expect(calls).toBe(1);
  });
});

