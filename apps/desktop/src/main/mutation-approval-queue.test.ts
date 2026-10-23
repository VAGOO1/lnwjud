import { describe, expect, it } from 'vitest';
import { MutationApprovalQueue } from './mutation-approval-queue.js';

function context(): { readonly signal: AbortSignal; cancel(): void } {
  const controller = new AbortController();
  return { signal: controller.signal, cancel: (): void => controller.abort() };
}

describe('MutationApprovalQueue', () => {
  it('settles an expired queued request immediately and never opens it after the active prompt closes', async () => {
    const queue = new MutationApprovalQueue();
    const a = context(); const b = context(); const c = context();
    let allowA!: (value: boolean) => void;
    const showA = (): Promise<boolean> => new Promise((resolve) => { allowA = resolve; });
    let openedB = 0; let openedC = 0;
    const first = queue.request(a, showA);
    const second = queue.request(b, async () => { openedB += 1; return true; });
    const third = queue.request(c, async () => { openedC += 1; return true; });
    b.cancel();
    await expect(second).resolves.toBe(false);
    allowA(true);
    await expect(first).resolves.toBe(true);
    await expect(third).resolves.toBe(true);
    expect(openedB).toBe(0);
    expect(openedC).toBe(1);
  });

  it('cancels the active prompt, drains queued requests, and rejects new work during shutdown', async () => {
    const queue = new MutationApprovalQueue();
    const a = context(); const b = context(); const later = context();
    let releaseA!: (value: boolean) => void;
    let enteredA!: () => void;
    const activeShown = new Promise<void>((resolve) => { enteredA = resolve; });
    let openedB = 0;
    const first = queue.request(a, () => new Promise((resolve) => { releaseA = resolve; enteredA(); }));
    const second = queue.request(b, async () => { openedB += 1; return true; });
    await activeShown;
    queue.shutdown();
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    await expect(queue.request(later, async () => true)).resolves.toBe(false);
    expect(later.signal.aborted).toBe(true);
    expect(openedB).toBe(0);
    releaseA(false);
  });
});
