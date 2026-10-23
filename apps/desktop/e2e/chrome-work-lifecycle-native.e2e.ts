import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { electronExecutablePath, terminateProcessTree } from './electron-runtime.js';
import { settleFirstRunAndOpenHome } from './first-run-helpers.js';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainEntry = path.join(desktopRoot, 'dist', 'main', 'main.js');
const electronExecutable = process.env.LNWJUD_E2E_ELECTRON_EXECUTABLE ?? electronExecutablePath(desktopRoot);
const packagedExecutable = process.env.LNWJUD_PACKAGED_EXECUTABLE;
const chromeExecutable = process.env.LNWJUD_REAL_BROWSER_TEST_EXECUTABLE ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

test('new Chrome tab and navigation retain the reviewed primary work and native budget', async () => {
  test.setTimeout(180_000);
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-invoice-native-work-'));
  await writeFile(path.join(workspace, 'package.json'), JSON.stringify({ name: 'invoice-native-fixture' }), 'utf8');
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-invoice-native-data-'));
  const browserProfile = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-invoice-native-chrome-'));
  const browserPort = await findBrowserPort();
  const fixture = await invoiceServer();
  let electron: ChildProcess | undefined; let browser: Browser | undefined; let fixtureBrowser: Browser | undefined; let chrome: ChildProcess | undefined; let client: Client | undefined;
  try {
    chrome = spawn(chromeExecutable, ['--headless=new', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${browserProfile}`, `--remote-debugging-port=${browserPort}`, 'about:blank'], { shell: false, windowsHide: true, stdio: 'ignore' });
    await waitForPort(browserPort, chrome);
    fixtureBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${browserPort}`);
    const devToolsPort = await findPort();
    const launchArguments = [`--disable-gpu`, `--remote-debugging-port=${devToolsPort}`, `--user-data-dir=${dataRoot}`, ...(packagedExecutable ? [] : [mainEntry])];
    electron = spawn(packagedExecutable ?? electronExecutable, launchArguments, { cwd: desktopRoot, shell: false, windowsHide: true, env: { ...process.env, APPDATA: dataRoot, LNWJUD_DATA_PATH: dataRoot, LNWJUD_WORKSPACE: workspace, LNWJUD_E2E_FIXTURE: '1', LNWJUD_E2E_NODE_PATH: process.execPath, LNWJUD_BROWSER_CDP_PORT: String(browserPort), LNWJUD_BROWSER_EXECUTABLE: chromeExecutable } });
    const stderr: string[] = []; electron.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString())); electron.stdout?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
    await waitForDevTools(devToolsPort, electron, stderr);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${devToolsPort}`);
    const context = browser.contexts()[0]; if (!context) throw new Error('Electron context missing');
    await expect.poll(() => context.pages().length, { timeout: 30_000 }).toBeGreaterThan(0);
    const home = context.pages()[0]; if (!home) throw new Error('Electron home missing');
    await settleFirstRunAndOpenHome(home);
    await home.evaluate(() => window.lnwjud.setPermissionProfile({ profile: 'full' }));
    const settings = await home.evaluate(() => window.lnwjud.getDashboard());
    expect(settings.permissionProfile).toBe('full');
    expect(settings.settings.desktopFullBypassAll).toBe(false);
    expect(settings.settings.stdioFullBypassAll).toBe(false);
    const endpointText = (await home.getByTestId('mcp-endpoint').textContent())?.trim(); if (!endpointText) throw new Error('MCP endpoint missing');
    client = new Client({ name: 'invoice-native-e2e', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    const initialTransport = new StreamableHTTPClientTransport(new URL(endpointText));
    await client.connect(initialTransport);

    const anchor = await fixtureBrowser.contexts()[0]!.newPage();
    const origin = `http://127.0.0.1:${fixture.port}`;
    await anchor.goto(origin + '/anchor');
    const workspaceId = settings.selectedWorkspace?.id; if (!workspaceId) throw new Error('Fixture workspace missing');
    const tabs = record(await callTool(client, 'dom_cdp', { action: 'list_tabs' })).tabs as Array<{ id: string; url: string }>;
    const anchorTabId = tabs.find((tab) => tab.url === origin + '/anchor')?.id; if (!anchorTabId) throw new Error('Exact anchor missing');
    const openRequest = { action: 'new_tab', tab_id: anchorTabId, parameters: { url: origin + '/new' }, userConfirmed: true };
    const work = record(await callTool(client, 'chrome_work_prepare', { workspaceId, tab_id: anchorTabId, pageUrl: origin + '/anchor',
      idempotencyKey: 'fresh-tab-navigation-fixture', requests: [openRequest] }));
    expect(work.status).toBe('HOST_REVIEW_REQUIRED'); expect(work.shown).toBe(0);
    await home.getByRole('button', { name: /^(งานอนุมัติ|Approval work)$/ }).click();
    const card = home.locator('.approval-work-card').filter({ hasText: String(work.primaryWorkId) });
    async function selectExpectedTarget(tabId: string, pageUrl: string): Promise<void> {
      await home!.getByRole('button', { name: /^(รีเฟรช|Refresh)$/ }).click();
      await card.getByRole('button', { name: /^(เตรียมงาน|Prepare work)$/ }).click();
      await expect(card.locator('.approval-work-review')).toContainText(tabId);
      await expect(card.locator('.approval-work-review')).toContainText(pageUrl);
      await card.getByRole('button', { name: /^(ยืนยันเริ่มงาน|Confirm start)$/ }).click();
      await expect.poll(async () => record(await callTool(client!, 'chrome_work_status', { workspaceId, primaryWorkId: work.primaryWorkId })).status).toBe('SELECTED');
    }
    let nativePages = 0;
    context.on('page', (page) => { page.on('framenavigated', (frame) => { if (frame === page.mainFrame() && frame.url().includes('#mutation-approval')) nativePages += 1; }); });
    async function approve(request: Record<string, unknown>): ReturnType<Client['callTool']> {
      const pending = callTool(client!, 'dom_cdp', request);
      const prompt = await waitForApproval(context);
      await expect(prompt.locator('pre')).toContainText(String(request.tab_id));
      await prompt.getByRole('button', { name: /อนุญาตครั้งนี้|Approve once/ }).click();
      const result = await pending; expect(result.isError, JSON.stringify(result)).not.toBe(true); return result;
    }
    async function extend(tabId: string, pageUrl: string, requests: Record<string, unknown>[], key: string): Promise<void> {
      const current = record(await callTool(client!, 'chrome_work_status', { workspaceId, primaryWorkId: work.primaryWorkId }));
      const extended = record(await callTool(client!, 'chrome_work_extend', { workspaceId, tab_id: tabId, pageUrl, requests, idempotencyKey: key,
        primaryWorkId: work.primaryWorkId, continuityToken: work.continuityToken, expectedConnectionRevision: current.connectionRevision,
        expectedBudgetRevision: current.revision, expectedContinuationRevision: current.continuationRevision }));
      expect(extended).toMatchObject({ status: 'HOST_REVIEW_REQUIRED', hostWorkId: work.hostWorkId, primaryWorkId: work.primaryWorkId, shown: current.shown });
    }
    await selectExpectedTarget(anchorTabId, origin + '/anchor');
    const opened = record(await approve(openRequest)); const newTabId = String(opened.id);
    expect(newTabId).not.toBe('undefined'); expect(newTabId).not.toBe(anchorTabId); expect(nativePages).toBe(1);
    await expect.poll(async () => record(await callTool(client!, 'dom_cdp', { action: 'list_tabs' })).tabs as unknown).toEqual(expect.arrayContaining([expect.objectContaining({ id: newTabId, url: origin + '/new' })]));
    const navigateRequest = { action: 'navigate', tab_id: newTabId, parameters: { url: origin + '/after-navigation' }, userConfirmed: true };
    await extend(newTabId, origin + '/new', [navigateRequest], 'returned-tab-target');
    const beforeReview = await callTool(client, 'dom_cdp', navigateRequest);
    expect(beforeReview.isError).toBe(true); expect(nativePages).toBe(1);
    await selectExpectedTarget(newTabId, origin + '/new'); await approve(navigateRequest); expect(nativePages).toBe(2);
    const write = { action: 'type', tab_id: newTabId, parameters: { selector: '.invoice-field', text: 'new-page-value', clear: true }, userConfirmed: true };
    const fourth = { ...write, parameters: { ...write.parameters, text: 'MUST-NOT-RUN' } };
    await extend(newTabId, origin + '/after-navigation', [write, fourth], 'navigated-page-target');
    await selectExpectedTarget(newTabId, origin + '/after-navigation'); await approve(write);
    expect(nativePages).toBe(3);
    const blocked = await callTool(client, 'dom_cdp', fourth); expect(blocked.isError).toBe(true);
    expect(JSON.stringify(blocked)).toContain('BUDGET_EXHAUSTED');
    const current = record(await callTool(client, 'chrome_work_status', { workspaceId, primaryWorkId: work.primaryWorkId }));
    expect(current).toMatchObject({ hostWorkId: work.hostWorkId, shown: 3, remaining: 0, inDoubt: 0, continuationRevision: 2 });
    expect(nativePages).toBe(3); expect(context.pages().filter((page) => page.url().includes('#mutation-approval'))).toHaveLength(0);
    const targetPage = fixtureBrowser.contexts()[0]!.pages().find((page) => page.url() === origin + '/after-navigation');
    expect(targetPage).toBeDefined(); await expect(targetPage!.locator('.invoice-field').first()).toHaveValue('new-page-value');
    const evidence = { status: 'TESTED_NATIVE_NEW_TAB_NAVIGATION', nativeJournalShown: current.shown, nativeApprovalPages: nativePages,
      newTabCreated: true, navigationVerified: true, reviewedTargets: current.targets, samePrimaryWorkAndBudget: true, fourthBlocked: true,
      automatedFixtureApproval: true, ownerApprovalsThisRun: 0, originalThreeDialogReplay: false, fullBypass: false, accessed5090: false };
    await writeFile(test.info().outputPath('chrome-lifecycle-result.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence));
  } finally {
    await client?.close().catch(() => undefined); await browser?.close().catch(() => undefined); await fixtureBrowser?.close().catch(() => undefined); if (electron) await terminateProcessTree(electron); if (chrome) await terminateProcessTree(chrome); await fixture.close();
    await Promise.all([workspace, dataRoot, browserProfile].map(removeOwnedTemporaryRoot));
  }
});

async function invoiceServer(): Promise<{ port: number; close: () => Promise<void> }> { const server = createServer((_q, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; connect-src 'none';"); res.end('<!doctype html><meta charset="utf-8"><title>ฟอร์มจำลองใบแจ้งหนี้ 50 ช่อง</title><form>' + Array.from({ length: 50 }, (_, i) => `<input class="invoice-field" name="line-${i + 1}">`).join('') + '</form>'); }); const port = await listen(server); return { port, close: () => new Promise((resolve) => server.close(() => resolve())) }; }
async function waitForApproval(context: ReturnType<Browser['contexts']>[number]): Promise<Page> {
  let found: Page | undefined;
  await expect.poll(async () => {
    for (const page of context.pages()) {
      if (page.url().includes('#mutation-approval') && await page.getByRole('alertdialog').count()) { found = page; return true; }
    }
    return false;
  }, { timeout: 30_000 }).toBe(true);
  return found!;
}
async function callTool(client: Client, name: string, args: Record<string, unknown>): ReturnType<Client['callTool']> { return client.callTool({ name, arguments: args }); }
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected a tool result object');
  const result = value as Record<string, unknown>;
  if (typeof result.structuredContent === 'object' && result.structuredContent !== null && !Array.isArray(result.structuredContent)) return result.structuredContent as Record<string, unknown>;
  if (Array.isArray(result.content)) {
    const text = result.content.find((item: unknown) => typeof item === 'object' && item !== null && 'text' in item && typeof item.text === 'string') as { text: string } | undefined;
    if (text) return record(JSON.parse(text.text));
  }
  return result;
}
async function findPort(): Promise<number> { const server = createServer(); const port = await listen(server); await new Promise<void>((r) => server.close(() => r())); return port; }
async function findBrowserPort(): Promise<number> {
  // The production protocol intentionally accepts environment ports 9222..9322 only.
  for (let port = 9230; port <= 9322; port += 1) {
    const probe = createServer();
    try { await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); }); await new Promise<void>((resolve) => probe.close(() => resolve())); return port; }
    catch { /* Try the next unused port; never connect to an occupied endpoint. */ }
  }
  throw new Error('No unused managed Chrome fixture port');
}
function listen(server: Server): Promise<number> { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); if (!address || typeof address === 'string') reject(new Error('port unavailable')); else resolve(address.port); }); }); }
async function waitForDevTools(port: number, process: ChildProcess, stderr: readonly string[]): Promise<void> { await expect.poll(async () => { if (process.exitCode !== null) throw new Error(`Electron exited ${process.exitCode}: ${stderr.join('')}`); try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; } }, { timeout: 30_000 }).toBe(true); }
async function waitForPort(port: number, process: ChildProcess): Promise<void> { await expect.poll(async () => { if (process.exitCode !== null) throw new Error(`Chrome exited ${process.exitCode}`); try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; } }, { timeout: 30_000 }).toBe(true); }
async function removeOwnedTemporaryRoot(root: string): Promise<void> {
  const target = path.resolve(root);
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('lnwjud-invoice-native-')) throw new Error('Refusing cleanup outside owned fixture root');
  await rm(target, { recursive: true, force: true });
}
