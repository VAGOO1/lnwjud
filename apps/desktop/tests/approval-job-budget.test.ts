import { describe, expect, it } from 'vitest';
import {
  type ApprovalJobBudgetJournal,
  type ApprovalJobBudgetState,
  type ApprovalJobIdentity,
} from '../src/main/approval-job-budget.js';
import { BudgetedApprovalProvider } from '../src/main/budgeted-approval-provider.js';

const work: ApprovalJobIdentity = { hostWorkId: 'host-work-1', ownerId: 'owner-a', workspaceId: 'workspace-a', targetId: 'tab-a', scopeDigest: 'scope-a' };

class MemoryJournal implements ApprovalJobBudgetJournal {
  readonly values = new Map<string, ApprovalJobBudgetState>();
  failLoad = false;
  failWrite = false;
  async load(hostWorkId: string): Promise<unknown | undefined> {
    if (this.failLoad) throw new Error('load failed');
    const value = this.values.get(hostWorkId);
    return value === undefined ? undefined : structuredClone(value);
  }
  async compareAndSwap(hostWorkId: string, expected: number | null, next: ApprovalJobBudgetState): Promise<boolean> {
    if (this.failWrite) throw new Error('write failed');
    const current = this.values.get(hostWorkId);
    if ((current?.revision ?? null) !== expected) return false;
    this.values.set(hostWorkId, structuredClone(next));
    return true;
  }
}

function context(): { readonly signal: AbortSignal; cancel(): void } {
  const controller = new AbortController();
  return { signal: controller.signal, cancel: (): void => controller.abort() };
}

async function provider(journal = new MemoryJournal()): Promise<{ readonly journal: MemoryJournal; readonly provider: BudgetedApprovalProvider; readonly job: Awaited<ReturnType<BudgetedApprovalProvider['beginJob']>> }> {
  const instance = new BudgetedApprovalProvider(journal);
  return { journal, provider: instance, job: await instance.beginJob(work) };
}

async function approve(ticket: { onShown(): Promise<boolean> }): Promise<boolean> { return await ticket.onShown(); }

describe('ApprovalJobBudget', () => {
  it('persists a host job before issuing its opaque handle and survives provider recreation', async () => {
    const first = await provider();
    await expect(first.provider.request(first.job, { requestId: 'one', actionDigest: 'action-1' }, context(), approve)).resolves.toBe(true);
    const restarted = new BudgetedApprovalProvider(first.journal);
    const reopened = await restarted.beginJob(work);
    await expect(restarted.snapshot(reopened)).resolves.toMatchObject({ requested: 1, shown: 1, approved: 1, remaining: 2 });
  });

  it('allows only three reservations across one job and blocks the fourth before its show factory', async () => {
    const { provider: instance, job } = await provider();
    for (const id of ['one', 'two', 'three']) {
      await expect(instance.request(job, { requestId: id, actionDigest: `action-${id}` }, context(), approve)).resolves.toBe(true);
    }
    let opened = 0;
    await expect(instance.request(job, { requestId: 'four', actionDigest: 'action-four' }, context(), async () => { opened += 1; return true; }))
      .rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
    expect(opened).toBe(0);
    await expect(instance.snapshot(job)).resolves.toMatchObject({ requested: 4, shown: 3, blocked: 1, approved: 3, remaining: 0 });
  });

  it('serializes 100 competing requests and never creates more than three windows', async () => {
    const { provider: instance, job } = await provider();
    let windows = 0;
    const results = await Promise.allSettled([...Array(100)].map((_, index) => instance.request(job, { requestId: `r-${index}`, actionDigest: `a-${index}` }, context(), async (ticket) => {
      windows += 1;
      return await ticket.onShown();
    })));
    expect(results.filter((result) => result.status === 'fulfilled' && result.value).length).toBe(3);
    expect(results.filter((result) => result.status === 'rejected').length).toBe(97);
    expect(windows).toBe(3);
  });

  it('does not count a cancelled request that never reaches a show event', async () => {
    const { provider: instance, job } = await provider();
    const cancelled = context();
    cancelled.cancel();
    await expect(instance.request(job, { requestId: 'cancelled', actionDigest: 'action' }, cancelled, approve)).resolves.toBe(false);
    await expect(instance.snapshot(job)).resolves.toMatchObject({ requested: 0, shown: 0, cancelled: 0, inDoubt: 0 });
  });

  it('does not recycle an ambiguous true result that lacks an actual show event', async () => {
    const { provider: instance, job } = await provider();
    await expect(instance.request(job, { requestId: 'uncertain', actionDigest: 'action' }, context(), async () => true)).resolves.toBe(false);
    await expect(instance.snapshot(job)).resolves.toMatchObject({ requested: 1, shown: 0, approved: 0, inDoubt: 1 });
    await expect(instance.request(job, { requestId: 'later', actionDigest: 'later' }, context(), approve)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  });

  it('does not reuse a true decision for an identical request identity', async () => {
    const { provider: instance, job } = await provider();
    await expect(instance.request(job, { requestId: 'same', actionDigest: 'one' }, context(), approve)).resolves.toBe(true);
    await expect(instance.request(job, { requestId: 'same', actionDigest: 'one' }, context(), approve)).rejects.toMatchObject({ code: 'DUPLICATE_REQUEST' });
    await expect(instance.request(job, { requestId: 'same', actionDigest: 'different' }, context(), approve)).rejects.toMatchObject({ code: 'DUPLICATE_REQUEST' });
  });

  it('isolates budgets between host jobs and rejects changed owner, target, or scope', async () => {
    const journal = new MemoryJournal();
    const one = new BudgetedApprovalProvider(journal);
    const oneJob = await one.beginJob(work);
    const two = new BudgetedApprovalProvider(journal);
    const otherJob = await two.beginJob({ ...work, hostWorkId: 'host-work-2', targetId: 'tab-b' });
    await expect(one.request(oneJob, { requestId: 'one', actionDigest: 'one' }, context(), approve)).resolves.toBe(true);
    await expect(two.request(otherJob, { requestId: 'one', actionDigest: 'one' }, context(), approve)).resolves.toBe(true);
    await expect(one.beginJob({ ...work, ownerId: 'owner-b' })).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
    const recreated = new BudgetedApprovalProvider(journal);
    await expect(recreated.beginJob({ ...work, scopeDigest: 'scope-b' })).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
  });

  it('fails closed on journal load errors, corruption, CAS conflicts, and shown-write failures', async () => {
    const journal = new MemoryJournal();
    const { provider: instance, job } = await provider(journal);
    journal.failLoad = true;
    await expect(instance.snapshot(job)).rejects.toMatchObject({ code: 'JOURNAL_UNAVAILABLE' });
    journal.failLoad = false;
    journal.values.set(work.hostWorkId, { bad: true } as unknown as ApprovalJobBudgetState);
    await expect(instance.snapshot(job)).rejects.toMatchObject({ code: 'INVALID_JOURNAL' });

    const fresh = await provider();
    const competing = new BudgetedApprovalProvider(fresh.journal);
    const competingJob = await competing.beginJob(work);
    const first = fresh.provider.request(fresh.job, { requestId: 'a', actionDigest: 'a' }, context(), approve);
    const second = competing.request(competingJob, { requestId: 'b', actionDigest: 'b' }, context(), approve);
    const raced = await Promise.allSettled([first, second]);
    expect(raced.filter((result) => result.status === 'rejected').length).toBeGreaterThanOrEqual(1);

    const failedShown = await provider();
    failedShown.journal.failWrite = true;
    await expect(failedShown.provider.request(failedShown.job, { requestId: 'shown-fail', actionDigest: 'shown-fail' }, context(), approve)).rejects.toMatchObject({ code: 'JOURNAL_UNAVAILABLE' });
  });
});
