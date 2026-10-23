import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostApprovalInvocation, type HostMutationApprovalRequest } from '@lnwjud/mcp-server';
import { DesktopApprovalWork } from '../src/main/desktop-approval-work.js';
import { prepareChromeWorkLaunch } from '../src/main/chrome-work-launch.js';
import { SqliteApprovalHostStore } from '../src/main/approval-host-store.js';

const roots: string[] = []; const hosts: DesktopApprovalWork[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('lnwjud-phase-continuation-')) throw new Error('Unexpected cleanup target');
    rmSync(root, { recursive: true, force: true });
  }
});
const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
const initial = { clientId: 'client', sessionId: 'session', workspaceId: 'workspace', tabId: 'tab', pageUrl: 'https://fixture.invalid/form', requestDigests: [sha('preflight')] };
async function fixture(prompt?: ConstructorParameters<typeof DesktopApprovalWork>[1]): Promise<{
  host: DesktopApprovalWork; filename: string; ticket: ReturnType<typeof prepareChromeWorkLaunch>; primaryWorkId: string; hostWorkId: string; shown(): number; open(): DesktopApprovalWork;
}> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lnwjud-phase-continuation-')); roots.push(root); let shown = 0;
  const open = (): DesktopApprovalWork => { const host = new DesktopApprovalWork(path.join(root, 'registry'), prompt ?? (async (_request, _context, gate): Promise<boolean> => {
    if (!gate || !await gate.beforeShow()) return false; shown += 1; return gate.onShown();
  })); hosts.push(host); return host; };
  const host = open(); const ticket = prepareChromeWorkLaunch(initial); const registered = await host.registerChromeWork(ticket);
  return { host, ticket, ...registered, filename: path.join(root, 'registry', 'host.sqlite'), shown: (): number => shown, open };
}
async function select(host: DesktopApprovalWork, id: string): Promise<void> {
  const review = await host.prepareFromRegistry(id, initial.workspaceId); await host.startReviewed(review.reviewToken);
}
function invoke(host: DesktopApprovalWork, digest: string, sessionId = initial.sessionId, target = { tabId: initial.tabId, pageUrl: initial.pageUrl }): Promise<boolean> {
  const controller = new AbortController();
  return host.request({ toolName: 'dom_cdp', workspaceId: initial.workspaceId, presentation: { browserTabId: target.tabId, browserTabLookup: 'resolved', browserTabUrl: target.pageUrl } } as HostMutationApprovalRequest,
    { signal: controller.signal, cancel: (): void => controller.abort(), deadlineAt: Date.now() + 10_000,
      invocationProof: createHostApprovalInvocation({ callId: randomUUID(), ...initial, sessionId, tabId: target.tabId, inputDigest: digest }) });
}
async function extension(f: Awaited<ReturnType<typeof fixture>>, digests: string[], key = 'dynamic-plan'): Promise<Parameters<DesktopApprovalWork['extendChromeWork']>[1]> {
  const row = (await f.host.list(initial.workspaceId)).works[0]!;
  const connection = await f.host.chromeConnection(f.primaryWorkId, initial.workspaceId);
  return { idempotencyKey: key, pageUrl: initial.pageUrl, requestDigests: digests, expectedBudgetRevision: row.revision, expectedConnectionRevision: connection.revision, expectedContinuationRevision: row.continuationRevision ?? 0 };
}

describe('Exact dynamic phases retain one durable Chrome approval budget', () => {
  it('admits post-preflight plan/hash exactly after fresh review, retains anchor, and blocks fourth mock show', async () => {
    const f = await fixture(); await select(f.host, f.primaryWorkId); await invoke(f.host, initial.requestDigests[0]!);
    const planId = randomUUID(); const payloadHash = sha('resolved fixture product/stock');
    const next = ['prepare', 'commit', 'fourth'].map((operation) => sha(JSON.stringify({ operation, planId, payloadHash })));
    const before = new DatabaseSync(f.filename, { readOnly: true }); const anchor = before.prepare('SELECT * FROM approval_host_jobs').get(); before.close();
    const staleReview = await f.host.prepareFromRegistry(f.primaryWorkId, initial.workspaceId);
    const input = await extension(f, next);
    expect(await f.host.extendChromeWork(f.ticket, input)).toBe(1);
    await expect(f.host.startReviewed(staleReview.reviewToken)).rejects.toMatchObject({ reason: 'HOST_REVIEW_REQUIRED' });
    await expect(invoke(f.host, next[0]!)).rejects.toMatchObject({ reason: 'HOST_WORK_REQUIRED' });
    expect(await f.host.snapshot(f.primaryWorkId)).toMatchObject({ hostWorkId: f.hostWorkId, shown: 1, remaining: 2 });
    await select(f.host, f.primaryWorkId); expect(await invoke(f.host, next[0]!)).toBe(true);
    expect(await f.host.extendChromeWork(f.ticket, input)).toBe(1); // response loss cannot reset or deactivate completed metadata
    await expect(invoke(f.host, next[0]!)).rejects.toMatchObject({ reason: 'DUPLICATE_REQUEST' });
    await f.host.close(); const restarted = f.open(); await select(restarted, f.primaryWorkId);
    expect(await invoke(restarted, next[1]!)).toBe(true);
    await expect(invoke(restarted, next[2]!)).rejects.toMatchObject({ reason: 'BUDGET_EXHAUSTED' });
    expect(f.shown()).toBe(3);
    const raw = new DatabaseSync(f.filename);
    try {
      expect(raw.prepare('SELECT * FROM approval_host_jobs').get()).toEqual(anchor);
      expect(() => raw.exec("UPDATE approval_phase_batches SET batch_json='{}'")).toThrow('immutable');
      expect(() => raw.exec('DELETE FROM approval_phase_batches')).toThrow('immutable');
    } finally { raw.close(); }
  });
  it('rejects forged capability, stale revisions, changed scope and duplicate exact digests without budget changes', async () => {
    const f = await fixture(); const input = await extension(f, [sha('new')]);
    await expect(f.host.extendChromeWork(structuredClone(f.ticket), input)).rejects.toThrow('capability');
    for (const changed of [{ pageUrl: 'https://other.invalid/form?secret=hidden' }, { expectedBudgetRevision: 99 }, { expectedConnectionRevision: 99 }, { expectedContinuationRevision: 99 }, { requestDigests: [initial.requestDigests[0]!] }, { requestDigests: [sha('same'), sha('same')] }]) {
      await expect(f.host.extendChromeWork(f.ticket, { ...input, ...changed })).rejects.toThrow();
    }
    expect(await f.host.snapshot(f.primaryWorkId)).toMatchObject({ shown: 0, requested: 0 });
    await f.host.extendChromeWork(f.ticket, input);
    await expect(f.host.extendChromeWork(f.ticket, { ...input, requestDigests: [sha('changed')] })).rejects.toThrow('intent changed');
  });
  it('invalidates reviews across another SQLite connection append and a changed-session reconnect', async () => {
    const f = await fixture(); const firstReview = await f.host.prepareFromRegistry(f.primaryWorkId, initial.workspaceId); const other = f.open();
    await other.extendChromeWork(f.ticket, await extension(f, [sha('new')]));
    await expect(f.host.startReviewed(firstReview.reviewToken)).rejects.toMatchObject({ reason: 'HOST_REVIEW_STALE' });
    await select(f.host, f.primaryWorkId); await other.reconnectChromeWork(f.ticket, 1, 'session-two');
    await expect(invoke(f.host, sha('new'), 'session-two')).rejects.toMatchObject({ reason: 'HOST_WORK_REQUIRED' });
    await select(f.host, f.primaryWorkId); expect(await invoke(f.host, sha('new'), 'session-two')).toBe(true);
  });
  it('fences a base reservation racing append on another connection before any mock window', async () => {
    const f = await fixture(); await select(f.host, f.primaryWorkId); const other = f.open(); const input = await extension(f, [sha('next')]);
    const original = SqliteApprovalHostStore.prototype.compareAndSwap; let injected = false;
    vi.spyOn(SqliteApprovalHostStore.prototype, 'compareAndSwap').mockImplementation(async function(this: SqliteApprovalHostStore, ...args: Parameters<typeof original>): Promise<boolean> {
      if (!injected) { injected = true; await other.extendChromeWork(f.ticket, input); }
      return original.apply(this, args);
    });
    await expect(invoke(f.host, initial.requestDigests[0]!)).rejects.toMatchObject({ reason: 'RECOVERY_REQUIRED' });
    expect(f.shown()).toBe(0); expect(await f.host.snapshot(f.primaryWorkId)).toMatchObject({ shown: 0, requested: 0 });
  });
  it('refuses continuation while a prior native reservation is unresolved', async () => {
    let shown!: () => void; let finish!: (allow: boolean) => void;
    const displayed = new Promise<void>((resolve) => { shown = resolve; }); const pending = new Promise<boolean>((resolve) => { finish = resolve; });
    const f = await fixture(async (_request, _context, gate): Promise<boolean> => { await gate!.onShown(); shown(); return pending; });
    await select(f.host, f.primaryWorkId); const input = await extension(f, [sha('next')]);
    const call = invoke(f.host, initial.requestDigests[0]!); await displayed;
    try { await expect(f.host.extendChromeWork(f.ticket, input)).rejects.toThrow('pending'); } finally { finish(true); await call; }
  });
  it('retains one budget across an exact new tab and navigation target after fresh review and restart', async () => {
    const f = await fixture(); await select(f.host, f.primaryWorkId); await invoke(f.host, initial.requestDigests[0]!);
    const newTab = { tabId: 'returned-new-tab', pageUrl: 'https://fixture.invalid/history' };
    await f.host.extendChromeWork(f.ticket, { ...await extension(f, [sha('navigate-new-tab')], 'new-tab-target'), ...newTab });
    await expect(invoke(f.host, sha('navigate-new-tab'), initial.sessionId, newTab)).rejects.toMatchObject({ reason: 'HOST_WORK_REQUIRED' });
    const review = await f.host.prepareFromRegistry(f.primaryWorkId, initial.workspaceId);
    expect(review.work.targets).toContainEqual(newTab);
    await f.host.startReviewed(review.reviewToken);
    await expect(invoke(f.host, sha('navigate-new-tab'), initial.sessionId, { ...newTab, pageUrl: 'https://wrong.invalid/' })).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
    expect(await invoke(f.host, sha('navigate-new-tab'), initial.sessionId, newTab)).toBe(true);
    const afterNavigation = { ...newTab, pageUrl: 'https://fixture.invalid/form-two' };
    await f.host.extendChromeWork(f.ticket, { ...await extension(f, [sha('type-new-page'), sha('fourth-new-page')], 'new-page-target'), ...afterNavigation });
    await f.host.close(); const restarted = f.open(); await select(restarted, f.primaryWorkId);
    expect(await invoke(restarted, sha('type-new-page'), initial.sessionId, afterNavigation)).toBe(true);
    await expect(invoke(restarted, sha('fourth-new-page'), initial.sessionId, afterNavigation)).rejects.toMatchObject({ reason: 'BUDGET_EXHAUSTED' });
    expect(await restarted.snapshot(f.primaryWorkId)).toMatchObject({ hostWorkId: f.hostWorkId, shown: 3, remaining: 0 });
    expect(f.shown()).toBe(3);
  });
  it('rejects overlapping selected targets across SQLite connections and malformed new targets', async () => {
    const f = await fixture();
    for (const target of [{ tabId: '' }, { tabId: 'x', pageUrl: 'file:///private' }, { tabId: 'x', pageUrl: 'https://fixture.invalid/path#fragment' }]) {
      await expect(f.host.extendChromeWork(f.ticket, { ...await extension(f, [sha('invalid')]), ...target })).rejects.toThrow();
    }
    const shared = { tabId: 'shared-new-tab', pageUrl: initial.pageUrl };
    await f.host.extendChromeWork(f.ticket, { ...await extension(f, [sha('shared')]), ...shared }); await select(f.host, f.primaryWorkId);
    const second = prepareChromeWorkLaunch({ ...initial, ...shared, requestDigests: [sha('other-job')] });
    const other = f.open(); const registered = await other.registerChromeWork(second);
    await expect(select(other, registered.primaryWorkId)).rejects.toMatchObject({ reason: 'HOST_REVIEW_STALE' });
    expect(await other.snapshot(registered.primaryWorkId)).toMatchObject({ shown: 0, requested: 0 });
  });
  it('opens retained v5 journals without migration and refuses new target scope there', async () => {
    const f = await fixture(); await f.host.close();
    const raw = new DatabaseSync(f.filename); raw.exec("UPDATE approval_host_store_meta SET value='5' WHERE key='schema_version'"); raw.close();
    const host = f.open(); const next = { ...await extension({ ...f, host }, [sha('legacy-phase')]), tabId: initial.tabId };
    await expect(host.extendChromeWork(f.ticket, { ...next, tabId: 'different' })).rejects.toThrow('Legacy');
    expect(await host.extendChromeWork(f.ticket, next)).toBe(1); await select(host, f.primaryWorkId);
    expect(await invoke(host, sha('legacy-phase'))).toBe(true);
    const check = new DatabaseSync(f.filename, { readOnly: true });
    try { expect(check.prepare("SELECT value FROM approval_host_store_meta WHERE key='schema_version'").get()).toEqual({ value: '5' }); } finally { check.close(); }
  });

});
