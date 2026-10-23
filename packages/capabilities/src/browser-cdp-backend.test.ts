import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appError, err, type Result } from '@lnwjud/domain';
import { CAPABILITY_ACTIVE_WORKSPACE_ROOT_METADATA_KEY } from './task-ownership.js';
import { BrowserCdpBackend, type BrowserCdpProtocol, type BrowserCdpTab } from './browser-cdp-backend.js';

const tab = (id: string, title: string, url: string): BrowserCdpTab => ({
  id,
  title,
  url,
  webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${id}`,
});

function protocolStub(options: {
  readonly tabs: readonly BrowserCdpTab[];
  readonly onRequest?: (tabId: string, method: string, params: Record<string, unknown>) => void;
  readonly responseForRequest?: (tabId: string, method: string, params: Record<string, unknown>) => unknown;
  readonly onClose?: (tabId: string) => void;
}): BrowserCdpProtocol {
  return {
    async status(): Promise<{ readonly ready: boolean; readonly port: number }> { return { ready: true, port: 9222 }; },
    async listTabs(): Promise<readonly BrowserCdpTab[]> { return options.tabs; },
    async newTab(url): Promise<BrowserCdpTab> { return tab('new-tab', '', url); },
    async closeTab(tabId): Promise<unknown> { options.onClose?.(tabId); return { closed: true }; },
    async request(tabId, method, params): Promise<unknown> {
      options.onRequest?.(tabId, method, params);
      if (options.responseForRequest !== undefined) return options.responseForRequest(tabId, method, params);
      if (method === 'Page.captureScreenshot') return { result: { data: 'aGVsbG8=' } };
      if (method === 'Page.navigate') return { result: { frameId: 'fixture-frame', loaderId: 'fixture-loader' } };
      return { result: { result: { value: method === 'Runtime.evaluate' ? { ok: true, isContentEditable: false, value: 'hello', text: 'hello', tag: 'DIV' } : { ok: true } } } };
    },
  };
}

function reorderingProtocolStub(options: {
  readonly first: readonly BrowserCdpTab[];
  readonly later: readonly BrowserCdpTab[];
  readonly onRequest: (tabId: string) => void;
}): BrowserCdpProtocol {
  let listCount = 0;
  const base = protocolStub({ tabs: options.first, onRequest: (tabId) => options.onRequest(tabId) });
  return {
    ...base,
    async listTabs(): Promise<readonly BrowserCdpTab[]> {
      listCount += 1;
      return listCount === 1 ? options.first : options.later;
    },
  };
}

function protectedActionInput(action: 'navigate' | 'close_tab' | 'evaluate' | 'click' | 'type' | 'set_files'): Record<string, unknown> {
  const parameters = action === 'navigate'
    ? { url: 'https://example.com/' }
    : action === 'evaluate'
      ? { expression: 'document.title' }
      : action === 'click'
        ? { selector: '#continue' }
        : action === 'type'
          ? { selector: '#prompt', text: 'test' }
          : action === 'set_files'
            ? { selector: 'input[type=file]', files: ['C:\\fixture.txt'] }
            : {};
  return { action, tab_id: 'chatgpt-tab', parameters, userConfirmed: true };
}

describe('BrowserCdpBackend', () => {
  it('retains completed steps and unknown effects after a transport exception without replay', async () => {
    let requests = 0;
    const backend = new BrowserCdpBackend({ protocol: protocolStub({ tabs: [tab('fixture', 'Fixture', 'http://127.0.0.1/')], responseForRequest: () => { if (++requests === 2) throw new Error('Transport lost');return { result: { result: { value: { ok: true } } } }; } }) });
    const result = await backend.execute({ tab_id: 'fixture', userConfirmed: true, steps: [{ action: 'click', parameters: { selector: '#one' } }, { action: 'query', parameters: { selector: '#state' } }, { action: 'click', parameters: { selector: '#commit' } }] });
    expect(result).toMatchObject({ ok: false, error: { details: { completedSteps: 1, failedAction: 'query', effectState: 'UNKNOWN', automaticReplayAllowed: 0 } } });
    expect(requests).toBe(2);
  });
  it.each([-1, 0, 2, '0.1', Number.NaN])('rejects unsafe polling interval %s before browser dispatch', async (pollInterval) => {
    let requests = 0;
    const backend = new BrowserCdpBackend({ protocol: protocolStub({ tabs: [tab('fixture', 'Fixture', 'http://127.0.0.1/')], onRequest: () => requests++ }) });
    expect(await backend.execute({ action: 'wait', tab_id: 'fixture', userConfirmed: true, parameters: { selector: '#field', poll_interval_seconds: pollInterval } })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(requests).toBe(0);
  });
  it.each(['status', 'tabs'] as const)('does not dispatch or launch after query lookup cancellation during %s', async (phase) => {
    const controller = new AbortController();let launches = 0;let requests = 0;
    const base = protocolStub({ tabs: [tab('tab-1', 'Fixture', 'https://example.com/form')], onRequest: () => requests++ });
    const protocol: BrowserCdpProtocol = { ...base, status: async (): ReturnType<BrowserCdpProtocol['status']> => { if (phase === 'status') controller.abort();return { ready: phase !== 'status', port: 9222 }; }, listTabs: async (): ReturnType<BrowserCdpProtocol['listTabs']> => { if (phase === 'tabs') controller.abort();return [tab('tab-1', 'Fixture', 'https://example.com/form')]; } };
    const backend = new BrowserCdpBackend({ protocol, launcher: async (): Promise<Result<unknown>> => { launches++;return { ok: true, value: {} }; } });
    const response = await backend.execute({ action: 'query', tab_id: 'tab-1', parameters: { selector: '#field' } }, controller.signal);
    expect(response).toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });expect(launches).toBe(0);expect(requests).toBe(0);
  });

  it.each(['list_tabs', 'query', 'wait', 'screenshot'] as const)('never launches a stopped browser for read-only %s', async (action) => {
    let launches = 0;let requests = 0;
    const base = protocolStub({ tabs: [], onRequest: () => requests++ });
    const backend = new BrowserCdpBackend({ protocol: { ...base, status: async (): ReturnType<BrowserCdpProtocol['status']> => ({ ready: false, port: 9222 }) }, launcher: async (): Promise<Result<unknown>> => { launches++;return { ok: true, value: {} }; } });
    const result = await backend.execute({ action, tab_id: 'tab-1', parameters: { selector: '#field' } });
    expect(result).toMatchObject({ ok: false, error: { code: 'PROCESS_NOT_FOUND' } });expect(launches).toBe(0);expect(requests).toBe(0);
  });

  it('does not execute expression waits in protected tabs without the protected override', async () => {
    let requests = 0;
    const backend = new BrowserCdpBackend({ protocol: protocolStub({ tabs: [tab('chatgpt-tab', 'ChatGPT', 'https://chatgpt.com/')], onRequest: () => requests++ }) });
    expect(await backend.execute({ action: 'wait', tab_id: 'chatgpt-tab', parameters: { expression: 'true' }, userConfirmed: true })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(requests).toBe(0);
  });
  it('reads tabs for approval only when Chrome is already ready and never invokes the launcher', async () => {
    let launches = 0;
    const backend = new BrowserCdpBackend({
      protocol: protocolStub({ tabs: [tab('approval-tab', 'Fixture', 'http://127.0.0.1/')] }),
      launcher: async (): Promise<Result<unknown>> => { launches += 1; return { ok: true, value: { launched: true } }; },
    });
    await expect(backend.listTabsIfRunning()).resolves.toMatchObject({ ok: true, value: { ready: true, tabs: [expect.objectContaining({ id: 'approval-tab' })] } });
    expect(launches).toBe(0);
  });

  it('does not launch Chrome when approval tab lookup is not ready or listTabs fails after readiness', async () => {
    let launches = 0;
    const unavailableBase = protocolStub({ tabs: [] });
    const unavailable = new BrowserCdpBackend({
      protocol: { ...unavailableBase, async status(): Promise<{ readonly ready: boolean; readonly port: number }> { return { ready: false, port: 9222 }; } },
      launcher: async (): Promise<Result<unknown>> => { launches += 1; return { ok: true, value: { launched: true } }; },
    });
    await expect(unavailable.listTabsIfRunning()).resolves.toMatchObject({ ok: true, value: { ready: false, tabs: [] } });
    const failedBase = protocolStub({ tabs: [] });
    const failed = new BrowserCdpBackend({
      protocol: { ...failedBase, async listTabs(): Promise<readonly BrowserCdpTab[]> { throw new Error('endpoint disappeared'); } },
      launcher: async (): Promise<Result<unknown>> => { launches += 1; return { ok: true, value: { launched: true } }; },
    });
    await expect(failed.listTabsIfRunning()).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_NOT_FOUND' } });
    expect(launches).toBe(0);
  });

  it('does not contact or launch Chrome for an already-aborted approval tab lookup', async () => {
    let statusCalls = 0;
    let launches = 0;
    const base = protocolStub({ tabs: [] });
    const backend = new BrowserCdpBackend({
      protocol: { ...base, async status(): Promise<{ readonly ready: boolean; readonly port: number }> { statusCalls += 1; return { ready: true, port: 9222 }; } },
      launcher: async (): Promise<Result<unknown>> => { launches += 1; return { ok: true, value: { launched: true } }; },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(backend.listTabsIfRunning(controller.signal)).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    expect(statusCalls).toBe(0);
    expect(launches).toBe(0);
  });

  it.each(['type', 'click', 'query'] as const)('stops a batch after a semantic %s failure without dispatching later steps', async (action) => {
    let dispatched = 0;
    const protocol = protocolStub({
      tabs: [tab('fixture', 'Fixture', 'http://127.0.0.1/')],
      responseForRequest: () => { dispatched += 1; return { result: { result: { value: { ok: false, error: 'Element not found' } } } }; },
    });
    const result = await new BrowserCdpBackend({ protocol }).execute({ tab_id: 'fixture', userConfirmed: true, steps: [
      { action, parameters: { selector: '#missing', text: 'first' } },
      { action: 'type', parameters: { selector: '#must-not-run', text: 'second' } },
    ] });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', recoverable: false } });
    expect(JSON.stringify(result)).toContain('step 1');
    expect(dispatched).toBe(1);
  });

  it('preserves an evaluate result containing ok:false as application data', async () => {
    let dispatched = 0;
    const protocol = protocolStub({
      tabs: [tab('fixture', 'Fixture', 'http://127.0.0.1/')],
      responseForRequest: () => { dispatched += 1; return { result: { result: { value: { ok: dispatched > 1, error: 'application data' } } } }; },
    });
    const result = await new BrowserCdpBackend({ protocol }).execute({ tab_id: 'fixture', userConfirmed: true, steps: [
      { action: 'evaluate', parameters: { expression: '({ok:false})' } },
      { action: 'query', parameters: { selector: '#read' } },
    ] });
    expect(result.ok).toBe(true);
    expect(dispatched).toBe(2);
  });

  it('stops a timed-out batch wait before any following input dispatch', async () => {
    const expressions: string[] = [];
    const protocol = protocolStub({
      tabs: [tab('fixture', 'Fixture', 'http://127.0.0.1/')],
      responseForRequest: (_id, _method, params) => { expressions.push(String(params.expression)); return { result: { result: { value: false } } }; },
    });
    const result = await new BrowserCdpBackend({ protocol }).execute({ tab_id: 'fixture', timeout_seconds: 0.1, userConfirmed: true, steps: [
      { action: 'wait', parameters: { selector: '#not-ready', poll_interval_seconds: 0.02 } },
      { action: 'type', parameters: { selector: '#must-not-run', text: 'second' } },
    ] });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', recoverable: false } });
    expect(JSON.stringify(result)).toContain('Wait timed out');
    expect(expressions.length).toBeGreaterThan(0);
    expect(expressions.every((expression) => expression === 'Boolean(document.querySelector("#not-ready"))')).toBe(true);
  });

  it.each(['type', 'click', 'query'] as const)('stops before submit after a %s script exception', async (action) => {
    let dispatched = 0;
    const protocol = protocolStub({
      tabs: [tab('fixture', 'Fixture', 'http://127.0.0.1/')],
      responseForRequest: () => { dispatched += 1; return { result: { exceptionDetails: { text: 'Uncaught SyntaxError' }, result: { type: 'object', subtype: 'error' } } }; },
    });
    const result = await new BrowserCdpBackend({ protocol }).execute({ tab_id: 'fixture', userConfirmed: true, steps: [
      { action, parameters: { selector: '[', text: 'invalid selector' } },
      { action: 'click', parameters: { selector: '#submit' } },
    ] });
    expect(result.ok).toBe(false);
    expect(dispatched).toBe(1);
  });

  for (const envelope of [{ type: 'undefined' }, {}]) {
    it.each(['type', 'click', 'query'] as const)('stops before submit after a malformed %s target response: '+JSON.stringify(envelope), async (action) => {
      let dispatched = 0;
      const protocol = protocolStub({ tabs: [tab('fixture', 'Fixture', 'http://127.0.0.1/')], responseForRequest: () => { dispatched += 1; return { result: { result: envelope } }; } });
      const result = await new BrowserCdpBackend({ protocol }).execute({ tab_id: 'fixture', userConfirmed: true, steps: [
        { action, parameters: { selector: '#field', text: 'value' } },
        { action: 'click', parameters: { selector: '#submit' } },
      ] });
      expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
      expect(dispatched).toBe(1);
    });
  }

  it('keeps dry-run target batches independent of live DOM response shapes', async () => {
    let dispatched = 0;
    const protocol = protocolStub({ tabs: [], onRequest: () => { dispatched += 1; } });
    const result = await new BrowserCdpBackend({ protocol }).execute({ tab_id: 'fixture', dry_run: true, steps: [
      { action: 'type', parameters: { selector: '#field', text: 'value' } },
      { action: 'query', parameters: { selector: '#field' } },
      { action: 'click', parameters: { selector: '#submit' } },
    ] });
    expect(result.ok).toBe(true);
    expect(dispatched).toBe(0);
  });

  it('allows evaluated undefined as application data before a valid query', async () => {
    let dispatched = 0;
    const protocol = protocolStub({ tabs: [tab('fixture', 'Fixture', 'http://127.0.0.1/')], responseForRequest: () => {
      dispatched += 1;
      return { result: { result: dispatched === 1 ? { type: 'undefined' } : { value: { ok: true, text: 'found' } } } };
    } });
    const result = await new BrowserCdpBackend({ protocol }).execute({ tab_id: 'fixture', userConfirmed: true, steps: [
      { action: 'evaluate', parameters: { expression: 'undefined' } },
      { action: 'query', parameters: { selector: '#field' } },
    ] });
    expect(result.ok).toBe(true);
    expect(dispatched).toBe(2);
  });

  it('runs a DOM query through the Chrome DevTools protocol', async () => {
    const requests: { readonly method: string; readonly params: Record<string, unknown> }[] = [];
    const protocol = protocolStub({
      tabs: [tab('tab-1', 'Test', 'http://127.0.0.1/')],
      onRequest: (_tabId, method, params) => requests.push({ method, params }),
    });
    const backend = new BrowserCdpBackend({ protocol });

    const result = await backend.execute({ action: 'query', tab_id: 'tab-1', parameters: { selector: '#app' } });

    expect(result).toMatchObject({ ok: true, value: { ok: true, text: 'hello', tag: 'DIV' } });
    expect(requests[0]?.method).toBe('Runtime.evaluate');
    expect(requests[0]?.params.expression).toContain('document.querySelector');
  });

  it('does not launch Chrome for a structured query when the managed browser is stopped', async () => {
    let launches = 0;
    const base = protocolStub({ tabs: [] });
    const protocol: BrowserCdpProtocol = {
      ...base,
      async status(): Promise<{ readonly ready: boolean; readonly port: number }> { return { ready: false, port: 9222 }; },
    };
    const backend = new BrowserCdpBackend({
      protocol,
      launcher: async (): Promise<Result<unknown>> => { launches += 1; return { ok: true, value: { launched: true } }; },
    });

    await expect(backend.execute({
      action: 'query',
      tab_id: 'invoice-tab',
      parameters: {
        page: { origin: 'https://shop.example', pathname: '/stock-in/batch', title: 'Invoice' },
        queries: [{ key: 'bill', selector: '#bill', expect: { count: 1 }, fields: ['value'] }],
      },
    })).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_NOT_FOUND' } });
    expect(launches).toBe(0);
  });

  it('uses a bounded structured query contract and stops a batch before typing when an expectation fails', async () => {
    let dispatched = 0;
    const protocol = protocolStub({
      tabs: [tab('tab-1', 'Invoice', 'https://shop.example/stock-in/batch')],
      responseForRequest: (_tabId, _method, params) => {
        dispatched += 1;
        expect(String(params.expression)).toContain('structured query');
        return { result: { result: { value: { ok: false, error: 'Expected count 1 but found 0', queries: [] } } } };
      },
    });

    const result = await new BrowserCdpBackend({ protocol }).execute({
      tab_id: 'tab-1',
      userConfirmed: true,
      steps: [
        { action: 'query', parameters: {
          page: { origin: 'https://shop.example', pathname: '/stock-in/batch', title: 'Invoice' },
          queries: [{ key: 'supplier', selector: '#sourceSearch', expect: { count: 1, value: 'Ubon' }, fields: ['value', 'visible'] }],
        } },
        { action: 'type', parameters: { selector: '#must-not-run', text: 'nope' } },
      ],
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(dispatched).toBe(1);
  });

  it('requires exact text before issuing an opt-in mouse event sequence', async () => {
    const requests: Record<string, unknown>[] = [];
    const protocol = protocolStub({
      tabs: [tab('tab-1', 'Invoice', 'https://shop.example/stock-in/batch')],
      onRequest: (_tabId, _method, params) => requests.push(params),
    });
    const backend = new BrowserCdpBackend({ protocol });

    await expect(backend.execute({
      action: 'click', tab_id: 'tab-1', userConfirmed: true,
      parameters: { selector: '#supplier', mouse_event_sequence: true },
    })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(requests).toEqual([]);

    await expect(backend.execute({
      action: 'click', tab_id: 'tab-1', userConfirmed: true,
      parameters: { selector: '#supplier', mouse_event_sequence: true, expected_text: 'Ubon supplier' },
    })).resolves.toMatchObject({ ok: true, value: { ok: true } });
    expect(String(requests[0]?.expression)).toContain("['mousedown','mouseup','click']");
  });

  it('requires application approval for expression wait and rejects a mixed wait contract', async () => {
    const backend = new BrowserCdpBackend({ protocol: protocolStub({ tabs: [tab('tab-1', 'Invoice', 'https://shop.example/stock-in/batch')] }) });
    await expect(backend.execute({
      action: 'wait', tab_id: 'tab-1', parameters: { expression: 'window.done' }, timeout_seconds: 0.1,
    })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    await expect(backend.execute({
      action: 'wait', tab_id: 'tab-1', userConfirmed: true,
      parameters: { selector: '#receipt', expression: 'window.done' }, timeout_seconds: 0.1,
    })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('returns a structured acknowledgement for Page.navigate without claiming page-load completion', async () => {
    const protocol = protocolStub({ tabs: [tab('tab-1', 'Test', 'http://127.0.0.1/')] });
    const backend = new BrowserCdpBackend({ protocol });

    const result = await backend.execute({
      action: 'navigate',
      tab_id: 'tab-1',
      parameters: { url: 'http://127.0.0.1/next' },
      userConfirmed: true,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        navigation_requested: true,
        navigation_complete: false,
        frame_id: 'fixture-frame',
        loader_id: 'fixture-loader',
      },
    });
  });

  it.each([
    ['protocol error', { error: { code: -32000, message: 'secret raw protocol detail' } }],
    ['navigation error', { result: { frameId: 'fixture-frame', errorText: 'net::ERR_NAME_NOT_RESOLVED' } }],
    ['malformed response', { result: {} }],
  ] as const)('rejects a %s from Page.navigate without returning raw protocol details', async (_label, response) => {
    const protocol = protocolStub({
      tabs: [tab('tab-1', 'Test', 'http://127.0.0.1/')],
      responseForRequest: () => response,
    });

    const result = await new BrowserCdpBackend({ protocol }).execute({
      action: 'navigate',
      tab_id: 'tab-1',
      parameters: { url: 'http://127.0.0.1/next' },
      userConfirmed: true,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    if (!result.ok) {
      expect(result.error.message).not.toContain('secret raw protocol detail');
      expect(result.error.message).not.toContain('ERR_NAME_NOT_RESOLVED');
    }
  });

  it('marks Page.navigate download responses without claiming completion', async () => {
    const protocol = protocolStub({
      tabs: [tab('tab-1', 'Test', 'http://127.0.0.1/')],
      responseForRequest: () => ({ result: { frameId: 'fixture-frame', isDownload: true } }),
    });

    const result = await new BrowserCdpBackend({ protocol }).execute({
      action: 'navigate',
      tab_id: 'tab-1',
      parameters: { url: 'http://127.0.0.1/download' },
      userConfirmed: true,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        navigation_requested: true,
        navigation_complete: false,
        frame_id: 'fixture-frame',
        is_download: true,
      },
    });
  });

  it('does not navigate any tab when tab_id is absent', async () => {
    const requested: string[] = [];
    const protocol = protocolStub({
      tabs: [
        tab('chatgpt-tab', 'ChatGPT', 'https://chatgpt.com/c/example'),
        tab('supabase-tab', 'Supabase', 'https://supabase.com/dashboard/project'),
      ],
      onRequest: (tabId) => requested.push(tabId),
    });

    const result = await new BrowserCdpBackend({ protocol }).execute({
      action: 'navigate',
      parameters: { url: 'https://supabase.com/dashboard/project/sql' },
      userConfirmed: true,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT', message: expect.stringContaining('tab_id') },
    });
    expect(requested).toEqual([]);
  });

  it('keeps every step on the explicit tab when list ordering changes', async () => {
    const requested: string[] = [];
    const protocol = reorderingProtocolStub({
      first: [
        tab('supabase-tab', 'Supabase', 'https://supabase.com/dashboard'),
        tab('chatgpt-tab', 'ChatGPT', 'https://chatgpt.com/c/example'),
      ],
      later: [
        tab('chatgpt-tab', 'ChatGPT', 'https://chatgpt.com/c/example'),
        tab('supabase-tab', 'Supabase', 'https://supabase.com/dashboard'),
      ],
      onRequest: (tabId) => requested.push(tabId),
    });

    const result = await new BrowserCdpBackend({ protocol }).execute({
      tab_id: 'supabase-tab',
      steps: [
        { action: 'query', parameters: { selector: '#sql-editor' } },
        { action: 'click', parameters: { selector: '#run' } },
      ],
      userConfirmed: true,
    });

    expect(result).toMatchObject({ ok: true });
    expect(requested).toEqual(['supabase-tab', 'supabase-tab']);
  });

  it('does not dispatch later DOM side effects after the caller aborts', async () => {
    const actions: string[] = [];
    const controller = new AbortController();
    const protocol = protocolStub({
      tabs: [tab('tab-1', 'Test', 'http://127.0.0.1/')],
      onRequest: (_tabId, method) => {
        actions.push(method);
        controller.abort();
      },
    });
    const backend = new BrowserCdpBackend({ protocol });

    const result = await backend.execute({
      steps: [
        { action: 'query', parameters: { selector: '#one' } },
        { action: 'click', parameters: { selector: '#one' } },
      ],
      tab_id: 'tab-1',
    }, controller.signal);

    expect(result).toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    expect(actions).toEqual(['Runtime.evaluate']);
  });

  it.each(['navigate', 'close_tab', 'evaluate', 'click', 'type', 'set_files'] as const)(
    'blocks %s on a ChatGPT tab without an explicit protected-tab confirmation',
    async (action) => {
      const requests: string[] = [];
      const closes: string[] = [];
      const protocol = protocolStub({
        tabs: [tab('chatgpt-tab', 'ChatGPT', 'https://chatgpt.com/c/example')],
        onRequest: (tabId) => requests.push(tabId),
        onClose: (tabId) => closes.push(tabId),
      });

      const result = await new BrowserCdpBackend({ protocol }).execute(protectedActionInput(action));

      expect(result).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
      expect(requests).toEqual([]);
      expect(closes).toEqual([]);
    },
  );

  it('does not let Full Bypass imply protected-tab confirmation', async () => {
    const requests: string[] = [];
    const protocol = protocolStub({
      tabs: [tab('chatgpt-tab', 'ChatGPT', 'https://chatgpt.com/c/example')],
      onRequest: (tabId) => requests.push(tabId),
    });
    const authorization = {
      mode: 'full_bypass',
      applicationApproved: true,
      bypassApplicationAuthorization: true,
      source: 'full_bypass',
    } as const;

    const result = await new BrowserCdpBackend({ protocol }).execute({
      action: 'navigate',
      tab_id: 'chatgpt-tab',
      parameters: { url: 'https://example.com/' },
    }, undefined, authorization);

    expect(result).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(requests).toEqual([]);
  });

  it('allows an explicitly confirmed protected-tab action', async () => {
    const requests: string[] = [];
    const protocol = protocolStub({
      tabs: [tab('chatgpt-tab', 'ChatGPT', 'https://chatgpt.com/c/example')],
      onRequest: (tabId) => requests.push(tabId),
    });

    const result = await new BrowserCdpBackend({ protocol }).execute({
      action: 'navigate',
      tab_id: 'chatgpt-tab',
      allow_protected_tab_action: true,
      parameters: { url: 'https://example.com/' },
      userConfirmed: true,
    });

    expect(result).toMatchObject({ ok: true });
    expect(requests).toEqual(['chatgpt-tab']);
  });

  it('rejects an unknown explicit tab without dispatch', async () => {
    const requests: string[] = [];
    const protocol = protocolStub({
      tabs: [tab('supabase-tab', 'Supabase', 'https://supabase.com/dashboard')],
      onRequest: (tabId) => requests.push(tabId),
    });

    const result = await new BrowserCdpBackend({ protocol }).execute({
      action: 'query',
      tab_id: 'missing-tab',
      parameters: { selector: 'body' },
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(requests).toEqual([]);
  });

  it('rejects step-level tab switching', async () => {
    const requests: string[] = [];
    const protocol = protocolStub({
      tabs: [
        tab('supabase-tab', 'Supabase', 'https://supabase.com/dashboard'),
        tab('chatgpt-tab', 'ChatGPT', 'https://chatgpt.com/c/example'),
      ],
      onRequest: (tabId) => requests.push(tabId),
    });

    const result = await new BrowserCdpBackend({ protocol }).execute({
      tab_id: 'supabase-tab',
      steps: [
        { action: 'query', parameters: { selector: 'body' } },
        { action: 'click', parameters: { selector: '#run', tab_id: 'chatgpt-tab' } },
      ],
      userConfirmed: true,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(requests).toEqual([]);
  });

  it('normalizes a legacy direct parameters.tab_id once', async () => {
    const requests: string[] = [];
    const protocol = protocolStub({
      tabs: [tab('tab-1', 'Legacy', 'https://example.com/')],
      onRequest: (tabId) => requests.push(tabId),
    });

    const result = await new BrowserCdpBackend({ protocol }).execute({
      action: 'query',
      parameters: { selector: 'body', tab_id: 'tab-1' },
    });

    expect(result).toMatchObject({ ok: true });
    expect(requests).toEqual(['tab-1']);
  });

  it('rejects conflicting top-level and legacy direct tab IDs', async () => {
    const requests: string[] = [];
    const protocol = protocolStub({
      tabs: [tab('tab-1', 'One', 'https://example.com/'), tab('tab-2', 'Two', 'https://example.org/')],
      onRequest: (tabId) => requests.push(tabId),
    });

    const result = await new BrowserCdpBackend({ protocol }).execute({
      action: 'query',
      tab_id: 'tab-1',
      parameters: { selector: 'body', tab_id: 'tab-2' },
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(requests).toEqual([]);
  });

  it('does not launch managed Chrome for read-only tab listing', async () => {
    let ready = false;
    let launches = 0;
    const base = protocolStub({ tabs: [tab('tab-1', 'Test', 'http://127.0.0.1/')] });
    const protocol: BrowserCdpProtocol = {
      ...base,
      async status(): Promise<{ readonly ready: boolean; readonly port: number }> { return { ready, port: 9222 }; },
    };
    const backend = new BrowserCdpBackend({
      protocol,
      launcher: async (): Promise<Result<unknown>> => {
        launches += 1;
        await Promise.resolve();
        ready = true;
        return { ok: true, value: { ready: true, port: 9222, launched: true } };
      },
    });

    await Promise.all([
      expect(backend.execute({ action: 'list_tabs' })).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_NOT_FOUND' } }),
      expect(backend.execute({ action: 'list_tabs' })).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_NOT_FOUND' } }),
    ]);
    expect(launches).toBe(0);
  });

  it('keeps a shared browser start alive when one concurrent waiter aborts', async () => {
    let launches = 0;
    let resolveLaunch!: (result: Result<unknown>) => void;
    const base = protocolStub({ tabs: [tab('tab-1', 'Test', 'http://127.0.0.1/')] });
    const protocol: BrowserCdpProtocol = {
      ...base,
      async status(): Promise<{ readonly ready: boolean; readonly port: number }> { return { ready: false, port: 9222 }; },
    };
    const backend = new BrowserCdpBackend({
      protocol,
      launcher: (_url, signal): Promise<Result<unknown>> => {
        launches += 1;
        return new Promise((resolve) => {
          resolveLaunch = resolve;
          signal?.addEventListener('abort', () => resolve(err(appError('PROCESS_TIMEOUT', 'launcher cancelled', true))), { once: true });
        });
      },
    });
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = backend.ensureStarted(undefined, firstController.signal);
    await Promise.resolve();
    const second = backend.ensureStarted(undefined, secondController.signal);
    await Promise.resolve();
    firstController.abort();

    await expect(first).resolves.toMatchObject({ ok: false, error: { code: 'PROCESS_TIMEOUT' } });
    resolveLaunch({ ok: true, value: { ready: true, port: 9222, launched: true } });
    await expect(second).resolves.toMatchObject({ ok: true, value: { ready: true, port: 9222, launched: true } });
    expect(launches).toBe(1);
  });

  it('does not start or dispatch a mutating DOM action without confirmation', async () => {
    let dispatched = false;
    let launches = 0;
    const base = protocolStub({
      tabs: [tab('tab-1', 'Test', 'http://127.0.0.1/')],
      onRequest: () => { dispatched = true; },
    });
    const protocol: BrowserCdpProtocol = {
      ...base,
      async status(): Promise<{ readonly ready: boolean; readonly port: number }> { return { ready: false, port: 9222 }; },
    };
    const backend = new BrowserCdpBackend({
      protocol,
      launcher: async (): Promise<Result<unknown>> => {
        launches += 1;
        return { ok: true, value: { ready: true, port: 9222, launched: true } };
      },
    });

    await expect(backend.execute({ action: 'click', tab_id: 'tab-1', parameters: { selector: '#delete' } }))
      .resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_REQUIRED' } });
    expect(launches).toBe(0);
    expect(dispatched).toBe(false);
  });

  it('accepts trusted Full Bypass authorization for a mutating non-protected DOM action', async () => {
    let dispatched = false;
    const protocol = protocolStub({
      tabs: [tab('tab-1', 'Test', 'http://127.0.0.1/')],
      onRequest: () => { dispatched = true; },
    });
    const authorization = { mode: 'full_bypass', applicationApproved: true, bypassApplicationAuthorization: true, source: 'full_bypass' } as const;

    await expect(new BrowserCdpBackend({ protocol }).execute(
      { action: 'click', tab_id: 'tab-1', parameters: { selector: '#delete' } },
      undefined,
      authorization,
    )).resolves.toMatchObject({ ok: true });
    expect(dispatched).toBe(true);
  });

  it('types into a standard input element using property setter and synthetic events', async () => {
    const requests: { readonly method: string; readonly params: Record<string, unknown> }[] = [];
    const protocol = protocolStub({
      tabs: [tab('tab-1', 'Test', 'http://127.0.0.1/')],
      onRequest: (_tabId, method, params) => requests.push({ method, params }),
      responseForRequest: (_tabId, method) => {
        if (method === 'Runtime.evaluate') {
          return { result: { result: { value: { ok: true, isContentEditable: false, value: 'typed-text', tag: 'INPUT' } } } };
        }
        return { result: {} };
      },
    });

    const result = await new BrowserCdpBackend({ protocol }).execute({
      action: 'type',
      tab_id: 'tab-1',
      parameters: { selector: 'input#title', text: 'typed-text' },
      userConfirmed: true,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        ok: true,
        typed: true,
        isContentEditable: false,
        value: 'typed-text',
        text: 'typed-text',
      },
    });
    expect(requests.some((req) => req.method === 'Runtime.evaluate')).toBe(true);
    expect(requests.some((req) => req.method === 'Input.insertText')).toBe(false);
  });

  it('types into a ProseMirror or contenteditable element by dispatching CDP Input.insertText', async () => {
    const requests: { readonly method: string; readonly params: Record<string, unknown> }[] = [];
    let evalCount = 0;
    const protocol = protocolStub({
      tabs: [tab('tab-1', 'Test', 'http://127.0.0.1/')],
      onRequest: (_tabId, method, params) => requests.push({ method, params }),
      responseForRequest: (_tabId, method) => {
        if (method === 'Runtime.evaluate') {
          evalCount += 1;
          if (evalCount === 1) {
            return { result: { result: { value: { ok: true, isContentEditable: true, tag: 'DIV', text: '' } } } };
          }
          return { result: { result: { value: { ok: true, text: 'Hello ProseMirror' } } } };
        }
        if (method === 'Input.insertText') {
          return { result: {} };
        }
        return { result: {} };
      },
    });

    const result = await new BrowserCdpBackend({ protocol }).execute({
      action: 'type',
      tab_id: 'tab-1',
      parameters: { selector: 'div.ProseMirror', text: 'Hello ProseMirror' },
      userConfirmed: true,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        ok: true,
        typed: true,
        isContentEditable: true,
        tag: 'DIV',
        text: 'Hello ProseMirror',
        value: 'Hello ProseMirror',
      },
    });
    const insertTextCall = requests.find((req) => req.method === 'Input.insertText');
    expect(insertTextCall).toBeDefined();
    expect(insertTextCall?.params).toEqual({ text: 'Hello ProseMirror' });
  });

  it('does not report success when CDP insertText leaves a contenteditable unchanged', async () => {
    let evalCount = 0;
    const protocol = protocolStub({
      tabs: [tab('tab-1', 'Test', 'http://127.0.0.1/')],
      responseForRequest: (_tabId, method) => {
        if (method === 'Runtime.evaluate') {
          evalCount += 1;
          if (evalCount === 1) {
            return { result: { result: { value: { ok: true, isContentEditable: true, tag: 'DIV', text: '' } } } };
          }
          return { result: { result: { value: { ok: true, text: '' } } } };
        }
        if (method === 'Input.insertText') return { result: {} };
        return { result: {} };
      },
    });

    const result = await new BrowserCdpBackend({ protocol }).execute({
      action: 'type',
      tab_id: 'tab-1',
      parameters: { selector: 'div.ProseMirror', text: 'Hello ProseMirror' },
      userConfirmed: true,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
  });

  it('returns structured not-found error when typing into a missing element', async () => {
    const protocol = protocolStub({
      tabs: [tab('tab-1', 'Test', 'http://127.0.0.1/')],
      responseForRequest: (_tabId, method) => {
        if (method === 'Runtime.evaluate') {
          return { result: { result: { value: { ok: false, error: 'Element not found' } } } };
        }
        return { result: {} };
      },
    });

    const result = await new BrowserCdpBackend({ protocol }).execute({
      action: 'type',
      tab_id: 'tab-1',
      parameters: { selector: '#does-not-exist', text: 'test' },
      userConfirmed: true,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        ok: false,
        error: 'Element not found',
        selector: '#does-not-exist',
      },
    });
  });

  it('activates only the explicitly pinned tab before native fallback', async () => {
    const requests: { readonly tabId: string; readonly method: string }[] = [];
    const protocol = protocolStub({
      tabs: [tab('tab-a', 'A', 'https://example.com/a'), tab('tab-b', 'B', 'https://example.com/b')],
      onRequest: (tabId, method) => requests.push({ tabId, method }),
    });

    const result = await new BrowserCdpBackend({ protocol }).execute({
      action: 'activate_tab',
      tab_id: 'tab-b',
      userConfirmed: true,
    });

    expect(result).toEqual({ ok: true, value: { activated: true, tab_id: 'tab-b' } });
    expect(requests).toEqual([{ tabId: 'tab-b', method: 'Page.bringToFront' }]);
  });

  it('sets browser file inputs only from files inside the Active Project', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-browser-upload-'));
    const nested = path.join(root, '0-fixture');
    const file = path.join(nested, 'fixture.txt');
    await mkdir(nested);
    await writeFile(file, 'fixture');
    const canonicalFile = await realpath(file);
    const requests: { readonly method: string; readonly params: Record<string, unknown> }[] = [];
    const protocol = protocolStub({
      tabs: [tab('tab-1', 'Upload', 'https://example.com/upload')],
      onRequest: (_tabId, method, params) => requests.push({ method, params }),
      responseForRequest: (_tabId, method) => {
        if (method === 'DOM.getDocument') return { result: { root: { nodeId: 1 } } };
        if (method === 'DOM.querySelector') return { result: { nodeId: 7 } };
        return { result: {} };
      },
    });

    try {
      const result = await new BrowserCdpBackend({ protocol }).execute({
        action: 'set_files',
        tab_id: 'tab-1',
        parameters: { selector: 'input[type=file]', files: [file] },
        metadata: { [CAPABILITY_ACTIVE_WORKSPACE_ROOT_METADATA_KEY]: root },
        userConfirmed: true,
      });

      expect(result).toEqual({ ok: true, value: { files_set: true, tab_id: 'tab-1', file_count: 1 } });
      expect(requests.map((request) => request.method)).toEqual(['DOM.getDocument', 'DOM.querySelector', 'DOM.setFileInputFiles']);
      expect(requests[2]?.params).toMatchObject({ nodeId: 7, files: [canonicalFile] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects browser file uploads outside the Active Project before any CDP mutation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-browser-root-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-browser-outside-'));
    const file = path.join(outside, 'fixture.txt');
    await writeFile(file, 'fixture');
    const requests: string[] = [];
    const protocol = protocolStub({
      tabs: [tab('tab-1', 'Upload', 'https://example.com/upload')],
      onRequest: (_tabId, method) => requests.push(method),
    });

    try {
      const result = await new BrowserCdpBackend({ protocol }).execute({
        action: 'set_files',
        tab_id: 'tab-1',
        parameters: { selector: 'input[type=file]', files: [file] },
        metadata: { [CAPABILITY_ACTIVE_WORKSPACE_ROOT_METADATA_KEY]: root },
        userConfirmed: true,
      });

      expect(result).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
      expect(requests).toEqual([]);
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });
});
