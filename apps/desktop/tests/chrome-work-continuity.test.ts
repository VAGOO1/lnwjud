import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostApprovalInvocation } from '../../../packages/mcp-server/src/host-approval-invocation.js';
import type { HostMutationApprovalRequest } from '@lnwjud/mcp-server';
import { DesktopApprovalWork } from '../src/main/desktop-approval-work.js';
import { prepareChromeWorkLaunch, type ChromeWorkLaunch } from '../src/main/chrome-work-launch.js';
import { SqliteApprovalHostStore } from '../src/main/approval-host-store.js';
import type { ApprovalHostPlan } from '../src/main/approval-host-runtime.js';
import type { ApprovalJobBudgetState } from '../src/main/approval-job-budget.js';

const roots: string[] = []; const hosts: DesktopApprovalWork[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); for (const host of hosts.splice(0)) await host.close();
  for (const directory of roots.splice(0)) {
    if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith('lnwjud-chrome-r5-')) throw new Error('Unexpected cleanup path');
    rmSync(directory, { recursive: true, force: true });
  }
});
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
function plan(): Omit<ApprovalHostPlan, 'primaryWorkId'> {
  return { clientId: 'fixture-client', sessionId: 'session-one', workspaceId: 'fixture-workspace', tabId: 'fixture-tab', pageUrl: 'https://fixture.invalid/form', requestDigests: [0, 1, 2, 3].map((phase) => digest(`phase-${phase}`)) };
}
interface Fixture { host: DesktopApprovalWork; directory: string; open(): DesktopApprovalWork; shown(): number; }
function fixture(prompt?: ConstructorParameters<typeof DesktopApprovalWork>[1]): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lnwjud-chrome-r5-')); roots.push(root); const directory = path.join(root, 'registry'); let count = 0;
  const open = (): DesktopApprovalWork => {
    const host = new DesktopApprovalWork(directory, prompt ?? (async (_request, _context, gate): Promise<boolean> => {
      if (gate === undefined || !await gate.beforeShow()) return false; count += 1; return gate.onShown();
    })); hosts.push(host); return host;
  };
  return { host: open(), directory, open, shown: (): number => count };
}
async function selected(f: Fixture, ticket: ChromeWorkLaunch): Promise<{ primaryWorkId: string; hostWorkId: string; connectionRevision: number }> {
  const record = await f.host.registerChromeWork(ticket);
  const review = await f.host.prepareFromRegistry(record.primaryWorkId, plan().workspaceId); await f.host.startReviewed(review.reviewToken, plan().workspaceId);
  return record;
}
function request(host: DesktopApprovalWork, phase: number, identity: Partial<Pick<ApprovalHostPlan, 'clientId' | 'sessionId' | 'workspaceId' | 'tabId'>> = {}): Promise<boolean> {
  const value = { ...plan(), ...identity }; const abort = new AbortController();
  return host.request({ toolName: 'dom_cdp', workspaceId: value.workspaceId, presentation: { browserTabId: value.tabId, browserTabLookup: 'resolved', browserTabUrl: value.pageUrl } } as HostMutationApprovalRequest,
    { signal: abort.signal, cancel: (): void => abort.abort(), deadlineAt: Date.now() + 120_000,
      invocationProof: createHostApprovalInvocation({ callId: `fixture-${phase}`, clientId: value.clientId, sessionId: value.sessionId, workspaceId: value.workspaceId, tabId: value.tabId, inputDigest: value.requestDigests[phase]! }) });
}

describe('Chrome host work registration and continuity', () => {
  it('registers once atomically, inactive, using the same host-minted ticket on repeated calls', async () => {
    const f = fixture(); const input = { ...plan(), requestDigests: [...plan().requestDigests] }; const ticket = prepareChromeWorkLaunch(input); input.requestDigests[0] = digest('changed');
    const [a, b] = await Promise.all([f.host.registerChromeWork(ticket), f.host.registerChromeWork(ticket)]);
    expect(a).toEqual(b); expect(a.primaryWorkId).toMatch(/^chrome-[0-9a-f-]{36}$/);
    expect((await f.host.list(plan().workspaceId)).works).toMatchObject([{ primaryWorkId: a.primaryWorkId, selected: false, shown: 0 }]);
    const raw = new DatabaseSync(path.join(f.directory, 'host.sqlite'), { readOnly: true });
    try { for (const table of ['approval_host_jobs', 'approval_job_budgets', 'approval_desktop_plans', 'approval_desktop_selection', 'approval_chrome_owners', 'approval_chrome_connections']) expect(raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toMatchObject({ count: 1 }); }
    finally { raw.close(); }
    await expect(request(f.host, 0)).rejects.toMatchObject({ reason: 'HOST_WORK_REQUIRED' }); expect(f.shown()).toBe(0);
  });
  it('rejects forged/serialized tickets and malformed plans before registration', async () => {
    const f = fixture(); const ticket = prepareChromeWorkLaunch(plan());
    await expect(f.host.registerChromeWork(structuredClone(ticket))).rejects.toThrow('capability');
    await expect(f.host.reconnectChromeWork({ chromeWorkLaunch: true }, 1, 'new-session')).rejects.toThrow('capability');
    expect(() => prepareChromeWorkLaunch({ ...plan(), requestDigests: [digest('same'), digest('same')] })).toThrow('unambiguous');
    expect(() => prepareChromeWorkLaunch({ ...plan(), pageUrl: 'https://fixture.invalid/form?secret=hidden' })).toThrow('exact origin');
    expect((await f.host.list(plan().workspaceId)).works).toEqual([]);
  });
  it('retains the original job/budget and fences the old session after an authorized reconnect', async () => {
    const f = fixture(); const ticket = prepareChromeWorkLaunch(plan()); const record = await selected(f, ticket); expect(await request(f.host, 0)).toBe(true);
    const before = await f.host.snapshot(record.primaryWorkId);
    expect(await f.host.reconnectChromeWork(ticket, 1, 'session-two')).toEqual({ clientId: plan().clientId, sessionId: 'session-two', revision: 2 });
    expect(await f.host.snapshot(record.primaryWorkId)).toEqual(before);
    await expect(request(f.host, 1)).rejects.toMatchObject({ reason: 'HOST_WORK_REQUIRED' });
    for (const identity of [{ clientId: 'other-client', sessionId: 'session-two' }, { sessionId: 'session-two', tabId: 'wrong-tab' }, { sessionId: 'session-two', workspaceId: 'wrong-project' }]) await expect(request(f.host, 1, identity)).rejects.toMatchObject({ reason: 'HOST_WORK_REQUIRED' });
    expect(await request(f.host, 1, { sessionId: 'session-two' })).toBe(true);
    await expect(request(f.host, 0, { sessionId: 'session-two' })).rejects.toMatchObject({ reason: 'DUPLICATE_REQUEST' });
    await expect(f.host.reconnectChromeWork(ticket, 1, 'session-three')).rejects.toThrow('stale');
    expect(await request(f.host, 2, { sessionId: 'session-two' })).toBe(true);
    await expect(request(f.host, 3, { sessionId: 'session-two' })).rejects.toMatchObject({ reason: 'BUDGET_EXHAUSTED' }); expect(f.shown()).toBe(3);
  });
  it('requires original supervisor capability after reopening; no replacement work is inferred', async () => {
    const f = fixture(); const ticket = prepareChromeWorkLaunch(plan()); const record = await selected(f, ticket); await f.host.close();
    const restarted = f.open();
    await expect(restarted.reconnectChromeWork(structuredClone(ticket), 1, 'session-two')).rejects.toThrow('capability');
    const other = prepareChromeWorkLaunch(plan()); await expect(restarted.reconnectChromeWork(other, 1, 'session-two')).rejects.toMatchObject({ reason: 'HOST_WORK_NOT_FOUND' });
    expect((await restarted.list(plan().workspaceId)).works).toHaveLength(1);
    expect(await restarted.reconnectChromeWork(ticket, 1, 'session-two')).toMatchObject({ revision: 2 });
    expect((await restarted.list(plan().workspaceId)).works[0]).toMatchObject({ primaryWorkId: record.primaryWorkId, hostWorkId: record.hostWorkId });
  });
  it('invalidates a review across another host connection changing the session binding', async () => {
    const f = fixture(); const ticket = prepareChromeWorkLaunch(plan()); const record = await f.host.registerChromeWork(ticket);
    const review = await f.host.prepareFromRegistry(record.primaryWorkId, plan().workspaceId); const other = f.open(); await other.list(plan().workspaceId);
    await other.reconnectChromeWork(ticket, 1, 'session-two');
    await expect(f.host.startReviewed(review.reviewToken)).rejects.toMatchObject({ reason: 'HOST_REVIEW_STALE' });
    expect((await f.host.list(plan().workspaceId)).works[0]?.selected).toBe(false);
  });
  it('rejects reconnect while a prompt has in-doubt evidence', async () => {
    let shown!: () => void; let finish!: (value: boolean) => void;
    const displayed = new Promise<void>((resolve) => { shown = resolve; }); const pending = new Promise<boolean>((resolve) => { finish = resolve; });
    const f = fixture(async (_request, _context, gate): Promise<boolean> => { await gate!.onShown(); shown(); return pending; });
    const ticket = prepareChromeWorkLaunch(plan()); const record = await selected(f, ticket); const operation = request(f.host, 0); await displayed;
    try { await expect(f.host.reconnectChromeWork(ticket, 1, 'session-two')).rejects.toThrow('pending or unknown'); }
    finally { finish(true); await operation; }
    expect(await f.host.snapshot(record.primaryWorkId)).toMatchObject({ shown: 1, inDoubt: 0 });
  });
  it('blocks a stale-session reservation racing a reconnect on another SQLite connection', async () => {
    const f = fixture(); const ticket = prepareChromeWorkLaunch(plan()); const record = await selected(f, ticket); const other = f.open(); await other.list(plan().workspaceId);
    const original = SqliteApprovalHostStore.prototype.compareAndSwap; let injected = false;
    vi.spyOn(SqliteApprovalHostStore.prototype, 'compareAndSwap').mockImplementation(async function(this: SqliteApprovalHostStore, id, revision, state, connectionRevision): Promise<boolean> {
      if (!injected && id === record.hostWorkId && state.records.some((row) => row.status === 'reserved')) { injected = true; await other.reconnectChromeWork(ticket, 1, 'session-two'); }
      return original.call(this, id, revision, state, connectionRevision);
    });
    let stopped = false;
    try { await request(f.host, 0); } catch { stopped = true; }
    const snapshot = await f.host.snapshot(record.primaryWorkId);
    expect(injected).toBe(true); expect(stopped).toBe(true); expect(f.shown()).toBe(0); expect(snapshot).toMatchObject({ requested: 0, shown: 0, inDoubt: 0 });
  });
  it('never falls back to the old session if Chrome connection evidence is missing', async () => {
    const f = fixture(); const ticket = prepareChromeWorkLaunch(plan()); const record = await selected(f, ticket);
    const raw = new DatabaseSync(path.join(f.directory, 'host.sqlite')); raw.prepare('DELETE FROM approval_chrome_connections WHERE host_work_id=?').run(record.hostWorkId); raw.close();
    await expect(request(f.host, 0)).rejects.toThrow('missing or corrupt');
    await expect(f.host.registerChromeWork(ticket)).rejects.toThrow('missing or corrupt'); expect(f.shown()).toBe(0);
  });
  it('rolls back job, plan and budget if Chrome owner enrollment fails', async () => {
    const f = fixture(); await f.host.start({ ...plan(), primaryWorkId: 'legacy-fixture' }); await f.host.deactivate('legacy-fixture');
    const raw = new DatabaseSync(path.join(f.directory, 'host.sqlite'));
    try {
      raw.exec("CREATE TRIGGER fixture_block_chrome_owner BEFORE INSERT ON approval_chrome_owners BEGIN SELECT RAISE(ABORT, 'fixture enrollment failure'); END;");
      await expect(f.host.registerChromeWork(prepareChromeWorkLaunch(plan()))).rejects.toThrow('fixture enrollment failure');
      for (const table of ['approval_host_jobs', 'approval_job_budgets', 'approval_desktop_plans', 'approval_desktop_selection']) expect(raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toMatchObject({ count: 1 });
      expect(raw.prepare('SELECT COUNT(*) AS count FROM approval_chrome_owners').get()).toMatchObject({ count: 0 });
    } finally { raw.close(); }
  });
  it('requires the host connection fence for all Chrome budget writes', async () => {
    const f = fixture(); const record = await selected(f, prepareChromeWorkLaunch(plan())); const store = SqliteApprovalHostStore.openExisting(path.join(f.directory, 'host.sqlite'));
    try { const state = await store.load(record.hostWorkId) as ApprovalJobBudgetState; expect(await store.compareAndSwap(record.hostWorkId, state.revision, { ...state, revision: state.revision + 1 })).toBe(false); }
    finally { store.close(); }
  });
  it('rejects conflicting selected work after two original owners converge on one connection', async () => {
    const f = fixture(); const first = prepareChromeWorkLaunch(plan()); const a = await selected(f, first);
    const second = prepareChromeWorkLaunch({ ...plan(), sessionId: 'session-two' }); const b = await selected(f, second);
    await expect(f.host.reconnectChromeWork(second, 1, 'session-one')).rejects.toThrow('Another Chrome work');
    await f.host.deactivate(a.primaryWorkId);
    expect(await f.host.reconnectChromeWork(second, 1, 'session-one')).toMatchObject({ revision: 2 });
    await expect(f.host.resume(a.primaryWorkId)).rejects.toThrow('Another Chrome work');
    expect(await f.host.snapshot(b.primaryWorkId)).toMatchObject({ shown: 0, remaining: 3 });
  });
});
