import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ok } from '@lnwjud/domain';
import type { HostMutationApprovalRequest } from '@lnwjud/mcp-server';
import { isMutationApprovalRequestValid, isMutationApprovalResponse, mutationApprovalDialogOptions } from '../src/main/mutation-approval.js';
import { createPresentedHostMutationApprovalProvider } from '../src/main/desktop-services.js';
import { mutationApprovalWindowSize } from '../src/main/mutation-approval-layout.js';

const request: HostMutationApprovalRequest = {
  toolName: 'shell',
  mutationKind: 'opaque_mutation',
  reason: 'shell run can execute effects that cannot be proven from argv',
  summary: 'tool = shell\ncwd = E:\\project-a\\tools\nexecutable = node.exe\narguments = ["cleanup.js"]',
  workspaceId: 'workspace-a',
  workspaceRoot: 'E:\\project-a',
  presentation: {
    browserTabId: 'tab-fixture-01',
    browserActions: ['type', 'type'],
    impact: 'จะพิมพ์หรือกรอกข้อมูล 2 ขั้น; เว็บไซต์อาจตรวจ บันทึก หรือส่งข้อมูลอัตโนมัติหลังคำสั่ง ระบบยังยืนยันผลต่อเนื่องไม่ได้',
    unknownImpact: true,
  },
};

afterEach(() => { vi.useRealTimers(); });

describe('desktop exact-action mutation approval', () => {
  it('makes cancel the safe default and shows the exact scoped command in Thai', () => {
    const options = mutationApprovalDialogOptions('th', request);
    expect(options).toMatchObject({
      type: 'warning', defaultId: 0, cancelId: 0, noLink: true,
      buttons: ['ยกเลิก', 'อนุญาตครั้งนี้'],
    });
    expect(options.message).toContain('มีผลต่อข้อมูล');
    expect(options.detail).toContain('สรุปก่อนอนุมัติ');
    expect(options.detail).toContain('tab-fixture-01');
    expect(options.detail).toContain('ยังตรวจชื่อหรือ URL ของแท็บไม่ได้ จึงไม่เดา');
    expect(options.detail).toContain('เครื่อง:');
    expect(options.detail).toContain('เว็บไซต์อาจตรวจ บันทึก หรือส่งข้อมูลอัตโนมัติ');
    expect(options.detail).toContain('ผลกระทบ: ยังยืนยันไม่ได้ทั้งหมด');
    expect(options.detail).toContain('E:\\project-a');
    expect(options.detail).toContain('cwd = E:\\project-a\\tools');
    expect(options.detail).toContain('arguments = ["cleanup.js"]');
    expect(options.detail).toContain(request.reason);
  });

  it('approves only the explicit second button and provides an English variant', () => {
    const options = mutationApprovalDialogOptions('en', request);
    expect(options.buttons).toEqual(['Cancel', 'Approve once']);
    expect(options.message).toContain('delete or replace data');
    expect(isMutationApprovalResponse(0)).toBe(false);
    expect(isMutationApprovalResponse(1)).toBe(true);
    expect(isMutationApprovalResponse(2)).toBe(false);
  });

  it('fails closed for empty or oversized exact-action summaries', () => {
    expect(isMutationApprovalRequestValid(request)).toBe(true);
    expect(isMutationApprovalRequestValid({ ...request, summary: '   ' })).toBe(false);
    expect(isMutationApprovalRequestValid({ ...request, summary: 'x'.repeat(8_193) })).toBe(false);
    expect(isMutationApprovalRequestValid({ ...request, toolName: '' })).toBe(false);
    expect(isMutationApprovalRequestValid({ ...request, reason: '' })).toBe(false);
  });

  it('labels unknown impact plainly instead of describing it as safe', () => {
    const options = mutationApprovalDialogOptions('th', {
      ...request,
      presentation: { impact: 'รันโค้ดในหน้าเว็บ; ระบบยืนยันผลกระทบล่วงหน้าไม่ได้', unknownImpact: true },
    });
    expect(options.detail).toContain('ผลกระทบ: ยังยืนยันไม่ได้ทั้งหมด');
    expect(options.detail).toContain('อาจเปลี่ยนข้อมูลในเครื่องหรือบริการที่คำสั่งเข้าถึง');
  });

  it('resolves only the submitted browser tab and redacts URL credentials, query, and fragment', async () => {
    const seen: HostMutationApprovalRequest[] = [];
    const provider = createPresentedHostMutationApprovalProvider(async (entry) => { seen.push(entry); return true; }, {
      listTabsIfRunning: async () => ok({ ready: true, tabs: [{ id: 'tab-fixture-01', title: '  ใบงาน\nทดสอบ  ', url: 'https://user:pass@example.test/form?secret=value#top' }] }),
    } as never);
    const controller = new AbortController();
    await expect(provider(request, { signal: controller.signal, deadlineAt: Date.now() + 10_000, cancel: () => controller.abort() })).resolves.toBe(true);
    expect(seen[0]?.presentation).toMatchObject({
      browserTabLookup: 'resolved', browserTabTitle: 'ใบงาน ทดสอบ', browserTabUrl: 'https://example.test/form',
    });
  });

  it('does not prompt with a guessed tab when the no-launch browser lookup is not ready', async () => {
    const seen: HostMutationApprovalRequest[] = [];
    const provider = createPresentedHostMutationApprovalProvider(async (entry) => { seen.push(entry); return true; }, {
      listTabsIfRunning: async () => ok({ ready: false, tabs: [] }),
    } as never);
    const controller = new AbortController();
    await expect(provider(request, { signal: controller.signal, deadlineAt: Date.now() + 10_000, cancel: () => controller.abort() })).resolves.toBe(true);
    expect(seen[0]?.presentation).toMatchObject({ browserTabLookup: 'unavailable' });
  });

  it('labels an exact tab as not found or unavailable without guessing another tab', async () => {
    const seen: HostMutationApprovalRequest[] = [];
    const provider = createPresentedHostMutationApprovalProvider(async (entry) => { seen.push(entry); return true; }, {
      listTabsIfRunning: async () => ok({ ready: true, tabs: [{ id: 'different-tab', title: 'other', url: 'https://other.test/' }] }),
    } as never);
    const controller = new AbortController();
    await provider(request, { signal: controller.signal, deadlineAt: Date.now() + 10_000, cancel: () => controller.abort() });
    expect(seen[0]?.presentation).toMatchObject({ browserTabId: 'tab-fixture-01', browserTabLookup: 'not_found' });
    expect(seen[0]?.presentation?.browserTabTitle).toBeUndefined();
  });

  it('keeps a failed tab lookup presentation-only and does not invoke approval after cancellation', async () => {
    const approve = vi.fn(async (): Promise<boolean> => true);
    const unavailable = createPresentedHostMutationApprovalProvider(approve, { listTabsIfRunning: async () => { throw new Error('browser unavailable'); } } as never);
    const first = new AbortController();
    await unavailable(request, { signal: first.signal, deadlineAt: Date.now() + 10_000, cancel: () => first.abort() });
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ presentation: expect.objectContaining({ browserTabLookup: 'unavailable' }) }), expect.anything());

    const blocked = createPresentedHostMutationApprovalProvider(approve, { listTabsIfRunning: async () => new Promise(() => {}) } as never);
    const second = new AbortController();
    second.abort();
    await expect(blocked(request, { signal: second.signal, deadlineAt: Date.now() + 10_000, cancel: () => second.abort() })).resolves.toBe(false);
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it('does not show a late approval when cancellation happens while browser status is pending', async () => {
    const approve = vi.fn(async (): Promise<boolean> => true);
    const provider = createPresentedHostMutationApprovalProvider(approve, {
      listTabsIfRunning: async (signal?: AbortSignal) => new Promise((resolve) => {
        signal?.addEventListener('abort', () => resolve(ok({ ready: true })), { once: true });
      }),
    } as never);
    const controller = new AbortController();
    const pending = provider(request, { signal: controller.signal, deadlineAt: Date.now() + 10_000, cancel: () => controller.abort() });
    controller.abort();
    await expect(pending).resolves.toBe(false);
    expect(approve).not.toHaveBeenCalled();
  });

  it('bounds a slow read-only lookup and still presents the approval as timed out', async () => {
    vi.useFakeTimers();
    const seen: HostMutationApprovalRequest[] = [];
    const provider = createPresentedHostMutationApprovalProvider(async (entry) => { seen.push(entry); return true; }, {
      listTabsIfRunning: async (signal?: AbortSignal) => new Promise((resolve) => {
        signal?.addEventListener('abort', () => resolve(ok({ tabs: [] })), { once: true });
      }),
    } as never);
    const controller = new AbortController();
    const approval = provider(request, { signal: controller.signal, deadlineAt: Date.now() + 10_000, cancel: () => controller.abort() });
    await vi.advanceTimersByTimeAsync(800);
    await expect(approval).resolves.toBe(true);
    expect(seen[0]?.presentation).toMatchObject({ browserTabLookup: 'timed_out' });
  });

  it('keeps approval details scrollable inside displays of different sizes', async () => {
    expect(mutationApprovalWindowSize({ width: 3456, height: 2234 })).toEqual({ width: 760, height: 680 });
    expect(mutationApprovalWindowSize({ width: 360, height: 300 })).toEqual({ width: 360, height: 300 });

    const [page, styles] = await Promise.all([
      readFile(new URL('../src/renderer/features/mutation-approval/MutationApprovalPage.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../src/renderer/styles.css', import.meta.url), 'utf8'),
    ]);
    expect(page).toContain('<pre dir="auto">{prompt.detail}</pre>');
    expect(page).toContain('className="mutation-approval-detail" tabIndex={0}');
    expect(styles).toMatch(/\.mutation-approval-detail\s*\{[^}]*overflow:\s*auto;/s);
    expect(styles).toMatch(/\.mutation-approval-detail\s*\{[^}]*min-height:\s*0;/s);
    expect(styles).toMatch(/\.mutation-approval-detail pre\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
  });

  it('refuses to create an approval dialog without a trusted host window or for an invalid request', () => {
    expect(() => mutationApprovalDialogOptions('en', request, false)).toThrow(/trusted host window/i);
    expect(() => mutationApprovalDialogOptions('en', { ...request, summary: '   ' }, true)).toThrow(/invalid/i);
  });
});
