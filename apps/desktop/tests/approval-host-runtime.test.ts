import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ok } from '@lnwjud/domain';
import { permissionProfiles, type PermissionProfile } from '@lnwjud/permissions';
import { CAPABILITY_ACTIVE_WORKSPACE_ROOT_METADATA_KEY } from '@lnwjud/capabilities';
import { createHostApprovalInvocation, hostApprovalInputDigest, readHostApprovalInvocation } from '../../../packages/mcp-server/src/host-approval-invocation.js';
import { ApprovalHostRuntime, type ApprovalHostContext, type ApprovalHostPlan, type ApprovalHostRequest } from '../src/main/approval-host-runtime.js';
import { SqliteApprovalHostStore } from '../src/main/approval-host-store.js';
import { attachApprovalPromptDisplay } from '../src/main/approval-prompt-display.js';
import type { ApprovalBudgetTicket } from '../src/main/approval-job-budget.js';
import { ToolRegistry, type HostMutationApprovalRequest, type McpApplicationServices, type WorkspaceScope } from '../../../packages/mcp-server/src/tool-registry.js';
import { domCdpCapabilitySchema } from '../../../packages/mcp-server/src/tools/schemas.js';

const stores: SqliteApprovalHostStore[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of directories.splice(0)) {
    if (path.dirname(dir) !== tmpdir() || !path.basename(dir).startsWith('lnwjud-host-runtime-')) throw new Error('Unexpected fixture cleanup path');
    rmSync(dir, { recursive: true, force: true });
  }
});
function storeAt(filename?: string): SqliteApprovalHostStore {
  if (filename !== undefined) { const store = SqliteApprovalHostStore.openExisting(filename); stores.push(store); return store; }
  const dir = mkdtempSync(path.join(tmpdir(), 'lnwjud-host-runtime-')); directories.push(dir);
  const store = SqliteApprovalHostStore.createNew(path.join(dir, 'approval.sqlite')); stores.push(store); return store;
}
function context(index: number, plan: ApprovalHostPlan, overrides = {}): ApprovalHostContext {
  const controller = new AbortController();
  return { signal: controller.signal, cancel: (): void => controller.abort(), invocationProof: createHostApprovalInvocation({
    callId: `new-call-${index}`, clientId: plan.clientId, sessionId: plan.sessionId,
    workspaceId: plan.workspaceId, tabId: plan.tabId, inputDigest: plan.requestDigests[index]!, ...overrides,
  }) };
}
function input(index: number): unknown {
  return { action: 'click', tab_id: 'mock-tab', parameters: { selector: `#phase-${index}` }, userConfirmed: true };
}
function planFor(count = 100): ApprovalHostPlan {
  return { primaryWorkId: 'fixture-primary-host-task', clientId: 'mock-client', sessionId: 'mock-session', workspaceId: 'mock-workspace', tabId: 'mock-tab', pageUrl: 'https://fixture.invalid/form',
    requestDigests: Array.from({ length: count }, (_, index) => hostApprovalInputDigest('dom_cdp', {
      ...domCdpCapabilitySchema.parse(input(index)), metadata: { [CAPABILITY_ACTIVE_WORKSPACE_ROOT_METADATA_KEY]: path.resolve(process.cwd()) },
    })) };
}
function request(plan: ApprovalHostPlan): ApprovalHostRequest {
  return { toolName: 'dom_cdp', workspaceId: plan.workspaceId, presentation: { browserTabId: plan.tabId, browserTabLookup: 'resolved', browserTabUrl: plan.pageUrl } };
}
class MockWindow extends EventEmitter {
  destroyed = false;
  shows = 0;
  isDestroyed(): boolean { return this.destroyed; }
  show(): void { this.shows += 1; this.emit('show'); }
  focus(): void { /* no native UI */ }
  close(): void { this.destroyed = true; this.emit('closed'); }
}
function displayFixture(): { windows: MockWindow[]; show(request: ApprovalHostRequest, context: ApprovalHostContext, ticket: ApprovalBudgetTicket): Promise<boolean> } {
  const windows: MockWindow[] = [];
  return { windows, async show(_request, ctx, ticket): Promise<boolean> {
    const window = new MockWindow(); windows.push(window);
    return new Promise((resolve) => {
      attachApprovalPromptDisplay(window, { signal: ctx.signal, beforeShow: ticket.beforeShow,
        onShown: async (): Promise<boolean> => { const counted = await ticket.onShown(); resolve(counted); return counted; } });
      window.emit('ready-to-show');
    });
  } };
}

describe('durable host job approval composition (SQLite and mock windows only)', () => {
  it('persists the host job, counts 3 show events and blocks 97 requests before window construction', async () => {
    const store = storeAt(); const display = displayFixture(); const runtime = new ApprovalHostRuntime(store, display.show);
    const plan = planFor(); const job = await runtime.createJob(plan);
    expect(store.readHostJob(job.hostWorkId)?.identity.hostWorkId).toBe(job.hostWorkId);
    const results = await Promise.allSettled(plan.requestDigests.map((_, index) => runtime.providerFor(job, index)(request(plan), context(index, plan))));
    expect(results.filter((result) => result.status === 'fulfilled' && result.value)).toHaveLength(3);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(97);
    expect(display.windows).toHaveLength(3); expect(display.windows.reduce((total, window) => total + window.shows, 0)).toBe(3);
    await expect(runtime.snapshot(job)).resolves.toMatchObject({ shown: 3, approved: 3, blocked: 97, remaining: 0 });
  });

  it('survives close/reopen and a separate Node process without resetting the cap or replaying a phase', async () => {
    const firstStore = storeAt(); const display = displayFixture(); const plan = planFor(4);
    const first = new ApprovalHostRuntime(firstStore, display.show); const job = await first.createJob(plan);
    for (let index = 0; index < 3; index += 1) await first.providerFor(job, index)(request(plan), context(index, plan));
    const filename = path.join(directories[0]!, 'approval.sqlite'); firstStore.close();
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1],{readOnly:true}); const row=db.prepare('SELECT state_json FROM approval_job_budgets WHERE host_work_id=?').get(process.argv[2]); console.log(JSON.stringify(JSON.parse(row.state_json))); db.close();",
      filename, job.hostWorkId], { encoding: 'utf8', windowsHide: true });
    expect(child.status, child.stderr).toBe(0); expect(JSON.parse(child.stdout)).toMatchObject({ shown: 3, approved: 3 });
    const reopened = new ApprovalHostRuntime(storeAt(filename), display.show); const resumed = await reopened.resumeJob(job.hostWorkId, plan);
    await expect(reopened.providerFor(resumed, 3)(request(plan), context(3, plan))).rejects.toMatchObject({ reason: 'BUDGET_EXHAUSTED' });
    await expect(reopened.providerFor(resumed, 0)(request(plan), context(0, plan, { callId: 'reconnected-new-call' }))).rejects.toMatchObject({ reason: 'DUPLICATE_REQUEST' });
    expect(display.windows).toHaveLength(3);
  });

  it.each(['primaryWorkId', 'clientId', 'sessionId', 'workspaceId', 'tabId', 'pageUrl', 'requestDigests'] as const)('cannot resume with changed %s', async (key) => {
    const store = storeAt(); const display = displayFixture(); const runtime = new ApprovalHostRuntime(store, display.show); const plan = planFor(4); const job = await runtime.createJob(plan);
    const changed = { ...plan, [key]: key === 'requestDigests' ? [...plan.requestDigests].reverse() : key === 'pageUrl' ? 'https://other.invalid/form' : 'other' };
    await expect(runtime.resumeJob(job.hostWorkId, changed)).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
    expect(display.windows).toHaveLength(0);
  });

  it('reuses the same primary work after a lost create response and never resets a consumed budget', async () => {
    const store = storeAt(); const plan = planFor(4); const display = displayFixture(); const first = new ApprovalHostRuntime(store, display.show);
    const job = await first.createJob(plan);
    for (let phase = 0; phase < 3; phase += 1) await first.providerFor(job, phase)(request(plan), context(phase, plan));
    store.close();
    const reopened = new ApprovalHostRuntime(storeAt(path.join(directories[0]!, 'approval.sqlite')), display.show);
    const recoveredByPrimaryId = await reopened.createJob(plan); // No prior returned UUID is needed.
    expect(recoveredByPrimaryId.hostWorkId).toBe(job.hostWorkId);
    await expect(reopened.snapshot(recoveredByPrimaryId)).resolves.toMatchObject({ shown: 3, remaining: 0 });
    await expect(reopened.providerFor(recoveredByPrimaryId, 3)(request(plan), context(3, plan))).rejects.toMatchObject({ reason: 'BUDGET_EXHAUSTED' });
    await expect(reopened.createJob({ ...plan, clientId: 'other-owner' })).rejects.toThrow(/different identity/);
    expect(display.windows).toHaveLength(3);
  });

  it('rejects forged handles/proofs, a mismatched invocation and an unresolved tab before showing', async () => {
    const store = storeAt(); const display = displayFixture(); const runtime = new ApprovalHostRuntime(store, display.show); const plan = planFor(4); const job = await runtime.createJob(plan);
    expect(() => runtime.providerFor({ hostWorkId: job.hostWorkId }, 0)).toThrow('did not bind');
    const provider = runtime.providerFor(job, 0);
    await expect(provider(request(plan), { ...context(0, plan), invocationProof: { hostInvocation: true, hostWorkId: job.hostWorkId } })).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
    for (const part of ['clientId', 'sessionId', 'workspaceId', 'tabId', 'inputDigest']) {
      await expect(provider(request(plan), context(0, plan, { [part]: part === 'inputDigest' ? 'a'.repeat(64) : 'other' }))).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
    }
    await expect(provider({ ...request(plan), presentation: { browserTabId: plan.tabId, browserTabLookup: 'unavailable', browserTabUrl: plan.pageUrl } }, context(0, plan))).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
    expect(display.windows).toHaveLength(0);
  });

  it('does not invent replacement parents or budgets when evidence is missing', async () => {
    const store = storeAt(); const display = displayFixture(); const runtime = new ApprovalHostRuntime(store, display.show);
    await expect(runtime.resumeJob('unknown-old-job', planFor(4))).rejects.toMatchObject({ code: 'JOURNAL_UNAVAILABLE' });
    store.close();
    await expect(runtime.createJob(planFor(4))).rejects.toThrow('closed');
    expect(display.windows).toHaveLength(0);
  });

  it('preserves an ambiguous reservation after reopening instead of granting a fresh budget', async () => {
    const store = storeAt(); const plan = planFor(4); let attempts = 0;
    const runtime = new ApprovalHostRuntime(store, async () => { attempts += 1; return true; });
    const job = await runtime.createJob(plan);
    expect(await runtime.providerFor(job, 0)(request(plan), context(0, plan))).toBe(false);
    const filename = path.join(directories[0]!, 'approval.sqlite'); store.close();
    const reopened = new ApprovalHostRuntime(storeAt(filename), async () => { attempts += 1; return true; });
    const resumed = await reopened.resumeJob(job.hostWorkId, plan);
    await expect(reopened.snapshot(resumed)).resolves.toMatchObject({ shown: 0, inDoubt: 1 });
    await expect(reopened.providerFor(resumed, 1)(request(plan), context(1, plan))).rejects.toMatchObject({ reason: 'RECOVERY_REQUIRED' });
    expect(attempts).toBe(1);
  });

  it.each(['missing', 'corrupt'])('fails closed when persisted budget evidence becomes %s', async (kind) => {
    const store = storeAt(); const plan = planFor(4); const display = displayFixture(); const runtime = new ApprovalHostRuntime(store, display.show);
    const job = await runtime.createJob(plan); const filename = path.join(directories[0]!, 'approval.sqlite');
    const raw = new DatabaseSync(filename);
    try {
      if (kind === 'missing') raw.prepare('DELETE FROM approval_job_budgets WHERE host_work_id=?').run(job.hostWorkId);
      else raw.prepare('UPDATE approval_job_budgets SET state_json=? WHERE host_work_id=?').run('{corrupt', job.hostWorkId);
    } finally { raw.close(); }
    await expect(runtime.resumeJob(job.hostWorkId, plan)).rejects.toMatchObject({ code: 'JOURNAL_UNAVAILABLE' });
    await expect(runtime.createJob(plan)).rejects.toMatchObject({ code: 'JOURNAL_UNAVAILABLE' });
    expect(display.windows).toHaveLength(0);
  });

  it('passes actual ToolRegistry invocation proofs through unchanged Guard decisions and returns a durable stop on request 4', async () => {
    const store = storeAt(); const display = displayFixture(); const runtime = new ApprovalHostRuntime<HostMutationApprovalRequest>(store, display.show);
    const plan = planFor(4); const job = await runtime.createJob(plan); const execute = vi.fn(async () => ok({ accepted: true }));
    const responses = []; const observations: unknown[] = [];
    for (let phase = 0; phase < 4; phase += 1) {
      const bound = runtime.providerFor(job, phase);
      const registry = new ToolRegistry({ capabilities: { execute } } as unknown as McpApplicationServices,
        { clientId: plan.clientId, clientName: 'mock-host', sessionId: plan.sessionId }, {
          sessionId: plan.sessionId, profileProvider: (): PermissionProfile => permissionProfiles.full,
          activeWorkspaceScopeProvider: (): WorkspaceScope => ({ workspaceId: plan.workspaceId, rootPath: process.cwd() }),
          hostMutationApprovalProvider: async (approval, ctx): Promise<boolean> => {
            observations.push({ approval, proof: readHostApprovalInvocation(ctx.invocationProof), digest: plan.requestDigests[phase] });
            try { return await bound({ ...approval, presentation: { ...approval.presentation, browserTabId: plan.tabId, browserTabLookup: 'resolved', browserTabUrl: plan.pageUrl } }, ctx); }
            catch (error) { observations.push(error); throw error; }
          },
        });
      responses.push(await registry.invoke('dom_cdp', input(phase), { sessionId: 'caller-trace-session', traceId: 'caller-trace-is-not-the-primary-job' }));
    }
    expect(responses.slice(0, 3).map((response) => response.isError), JSON.stringify(observations)).toEqual([undefined, undefined, undefined]);
    expect(responses[3]).toMatchObject({ isError: true, structuredContent: { error: { code: 'PERMISSION_DENIED', details: { hostWorkId: job.hostWorkId, reason: 'BUDGET_EXHAUSTED', retryAllowed: 0 } } } });
    expect(execute).toHaveBeenCalledTimes(3); expect(display.windows).toHaveLength(3);
    const state = await runtime.snapshot(job);
    expect(state).toMatchObject({ shown: 3, blocked: 1, remaining: 0, inDoubt: 0 });
  });
});
