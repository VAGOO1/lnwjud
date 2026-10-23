import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { electronExecutablePath, terminateProcessTree } from './electron-runtime.js';
import { settleFirstRunAndOpenHome } from './first-run-helpers.js';
import { invoiceThreeStepPlan } from '../../../packages/mcp-server/src/fixtures/invoice-three-step-plan.js';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chromeExecutable = process.env.LNWJUD_REAL_BROWSER_TEST_EXECUTABLE ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

test('complete 50-field fake invoice uses three genuine native approval prompts with readback', async () => {
  test.setTimeout(180_000);
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-3step-native-work-'));
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-3step-native-data-'));
  const profile = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-3step-native-chrome-'));
  await writeFile(path.join(workspace, 'package.json'), JSON.stringify({ name: 'three-step-fake-only' }));
  const html = await readFile(path.resolve(desktopRoot, '../../packages/mcp-server/src/fixtures/invoice-three-step.html'));
  const server = createServer((_q, res) => { res.setHeader('content-type', 'text/html; charset=utf-8');res.setHeader('content-security-policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'none'; connect-src 'none'; base-uri 'none'");res.end(html); });
  const port = await listen(server);
  const browserPort = await browserFixturePort();
  const plan = invoiceThreeStepPlan('http://127.0.0.1:' + port, 'native');
  let electron: ChildProcess | undefined, chrome: ChildProcess | undefined, appBrowser: Browser | undefined, fixtureBrowser: Browser | undefined, client: Client | undefined;
  try {
    chrome = spawn(chromeExecutable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--user-data-dir=' + profile, '--remote-debugging-port=' + browserPort, 'about:blank'], { shell: false, windowsHide: true, stdio: 'ignore' });
    await portReady(browserPort, chrome);
    fixtureBrowser = await chromium.connectOverCDP('http://127.0.0.1:' + browserPort);
    const debugPort = await unusedPort();
    const packaged = process.env.LNWJUD_PACKAGED_EXECUTABLE;
    const args = ['--disable-gpu', '--remote-debugging-port=' + debugPort, '--user-data-dir=' + dataRoot, ...(packaged ? [] : [path.join(desktopRoot, 'dist/main/main.js')])];
    electron = spawn(packaged ?? electronExecutablePath(desktopRoot), args, { cwd: desktopRoot, shell: false, windowsHide: true, env: { ...process.env, APPDATA: dataRoot, LNWJUD_DATA_PATH: dataRoot, LNWJUD_WORKSPACE: workspace, LNWJUD_E2E_FIXTURE: '1', LNWJUD_E2E_NODE_PATH: process.execPath, LNWJUD_BROWSER_CDP_PORT: String(browserPort), LNWJUD_BROWSER_EXECUTABLE: chromeExecutable } });
    const stderr: string[] = [];electron.stderr?.on('data', (b: Buffer) => stderr.push(b.toString()));electron.stdout?.on('data', (b: Buffer) => stderr.push(b.toString()));
    await portReady(debugPort, electron, stderr);
    appBrowser = await chromium.connectOverCDP('http://127.0.0.1:' + debugPort);
    const context = appBrowser.contexts()[0]!;
    await expect.poll(() => context.pages().length).toBeGreaterThan(0);
    const home = context.pages()[0]!;
    await settleFirstRunAndOpenHome(home);
    await home.evaluate(() => window.lnwjud.setPermissionProfile({ profile: 'full' }));
    const dashboard = await home.evaluate(() => window.lnwjud.getDashboard());
    expect(dashboard.settings.desktopFullBypassAll).toBe(false);expect(dashboard.settings.stdioFullBypassAll).toBe(false);
    const endpoint = (await home.getByTestId('mcp-endpoint').textContent())?.trim();
    if (!endpoint) throw new Error('MCP endpoint absent');
    client = new Client({ name: 'three-step-native-fixture', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
    const connectedClient = client;
    let prompts = 0;
    context.on('page', p => p.on('framenavigated', frame => { if (frame === p.mainFrame() && frame.url().includes('#mutation-approval')) prompts++; }));
    const call = (args: Record<string, unknown>): ReturnType<Client['callTool']> => connectedClient.callTool({ name: 'dom_cdp', arguments: args });
    const approvedCall = async (args: Record<string, unknown>): ReturnType<Client['callTool']> => {
      const pending = call({ ...args, userConfirmed: true });
      const approval = await waitForApproval(context);
      await expect(approval.locator('pre')).toContainText('สรุปก่อนอนุมัติ:');
      await expect(approval.locator('pre')).toContainText('เครื่อง: ' + os.hostname());
      await approval.getByRole('button', { name: /อนุญาตครั้งนี้|Approve once/ }).click();
      const result = await pending;
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      return result;
    };
    const opened = object(await approvedCall({ action: 'new_tab', parameters: { url: plan.historyUrl } }));
    const tabId = String(opened.id);
    expect(tabId).not.toBe('undefined');expect(prompts).toBe(1);
    expect((await call({ action: 'wait', tab_id: tabId, parameters: { selector: '#history-ready' } })).isError).not.toBe(true);
    expect(object(await call({ ...plan.duplicateQuery, tab_id: tabId }))).toMatchObject({ ok: true });expect(prompts).toBe(1);
    await approvedCall({ tab_id: tabId, steps: plan.prepare });
    expect(prompts).toBe(2);
    expect(object(await call({ ...plan.precommit, tab_id: tabId }))).toMatchObject({ ok: true });expect(prompts).toBe(2);
    const fixturePage = fixtureBrowser.contexts()[0]!.pages().find(p => p.url() === plan.invoiceUrl);
    if (!fixturePage) throw new Error('Exact fixture page absent');
    expect(await fixturePage.locator('.invoice-field').count()).toBe(50);
    expect(await fixturePage.locator('#selected-source').textContent()).toBe('ผู้ขายจำลอง ID 13');
    await approvedCall({ tab_id: tabId, steps: plan.commit });
    expect(prompts).toBe(3);
    const readback = object(await call({ ...plan.readback, tab_id: tabId }));
    expect(readback).toMatchObject({ ok: true });expect(prompts).toBe(3);
    await expect(fixturePage.locator('#commit-count')).toHaveText('1');
    await expect(fixturePage.locator('#saved-total')).toHaveText('14550');
    expect(context.pages().filter(p => p.url().includes('#mutation-approval'))).toHaveLength(0);
    console.log(JSON.stringify({ status: packaged ? 'PACKAGED_NATIVE_THREE_STEP_PASS' : 'NATIVE_THREE_STEP_PASS', prompts, fields: 50, rows: 4, quantity: 35, total: 14550, commitCount: 1, readback, fullBypass: false, installed5090Changed: false }));
  } finally {
    await client?.close().catch(() => undefined);await appBrowser?.close().catch(() => undefined);await fixtureBrowser?.close().catch(() => undefined);
    if (electron) await terminateProcessTree(electron);if (chrome) await terminateProcessTree(chrome);
    server.closeAllConnections();await new Promise<void>(resolve => server.close(() => resolve()));
    for (const root of [workspace, dataRoot, profile]) { const target = path.resolve(root);assertFixtureCleanup(target, 'lnwjud-3step-native-');await rm(target, { recursive: true, force: true }); }
  }
});

function object(value: unknown): Record<string, unknown> { const r = value as { structuredContent?: Record<string, unknown>; content?: { type: string; text?: string }[] };if (r.structuredContent) return r.structuredContent;const t = r.content?.find(c => c.type === 'text')?.text;if (t) return JSON.parse(t) as Record<string, unknown>;throw new Error('Tool result has no structured data'); }
async function waitForApproval(context: BrowserContext): Promise<Page> { let found: Page | undefined;await expect.poll(async () => { for (const p of context.pages()) if (p.url().includes('#mutation-approval') && await p.getByRole('alertdialog').count()) { found = p;return true; }return false; }, { timeout: 30_000 }).toBe(true);return found!; }
function listen(server: Server, port = 0): Promise<number> { return new Promise((resolve, reject) => { server.once('error', reject);server.listen(port, '127.0.0.1', () => { const a = server.address();if (!a || typeof a === 'string') reject(new Error('Missing fixture address'));else resolve(a.port); }); }); }
async function unusedPort(): Promise<number> { const s = createServer();const p = await listen(s);await new Promise<void>(resolve => s.close(() => resolve()));return p; }
async function browserFixturePort(): Promise<number> { for (let p = 9230; p <= 9322; p++) { const s = createServer();try { await listen(s, p);await new Promise<void>(resolve => s.close(() => resolve()));return p; } catch { /* never attach occupied port */ } }throw new Error('No available fixture CDP port'); }
async function portReady(port: number, child: ChildProcess, stderr: readonly string[] = []): Promise<void> { await expect.poll(async () => { if (child.exitCode !== null) throw new Error('Fixture process exited: ' + stderr.join(''));try { return (await fetch('http://127.0.0.1:' + port + '/json/version')).ok; } catch { return false; } }, { timeout: 30_000 }).toBe(true); }

function assertFixtureCleanup(target: string, prefix: string): void {
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith(prefix)) throw new Error('Unsafe fixture cleanup target');
}
