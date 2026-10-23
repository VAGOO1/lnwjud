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

test('native Chrome work keeps its three-window budget through real HTTP and Chrome', async () => {
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
    const fixturePage = (await fixtureBrowser.contexts()[0]!.newPage());
    await fixturePage.goto(`http://127.0.0.1:${fixture.port}/`);
    const tabs = await callTool(client, 'dom_cdp', { action: 'list_tabs', userConfirmed: true });
    const tabList = record(tabs).tabs as Array<Record<string, unknown>>;
    const tabId = String(tabList.find((entry) => String(entry.url).includes(`127.0.0.1:${fixture.port}`))?.id ?? '');
    if (!tabId) throw new Error('Fixture tab was not visible through dom_cdp list_tabs: ' + JSON.stringify(tabs));
    const steps = Array.from({ length: 50 }, (_, i) => ({ action: 'type', parameters: { selector: `.invoice-field:nth-of-type(${i + 1})`, text: `value-${i + 1}`, clear: true } }));
    const workspaceId = settings.selectedWorkspace?.id;
    if (!workspaceId) throw new Error('Isolated Desktop workspace missing');
    const cancelSteps = steps.map((step, index) => ({ ...step, parameters: { ...step.parameters, text: `cancel-${index + 1}` } }));
    const denySteps = steps.map((step, index) => ({ ...step, parameters: { ...step.parameters, text: `deny-${index + 1}` } }));
    const requests = [cancelSteps, denySteps, steps, [{ action: 'type', parameters: { selector: '.invoice-field', text: 'MUST-NOT-RUN', clear: true } }]]
      .map((phaseSteps) => ({ tab_id: tabId, steps: phaseSteps, userConfirmed: true }));
    const proposal = record(await callTool(client, 'chrome_work_prepare', {
      workspaceId, tab_id: tabId, pageUrl: `http://127.0.0.1:${fixture.port}/`,
      idempotencyKey: 'isolated-native-http-budget', requests: requests.slice(0, 1),
    }));
    expect(proposal.status).toBe('HOST_REVIEW_REQUIRED');
    expect(proposal.shown).toBe(0);
    expect(proposal.browserActionsStartedByThisMetadataCall).toBe(false);
    await home.getByRole('button', { name: /^(งานอนุมัติ|Approval work)$/ }).click();
    const workCard = home.locator('.approval-work-card').filter({ hasText: String(proposal.primaryWorkId) });
    await expect(workCard).toHaveCount(1);
    await workCard.getByRole('button', { name: /^(เตรียมงาน|Prepare work)$/ }).click();
    await workCard.getByRole('button', { name: /^(ยืนยันเริ่มงาน|Confirm start)$/ }).click();
    await expect.poll(async () => record(await callTool(client!, 'chrome_work_status', { workspaceId, primaryWorkId: proposal.primaryWorkId })).status).toBe('SELECTED');
    let promptCount = 0;
    context.on('page', (page) => { page.on('framenavigated', (frame) => { if (frame === page.mainFrame() && frame.url().includes('#mutation-approval')) promptCount += 1; }); });
    const cancellation = new AbortController();
    const cancelledPending = client.callTool({ name: 'dom_cdp', arguments: requests[0]! }, { signal: cancellation.signal });
    const cancelledOutcome = cancelledPending.then(() => 'fulfilled' as const, () => 'rejected' as const);
    const cancelledPrompt = await waitForApproval(context);
    const details = cancelledPrompt.locator('pre');
    await expect(details).toContainText('สรุปก่อนอนุมัติ:');
    await expect(details).toContainText(`เครื่อง: ${os.hostname()}`);
    await expect(details).toContainText('แท็บ: ฟอร์มจำลองใบแจ้งหนี้ 50 ช่อง');
    await expect(details).toContainText(`หน้า: http://127.0.0.1:${fixture.port}/`);
    await expect(details).toContainText(`รหัสแท็บ: ${tabId}`);
    await expect(details).toContainText('เว็บไซต์อาจตรวจ บันทึก หรือส่งข้อมูลอัตโนมัติ');
    await expect(details).toContainText('stepCount = 50');
    await expect(details).toContainText(tabId);
    await expect(details).toContainText('step[1].action = "type"');
    await expect(details).toContainText('step[50].action = "type"');
    await expect(details).toContainText('cancel-1');
    await expect(details).toContainText('cancel-50');
    const completeDetails = await details.textContent();
    for (let index = 1; index <= 50; index += 1) {
      expect(completeDetails).toContain(`step[${index}].parameters`);
      expect(completeDetails).toContain(`"selector":".invoice-field:nth-of-type(${index})"`);
      expect(completeDetails).toContain(`"text":"cancel-${index}"`);
    }
    cancellation.abort(new Error('fixture client disconnected'));
    expect(await cancelledOutcome).toBe('rejected');
    await expect.poll(() => cancelledPrompt.isClosed(), { timeout: 10_000 }).toBe(true);
    expect(await fixturePage.locator('.invoice-field').evaluateAll((nodes) => nodes.every((node) => (node as HTMLInputElement).value === ''))).toBe(true);
    await expect.poll(async () => record(await callTool(client!, 'chrome_work_status', { workspaceId, primaryWorkId: proposal.primaryWorkId })).inDoubt).toBe(0);
    const priorSessionId = initialTransport.sessionId;
    await client.close();
    client = new Client({ name: 'invoice-native-e2e', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    const reconnectTransport = new StreamableHTTPClientTransport(new URL(endpointText));
    await client.connect(reconnectTransport);
    const httpSessionChanged = priorSessionId !== reconnectTransport.sessionId;
    const beforeReconnect = record(await callTool(client, 'chrome_work_status', { workspaceId, primaryWorkId: proposal.primaryWorkId, continuityToken: proposal.continuityToken }));
    expect(beforeReconnect.shown).toBe(1);
    const reconnected = record(await callTool(client, 'chrome_work_reconnect', {
      workspaceId, primaryWorkId: proposal.primaryWorkId, continuityToken: proposal.continuityToken,
      expectedConnectionRevision: beforeReconnect.connectionRevision,
    }));
    expect(reconnected.hostWorkId).toBe(proposal.hostWorkId);
    expect(reconnected.shown).toBe(1);
    // Stateless modern HTTP retains one endpoint identity; only a changed protocol session rotates the revision.
    expect(reconnected.connectionRevision).toBe(Number(beforeReconnect.connectionRevision) + (httpSessionChanged ? 1 : 0));
    const continued = record(await callTool(client, 'chrome_work_extend', {
      workspaceId, tab_id: tabId, pageUrl: `http://127.0.0.1:${fixture.port}/`,
      primaryWorkId: proposal.primaryWorkId, continuityToken: proposal.continuityToken,
      expectedConnectionRevision: reconnected.connectionRevision, expectedBudgetRevision: reconnected.revision,
      expectedContinuationRevision: reconnected.continuationRevision, idempotencyKey: 'native-after-first-phase', requests: requests.slice(1),
    }));
    expect(continued).toMatchObject({ status: 'HOST_REVIEW_REQUIRED', hostWorkId: proposal.hostWorkId, shown: 1, remaining: 2, continuationRevision: 1, browserActionsStartedByThisMetadataCall: false });
    await home.getByRole('button', { name: /^(รีเฟรช|Refresh)$/ }).click();
    await workCard.getByRole('button', { name: /^(เตรียมงาน|Prepare work)$/ }).click();
    await workCard.getByRole('button', { name: /^(ยืนยันเริ่มงาน|Confirm start)$/ }).click();
    await expect.poll(async () => record(await callTool(client!, 'chrome_work_status', { workspaceId, primaryWorkId: proposal.primaryWorkId })).status).toBe('SELECTED');
    const deniedPending = callTool(client, 'dom_cdp', requests[1]!);
    const denyPrompt = await waitForApproval(context);
    await denyPrompt.screenshot({ path: test.info().outputPath('approval-thai-native.png') });
    await denyPrompt.getByRole('button', { name: /^(ยกเลิก|Cancel)$/ }).click();
    const denied = await deniedPending;
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain('PERMISSION_DENIED');
    expect(await fixturePage.locator('.invoice-field').evaluateAll((nodes) => nodes.every((node) => (node as HTMLInputElement).value === ''))).toBe(true);
    expect(promptCount).toBe(2);
    // A distinct, intentional test invocation exercises the positive path after known denial.
    const pending = callTool(client, 'dom_cdp', requests[2]!);
    const approval = await waitForApproval(context);
    await expect(approval.locator('pre')).toContainText('stepCount = 50');
    await approval.getByRole('button', { name: /อนุญาตครั้งนี้|Approve once/ }).click();
    const approved = await pending;
    expect(approved.isError).not.toBe(true);
    await expect.poll(() => fixturePage.locator('.invoice-field').count(), { timeout: 20_000 }).toBe(50);
    await expect.poll(() => fixturePage.locator('.invoice-field').evaluateAll((nodes) => nodes.every((node, i) => (node as HTMLInputElement).value === `value-${i + 1}`)), { timeout: 20_000 }).toBe(true);
    expect(promptCount).toBe(3);
    expect(context.pages().filter((page) => page.url().includes('#mutation-approval'))).toHaveLength(0);
    const blocked = await callTool(client, 'dom_cdp', requests[3]!);
    expect(blocked.isError).toBe(true);
    expect(JSON.stringify(blocked)).toContain('BUDGET_EXHAUSTED');
    const finalState = record(await callTool(client, 'chrome_work_status', { workspaceId, primaryWorkId: proposal.primaryWorkId }));
    expect(finalState).toMatchObject({ shown: 3, remaining: 0, inDoubt: 0, hostWorkId: proposal.hostWorkId, connectionRevision: reconnected.connectionRevision });
    expect(promptCount).toBe(3);
    expect(context.pages().filter((page) => page.url().includes('#mutation-approval'))).toHaveLength(0);
    expect(await fixturePage.locator('.invoice-field').evaluateAll((nodes) => nodes.every((node, i) => (node as HTMLInputElement).value === `value-${i + 1}`))).toBe(true);
    const evidence = { status: 'TESTED_ISOLATED_NORMAL_RENDERER_CHROME_HTTP', nativeJournalShown: finalState.shown,
      nativeApprovalPages: promptCount, fourthBlocked: true, httpReconnectBudgetRetained: true, httpSessionChanged, exactContinuationOnSameBudget: true, continuationRevision: finalState.continuationRevision, fields: 50,
      automatedFixtureApproval: true, ownerApprovalsThisRun: 0, fullBypass: false, installed5090Changed: false };
    await writeFile(test.info().outputPath('approval-budget-http-result.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence));
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
