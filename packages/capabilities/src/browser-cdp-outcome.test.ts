import {describe, expect, it} from 'vitest';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {BrowserCdpBackend, type BrowserCdpProtocol, type BrowserCdpTab} from './browser-cdp-backend.js';
import {CAPABILITY_ACTIVE_WORKSPACE_ROOT_METADATA_KEY} from './task-ownership.js';

const tab = {id: 'fixture-tab', title: 'Fixture', url: 'https://fixture.invalid/', webSocketDebuggerUrl: 'FAKE-NOT-OPENED'};
function fixture(onRequest: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>): BrowserCdpProtocol {
  return {
    async status(): Promise<{ready: boolean; port: number}> { return {ready: true, port: 0}; },
    async listTabs(): Promise<readonly BrowserCdpTab[]> { return [tab]; },
    async newTab(): Promise<BrowserCdpTab> { await onRequest('newTab', {}); return tab; },
    async closeTab(): Promise<unknown> { return onRequest('closeTab', {}); },
    async request(_tabId, method, params): Promise<unknown> { return onRequest(method, params); },
  };
}
const input = {action: 'evaluate', tab_id: tab.id, userConfirmed: true, parameters: {expression: 'fixture effect'}};
const unknown = {effectState: 'UNKNOWN', inspectionRequired: 1, automaticReplayAllowed: 0};
const notDispatched = {effectState: 'NO_MUTATION_DISPATCHED', inspectionRequired: 0, automaticReplayAllowed: 0};

describe('single DOM outcome contract', () => {
  it.each([
    ['evaluate', {expression: 'fixture effect'}],
    ['click', {selector: '#save'}],
    ['type', {selector: '#field', text: 'value'}],
    ['navigate', {url: 'https://fixture.invalid/next'}],
    ['new_tab', {url: 'https://fixture.invalid/next'}],
    ['close_tab', {}],
    ['activate_tab', {}],
    ['wait', {expression: 'fixture effect'}],
  ])('reports uncertain effects after %s dispatch loses its response, without replay', async (action, parameters) => {
    let effects = 0;
    const backend = new BrowserCdpBackend({protocol: fixture(() => {effects++; throw new Error('Transport lost after effect');})});
    const result = await backend.execute({action, parameters, tab_id: tab.id, userConfirmed: true});
    expect(result).toMatchObject({ok: false, error: {code: 'INTERNAL_ERROR', details: unknown}});
    expect(effects).toBe(1);
  });

  it('reports uncertain launch outcome without invoking the launcher again', async () => {
    let launches = 0;
    const base = fixture(() => {throw new Error('No page command expected');});
    const backend = new BrowserCdpBackend({
      protocol: {...base, status: async (): Promise<{ready: boolean; port: number}> => ({ready: false, port: 0})},
      launcher: async (): Promise<never> => {launches++; throw new Error('Launch response lost');},
    });
    expect(await backend.execute({action: 'launch', userConfirmed: true})).toMatchObject({ok: false, error: {details: unknown}});
    expect(launches).toBe(1);
  });

  it('retains uncertainty when cancellation arrives after an effect', async () => {
    const controller = new AbortController();
    let effects = 0;
    const backend = new BrowserCdpBackend({protocol: fixture(() => {
      effects++;
      controller.abort();
      return {result: {result: {value: {ok: true}}}};
    })});
    expect(await backend.execute(input, controller.signal)).toMatchObject({ok: false, error: {code: 'PROCESS_TIMEOUT', details: unknown}});
    expect(effects).toBe(1);
  });

  it('proves no dispatch when already cancelled', async () => {
    let effects = 0;
    const controller = new AbortController();
    controller.abort();
    const backend = new BrowserCdpBackend({protocol: fixture(() => {effects++;})});
    expect(await backend.execute(input, controller.signal)).toMatchObject({ok: false, error: {code: 'PROCESS_TIMEOUT', details: notDispatched}});
    expect(effects).toBe(0);
  });

  it('proves no mutation dispatch when cancelled during tab lookup', async () => {
    let effects = 0;
    const controller = new AbortController();
    const base = fixture(() => {effects++;});
    const backend = new BrowserCdpBackend({protocol: {...base, listTabs: async (): Promise<readonly BrowserCdpTab[]> => {controller.abort(); return [tab];}}});
    expect(await backend.execute(input, controller.signal)).toMatchObject({ok: false, error: {code: 'PROCESS_TIMEOUT', details: notDispatched}});
    expect(effects).toBe(0);
  });

  it('keeps permission refusal before any dispatch', async () => {
    let effects = 0;
    const backend = new BrowserCdpBackend({protocol: fixture(() => {effects++;})});
    expect(await backend.execute({...input, userConfirmed: false})).toMatchObject({ok: false, error: {code: 'PERMISSION_REQUIRED', details: notDispatched}});
    expect(effects).toBe(0);
  });

  it('keeps protected-tab refusal before any mutation dispatch', async () => {
    let effects = 0;
    const base = fixture(() => {effects++;});
    const backend = new BrowserCdpBackend({protocol: {...base, listTabs: async (): Promise<readonly BrowserCdpTab[]> => [{...tab, url: 'https://chatgpt.com/'}]}});
    expect(await backend.execute(input)).toMatchObject({ok: false, error: {code: 'PERMISSION_DENIED', details: notDispatched}});
    expect(effects).toBe(0);
  });

  it('does not label invalid click mode as an uncertain mutation', async () => {
    let effects = 0;
    const backend = new BrowserCdpBackend({protocol: fixture(() => {effects++;})});
    expect(await backend.execute({...input, action: 'click', parameters: {selector: '#save', mouse_event_sequence: true}})).toMatchObject({ok: false, error: {code: 'INVALID_INPUT', details: notDispatched}});
    expect(effects).toBe(0);
  });

  it('leaves successful response unchanged', async () => {
    let effects = 0;
    const backend = new BrowserCdpBackend({protocol: fixture(() => {effects++; return {result: {result: {value: {ok: true, fixtureId: 7}}}};})});
    expect(await backend.execute(input)).toEqual({ok: true, value: {ok: true, fixtureId: 7}});
    expect(effects).toBe(1);
  });

  it.each(['document', 'selector', 'upload'] as const)('marks file upload dispatch correctly when %s fails', async stage => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-dom-upload-'));
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('lnwjud-dom-upload-')) throw new Error('Unsafe fixture cleanup');
    const file = path.join(root, 'fixture.txt');
    await writeFile(file, 'Inert local fixture');
    let effects = 0;
    const backend = new BrowserCdpBackend({protocol: fixture(method => {
      if (method === 'DOM.getDocument') {
        if (stage === 'document') throw new Error('Document response lost before upload');
        return {result: {root: {nodeId: 1}}};
      }
      if (method === 'DOM.querySelector') return {result: {nodeId: stage === 'selector' ? 0 : 7}};
      if (method === 'DOM.setFileInputFiles') {effects++; throw new Error('Upload response lost after effect');}
      throw new Error('Unexpected fixture request');
    })});
    try {
      const result = await backend.execute({action: 'set_files', tab_id: tab.id, userConfirmed: true,
        parameters: {selector: 'input[type=file]', files: [file]},
        metadata: {[CAPABILITY_ACTIVE_WORKSPACE_ROOT_METADATA_KEY]: root}});
      expect(result).toMatchObject({ok: false, error: {details: stage === 'upload' ? unknown : notDispatched}});
      expect(effects).toBe(stage === 'upload' ? 1 : 0);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('preserves a file path refusal without claiming a mutation', async () => {
    let calls = 0;
    const backend = new BrowserCdpBackend({protocol: fixture(() => {calls++;})});
    const result = await backend.execute({action: 'set_files', tab_id: tab.id, userConfirmed: true,
      parameters: {selector: 'input[type=file]', files: ['fixture.txt']}});
    expect(result).toMatchObject({ok: false, error: {code: 'PATH_OUTSIDE_WORKSPACE', details: notDispatched}});
    expect(calls).toBe(0);
  });

  it('does not add mutation metadata to a failed read-only query', async () => {
    const backend = new BrowserCdpBackend({protocol: fixture(() => {throw new Error('Read failed');})});
    const result = await backend.execute({action: 'query', tab_id: tab.id, parameters: {selector: 'main'}});
    expect(result).toMatchObject({ok: false, error: {code: 'INTERNAL_ERROR'}});
    if (!result.ok) expect(result.error.details).not.toHaveProperty('effectState');
  });

  it('keeps existing batch uncertainty metadata', async () => {
    let effects = 0;
    const backend = new BrowserCdpBackend({protocol: fixture(() => {effects++; throw new Error('Transport lost');})});
    expect(await backend.execute({tab_id: tab.id, userConfirmed: true, steps: [{action: 'evaluate', parameters: input.parameters}]}))
      .toMatchObject({ok: false, error: {details: {...unknown, browserBatch: 1, completedSteps: 0}}});
    expect(effects).toBe(1);
  });

  it('keeps dispatch evidence separate across concurrent requests on one backend', async () => {
    let release!: () => void;
    let entered!: () => void;
    let effects = 0;
    const ready = new Promise<void>(resolve => {entered = resolve;});
    const backend = new BrowserCdpBackend({protocol: fixture(async () => {
      effects++; entered();
      await new Promise<void>(resolve => {release = resolve;});
      throw new Error('First request lost response');
    })});
    const first = backend.execute(input);
    await ready;
    const second = await backend.execute({...input, action: 'click', parameters: {mouse_event_sequence: true}});
    expect(second).toMatchObject({ok: false, error: {code: 'INVALID_INPUT', details: notDispatched}});
    release();
    expect(await first).toMatchObject({ok: false, error: {details: unknown}});
    expect(effects).toBe(1);
  });
});

