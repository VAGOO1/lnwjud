import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostApprovalInvocation } from '../../../packages/mcp-server/src/host-approval-invocation.js';
import { DesktopApprovalWork } from '../src/main/desktop-approval-work.js';
import { registerApprovalWorkIpc } from '../src/main/desktop-approval-ipc.js';
import { approvalWorkChannels } from '../../../packages/ipc-contracts/src/approval-work-contracts.js';
import type { ApprovalHostPlan } from '../src/main/approval-host-runtime.js';

const roots: string[] = []; const hosts: DesktopApprovalWork[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const host of hosts.splice(0)) await host.close();
  for (const dir of roots.splice(0)) {
    if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith('lnwjud-registry-r4-')) throw new Error('Unexpected cleanup path');
    rmSync(dir, { recursive: true, force: true });
  }
});
export function registryPlan(primaryWorkId = 'work-a', workspaceId = 'workspace-a'): ApprovalHostPlan {
  return { primaryWorkId, workspaceId, clientId: 'fixture-client', sessionId: 'fixture-session', tabId: 'fixture-tab', pageUrl: 'https://fixture.invalid/form',
    requestDigests: Array.from({ length: 4 }, (_, phase) => createHash('sha256').update(`phase-${phase}`).digest('hex')) };
}
function fixture(): { host: DesktopApprovalWork; directory: string; open: () => DesktopApprovalWork; invoke: (channel: string, payload?: unknown, trusted?: boolean) => Promise<unknown>; setWorkspace: (id: string) => void; shown: () => number } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lnwjud-registry-r4-')); roots.push(root);
  const directory = path.join(root, 'registry'); let shown = 0;
  const open = (): DesktopApprovalWork => {
    const host = new DesktopApprovalWork(directory, async (_request, _context, gate): Promise<boolean> => {
      if (gate === undefined || !await gate.beforeShow()) return false;
      shown += 1; return gate.onShown();
    }); hosts.push(host); return host;
  };
  const host = open(); let workspace = 'workspace-a';
  const handlers = new Map<string, (event: boolean, payload: unknown) => unknown>();
  registerApprovalWorkIpc((channel, handler): void => { handlers.set(channel, handler); }, (trusted: boolean): void => { if (!trusted) throw new Error('Untrusted sender'); }, () => ({
    list: (): ReturnType<DesktopApprovalWork['list']> => host.list(workspace), prepareFromRegistry: (id: string): ReturnType<DesktopApprovalWork['prepareFromRegistry']> => host.prepareFromRegistry(id, workspace),
    startReviewed: (token: string): ReturnType<DesktopApprovalWork['startReviewed']> => host.startReviewed(token, workspace), resume: (id: string): ReturnType<DesktopApprovalWork['resume']> => host.resume(id, workspace), deactivate: (id: string): ReturnType<DesktopApprovalWork['deactivate']> => host.deactivate(id, workspace),
  }));
  const invoke = async (channel: string, payload?: unknown, trusted = true): Promise<unknown> => {
    const handler = handlers.get(channel); if (handler === undefined) throw new Error(`Missing IPC handler: ${channel}`);
    return handler(trusted, payload);
  };
  return { host, directory, open, invoke, setWorkspace: (id: string): void => { workspace = id; }, shown: (): number => shown };
}
async function request(host: DesktopApprovalWork, plan: ApprovalHostPlan, phase: number): Promise<boolean> {
  const controller = new AbortController();
  return host.request({ toolName: 'dom_cdp', workspaceId: plan.workspaceId, presentation: { browserTabId: plan.tabId, browserTabLookup: 'resolved', browserTabUrl: plan.pageUrl } } as never,
    { invocationProof: createHostApprovalInvocation({ callId: `call-${phase}`, clientId: plan.clientId, sessionId: plan.sessionId, workspaceId: plan.workspaceId, tabId: plan.tabId, inputDigest: plan.requestDigests[phase]! }), signal: controller.signal, cancel: () => controller.abort() } as never);
}

describe('registry prepared Desktop review token', () => {
  it('lists existing host work, issues a registry-only token, and resumes the same ID', async () => {
    const f = fixture(); const plan = registryPlan(); const handle = await f.host.start(plan); await f.host.deactivate(plan.primaryWorkId);
    expect(await f.invoke(approvalWorkChannels.list)).toMatchObject({ workspaceId: plan.workspaceId, works: [{ primaryWorkId: plan.primaryWorkId, hostWorkId: handle.hostWorkId, selected: false, shown: 0, remaining: 3 }] });
    const review = await f.invoke(approvalWorkChannels.prepare, { primaryWorkId: plan.primaryWorkId, userConfirmed: true }) as { reviewToken: string; work: object };
    expect(review.work).not.toHaveProperty('sessionId'); expect(review.work).not.toHaveProperty('requestDigests');
    expect(await f.invoke(approvalWorkChannels.start, { reviewToken: review.reviewToken, userConfirmed: true })).toEqual(handle);
    await expect(f.invoke(approvalWorkChannels.start, { reviewToken: review.reviewToken, userConfirmed: true })).rejects.toMatchObject({ reason: 'HOST_REVIEW_REQUIRED' });
    expect(f.shown()).toBe(0);
  });
  it('rejects forged, extra plan fields and untrusted senders without creating a registry', async () => {
    const f = fixture();
    expect(await f.invoke(approvalWorkChannels.list)).toEqual({ workspaceId: 'workspace-a', works: [] });
    await expect(f.invoke(approvalWorkChannels.prepare, { primaryWorkId: 'forged', userConfirmed: true })).rejects.toMatchObject({ reason: 'HOST_WORK_NOT_FOUND' });
    await expect(f.invoke(approvalWorkChannels.prepare, { primaryWorkId: 'forged', plan: registryPlan(), userConfirmed: true })).rejects.toThrow('confirmation');
    await expect(f.invoke(approvalWorkChannels.list, undefined, false)).rejects.toThrow('Untrusted');
    await expect(f.invoke(approvalWorkChannels.list, { workspaceId: 'forged' })).rejects.toThrow('no payload');
    expect(existsSync(f.directory)).toBe(false);
  });
  it('enforces host-selected workspace for list, prepare, start, resume and deactivate', async () => {
    const f = fixture(); const plan = registryPlan(); await f.host.start(plan); await f.host.deactivate(plan.primaryWorkId);
    const review = await f.host.prepareFromRegistry(plan.primaryWorkId, plan.workspaceId);
    f.setWorkspace('workspace-b');
    expect(await f.invoke(approvalWorkChannels.list)).toEqual({ workspaceId: 'workspace-b', works: [] });
    for (const channel of [approvalWorkChannels.prepare, approvalWorkChannels.resume, approvalWorkChannels.deactivate]) {
      await expect(f.invoke(channel, { primaryWorkId: plan.primaryWorkId, userConfirmed: true })).rejects.toMatchObject({ reason: 'HOST_WORKSPACE_MISMATCH' });
    }
    await expect(f.invoke(approvalWorkChannels.start, { reviewToken: review.reviewToken, userConfirmed: true })).rejects.toMatchObject({ reason: 'HOST_WORKSPACE_MISMATCH' });
    f.setWorkspace(plan.workspaceId);
    await expect(f.host.startReviewed(review.reviewToken)).rejects.toMatchObject({ reason: 'HOST_REVIEW_REQUIRED' });
  });
  it('invalidates a review when budget evidence changes, with no replay or replacement ID', async () => {
    const f = fixture(); const plan = registryPlan(); const handle = await f.host.start(plan);
    const review = await f.host.prepareFromRegistry(plan.primaryWorkId, plan.workspaceId);
    expect(await request(f.host, plan, 0)).toBe(true);
    await expect(f.host.startReviewed(review.reviewToken)).rejects.toMatchObject({ reason: 'HOST_REVIEW_STALE' });
    expect(await f.host.snapshot(plan.primaryWorkId)).toMatchObject({ hostWorkId: handle.hostWorkId, shown: 1, remaining: 2 });
  });
  it('rejects expired tokens and preserves the three-window limit after reopening', async () => {
    const f = fixture(); const plan = registryPlan(); const handle = await f.host.start(plan);
    const review = await f.host.prepareFromRegistry(plan.primaryWorkId, plan.workspaceId);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(review.expiresAt);
    await expect(f.host.startReviewed(review.reviewToken)).rejects.toMatchObject({ reason: 'HOST_REVIEW_REQUIRED' }); clock.mockRestore();
    for (let phase = 0; phase < 3; phase += 1) expect(await request(f.host, plan, phase)).toBe(true);
    await f.host.close(); const restarted = f.open();
    const restored = await restarted.prepareFromRegistry(plan.primaryWorkId, plan.workspaceId);
    expect(restored.work).toMatchObject({ hostWorkId: handle.hostWorkId, shown: 3, remaining: 0 });
    expect(await restarted.startReviewed(restored.reviewToken)).toEqual(handle);
    await expect(request(restarted, plan, 3)).rejects.toMatchObject({ reason: 'BUDGET_EXHAUSTED' });
    expect(f.shown()).toBe(3);
  });
  it('fails closed when persisted evidence disappears, without recreating it', async () => {
    const f = fixture(); const plan = registryPlan(); await f.host.start(plan); await f.host.close();
    unlinkSync(path.join(f.directory, 'host.sqlite')); const restarted = f.open();
    await expect(restarted.list(plan.workspaceId)).rejects.toMatchObject({ reason: 'HOST_REGISTRY_UNAVAILABLE' });
    await expect(restarted.prepareFromRegistry(plan.primaryWorkId, plan.workspaceId)).rejects.toMatchObject({ reason: 'HOST_REGISTRY_UNAVAILABLE' });
    expect(existsSync(path.join(f.directory, 'host.sqlite'))).toBe(false);
  });
});
