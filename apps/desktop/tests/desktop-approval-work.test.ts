import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from '@lnwjud/domain';
import { CAPABILITY_ACTIVE_WORKSPACE_ROOT_METADATA_KEY } from '@lnwjud/capabilities';
import { hostApprovalInputDigest, ToolRegistry, type HostMutationApprovalContext, type HostMutationApprovalRequest, type McpHttpServerOptions } from '@lnwjud/mcp-server';
import { createDesktopRuntime, type DesktopRuntime } from '../src/main/desktop-services.js';
import { DesktopApprovalWork } from '../src/main/desktop-approval-work.js';
import { SqliteApprovalHostStore } from '../src/main/approval-host-store.js';
import { registerApprovalWorkIpc } from '../src/main/desktop-approval-ipc.js';
import { approvalWorkChannels } from '../../../packages/ipc-contracts/src/approval-work-contracts.js';
import { TunnelController } from '../src/main/tunnel-controller.js';
import { attachApprovalPromptDisplay, type ApprovalPromptDisplayGate } from '../src/main/approval-prompt-display.js';
import type { ApprovalHostPlan } from '../src/main/approval-host-runtime.js';
import { domCdpCapabilitySchema } from '../../../packages/mcp-server/src/tools/schemas.js';
import { prepareChromeWorkLaunch } from '../src/main/chrome-work-launch.js';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpServer } from '../../../packages/mcp-server/src/server.js';
import { ActivityTracker } from '../../../packages/mcp-server/src/activity-tracker.js';

const fixture = vi.hoisted(() => ({ options: [] as unknown[], dispatches: 0, lookups: 0, forbidden: 0, waitForRequest: undefined as Promise<unknown> | undefined }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const forbidden = (): never => { fixture.forbidden += 1; throw new Error('Native/process launch is forbidden in this fixture'); };
  return { ...actual, spawn: forbidden, spawnSync: forbidden, exec: forbidden, execSync: forbidden, execFile: forbidden, execFileSync: forbidden };
});
vi.mock('@lnwjud/mcp-server', async (original) => {
  const actual = await original<typeof import('@lnwjud/mcp-server')>();
  return { ...actual, startMcpHttp: async (options: unknown): Promise<unknown> => {
    fixture.options.push(options);
    return { endpoint: new URL('http://127.0.0.1:1/mcp'), close: async (): Promise<void> => { await fixture.waitForRequest; } };
  } };
});
vi.mock('../src/main/capability-runtime.js', () => ({
  createLocalCapabilityRuntime: (): unknown => ({
    service: { execute: async (): Promise<unknown> => { fixture.dispatches += 1; return ok({ fixture: true }); } },
    health: { execute: async (): Promise<unknown> => ok({}) },
    shell: { cancelForGoal: async (): Promise<unknown> => ok({ cancelled: 0 }) },
    domCdp: {
      ensureStarted: (): never => { fixture.forbidden += 1; throw new Error('Chrome launch forbidden'); },
      listTabsIfRunning: async (): Promise<unknown> => { fixture.lookups += 1; return ok({ ready: true, tabs: [{ id: 'fixture-tab', title: 'Fixture', url: 'https://fixture.invalid/form' }] }); },
    },
  }),
  buildCapabilitySummary: async (): Promise<readonly unknown[]> => [],
}));

const roots: string[] = [];
const runtimes: DesktopRuntime[] = [];
const hosts: DesktopApprovalWork[] = [];
beforeEach(() => {
  fixture.options = []; fixture.dispatches = 0; fixture.lookups = 0; fixture.forbidden = 0;
  fixture.waitForRequest = undefined;
  vi.spyOn(TunnelController.prototype, 'shutdownForDesktopExit').mockResolvedValue();
});
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const host of hosts.splice(0)) await host.close();
  vi.restoreAllMocks();
  expect(fixture.forbidden).toBe(0);
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('lnwjud-desktop-work-')) throw new Error('Unexpected cleanup target');
    rmSync(root, { recursive: true, force: true });
  }
});
function root(): string { const dir = mkdtempSync(path.join(os.tmpdir(), 'lnwjud-desktop-work-')); roots.push(dir); return dir; }
function input(phase: number): unknown { return { action: 'click', tab_id: 'fixture-tab', parameters: { selector: `#phase-${phase}` }, userConfirmed: true }; }
function plan(workspaceId: string, workspaceRoot: string, primaryWorkId = 'trusted-primary-work'): ApprovalHostPlan {
  return { primaryWorkId, clientId: 'fixture-client', sessionId: 'fixture-session', workspaceId, tabId: 'fixture-tab', pageUrl: 'https://fixture.invalid/form',
    requestDigests: Array.from({ length: 4 }, (_, phase) => hostApprovalInputDigest('dom_cdp', { ...domCdpCapabilitySchema.parse(input(phase)), metadata: { [CAPABILITY_ACTIVE_WORKSPACE_ROOT_METADATA_KEY]: path.resolve(workspaceRoot) } })) };
}
class MockWindow extends EventEmitter {
  destroyed = false;
  isDestroyed(): boolean { return this.destroyed; }
  show(): void { this.emit('show'); }
  focus(): void {}
  close(): void { this.destroyed = true; this.emit('closed'); }
}
function promptFixture(): { count: number; prompt(request: HostMutationApprovalRequest, context: HostMutationApprovalContext, gate?: ApprovalPromptDisplayGate): Promise<boolean> } {
  const display = { count: 0, async prompt(_request: HostMutationApprovalRequest, context: HostMutationApprovalContext, gate?: ApprovalPromptDisplayGate): Promise<boolean> {
    if (gate === undefined) return false;
    const window = new MockWindow(); display.count += 1;
    return new Promise((resolve) => {
      attachApprovalPromptDisplay(window, { signal: context.signal, beforeShow: gate.beforeShow, onShown: async (): Promise<boolean> => { const recorded = await gate.onShown(); resolve(recorded); return recorded; } });
      window.emit('ready-to-show');
    });
  } };
  return display;
}
function runtimeAt(data: string, display: ReturnType<typeof promptFixture>): DesktopRuntime {
  const runtime = createDesktopRuntime(data, { permissionProfile: 'full', checkpointEncryptionKey: Buffer.alloc(32, 0x37), hostMutationApprovalProvider: display.prompt });
  runtimes.push(runtime); return runtime;
}
function registry(options: McpHttpServerOptions, job: ApprovalHostPlan): ToolRegistry {
  return new ToolRegistry(options.services, { clientId: job.clientId, clientName: 'Fixture', sessionId: job.sessionId }, { ...options, sessionId: job.sessionId });
}
function controls(runtime: DesktopRuntime): (channel: string, payload: unknown, trusted?: boolean) => Promise<unknown> {
  const handlers = new Map<string, (event: boolean, payload: unknown) => unknown | Promise<unknown>>();
  registerApprovalWorkIpc((channel, handler) => { handlers.set(channel, handler); }, (event: boolean) => { if (!event) throw new Error('Untrusted sender'); }, () => runtime.services.approvalWork);
  return async (channel, payload, trusted = true): Promise<unknown> => handlers.get(channel)!(trusted, payload);
}
function review(runtime: DesktopRuntime, job: ApprovalHostPlan): { readonly reviewToken: string; readonly userConfirmed: true } {
  return { ...runtime.approvalWork!.prepare(job), userConfirmed: true };
}

function proposal(workspaceId: string): Record<string, unknown> {
  return { workspaceId, tab_id: 'fixture-tab', pageUrl: 'https://fixture.invalid/form', idempotencyKey: 'fixture-owner-intent', requests: [0, 1, 2, 3].map(input) };
}
async function wire(options: Omit<McpHttpServerOptions, 'activityTracker'>, sessionId: string, activityTracker?: ActivityTracker): Promise<{ client: Client; close(): Promise<void> }> {
  const server = createMcpServer({ services: options.services, actor: { clientId: 'fixture-client', clientName: 'Fixture' }, requestScope: { sessionId, transport: 'http' },
    ...(options.profileProvider === undefined ? {} : { profileProvider: options.profileProvider }),
    ...(options.authorizationModeProvider === undefined ? {} : { authorizationModeProvider: options.authorizationModeProvider }),
    ...(options.invocationGuardProvider === undefined ? {} : { invocationGuardProvider: options.invocationGuardProvider }),
    ...(options.activeWorkspaceScopeProvider === undefined ? {} : { activeWorkspaceScopeProvider: options.activeWorkspaceScopeProvider }),
    ...(options.activeWorkspaceScopesProvider === undefined ? {} : { activeWorkspaceScopesProvider: options.activeWorkspaceScopesProvider }),
    ...(options.hostMutationApprovalProvider === undefined ? {} : { hostMutationApprovalProvider: options.hostMutationApprovalProvider }),
    ...(activityTracker === undefined ? {} : { activityTracker }) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'chrome-work-wire-fixture', version: '1.0.0' });
  await server.connect(serverTransport); await client.connect(clientTransport);
  return { client, close: async (): Promise<void> => { await client.close(); await server.close(); } };
}

describe('ordinary MCP sender to R5 host work, using the real SDK in memory', () => {
  it('discovers, proposes, reviews, dispatches and reconnects without resetting the three-show budget', async () => {
    const data = root(); const workspaceRoot = root(); const display = promptFixture(); const runtime = runtimeAt(data, display);
    const workspaceId = await runtime.ensureDefaultWorkspace(workspaceRoot); await runtime.services.startMcp({ workspaceId });
    const options = fixture.options.at(-1) as McpHttpServerOptions;
    const audit: unknown[] = [];
    const activity = new ActivityTracker({ record: async (event): Promise<void> => { audit.push(event); } }, undefined, { record: async (event, detail): Promise<void> => { audit.push({ event, detail }); } });
    const first = await wire(options, 'fixture-session', activity);
    let second: Awaited<ReturnType<typeof wire>> | undefined;
    try {
      const tools = (await first.client.listTools()).tools.map((tool) => tool.name);
      expect(tools).toEqual(expect.arrayContaining(['chrome_work_prepare', 'chrome_work_status', 'chrome_work_reconnect', 'dom_cdp']));
      const response = await first.client.callTool({ name: 'chrome_work_prepare', arguments: proposal(workspaceId) });
      expect(response.isError).not.toBe(true);
      const prepared = response.structuredContent as { primaryWorkId: string; hostWorkId: string; connectionRevision: number; continuityToken: string };
      expect(prepared).toMatchObject({ primaryWorkId: expect.stringMatching(/^chrome-/), hostWorkId: expect.any(String), connectionRevision: 1, continuityToken: expect.any(String), selected: false, remaining: 3 });
      const duplicate = await first.client.callTool({ name: 'chrome_work_prepare', arguments: proposal(workspaceId) });
      expect(duplicate.structuredContent).toEqual(prepared);
      const newKey = await first.client.callTool({ name: 'chrome_work_prepare', arguments: { ...proposal(workspaceId), idempotencyKey: 'new-key-same-work' } });
      expect(newKey.structuredContent).toEqual(prepared);
      expect((await first.client.callTool({ name: 'dom_cdp', arguments: input(0) as Record<string, unknown> })).isError).toBe(true);
      expect(display.count).toBe(0); expect(fixture.dispatches).toBe(0);
      const ipc = controls(runtime);
      const reviewed = await ipc(approvalWorkChannels.prepare, { primaryWorkId: prepared.primaryWorkId, userConfirmed: true }) as { reviewToken: string };
      await ipc(approvalWorkChannels.start, { reviewToken: reviewed.reviewToken, userConfirmed: true });
      expect((await first.client.callTool({ name: 'dom_cdp', arguments: input(0) as Record<string, unknown> })).isError).not.toBe(true);
      expect((await first.client.callTool({ name: 'dom_cdp', arguments: input(1) as Record<string, unknown> })).isError).not.toBe(true);
      second = await wire(options, 'fixture-reconnected', activity);
      const resume = { workspaceId, primaryWorkId: prepared.primaryWorkId, continuityToken: prepared.continuityToken, expectedConnectionRevision: 1 };
      const beforeReconnect = await second.client.callTool({ name: 'chrome_work_status', arguments: { workspaceId, primaryWorkId: prepared.primaryWorkId, continuityToken: prepared.continuityToken } });
      expect(beforeReconnect.structuredContent).toMatchObject({ connectionRevision: 1, shown: 2, remaining: 1 });
      expect(JSON.stringify(beforeReconnect)).not.toContain(prepared.continuityToken);
      expect((await second.client.callTool({ name: 'chrome_work_prepare', arguments: proposal(workspaceId) })).isError).toBe(true);
      expect((await second.client.callTool({ name: 'chrome_work_reconnect', arguments: { ...resume, continuityToken: 'forged' } })).isError).toBe(true);
      const reconnected = await second.client.callTool({ name: 'chrome_work_reconnect', arguments: resume });
      expect(reconnected.structuredContent).toMatchObject({ primaryWorkId: prepared.primaryWorkId, hostWorkId: prepared.hostWorkId, connectionRevision: 2, shown: 2, remaining: 1 });
      expect((await first.client.callTool({ name: 'dom_cdp', arguments: input(2) as Record<string, unknown> })).isError).toBe(true);
      expect((await second.client.callTool({ name: 'dom_cdp', arguments: input(0) as Record<string, unknown> })).isError).toBe(true);
      expect((await second.client.callTool({ name: 'dom_cdp', arguments: input(2) as Record<string, unknown> })).isError).not.toBe(true);
      const fourth = await second.client.callTool({ name: 'dom_cdp', arguments: input(3) as Record<string, unknown> });
      expect(fourth).toMatchObject({ isError: true, structuredContent: { error: { details: { reason: 'BUDGET_EXHAUSTED', retryAllowed: 0 } } } });
      const status = await second.client.callTool({ name: 'chrome_work_status', arguments: { workspaceId, primaryWorkId: prepared.primaryWorkId } });
      expect(status.structuredContent).toMatchObject({ shown: 3, remaining: 0, connectionRevision: 2 });
      expect(JSON.stringify(status)).not.toContain(prepared.continuityToken);
      expect(JSON.stringify(audit)).not.toContain(prepared.continuityToken);
      expect(JSON.stringify(audit)).toContain('[REDACTED]');
      expect(display.count).toBe(3); expect(fixture.dispatches).toBe(3);
    } finally { await second?.close(); await first.close(); }
  });

  it('fails closed after a Desktop process lifetime ends, retaining budget without minting a replacement', async () => {
    const data = root(); const workspaceRoot = root(); const display = promptFixture(); const first = runtimeAt(data, display);
    const workspaceId = await first.ensureDefaultWorkspace(workspaceRoot); await first.services.startMcp({ workspaceId });
    const options = fixture.options.at(-1) as McpHttpServerOptions; const job = plan(workspaceId, workspaceRoot);
    const created = await registry(options, job).invoke('chrome_work_prepare', proposal(workspaceId));
    const registered = created.structuredContent as { primaryWorkId: string; continuityToken: string };
    expect(created.isError).not.toBe(true); await first.close();
    const next = runtimeAt(data, display); await next.services.startMcp({ workspaceId });
    const sender = registry(fixture.options.at(-1) as McpHttpServerOptions, job);
    expect((await sender.invoke('chrome_work_reconnect', { workspaceId, primaryWorkId: registered.primaryWorkId, continuityToken: registered.continuityToken, expectedConnectionRevision: 1 })).isError).toBe(true);
    expect((await sender.invoke('chrome_work_prepare', { ...proposal(workspaceId), idempotencyKey: 'fresh-key-after-process-restart' })).isError).toBe(true);
    const saved = await next.services.approvalWork!.list();
    expect(saved.works).toHaveLength(1); expect(saved.works[0]).toMatchObject({ primaryWorkId: registered.primaryWorkId, shown: 0, remaining: 3 });
    expect(display.count).toBe(0); expect(fixture.dispatches).toBe(0);
  });

  it('enrolls one work for concurrent and re-keyed retries, rejects changed intent, owner and stale revision', async () => {
    const data = root(); const workspaceRoot = root(); const display = promptFixture(); const runtime = runtimeAt(data, display);
    const workspaceId = await runtime.ensureDefaultWorkspace(workspaceRoot); await runtime.services.startMcp({ workspaceId });
    const options = fixture.options.at(-1) as McpHttpServerOptions; const job = plan(workspaceId, workspaceRoot); const sender = registry(options, job);
    const pair = await Promise.all([sender.invoke('chrome_work_prepare', proposal(workspaceId)), sender.invoke('chrome_work_prepare', proposal(workspaceId))]);
    expect(pair[0]!.isError).not.toBe(true); expect(pair[1]!.structuredContent).toEqual(pair[0]!.structuredContent);
    const registered = pair[0]!.structuredContent as { primaryWorkId: string; continuityToken: string };
    expect((await sender.invoke('chrome_work_prepare', { ...proposal(workspaceId), idempotencyKey: 'alias' })).isError).not.toBe(true);
    const changed = { ...proposal(workspaceId), idempotencyKey: 'alias', requests: [input(10)] };
    expect((await sender.invoke('chrome_work_prepare', changed)).isError).toBe(true);
    const owner = registry(options, { ...job, clientId: 'other-client' });
    const resume = { workspaceId, primaryWorkId: registered.primaryWorkId, continuityToken: registered.continuityToken, expectedConnectionRevision: 1 };
    expect((await owner.invoke('chrome_work_reconnect', resume)).isError).toBe(true);
    expect((await owner.invoke('chrome_work_status', { workspaceId, primaryWorkId: registered.primaryWorkId })).isError).toBe(true);
    expect((await registry(options, { ...job, sessionId: 'next-session' }).invoke('chrome_work_reconnect', resume)).isError).not.toBe(true);
    expect((await sender.invoke('chrome_work_reconnect', resume)).isError).toBe(true);
    expect((await sender.invoke('chrome_work_prepare', proposal(workspaceId))).isError).toBe(true);
    const list = await runtime.services.approvalWork!.list();
    expect(list.works).toHaveLength(1); expect(list.works[0]).toMatchObject({ shown: 0, remaining: 3, selected: false });
    expect(display.count).toBe(0); expect(fixture.dispatches).toBe(0);
  });
});

describe('Desktop start/resume composition with mock capabilities and no listeners/UI', () => {
  it('binds registry selection IPC to the current host Primary Project', async () => {
    const data = root(); const firstRoot = root(); const secondRoot = root(); const display = promptFixture(); const runtime = runtimeAt(data, display);
    const workspaceId = await runtime.ensureDefaultWorkspace(firstRoot); const job = plan(workspaceId, firstRoot);
    const handle = await runtime.approvalWork!.start(job); await runtime.approvalWork!.deactivate(job.primaryWorkId);
    const ipc = controls(runtime);
    expect(await ipc(approvalWorkChannels.list, undefined)).toMatchObject({ workspaceId, works: [{ hostWorkId: handle.hostWorkId }] });
    const review = await ipc(approvalWorkChannels.prepare, { primaryWorkId: job.primaryWorkId, userConfirmed: true }) as { reviewToken: string };
    const second = await runtime.services.addWorkspace({ rootPath: secondRoot });
    const other = second.id;
    await runtime.services.selectWorkspace({ workspaceId: other });
    expect(await ipc(approvalWorkChannels.list, undefined)).toEqual({ workspaceId: other, works: [] });
    await expect(ipc(approvalWorkChannels.start, { reviewToken: review.reviewToken, userConfirmed: true })).rejects.toMatchObject({ reason: 'HOST_WORKSPACE_MISMATCH' });
    expect(display.count).toBe(0); expect(fixture.dispatches).toBe(0);
  });
  it('uses the same durable work across HTTP reconnect, Desktop close/reopen and stdio provider routing', async () => {
    const data = root(); const workspaceRoot = root(); const display = promptFixture();
    const first = runtimeAt(data, display); const workspaceId = await first.ensureDefaultWorkspace(workspaceRoot); const job = plan(workspaceId, workspaceRoot);
    const handle = await controls(first)(approvalWorkChannels.start, review(first, job)) as { hostWorkId: string };
    await first.services.startMcp({ workspaceId });
    const firstOptions = fixture.options.at(-1) as McpHttpServerOptions;
    expect(firstOptions.hostMutationApprovalProvider).toBe(first.hostMutationApprovalProvider);
    expect((await registry(firstOptions, job).invoke('dom_cdp', input(0))).isError).not.toBe(true);
    await first.services.restartMcp(); // Recreates transport with no real listener.
    const reconnected = fixture.options.at(-1) as McpHttpServerOptions;
    expect(reconnected.hostMutationApprovalProvider).toBe(first.hostMutationApprovalProvider);
    expect((await registry(reconnected, job).invoke('dom_cdp', input(1))).isError).not.toBe(true);
    await first.close();

    const restarted = runtimeAt(data, display);
    expect(await controls(restarted)(approvalWorkChannels.resume, { primaryWorkId: job.primaryWorkId, userConfirmed: true })).toMatchObject({ hostWorkId: handle.hostWorkId });
    await expect(restarted.approvalWork!.snapshot(job.primaryWorkId)).resolves.toMatchObject({ shown: 2, remaining: 1 });
    await restarted.services.startMcp({ workspaceId });
    const nextOptions = fixture.options.at(-1) as McpHttpServerOptions;
    // Stdio receives this exact composed provider from DesktopRuntime, just as main.ts now does.
    const stdio = { ...nextOptions, hostMutationApprovalProvider: restarted.hostMutationApprovalProvider! };
    expect((await registry(stdio, job).invoke('dom_cdp', input(2))).isError).not.toBe(true);
    const denied = await registry(nextOptions, job).invoke('dom_cdp', input(3));
    expect(denied).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED', details: { reason: 'BUDGET_EXHAUSTED', retryAllowed: 0, hostWorkId: handle.hostWorkId } } } });
    expect(display.count).toBe(3); expect(fixture.dispatches).toBe(3);
    await expect(restarted.approvalWork!.start(job)).resolves.toMatchObject({ hostWorkId: handle.hostWorkId });
    await expect(restarted.approvalWork!.snapshot(job.primaryWorkId)).resolves.toMatchObject({ shown: 3, remaining: 0 });
    const source = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
    expect(source).toContain('hostMutationApprovalProvider: runtime.hostMutationApprovalProvider');
    expect(source).toContain('showMutationApprovalPrompt(request, context, displayGate)');
  });

  it('requires explicit host work and ignores caller job/session hints', async () => {
    const data = root(); const workspaceRoot = root(); const display = promptFixture(); const runtime = runtimeAt(data, display);
    const workspaceId = await runtime.ensureDefaultWorkspace(workspaceRoot); const job = plan(workspaceId, workspaceRoot);
    await runtime.services.startMcp({ workspaceId }); const options = fixture.options.at(-1) as McpHttpServerOptions;
    const noWork = await registry(options, job).invoke('dom_cdp', input(0), { traceId: job.primaryWorkId });
    expect(noWork).toMatchObject({ isError: true, structuredContent: { error: { details: { reason: 'HOST_WORK_REQUIRED' } } } });
    expect(existsSync(path.join(data, 'approval-work'))).toBe(false);
    await runtime.approvalWork!.start(job);
    const replayHint = await registry(options, job).invoke('dom_cdp', { ...input(0) as object, primaryWorkId: 'caller-job' });
    expect(replayHint.isError).toBe(true);
    expect(display.count).toBe(0); expect(fixture.dispatches).toBe(0);
  });

  it('does not recreate a missing journal after restart', async () => {
    const data = root(); const workspaceRoot = root(); const display = promptFixture(); const first = runtimeAt(data, display);
    const workspaceId = await first.ensureDefaultWorkspace(workspaceRoot); const job = plan(workspaceId, workspaceRoot);
    await first.approvalWork!.start(job); await first.close();
    unlinkSync(path.join(data, 'approval-work', 'host.sqlite'));
    const next = runtimeAt(data, display);
    await expect(next.approvalWork!.resume(job.primaryWorkId)).rejects.toMatchObject({ reason: 'HOST_REGISTRY_UNAVAILABLE' });
    await expect(next.approvalWork!.start(job)).rejects.toMatchObject({ reason: 'HOST_REGISTRY_UNAVAILABLE' });
    expect(existsSync(path.join(data, 'approval-work', 'host.sqlite'))).toBe(false);
    expect(display.count).toBe(0);
  });

  it('selects one host work per scope and keeps inactive history without making future work ambiguous', async () => {
    const data = root(); const workspaceRoot = root(); const display = promptFixture(); const runtime = runtimeAt(data, display);
    const workspaceId = await runtime.ensureDefaultWorkspace(workspaceRoot); const job = plan(workspaceId, workspaceRoot);
    await runtime.approvalWork!.start(job);
    await expect(runtime.approvalWork!.start({ ...job, primaryWorkId: 'other-trusted-work' })).rejects.toThrow(/still selected/);
    await controls(runtime)(approvalWorkChannels.deactivate, { primaryWorkId: job.primaryWorkId, userConfirmed: true });
    await controls(runtime)(approvalWorkChannels.start, review(runtime, { ...job, primaryWorkId: 'other-trusted-work' }));
    await runtime.services.startMcp({ workspaceId });
    const response = await registry(fixture.options.at(-1) as McpHttpServerOptions, job).invoke('dom_cdp', input(0));
    expect(response.isError).not.toBe(true);
    expect(display.count).toBe(1); expect(fixture.dispatches).toBe(1);
    await expect(runtime.approvalWork!.snapshot(job.primaryWorkId)).resolves.toMatchObject({ shown: 0 });
  });

  it('requires trusted confirmed host IPC and never exposes start/resume as MCP action approval', async () => {
    const data = root(); const workspaceRoot = root(); const display = promptFixture(); const runtime = runtimeAt(data, display);
    const workspaceId = await runtime.ensureDefaultWorkspace(workspaceRoot); const job = plan(workspaceId, workspaceRoot); const invoke = controls(runtime);
    const token = review(runtime, job);
    await expect(invoke(approvalWorkChannels.start, token, false)).rejects.toThrow('Untrusted');
    await expect(invoke(approvalWorkChannels.start, { reviewToken: token.reviewToken })).rejects.toThrow('confirmation');
    await expect(invoke(approvalWorkChannels.start, { reviewToken: 'renderer-minted', userConfirmed: true })).rejects.toMatchObject({ reason: 'HOST_REVIEW_REQUIRED' });
    await expect(invoke(approvalWorkChannels.start, { plan: job, userConfirmed: true })).rejects.toThrow('confirmation');
    await expect(invoke(approvalWorkChannels.resume, { primaryWorkId: job.primaryWorkId, userConfirmed: true, traceId: 'forged' })).rejects.toThrow('confirmation');
    expect(existsSync(path.join(data, 'approval-work'))).toBe(false); expect(display.count).toBe(0);
    await invoke(approvalWorkChannels.start, token);
    await expect(invoke(approvalWorkChannels.start, token)).rejects.toMatchObject({ reason: 'HOST_REVIEW_REQUIRED' });
  });

  it('blocks a stale request if deactivate wins before reservation, including another SQLite connection', async () => {
    const data = root(); const workspaceRoot = root(); const display = promptFixture(); const runtime = runtimeAt(data, display);
    const workspaceId = await runtime.ensureDefaultWorkspace(workspaceRoot); const job = plan(workspaceId, workspaceRoot);
    const handle = await runtime.approvalWork!.start(job); await runtime.services.startMcp({ workspaceId });
    let reached!: () => void; let release!: () => void;
    const atReservation = new Promise<void>((resolve) => { reached = resolve; });
    const proceed = new Promise<void>((resolve) => { release = resolve; });
    const original = SqliteApprovalHostStore.prototype.compareAndSwap;
    let held = false;
    vi.spyOn(SqliteApprovalHostStore.prototype, 'compareAndSwap').mockImplementation(async function (this: SqliteApprovalHostStore, ...args: Parameters<typeof original>): Promise<boolean> {
      if (!held) { held = true; reached(); await proceed; }
      return original.apply(this, args);
    });
    const pending = registry(fixture.options.at(-1) as McpHttpServerOptions, job).invoke('dom_cdp', input(0));
    await atReservation;
    const other = SqliteApprovalHostStore.openExisting(path.join(data, 'approval-work', 'host.sqlite'));
    try { other.selectDesktopWork(handle.hostWorkId, false); } finally { other.close(); }
    release();
    const response = await pending;
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { details: { reason: 'RECOVERY_REQUIRED' } } } });
    expect(display.count).toBe(0); expect(fixture.dispatches).toBe(0);
    await expect(runtime.approvalWork!.snapshot(job.primaryWorkId)).resolves.toMatchObject({ requested: 0, shown: 0, remaining: 3 });
  });

  it('cancels pending approval before waiting for MCP shutdown and preserves its spent show event', async () => {
    const data = root(); const workspaceRoot = root(); let shown!: () => void; const didShow = new Promise<void>((resolve) => { shown = resolve; });
    const display = promptFixture(); const runtime = createDesktopRuntime(data, { permissionProfile: 'full', checkpointEncryptionKey: Buffer.alloc(32, 0x37), hostMutationApprovalProvider: async (_request, context, gate): Promise<boolean> => {
      if (!gate) return false;
      const window = new MockWindow();
      attachApprovalPromptDisplay(window, { signal: context.signal, beforeShow: gate.beforeShow, onShown: async (): Promise<boolean> => { const recorded = await gate.onShown(); shown(); return recorded; } });
      window.emit('ready-to-show');
      return new Promise((resolve) => { context.signal.addEventListener('abort', () => resolve(false), { once: true }); });
    } }); runtimes.push(runtime);
    const workspaceId = await runtime.ensureDefaultWorkspace(workspaceRoot); const job = plan(workspaceId, workspaceRoot);
    await runtime.approvalWork!.start(job); await runtime.services.startMcp({ workspaceId });
    const pending = registry(fixture.options.at(-1) as McpHttpServerOptions, job).invoke('dom_cdp', input(0));
    fixture.waitForRequest = pending; await didShow;
    await expect(runtime.approvalWork!.deactivate(job.primaryWorkId)).rejects.toThrow(/pending/);
    await runtime.close(); expect((await pending).isError).toBe(true); expect(fixture.dispatches).toBe(0);
    fixture.waitForRequest = undefined;
    const next = runtimeAt(data, display);
    await expect(next.approvalWork!.snapshot(job.primaryWorkId)).resolves.toMatchObject({ shown: 1, approved: 0 });
  });

  it('consumes a review token once before concurrent start awaits and rejects expired tokens', async () => {
    const data = root(); const workspaceRoot = root(); const display = promptFixture(); const runtime = runtimeAt(data, display);
    const workspaceId = await runtime.ensureDefaultWorkspace(workspaceRoot); const job = plan(workspaceId, workspaceRoot);
    const token = review(runtime, job); const invoke = controls(runtime);
    const results = await Promise.allSettled([invoke(approvalWorkChannels.start, token), invoke(approvalWorkChannels.start, token)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await expect(runtime.approvalWork!.snapshot(job.primaryWorkId)).resolves.toMatchObject({ requested: 0, shown: 0, remaining: 3 });
    const expired = review(runtime, job); const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 120_001);
    await expect(invoke(approvalWorkChannels.start, expired)).rejects.toMatchObject({ reason: 'HOST_REVIEW_REQUIRED' });
    expect(display.count).toBe(0);
  });

  it('fails closed on incomplete startup registry and closes idempotently', async () => {
    const data = root(); const directory = path.join(data, 'approval-work'); mkdirSync(directory);
    const display = promptFixture(); const host = new DesktopApprovalWork(directory, display.prompt); hosts.push(host);
    await expect(host.resume('old-primary')).rejects.toMatchObject({ reason: 'HOST_REGISTRY_UNAVAILABLE' });
    const one = host.close(); expect(host.close()).toBe(one); await one;
    await expect(host.resume('old-primary')).rejects.toMatchObject({ reason: 'HOST_SHUTTING_DOWN' });
  });

  it('registers a new Chrome work from a main-process ticket before the first tool call, then selects it through trusted renderer IPC', async () => {
    const data = root(); const workspaceRoot = root(); const display = promptFixture(); const runtime = runtimeAt(data, display);
    const workspaceId = await runtime.ensureDefaultWorkspace(workspaceRoot); const seed = plan(workspaceId, workspaceRoot);
    const launchInput: Omit<ApprovalHostPlan, 'primaryWorkId'> = seed;
    const ticket = runtime.chromeWork!.prepare(launchInput);
    const registered = await runtime.chromeWork!.register(ticket);
    expect(registered).toMatchObject({ hostWorkId: expect.any(String), primaryWorkId: expect.stringMatching(/^chrome-/), connectionRevision: 1 });
    const invoke = controls(runtime);
    expect(await invoke(approvalWorkChannels.list, undefined)).toMatchObject({ workspaceId, works: [{ primaryWorkId: registered.primaryWorkId, selected: false, remaining: 3 }] });
    await expect(invoke(approvalWorkChannels.start, { reviewToken: 'renderer-minted', userConfirmed: true })).rejects.toMatchObject({ reason: 'HOST_REVIEW_REQUIRED' });
    const prepared = await invoke(approvalWorkChannels.prepare, { primaryWorkId: registered.primaryWorkId, userConfirmed: true }) as { reviewToken: string; work: { selected: boolean } };
    expect(prepared.work.selected).toBe(false);
    await expect(invoke(approvalWorkChannels.start, { reviewToken: prepared.reviewToken, userConfirmed: true })).resolves.toMatchObject({ hostWorkId: registered.hostWorkId });
    await runtime.services.startMcp({ workspaceId });
    const boundJob = { ...launchInput, primaryWorkId: registered.primaryWorkId };
    const response = await registry(fixture.options.at(-1) as McpHttpServerOptions, boundJob).invoke('dom_cdp', input(0));
    expect(response.isError).not.toBe(true); expect(display.count).toBe(1); expect(fixture.dispatches).toBe(1);
  });

  it('keeps the same Chrome work and budget across reconnect, rejects forged tickets and stale revisions', async () => {
    const data = root(); const workspaceRoot = root(); const display = promptFixture(); const first = runtimeAt(data, display);
    const workspaceId = await first.ensureDefaultWorkspace(workspaceRoot); const seed = plan(workspaceId, workspaceRoot); const launchInput: Omit<ApprovalHostPlan, 'primaryWorkId'> = seed;
    const ticket = first.chromeWork!.prepare(launchInput); const registered = await first.chromeWork!.register(ticket); const invoke = controls(first);
    const review = await invoke(approvalWorkChannels.prepare, { primaryWorkId: registered.primaryWorkId, userConfirmed: true }) as { reviewToken: string };
    await invoke(approvalWorkChannels.start, { reviewToken: review.reviewToken, userConfirmed: true }); await first.services.startMcp({ workspaceId });
    const bound = { ...launchInput, primaryWorkId: registered.primaryWorkId };
    const options = fixture.options.at(-1) as McpHttpServerOptions;
    expect((await registry(options, bound).invoke('dom_cdp', input(0))).isError).not.toBe(true);
    expect((await registry(options, bound).invoke('dom_cdp', input(1))).isError).not.toBe(true);
    await expect(first.chromeWork!.register(structuredClone(ticket))).rejects.toThrow(/capability/);
    await first.close();
    const restarted = runtimeAt(data, display);
    await expect(restarted.chromeWork!.reconnect(ticket, registered.connectionRevision + 1, 'fixture-session-reconnected')).rejects.toThrow(/stale|revision/i);
    const connection = await restarted.chromeWork!.reconnect(ticket, registered.connectionRevision, 'fixture-session-reconnected');
    expect(connection).toMatchObject({ clientId: launchInput.clientId, sessionId: 'fixture-session-reconnected', revision: 2 });
    const selected = controls(restarted);
    const prepared = await selected(approvalWorkChannels.prepare, { primaryWorkId: registered.primaryWorkId, userConfirmed: true }) as { reviewToken: string };
    await selected(approvalWorkChannels.start, { reviewToken: prepared.reviewToken, userConfirmed: true }); await restarted.services.startMcp({ workspaceId });
    const reconnected = { ...bound, sessionId: 'fixture-session-reconnected' };
    const nextOptions = fixture.options.at(-1) as McpHttpServerOptions;
    expect((await registry(nextOptions, reconnected).invoke('dom_cdp', input(2))).isError).not.toBe(true);
    const denied = await registry(nextOptions, reconnected).invoke('dom_cdp', input(3));
    expect(denied).toMatchObject({ isError: true, structuredContent: { error: { details: { reason: 'BUDGET_EXHAUSTED', retryAllowed: 0 } } } });
    expect(display.count).toBe(3); expect(fixture.dispatches).toBe(3);
  });

  it('rejects Chrome registration outside the selected workspace and preserves the old session boundary', async () => {
    const data = root(); const workspaceRoot = root(); const otherRoot = root(); const display = promptFixture(); const runtime = runtimeAt(data, display);
    const workspaceId = await runtime.ensureDefaultWorkspace(workspaceRoot); const seed = plan(workspaceId, workspaceRoot); const launchInput: Omit<ApprovalHostPlan, 'primaryWorkId'> = seed;
    const otherWorkspaceId = await runtime.services.addWorkspace({ rootPath: otherRoot }).then((value) => value.id); await runtime.services.selectWorkspace({ workspaceId: otherWorkspaceId });
    const ticket = prepareChromeWorkLaunch(launchInput);
    await expect(runtime.chromeWork!.register(ticket)).rejects.toThrow(/Primary Project/);
    expect(fixture.dispatches).toBe(0); expect(display.count).toBe(0);
  });
  it('continues exact requests learned after preflight through MCP on the same work and budget', async () => {
    const data = root(); const workspaceRoot = root(); const display = promptFixture(); const runtime = runtimeAt(data, display);
    const workspaceId = await runtime.ensureDefaultWorkspace(workspaceRoot); await runtime.services.startMcp({ workspaceId });
    const options = fixture.options.at(-1) as McpHttpServerOptions; const client = registry(options, plan(workspaceId, workspaceRoot));
    const proposed = await client.invoke('chrome_work_prepare', { ...proposal(workspaceId), requests: [input(0)] });
    const saved = proposed.structuredContent as { primaryWorkId: string; hostWorkId: string; continuityToken: string };
    expect(proposed.isError).not.toBe(true);
    const ipc = controls(runtime);
    const select = async (): Promise<void> => { const review = await ipc(approvalWorkChannels.prepare, { primaryWorkId: saved.primaryWorkId, userConfirmed: true }) as { reviewToken: string }; await ipc(approvalWorkChannels.start, { reviewToken: review.reviewToken, userConfirmed: true }); };
    await select(); expect((await client.invoke('dom_cdp', input(0))).isError).not.toBe(true);
    // Exact future requests become known only after the first phase.
    const dynamic = [1, 2, 3].map((phase) => ({ ...input(phase) as object, parameters: { selector: `#resolved-${saved.hostWorkId}-${phase}` } }));
    const status = (await client.invoke('chrome_work_status', { workspaceId, primaryWorkId: saved.primaryWorkId })).structuredContent as { revision: number };
    const extend = { ...proposal(workspaceId), requests: dynamic, primaryWorkId: saved.primaryWorkId, continuityToken: saved.continuityToken, idempotencyKey: 'resolved-after-preflight',
      expectedConnectionRevision: 1, expectedBudgetRevision: status.revision, expectedContinuationRevision: 0 };
    expect((await client.invoke('chrome_work_extend', { ...extend, continuityToken: 'forged' })).isError).toBe(true);
    expect((await client.invoke('chrome_work_extend', { ...extend, tab_id: 'other-tab', requests: [{ ...dynamic[0], tab_id: 'mismatched-request-tab' }] })).isError).toBe(true);
    const extended = await client.invoke('chrome_work_extend', extend);
    expect(extended).toMatchObject({ structuredContent: { hostWorkId: saved.hostWorkId, primaryWorkId: saved.primaryWorkId, selected: false, shown: 1, remaining: 2, continuationRevision: 1 } });
    expect((await client.invoke('dom_cdp', dynamic[0])).isError).toBe(true); expect(display.count).toBe(1);
    await select();
    expect((await client.invoke('dom_cdp', dynamic[0])).isError).not.toBe(true);
    expect((await client.invoke('chrome_work_extend', extend)).isError).not.toBe(true); // lost response retry
    expect((await client.invoke('dom_cdp', dynamic[1])).isError).not.toBe(true);
    expect(await client.invoke('dom_cdp', dynamic[2])).toMatchObject({ isError: true, structuredContent: { error: { details: { reason: 'BUDGET_EXHAUSTED' } } } });
    expect((await client.invoke('chrome_work_status', { workspaceId, primaryWorkId: saved.primaryWorkId })).structuredContent).toMatchObject({ hostWorkId: saved.hostWorkId, shown: 3, remaining: 0, continuationRevision: 1 });
    expect(display.count).toBe(3); expect(fixture.dispatches).toBe(3);
  });

});
