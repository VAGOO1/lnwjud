import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { permissionProfiles } from '@lnwjud/permissions';
import { LocalCapabilityService, BrowserCdpBackend, NodeBrowserCdpProtocol, type CapabilityBackend } from '@lnwjud/capabilities';
import { createProcessTreeTerminator } from '@lnwjud/process';
import { ok } from '@lnwjud/domain';
import { ToolRegistry, type McpApplicationServices } from './tool-registry.js';
import { fixtureTitle, invoiceThreeStepPlan } from './fixtures/invoice-three-step-plan.js';

describe('three approved browser phases with real generated DOM operations', () => {
  it('opens, prepares 50 fields, commits once and verifies receipt/stock/prices in three approvals', async () => {
    const profile = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-3step-cdp-'));
    const html = await readFile(new URL('./fixtures/invoice-three-step.html', import.meta.url));
    const server = createServer((_q, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html); });
    const port = await listen(server);
    const cdpPort = await unusedPort();
    const chrome = spawn(process.env.LNWJUD_REAL_BROWSER_TEST_EXECUTABLE ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', ['--headless=new', '--no-first-run', '--no-default-browser-check', '--user-data-dir=' + profile, '--remote-debugging-port=' + cdpPort, 'about:blank'], { shell: false, windowsHide: true, stdio: 'ignore' });
    const protocol = new NodeBrowserCdpProtocol({ port: cdpPort });
    const backend = new BrowserCdpBackend({ protocol });
    const approvals = vi.fn(async (): Promise<boolean> => true);
    const noop: CapabilityBackend = { execute: async () => ok({}) };
    const capabilities = new LocalCapabilityService({ shell: noop, domCdp: backend, accessibility: noop, inputEvent: noop, vision: noop, window: noop, health: noop, systemInfo: noop, notification: noop, fileDialog: noop, clipboard: noop, webFetch: noop, audio: noop, screenRecord: noop, office: noop, scheduler: noop, wslExec: noop, wslFs: noop });
    const registry = new ToolRegistry({ capabilities } as McpApplicationServices, { clientId: '3step-browser', clientName: '3step-browser' }, { profileProvider: (): typeof permissionProfiles.full => permissionProfiles.full, hostMutationApprovalProvider: approvals });
    const origin = 'http://127.0.0.1:' + port;
    const plan = invoiceThreeStepPlan(origin, 'browser');
    try {
      await until(async () => (await protocol.status()).ready);
      const opened = await registry.invoke('dom_cdp', { action: 'new_tab', parameters: { url: plan.historyUrl }, userConfirmed: true });
      expect(opened.isError).not.toBe(true);
      const tabId = String(opened.structuredContent?.id);
      expect(tabId).not.toBe('undefined');
      expect(approvals).toHaveBeenCalledTimes(1);
      const waited = await registry.invoke('dom_cdp', { action: 'wait', tab_id: tabId, parameters: { selector: '#history-ready' } });
      expect(waited.isError).not.toBe(true);
      const query = async (pathname: string, items: Record<string, unknown>[]): ReturnType<ToolRegistry['invoke']> => registry.invoke('dom_cdp', { action: 'query', tab_id: tabId, parameters: { page: { origin, pathname, title: fixtureTitle }, queries: items } });
      const probe = (key: string, selector: string, fields: string[], expectation: Record<string, unknown>, attributes?: string[]): Record<string, unknown> => ({ key, selector, fields, expect: expectation, ...(attributes ? { attributes } : {}) });
      expect((await registry.invoke('dom_cdp', { ...plan.duplicateQuery, tab_id: tabId })).structuredContent).toMatchObject({ ok: true });
      const prepared = await registry.invoke('dom_cdp', { tab_id: tabId, steps: plan.prepare, userConfirmed: true });
      expect(prepared.isError, JSON.stringify(prepared)).not.toBe(true);
      expect(plan.prepare.filter(s => s.action === 'type')).toHaveLength(50);
      expect(approvals).toHaveBeenCalledTimes(2);
      const reviewed = await registry.invoke('dom_cdp', { ...plan.precommit, tab_id: tabId });
      expect(reviewed.structuredContent).toMatchObject({ ok: true });
      expect(approvals).toHaveBeenCalledTimes(2);
      const committed = await registry.invoke('dom_cdp', { tab_id: tabId, steps: plan.commit, userConfirmed: true });
      expect(committed.isError, JSON.stringify(committed)).not.toBe(true);
      expect(approvals).toHaveBeenCalledTimes(3);
      const verified = await registry.invoke('dom_cdp', { ...plan.readback, tab_id: tabId });
      expect(verified.structuredContent).toMatchObject({ ok: true });
      expect(approvals).toHaveBeenCalledTimes(3);
      console.log(JSON.stringify({ status: 'TESTED_REAL_CHROME_THREE_PHASES', fields: 50, lines: 4, quantity: 35, total: 14550, hostApprovals: 3, commits: 1, stockAndPricesReadBack: true, fullBypass: false }));

      // These reads execute the generated code against a real DOM, not a protocol stub.
      const lastRow = await query('/history', [probe('rows', '.history-row', ['text'], { count: 50, notContains: 'LAST-ROW-BILL' })]);
      expect(lastRow.structuredContent).toMatchObject({ ok: false });
      expect((await query('/history', [probe('rows', '.history-row', ['text'], { count: 50, notContains: 'ABSENT-BILL' })])).structuredContent).toMatchObject({ ok: true });
      for (const item of [
        probe('overflow', '#overflow-probe', ['text'], { count: 1, notContains: 'ABSENT-BILL' }),
        probe('options', '#options-probe', ['options'], { count: 1 }),
        probe('attribute', '#long-attribute-probe', ['attributes'], { count: 1 }, ['data-label']),
      ]) expect((await query('/history', [item])).structuredContent).toMatchObject({ ok: false });
      for (const selector of ['#password-probe', '#hidden-probe', '#file-probe']) {
        const read = await query('/history', [probe('secret', selector, ['value'], { count: 1 })]);
        expect(JSON.stringify(read)).toContain('[REDACTED]');
        expect(JSON.stringify(read)).not.toContain('FAKE-PASSWORD');
        expect((await query('/history', [probe('secret', selector, ['value'], { count: 1, notContains: 'NOT-PRESENT' })])).structuredContent).toMatchObject({ ok: false });
      }
      for (const attribute of ['data-session-id', 'data-auth-token', 'data-credential', 'data-jwt']) expect((await query('/history', [probe('secretAttribute', '#attribute-probe', ['attributes'], { count: 1 }, [attribute])])).isError).toBe(true);
      expect((await query('/history', [probe('missingSource', '#history-ready', ['tag'], { count: 1, notContains: 'X' })])).isError).toBe(true);
      expect((await query('/history', [probe('zeroCount', '#not-present', ['text'], { count: 0, notContains: 'X' })])).isError).toBe(true);
      expect(JSON.stringify(await query('/history', [probe('nodes', '.many-node', ['text'], { count: 100 })]))).toContain('node overflow');
      expect((await query('/history', [probe('invalidValue', '#history-ready', ['value'], { count: 1, notContains: 'X' })])).structuredContent).toMatchObject({ ok: false });
      for (const fields of [['text', 'value'], ['checked'], ['options']]) expect((await query('/history', [probe('unavailableSource', '#history-ready', fields, { count: 1, ...(fields.includes('text') ? { notContains: 'ABSENT' } : {}) })])).structuredContent).toMatchObject({ ok: false });
      expect(approvals).toHaveBeenCalledTimes(3);

      // Wrong page or duplicate guards may ask once for the reviewed batch, but do zero writes and never replay.
      for (const first of [
        { action: 'query', parameters: { page: { origin, pathname: '/wrong', title: fixtureTitle }, queries: [probe('guard', '#existing-bill', ['text'], { count: 1 })] } },
        { action: 'query', parameters: { page: { origin, pathname: '/history', title: fixtureTitle }, queries: [probe('duplicate', '#existing-bill', ['text'], { count: 0 })] } },
      ]) {
        const response = await registry.invoke('dom_cdp', { tab_id: tabId, steps: [first, { action: 'click', parameters: { selector: '#after-probe' } }], userConfirmed: true });
        expect(response.isError).toBe(true);
        expect(response.structuredContent?.error).toMatchObject({ details: { completedSteps: 0, effectState: 'NO_MUTATION_DISPATCHED', automaticReplayAllowed: 0 } });
      }
      for (const [selector, label] of [['#throw-probe', 'THROW'], ['#detach-probe', 'DETACH'], ['.ambiguous-probe', 'PROBE']]) {
        const response = await registry.invoke('dom_cdp', { tab_id: tabId, steps: [{ action: 'click', parameters: { selector, mouse_event_sequence: true, expected_text: label } }, { action: 'click', parameters: { selector: '#after-probe' } }], userConfirmed: true });
        expect(response.isError, selector).toBe(true);
        expect(response.structuredContent?.error).toMatchObject({ details: { effectState: 'UNKNOWN', automaticReplayAllowed: 0 } });
      }
      approvals.mockResolvedValueOnce(false);
      const denied = await registry.invoke('dom_cdp', { tab_id: tabId, steps: [{ action: 'wait', parameters: { expression: "document.querySelector('#probe-clicks').textContent='999';true" } }, { action: 'query', parameters: { selector: '#history-ready' } }], userConfirmed: true });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied)).toContain('PERMISSION_DENIED');
      expect((await query('/history', [probe('noLaterClick', '#probe-clicks', ['text'], { count: 1, text: '0' }), probe('oneCommit', '#commit-count', ['text'], { count: 1, text: '1' })])).structuredContent).toMatchObject({ ok: true });
      expect((await registry.invoke('dom_cdp', { action: 'click', tab_id: tabId, parameters: { selector: '.many-node', mouse_event_sequence: true, expected_text: 'X' }, userConfirmed: true })).structuredContent).toMatchObject({ ok: false });
      expect((await registry.invoke('dom_cdp', { action: 'click', tab_id: tabId, parameters: { selector: '.many-node' }, userConfirmed: true })).structuredContent).toMatchObject({ ok: true });
      expect((await query('/history', [probe('legacyFirst', '.many-node[data-label="clicked"]', ['text'], { count: 1, text: 'X' })])).structuredContent).toMatchObject({ ok: true });
    } finally {
      capabilities.close();
      await backend.close();
      await stopBrowser(chrome, protocol);
      server.closeAllConnections();await new Promise<void>(resolve => server.close(() => resolve()));
      const target = path.resolve(profile);
      assertFixtureCleanup(target, 'lnwjud-3step-cdp-');
      await rm(target, { recursive: true, force: true });
    }
  }, 90_000);
});
function listen(server: Server): Promise<number> { return new Promise((resolve, reject) => { server.once('error', reject);server.listen(0, '127.0.0.1', () => { const a = server.address();if (!a || typeof a === 'string') reject(new Error('fixture address missing'));else resolve(a.port); }); }); }
async function unusedPort(): Promise<number> { const s = createServer();const p = await listen(s);await new Promise<void>(resolve => s.close(() => resolve()));return p; }
async function until(predicate: () => Promise<boolean>): Promise<void> { const end = Date.now() + 20_000;while (!await predicate()) { if (Date.now() > end) throw new Error('Fixture browser start timeout');await new Promise(resolve => setTimeout(resolve, 50)); } }
async function stopBrowser(browser: ChildProcess, protocol: NodeBrowserCdpProtocol): Promise<void> { try { const tabs = await protocol.listTabs();if (tabs[0]) await protocol.request(tabs[0].id, 'Browser.close', {}); } catch { /* owned process fallback */ }const exited = await new Promise<boolean>(resolve => { if (browser.exitCode !== null || browser.signalCode !== null) return resolve(true);const timer = setTimeout(() => resolve(false), 2000);browser.once('exit', () => { clearTimeout(timer);resolve(true); }); });if (!exited && browser.pid !== undefined) await createProcessTreeTerminator().stop(browser, browser.pid); }

function assertFixtureCleanup(target: string, prefix: string): void {
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith(prefix)) throw new Error('Unsafe fixture cleanup target');
}
