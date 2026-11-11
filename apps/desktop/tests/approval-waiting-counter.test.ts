import { describe, expect, it } from 'vitest';
import { createApprovalWaitingCounter } from '../src/main/mutation-approval.js';

describe('approval waiting counter', () => {
  it('counts requests until each one is answered', async () => {
    const counter = createApprovalWaitingCounter();
    let answerFirst: (value: boolean) => void = () => undefined;
    const first = counter.track(new Promise<boolean>((resolve) => { answerFirst = resolve; }));
    const second = counter.track(Promise.resolve(false));
    expect(counter.count).toBe(2);
    await expect(second).resolves.toBe(false);
    expect(counter.count).toBe(1);
    answerFirst(true);
    await expect(first).resolves.toBe(true);
    expect(counter.count).toBe(0);
  });

  it('still releases the count when the prompt fails, and keeps the failure', async () => {
    const counter = createApprovalWaitingCounter();
    const failed = counter.track(Promise.reject(new Error('window failed')));
    expect(counter.count).toBe(1);
    await expect(failed).rejects.toThrow('window failed');
    expect(counter.count).toBe(0);
  });

  it('exposes no way to change the count from outside', () => {
    const counter = createApprovalWaitingCounter();
    expect(Object.keys(counter).sort()).toEqual(['count', 'track']);
    expect(() => { (counter as { count: number }).count = 5; }).toThrow();
    expect(counter.count).toBe(0);
  });
});
