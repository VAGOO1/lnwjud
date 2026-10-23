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

const executable = process.env.LNWJUD_REAL_BROWSER_TEST_EXECUTABLE ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

describe('invoice approval batching through ToolRegistry and real Chrome CDP', () => {
  it('fills 50 invoice fields with one host approval, and never replays after denial/failure', async () => {
    if (!executable || !await fileExists(executable)) throw new Error(`Chrome fixture executable not found: ${executable}`);
    const profile = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-invoice-cdp-'));
    const server = createServer();
    const html = await readFile(new URL('./fixtures/invoice-form.html', import.meta.url), 'utf8');
    server.on('request', (_request, response) => { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(html); });
    const port = await listen(server);
    const cdpPort = await unusedPort();
    const browser = spawn(executable, ['--headless=new', '--enable-automation', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, `--remote-debugging-port=${cdpPort}`, 'about:blank'], { shell: false, windowsHide: true, stdio: 'ignore' });
    const protocol = new NodeBrowserCdpProtocol({ port: cdpPort, chromeExecutable: executable });
    const backend = new BrowserCdpBackend({ protocol });
    const approvals = vi.fn(async () => true);
    const capability = new LocalCapabilityService(dummyBackends(backend));
    const registry = new ToolRegistry({ capabilities: capability } as McpApplicationServices, { clientId: 'invoice-test', clientName: 'invoice-test' }, {
      profileProvider: (): typeof permissionProfiles.full => permissionProfiles.full,
      hostMutationApprovalProvider: approvals,
    });
    try {
      await until(async () => (await protocol.status()).ready);
      const tab = await protocol.newTab('about:blank');
      await protocol.request(tab.id, 'Page.navigate', { url: `http://127.0.0.1:${port}/invoice` });
      await until(async () => (await protocol.listTabs()).some((candidate) => candidate.id === tab.id));
      await until(async () => {
        try {
          const response = await protocol.request(tab.id, 'Runtime.evaluate', { expression: "document.querySelectorAll('.invoice-field').length", returnByValue: true });
          return (response as { result?: { result?: { value?: unknown } } }).result?.result?.value === 50;
        } catch { return false; }
      });
      const steps = Array.from({ length: 50 }, (_, index) => ({ action: 'type', parameters: { selector: `.invoice-field:nth-of-type(${index + 1})`, text: `value-${index + 1}`, clear: true } }));
      const response = await registry.invoke('dom_cdp', { tab_id: tab.id, steps, userConfirmed: true });
      expect(response.isError).not.toBe(true);
      expect(approvals).toHaveBeenCalledTimes(1);
      const read = await backend.execute({ action: 'evaluate', tab_id: tab.id, parameters: { expression: "Array.from(document.querySelectorAll('.invoice-field')).every((el, i) => el.value === `value-${i + 1}`)" }, userConfirmed: true });
      expect(read).toMatchObject({ ok: true, value: true });

      approvals.mockResolvedValueOnce(false);
      const before = await values(protocol, tab.id);
      const denied = await registry.invoke('dom_cdp', { tab_id: tab.id, steps: [{ action: 'type', parameters: { selector: '.invoice-field:nth-of-type(1)', text: 'DENIED', clear: true } }], userConfirmed: true });
      expect(denied.isError).toBe(true);
      expect(await values(protocol, tab.id)).toEqual(before);
      expect(approvals).toHaveBeenCalledTimes(2);

      approvals.mockResolvedValueOnce(true);
      await protocol.request(tab.id, 'Runtime.evaluate', { expression: "window.partialInputEvents = 0; document.querySelector('.invoice-field').addEventListener('input', () => window.partialInputEvents++);", returnByValue: true });
      const partial = await registry.invoke('dom_cdp', { tab_id: tab.id, steps: [
        { action: 'type', parameters: { selector: '.invoice-field:nth-of-type(1)', text: 'PARTIAL', clear: true } },
        { action: 'type', parameters: { selector: '#missing-invoice-field', text: 'SHOULD-NOT-EXIST', clear: true } },
        { action: 'type', parameters: { selector: '.invoice-field:nth-of-type(2)', text: 'MUST-NOT-RUN', clear: true } },
      ], userConfirmed: true });
      expect(JSON.stringify(partial)).toContain('Element not found');
      expect(partial.isError).toBe(true);
      expect((await values(protocol, tab.id))[0]).toBe('PARTIAL');
      expect((await values(protocol, tab.id))[1]).toBe('value-2');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect((await values(protocol, tab.id))[0]).toBe('PARTIAL');
      const eventCount = await protocol.request(tab.id, 'Runtime.evaluate', { expression: 'window.partialInputEvents', returnByValue: true });
      expect((eventCount as { result?: { result?: { value?: unknown } } }).result?.result?.value).toBe(1);
      expect(approvals).toHaveBeenCalledTimes(3);
      const malformed = await registry.invoke('dom_cdp', { tab_id: tab.id, steps: [
        { action: 'type', parameters: { selector: '[', text: 'invalid-selector', clear: true } },
        { action: 'type', parameters: { selector: '.invoice-field:nth-of-type(2)', text: 'MUST-NOT-RUN', clear: true } },
      ], userConfirmed: true });
      expect(malformed.isError).toBe(true);
      expect(JSON.stringify(malformed)).toContain('INTERNAL_ERROR');
      expect((await values(protocol, tab.id))[1]).toBe('value-2');
      expect(approvals).toHaveBeenCalledTimes(4);
    } finally {
      capability.close();
      await backend.close();
      await stopBrowser(browser, protocol);
      await closeServer(server);
      const cleanupTarget = path.resolve(profile);
      assertFixtureCleanup(cleanupTarget, 'lnwjud-invoice-cdp-');
      await rm(cleanupTarget, { recursive: true, force: true });
    }
  }, 45_000);
});

function dummyBackends(domCdp: CapabilityBackend): ConstructorParameters<typeof LocalCapabilityService>[0] {
  const noop: CapabilityBackend = { execute: async (): Promise<ReturnType<CapabilityBackend['execute']> extends Promise<infer T> ? T : never> => ok({}) };
  return { shell: noop, domCdp, accessibility: noop, inputEvent: noop, vision: noop, window: noop, health: noop, systemInfo: noop, notification: noop, fileDialog: noop, clipboard: noop, webFetch: noop, audio: noop, screenRecord: noop, office: noop, scheduler: noop, wslExec: noop, wslFs: noop };
}
async function values(protocol: NodeBrowserCdpProtocol, tabId: string): Promise<string[]> { const response = await protocol.request(tabId, 'Runtime.evaluate', { expression: "Array.from(document.querySelectorAll('.invoice-field')).map((el) => el.value)", returnByValue: true }); return (((response as { result?: { result?: { value?: unknown } } }).result?.result?.value ?? []) as string[]); }
async function fileExists(file: string): Promise<boolean> { try { await readFile(file); return true; } catch { return false; } }
function listen(server: Server): Promise<number> { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); if (!address || typeof address === 'string') reject(new Error('fixture server address unavailable')); else resolve(address.port); }); }); }
function closeServer(server: Server): Promise<void> { server.closeAllConnections(); return new Promise((resolve) => server.close(() => resolve())); }
async function unusedPort(): Promise<number> { const probe = createServer(); return new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', () => { const address = probe.address(); if (!address || typeof address === 'string') reject(new Error('port unavailable')); else { const port = address.port; probe.close(() => resolve(port)); } }); }); }
async function until(predicate: () => Promise<boolean>): Promise<void> { const deadline = Date.now() + 20_000; while (!await predicate()) { if (Date.now() > deadline) throw new Error('browser fixture timed out'); await new Promise((resolve) => setTimeout(resolve, 50)); } }
async function stopBrowser(browser: ChildProcess, protocol: NodeBrowserCdpProtocol): Promise<void> {
  try { const tabs = await protocol.listTabs(); if (tabs[0]) await protocol.request(tabs[0].id, 'Browser.close', {}); } catch { /* Owned-process termination below handles a closed protocol. */ }
  const exited = await new Promise<boolean>((resolve) => {
    if (browser.exitCode !== null || browser.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), 2000);
    browser.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
  if (!exited && browser.pid !== undefined) await createProcessTreeTerminator().stop(browser, browser.pid);
}

function assertFixtureCleanup(target: string, prefix: string): void {
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith(prefix)) throw new Error('Unsafe fixture cleanup target');
}
