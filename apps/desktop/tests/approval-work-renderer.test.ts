import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { isValidElement, type ReactElement } from 'react';
import { ApprovalWorkPage, type ApprovalWorkPageApi } from '../src/renderer/features/approval-work/ApprovalWorkPage.js';
import { DesktopApprovalWork } from '../src/main/desktop-approval-work.js';
import { registerApprovalWorkIpc } from '../src/main/desktop-approval-ipc.js';
import { approvalWorkChannels, type DesktopApprovalWorkSummary } from '../../../packages/ipc-contracts/src/approval-work-contracts.js';
import { createHostApprovalInvocation } from '../../../packages/mcp-server/src/host-approval-invocation.js';

// Execute real React component/button callbacks; schedule hooks without a DOM or native window.
const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as Array<() => void> }));
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>();
  function memo(factory: () => unknown, deps: readonly unknown[]): unknown {
    const slot = hooks.cursor++; const prior = hooks.slots[slot] as { deps: readonly unknown[]; value: unknown } | undefined;
    if (prior === undefined || deps.some((value, index) => value !== prior.deps[index])) hooks.slots[slot] = { deps, value: factory() };
    return (hooks.slots[slot] as { value: unknown }).value;
  }
  return { ...actual,
    useState: (initial: unknown): [unknown, (value: unknown) => void] => {
      const slot = hooks.cursor++;
      if (!(slot in hooks.slots)) hooks.slots[slot] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      return [hooks.slots[slot], (value: unknown): void => { hooks.slots[slot] = typeof value === 'function' ? (value as (old: unknown) => unknown)(hooks.slots[slot]) : value; }];
    },
    useRef: (value: unknown): unknown => memo(() => ({ current: value }), []), useMemo: memo,
    useEffect: (effect: () => void | (() => void), deps: readonly unknown[]): void => {
      const slot = hooks.cursor++; const prior = hooks.slots[slot] as { deps: readonly unknown[]; cleanup?: () => void } | undefined;
      if (prior !== undefined && deps.length === prior.deps.length && deps.every((value, index) => value === prior.deps[index])) return;
      prior?.cleanup?.(); hooks.effects.push(() => { hooks.slots[slot] = { deps, cleanup: effect() }; });
    },
  };
});
const roots: string[] = []; const hosts: DesktopApprovalWork[] = [];
beforeEach(() => { hooks.cursor = 0; hooks.slots = []; hooks.effects = []; });
afterEach(async () => {
  for (const slot of hooks.slots) {
    const cleanup = (slot as { cleanup?: unknown } | undefined)?.cleanup;
    if (typeof cleanup === 'function') cleanup();
  }
  vi.useRealTimers(); vi.restoreAllMocks(); for (const host of hosts.splice(0)) await host.close();
  for (const dir of roots.splice(0)) {
    if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith('lnwjud-renderer-r4-')) throw new Error('Unexpected cleanup path');
    rmSync(dir, { recursive: true, force: true });
  }
});
function work(overrides: Partial<DesktopApprovalWorkSummary> = {}): DesktopApprovalWorkSummary {
  return { primaryWorkId: 'work-a', hostWorkId: 'host-a', workspaceId: 'workspace-a', tabId: 'tab-a', pageUrl: 'https://fixture.invalid/form', selected: false,
    shown: 0, remaining: 3, limit: 3, blocked: 0, inDoubt: 0, revision: 1, ...overrides };
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
type MockPageApi = { [Method in keyof ApprovalWorkPageApi]: Mock<ApprovalWorkPageApi[Method]> };
function apiFixture(): MockPageApi {
  return {
    listApprovalWorks: vi.fn<ApprovalWorkPageApi['listApprovalWorks']>(async () => ({ workspaceId: 'workspace-a', works: [work()] })),
    prepareApprovalWork: vi.fn(async () => ({ reviewToken: 'token-a', expiresAt: Date.now() + 60_000, work: work() })),
    startApprovalWork: vi.fn(async () => ({ hostWorkId: 'host-a' })),
    deactivateApprovalWork: vi.fn(async () => ({ deactivated: true as const })),
  };
}
function page(api: ApprovalWorkPageApi): { render: () => void; settle: () => Promise<void>; button: (label: string) => ReactElement<Record<string, unknown>> | undefined; click: (label: string) => void; nodes: () => Array<ReactElement<Record<string, unknown>>>; setWorkspace: (id: string | null) => void } {
  let workspace: string | null = 'workspace-a'; let tree: ReactElement;
  const pending = new Set<Promise<unknown>>();
  const track = <T,>(operation: Promise<T>): Promise<T> => { pending.add(operation); void operation.finally((): void => { pending.delete(operation); }).catch((): undefined => undefined); return operation; };
  const observed: ApprovalWorkPageApi = { listApprovalWorks: () => track(api.listApprovalWorks()), prepareApprovalWork: (request) => track(api.prepareApprovalWork(request)),
    startApprovalWork: (request) => track(api.startApprovalWork(request)), deactivateApprovalWork: (request) => track(api.deactivateApprovalWork(request)) };
  const render = (): void => { hooks.cursor = 0; tree = ApprovalWorkPage({ api: observed, locale: 'en', selectedWorkspaceId: workspace }); for (const effect of hooks.effects.splice(0)) effect(); };
  const settle = async (): Promise<void> => { for (let turn = 0; turn < 12; turn += 1) { await Promise.allSettled([...pending]); await Promise.resolve(); render(); } };
  const nodes = (node: unknown): Array<ReactElement<Record<string, unknown>>> => {
    if (Array.isArray(node)) return node.flatMap((item) => nodes(item));
    if (!isValidElement<Record<string, unknown>>(node)) return [];
    return [node, ...nodes(node.props.children)];
  };
  const button = (label: string): ReactElement<Record<string, unknown>> | undefined => nodes(tree).find((node) => node.props.children === label && typeof node.props.onClick === 'function');
  const click = (label: string): void => { const found = button(label); if (found === undefined) throw new Error(`Button missing: ${label}`); if (found.props.disabled) throw new Error(`Button disabled: ${label}`); (found.props.onClick as () => void)(); };
  render(); return { render, settle, button, click, nodes: (): Array<ReactElement<Record<string, unknown>>> => nodes(tree), setWorkspace: (id: string | null): void => { workspace = id; render(); } };
}

describe('actual renderer selection handlers without native UI', () => {
  it('selects persisted work through renderer -> trusted IPC -> SQLite and preserves cap after reopening', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'lnwjud-renderer-r4-')); roots.push(root); const directory = path.join(root, 'registry');
    let mockShowEvents = 0; let selectedWorkspace = 'workspace-a';
    const open = (): DesktopApprovalWork => { const instance = new DesktopApprovalWork(directory, async (_request, _context, gate): Promise<boolean> => {
      if (gate === undefined || !await gate.beforeShow()) return false; mockShowEvents += 1; return gate.onShown();
    }); hosts.push(instance); return instance; };
    let host = open();
    const plan = { primaryWorkId: 'work-a', workspaceId: 'workspace-a', clientId: 'fixture-client', sessionId: 'fixture-session', tabId: 'tab-a', pageUrl: 'https://fixture.invalid/form',
      requestDigests: Array.from({ length: 4 }, (_, phase) => createHash('sha256').update(`renderer-phase-${phase}`).digest('hex')) };
    const handle = await host.start(plan); await host.deactivate(plan.primaryWorkId);
    const handlers = new Map<string, (event: boolean, payload: unknown) => unknown>();
    registerApprovalWorkIpc((channel, handler): void => { handlers.set(channel, handler); }, (trusted: boolean): void => { if (!trusted) throw new Error('Untrusted sender'); }, () => ({
      list: (): ReturnType<DesktopApprovalWork['list']> => host.list(selectedWorkspace), prepareFromRegistry: (id: string): ReturnType<DesktopApprovalWork['prepareFromRegistry']> => host.prepareFromRegistry(id, selectedWorkspace),
      startReviewed: (token: string): ReturnType<DesktopApprovalWork['startReviewed']> => host.startReviewed(token, selectedWorkspace), resume: (id: string): ReturnType<DesktopApprovalWork['resume']> => host.resume(id, selectedWorkspace), deactivate: (id: string): ReturnType<DesktopApprovalWork['deactivate']> => host.deactivate(id, selectedWorkspace),
    }));
    const invoke = async <T,>(channel: string, payload?: unknown): Promise<T> => {
      const handler = handlers.get(channel); if (handler === undefined) throw new Error(`Missing IPC handler: ${channel}`); return await handler(true, payload) as T;
    };
    const api: ApprovalWorkPageApi = { listApprovalWorks: () => invoke(approvalWorkChannels.list), prepareApprovalWork: (request) => invoke(approvalWorkChannels.prepare, request),
      startApprovalWork: (request) => invoke(approvalWorkChannels.start, request), deactivateApprovalWork: (request) => invoke(approvalWorkChannels.deactivate, request) };
    const ui = page(api); await ui.settle(); ui.click('Prepare work'); await ui.settle();
    expect(ui.button('Confirm start')).toBeDefined(); ui.click('Confirm start'); await ui.settle();
    expect((await host.list(plan.workspaceId)).works[0]).toMatchObject({ selected: true, hostWorkId: handle.hostWorkId });
    const request = async (phase: number): Promise<boolean> => {
      const abort = new AbortController();
      return host.request({ toolName: 'dom_cdp', workspaceId: plan.workspaceId, presentation: { browserTabId: plan.tabId, browserTabLookup: 'resolved', browserTabUrl: plan.pageUrl } } as never,
        { signal: abort.signal, cancel: () => abort.abort(), invocationProof: createHostApprovalInvocation({ callId: `renderer-call-${phase}`, clientId: plan.clientId, sessionId: plan.sessionId, workspaceId: plan.workspaceId, tabId: plan.tabId, inputDigest: plan.requestDigests[phase]! }) } as never);
    };
    expect(await request(0)).toBe(true); ui.click('Deactivate work'); await ui.settle();
    expect((await host.list(plan.workspaceId)).works[0]?.selected).toBe(false);
    await host.close(); host = open();
    ui.click('Refresh'); await ui.settle(); ui.click('Prepare work'); await ui.settle(); ui.click('Confirm start'); await ui.settle();
    expect(await request(1)).toBe(true); expect(await request(2)).toBe(true);
    await expect(request(3)).rejects.toMatchObject({ reason: 'BUDGET_EXHAUSTED' }); expect(mockShowEvents).toBe(3);
    expect((await host.list(plan.workspaceId)).works[0]).toMatchObject({ hostWorkId: handle.hostWorkId, shown: 3, remaining: 0, blocked: 1 });
    selectedWorkspace = 'workspace-b'; ui.setWorkspace(selectedWorkspace); await ui.settle(); expect(ui.button('Prepare work')).toBeUndefined();
  });
  it('requires separate prepare/confirm clicks and prevents a same-tick double start', async () => {
    const api = apiFixture(); const pending = deferred<{ hostWorkId: string }>(); api.startApprovalWork.mockImplementation(() => pending.promise);
    const ui = page(api); await ui.settle(); expect(api.prepareApprovalWork).not.toHaveBeenCalled();
    ui.click('Prepare work'); await ui.settle(); expect(api.startApprovalWork).not.toHaveBeenCalled();
    ui.click('Confirm start'); ui.click('Confirm start'); expect(api.startApprovalWork).toHaveBeenCalledTimes(1);
    pending.resolve({ hostWorkId: 'host-a' }); await ui.settle();
    expect(api.prepareApprovalWork).toHaveBeenCalledWith({ primaryWorkId: 'work-a', userConfirmed: true });
    expect(api.startApprovalWork).toHaveBeenCalledWith({ reviewToken: 'token-a', userConfirmed: true });
  });
  it('discards late preparation and errors after a project switch', async () => {
    const api = apiFixture(); const pending = deferred<Awaited<ReturnType<ApprovalWorkPageApi['prepareApprovalWork']>>>(); api.prepareApprovalWork.mockImplementation(() => pending.promise);
    const ui = page(api); await ui.settle(); ui.click('Prepare work'); ui.setWorkspace('workspace-b');
    pending.resolve({ reviewToken: 'stale-token', expiresAt: Date.now() + 60_000, work: work() }); await ui.settle();
    expect(ui.button('Confirm start')).toBeUndefined(); expect(api.startApprovalWork).not.toHaveBeenCalled();
    expect(ui.nodes().filter((node) => node.props.role === 'alert')).toHaveLength(0);
    const failed = deferred<Awaited<ReturnType<ApprovalWorkPageApi['prepareApprovalWork']>>>(); api.prepareApprovalWork.mockImplementation(() => failed.promise);
    ui.setWorkspace('workspace-a'); await ui.settle(); ui.click('Prepare work'); ui.setWorkspace('workspace-b');
    failed.reject(new Error('Old project failure')); await ui.settle(); expect(ui.nodes().filter((node) => node.props.role === 'alert')).toHaveLength(0);
  });
  it('does not show a late registry response from the previous project', async () => {
    const api = apiFixture(); const pending = deferred<Awaited<ReturnType<ApprovalWorkPageApi['listApprovalWorks']>>>(); api.listApprovalWorks.mockImplementation(() => pending.promise);
    const ui = page(api); ui.setWorkspace('workspace-b'); pending.resolve({ workspaceId: 'workspace-a', works: [work()] }); await ui.settle();
    expect(ui.button('Prepare work')).toBeUndefined();
  });
  it('rejects mismatched host reviews and consumes a failed token before retry', async () => {
    const api = apiFixture(); api.prepareApprovalWork.mockResolvedValueOnce({ reviewToken: 'forged', expiresAt: Date.now() + 60_000, work: work({ hostWorkId: 'wrong-host' }) });
    const ui = page(api); await ui.settle(); ui.click('Prepare work'); await ui.settle(); expect(ui.button('Confirm start')).toBeUndefined();
    ui.click('Prepare work'); await ui.settle(); api.startApprovalWork.mockRejectedValue(new Error('UNKNOWN; reconcile only'));
    ui.click('Confirm start'); await ui.settle(); expect(ui.button('Confirm start')).toBeUndefined(); expect(api.startApprovalWork).toHaveBeenCalledTimes(1);
    expect(ui.nodes().some((node) => node.props.role === 'alert')).toBe(true);
  });
  it('disables exhausted/in-doubt work, expires tokens, and handles an empty registry', async () => {
    const api = apiFixture(); api.listApprovalWorks.mockResolvedValue({ workspaceId: 'workspace-a', works: [work({ remaining: 0, inDoubt: 1 })] });
    const ui = page(api); await ui.settle(); expect(ui.button('Prepare work')?.props.disabled).toBe(true);
    api.listApprovalWorks.mockResolvedValue({ workspaceId: 'workspace-a', works: [work()] }); ui.click('Refresh'); await ui.settle();
    api.prepareApprovalWork.mockResolvedValueOnce({ reviewToken: 'exhausted', expiresAt: Date.now() + 60_000, work: work({ remaining: 0, shown: 3 }) });
    ui.click('Prepare work'); await ui.settle(); expect(ui.button('Confirm start')?.props.disabled).toBe(true);
    ui.click('Refresh'); await ui.settle(); vi.useFakeTimers(); ui.click('Prepare work'); await ui.settle();
    await vi.advanceTimersByTimeAsync(60_001); ui.render(); expect(ui.button('Confirm start')).toBeUndefined(); vi.useRealTimers();
    api.listApprovalWorks.mockResolvedValue({ workspaceId: 'workspace-a', works: [] }); ui.click('Refresh'); await ui.settle(); expect(ui.button('Prepare work')).toBeUndefined();
  });
});
