import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';
import { attachApprovalPromptDisplay, type ApprovalPromptDisplayGate } from '../src/main/approval-prompt-display.js';
import { BudgetedApprovalProvider } from '../src/main/budgeted-approval-provider.js';
import type { ApprovalBudgetTicket, ApprovalJobBudgetJournal, ApprovalJobBudgetState, ApprovalJobIdentity, ApprovalRequestContext } from '../src/main/approval-job-budget.js';

class MockPromptWindow extends EventEmitter {
  destroyed = false;
  nativeShows = 0;
  focuses = 0;
  emitShow = true;
  isDestroyed(): boolean { return this.destroyed; }
  show(): void { this.nativeShows += 1; if (this.emitShow) this.emit('show'); }
  focus(): void { this.focuses += 1; }
  close(): void { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
}
const flush = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });
function gate(overrides: Partial<ApprovalPromptDisplayGate> = {}): ApprovalPromptDisplayGate {
  return { beforeShow: vi.fn(async () => true), onShown: vi.fn(async () => true), ...overrides };
}

describe('approval prompt display lifecycle (mock windows only)', () => {
  it('counts from the show event, never from enqueue, construction or ready-to-show', async () => {
    const window = new MockPromptWindow();
    let release!: (allowed: boolean) => void;
    const lifecycle = gate({ beforeShow: () => new Promise((resolve) => { release = resolve; }) });
    attachApprovalPromptDisplay(window, lifecycle);
    expect(lifecycle.onShown).not.toHaveBeenCalled();
    window.emit('ready-to-show');
    expect(window.nativeShows).toBe(0);
    expect(lifecycle.onShown).not.toHaveBeenCalled();
    release(true); await flush();
    expect(window.nativeShows).toBe(1);
    expect(lifecycle.onShown).toHaveBeenCalledTimes(1);
  });

  it('does not turn ready-to-show or a show() return into display evidence', async () => {
    const window = new MockPromptWindow(); window.emitShow = false;
    const lifecycle = gate(); attachApprovalPromptDisplay(window, lifecycle);
    window.emit('ready-to-show'); await flush();
    expect(window.nativeShows).toBe(1);
    expect(lifecycle.onShown).not.toHaveBeenCalled();
  });

  it('denies before invoking native show and closes the hidden window', async () => {
    const window = new MockPromptWindow();
    const lifecycle = gate({ beforeShow: async () => false });
    attachApprovalPromptDisplay(window, lifecycle);
    window.show(); await flush();
    expect(window.nativeShows).toBe(0); expect(window.destroyed).toBe(true);
    expect(lifecycle.onShown).not.toHaveBeenCalled();
  });

  it('gates direct show calls and prevents reopening a consumed prompt', async () => {
    const window = new MockPromptWindow(); const lifecycle = gate();
    attachApprovalPromptDisplay(window, lifecycle);
    window.show(); window.show(); await flush();
    expect(window.nativeShows).toBe(1);
    window.show(); await flush();
    expect(window.nativeShows).toBe(1); expect(window.destroyed).toBe(true);
    expect(lifecycle.onShown).toHaveBeenCalledTimes(1);
  });

  it('an abort during the asynchronous guard prevents the window from appearing', async () => {
    const window = new MockPromptWindow(); const controller = new AbortController();
    let release!: (allowed: boolean) => void;
    const lifecycle = gate({ signal: controller.signal, beforeShow: () => new Promise((resolve) => { release = resolve; }) });
    attachApprovalPromptDisplay(window, lifecycle);
    window.emit('ready-to-show'); controller.abort(); release(true); await flush();
    expect(window.nativeShows).toBe(0); expect(window.destroyed).toBe(true);
    expect(lifecycle.onShown).not.toHaveBeenCalled();
  });

  it('closes on a failed shown journal and never treats it as approval', async () => {
    const window = new MockPromptWindow();
    attachApprovalPromptDisplay(window, gate({ onShown: async () => { throw new Error('mock journal unavailable'); } }));
    window.emit('ready-to-show'); await flush();
    expect(window.nativeShows).toBe(1); expect(window.destroyed).toBe(true);
  });

  it('preserves the existing display path when no budgeted host adapter is installed', () => {
    const window = new MockPromptWindow(); attachApprovalPromptDisplay(window);
    window.emit('ready-to-show');
    expect(window.nativeShows).toBe(1); expect(window.focuses).toBe(1);
  });

  it('passes the optional host lifecycle through the existing Desktop prompt factory', async () => {
    const main = await readFile(new URL('../src/main/main.ts', import.meta.url), 'utf8');
    const window = await readFile(new URL('../src/main/window.ts', import.meta.url), 'utf8');
    expect(main).toContain('displayGate === undefined ? undefined : { ...displayGate, signal }');
    expect(window).toContain('attachApprovalPromptDisplay(approvalWindow, displayGate)');
  });
});

class MockCasJournal implements ApprovalJobBudgetJournal {
  readonly rows = new Map<string, ApprovalJobBudgetState>();
  async load(id: string): Promise<unknown> { return structuredClone(this.rows.get(id)); }
  async compareAndSwap(id: string, revision: number | null, next: ApprovalJobBudgetState): Promise<boolean> {
    if ((this.rows.get(id)?.revision ?? null) !== revision) return false;
    this.rows.set(id, structuredClone(next)); return true;
  }
}
function work(hostWorkId: string): ApprovalJobIdentity {
  return { hostWorkId, ownerId: 'mock-owner:session-a', workspaceId: 'mock-workspace', targetId: 'exact-mock-tab:https://example.test/form', scopeDigest: 'a'.repeat(64) };
}
function requestContext(): ApprovalRequestContext {
  const controller = new AbortController();
  return { signal: controller.signal, cancel: () => controller.abort() };
}

describe('host job adapter -> Desktop display hook (no Electron or Chrome)', () => {
  it('changes 100 sequential requests from 100 mock windows to 3 and blocks 97 before construction', async () => {
    const journal = new MockCasJournal(); const provider = new BudgetedApprovalProvider(journal);
    const job = await provider.beginJob(work('host-mock-100'));
    let created = 0, displayed = 0, approved = 0, blocked = 0;
    for (let i = 0; i < 100; i++) {
      const context = requestContext();
      try {
        const allowed = await provider.request(job, { requestId: `request-${i}`, actionDigest: i.toString(16).padStart(64, '0') }, context, async (ticket) => {
          created += 1;
          const window = new MockPromptWindow();
          attachApprovalPromptDisplay(window, { ...ticket, signal: context.signal });
          return new Promise<boolean>((resolve) => {
            window.once('show', () => { displayed += 1; resolve(true); });
            window.once('closed', () => resolve(false));
            window.emit('ready-to-show');
          });
        });
        if (allowed) approved += 1;
      } catch (error) {
        expect(error).toMatchObject({ code: 'BUDGET_EXHAUSTED' }); blocked += 1;
      }
    }
    expect({ created, displayed, approved, blocked }).toEqual({ created: 3, displayed: 3, approved: 3, blocked: 97 });
    const snapshot = await provider.snapshot(job);
    expect(snapshot).toMatchObject({ requested: 100, shown: 3, blocked: 97, approved: 3, inDoubt: 0, remaining: 0 });
  });

  it('does not grant approval when a renderer-like caller returns true without an actual show event', async () => {
    const provider = new BudgetedApprovalProvider(new MockCasJournal());
    const job = await provider.beginJob(work('host-mock-no-event'));
    await expect(provider.request(job, { requestId: 'no-event', actionDigest: 'b'.repeat(64) }, requestContext(), async () => true)).resolves.toBe(false);
    expect(await provider.snapshot(job)).toMatchObject({ shown: 0, approved: 0 });
  });

  it('does not reset the limit after recreating the provider with the same journal', async () => {
    const journal = new MockCasJournal();
    let provider = new BudgetedApprovalProvider(journal); let job = await provider.beginJob(work('host-mock-reconnect'));
    const show = async (ticket: ApprovalBudgetTicket): Promise<boolean> => ticket.onShown();
    for (let i = 0; i < 3; i++) {
      await expect(provider.request(job, { requestId: `first-${i}`, actionDigest: 'c'.repeat(64) }, requestContext(), show)).resolves.toBe(true);
    }
    provider = new BudgetedApprovalProvider(journal); job = await provider.resumeJob(work('host-mock-reconnect'));
    const fourth = vi.fn(show);
    await expect(provider.request(job, { requestId: 'fourth', actionDigest: 'c'.repeat(64) }, requestContext(), fourth)).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
    expect(fourth).not.toHaveBeenCalled();
    expect(await provider.snapshot(job)).toMatchObject({ shown: 3, remaining: 0 });
  });

  it('stops after an actual shown-event write fails, retaining the unknown reservation across restart', async () => {
    const journal = new MockCasJournal(); const provider = new BudgetedApprovalProvider(journal);
    const identity = work('host-mock-shown-write-failure'); const job = await provider.beginJob(identity);
    const persist = journal.compareAndSwap.bind(journal);
    let failShown = true, created = 0;
    journal.compareAndSwap = async (id, revision, state): Promise<boolean> => {
      if (failShown && state.records.some((record) => record.status === 'shown')) throw new Error('mock disk failed after display');
      return persist(id, revision, state);
    };
    await expect(provider.request(job, { requestId: 'failed-shown', actionDigest: 'd'.repeat(64) }, requestContext(), async (ticket) => {
      created += 1;
      await expect(ticket.onShown()).rejects.toMatchObject({ code: 'JOURNAL_UNAVAILABLE' });
      return true;
    })).resolves.toBe(false);
    failShown = false;
    expect(await provider.snapshot(job)).toMatchObject({ shown: 0, approved: 0, inDoubt: 1 });
    const later = vi.fn(async () => true);
    await expect(provider.request(job, { requestId: 'later', actionDigest: 'e'.repeat(64) }, requestContext(), later)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    const restarted = new BudgetedApprovalProvider(journal); const reopened = await restarted.resumeJob(identity);
    await expect(restarted.request(reopened, { requestId: 'after-restart', actionDigest: 'e'.repeat(64) }, requestContext(), later)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(created).toBe(1); expect(later).not.toHaveBeenCalled();
  });

  it('never resets disappeared evidence when resuming a known host job', async () => {
    const journal = new MockCasJournal(); const provider = new BudgetedApprovalProvider(journal);
    const identity = work('host-mock-missing-journal'); const job = await provider.beginJob(identity);
    journal.rows.delete(identity.hostWorkId);
    await expect(provider.snapshot(job)).rejects.toMatchObject({ code: 'JOURNAL_UNAVAILABLE' });
    const restarted = new BudgetedApprovalProvider(journal);
    await expect(restarted.resumeJob(identity)).rejects.toMatchObject({ code: 'JOURNAL_UNAVAILABLE' });
    expect(journal.rows.has(identity.hostWorkId)).toBe(false);
  });

  it('rejects a contradictory approved record that has no display evidence', async () => {
    const journal = new MockCasJournal(); const provider = new BudgetedApprovalProvider(journal);
    const identity = work('host-mock-corrupt-record'); const job = await provider.beginJob(identity);
    const stored = journal.rows.get(identity.hostWorkId)!;
    journal.rows.set(identity.hostWorkId, { ...stored, requested: 1, approved: 1, records: [{ requestId: 'forged', actionDigest: 'a'.repeat(64), status: 'approved', shown: false }] });
    await expect(provider.snapshot(job)).rejects.toMatchObject({ code: 'INVALID_JOURNAL' });
  });

  it('snapshots request identity before awaiting the journal or user', async () => {
    const journal = new MockCasJournal(); const provider = new BudgetedApprovalProvider(journal);
    const identity = work('host-mock-mutable-input'); const job = await provider.beginJob(identity);
    const input = { requestId: 'original', actionDigest: 'a'.repeat(64) };
    const pending = provider.request(job, input, requestContext(), async (ticket) => ticket.onShown());
    input.requestId = 'changed'; input.actionDigest = 'b'.repeat(64);
    await expect(pending).resolves.toBe(true);
    expect(journal.rows.get(identity.hostWorkId)?.records[0]).toMatchObject({ requestId: 'original', actionDigest: 'a'.repeat(64), status: 'approved' });
  });

  it('requires a host handle, rejects malformed identities, and keeps owner/workspace/tab binding', async () => {
    const journal = new MockCasJournal(); const provider = new BudgetedApprovalProvider(journal);
    await expect(provider.beginJob({} as ApprovalJobIdentity)).rejects.toMatchObject({ code: 'INVALID_IDENTITY' });
    await expect(provider.beginJob({ ...work('invalid'), hostWorkId: 'unsafe\u0000key' })).rejects.toMatchObject({ code: 'INVALID_IDENTITY' });
    const identity = work('host-mock-binding'); const job = await provider.beginJob(identity);
    const stranger = new BudgetedApprovalProvider(journal);
    await expect(stranger.snapshot(job)).rejects.toMatchObject({ code: 'UNKNOWN_HANDLE' });
    for (const changed of [{ ownerId: 'another-room' }, { workspaceId: 'another-project' }, { targetId: 'another-tab' }, { scopeDigest: 'another-plan' }]) {
      await expect(provider.beginJob({ ...identity, ...changed })).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
    }
  });

  it('rejects late Allow after cancellation while retaining a displayed window in the count', async () => {
    const provider = new BudgetedApprovalProvider(new MockCasJournal());
    const job = await provider.beginJob(work('host-mock-late-allow')); const context = requestContext();
    const result = await provider.request(job, { requestId: 'late-allow', actionDigest: 'a'.repeat(64) }, context, async (ticket) => {
      await ticket.onShown(); context.cancel(); return true;
    });
    expect(result).toBe(false);
    expect(await provider.snapshot(job)).toMatchObject({ shown: 1, approved: 0, cancelled: 1, inDoubt: 0 });
  });

  it('an actual show event wins the counting race with an immediate cancellation', async () => {
    const provider = new BudgetedApprovalProvider(new MockCasJournal());
    const job = await provider.beginJob(work('host-mock-show-abort-race')); const context = requestContext();
    await expect(provider.request(job, { requestId: 'show-abort-race', actionDigest: 'a'.repeat(64) }, context, async (ticket) => {
      const recordActualShow = ticket.onShown();
      context.cancel();
      await recordActualShow;
      return true;
    })).resolves.toBe(false);
    expect(await provider.snapshot(job)).toMatchObject({ shown: 1, approved: 0, cancelled: 1, remaining: 2 });
  });
});
