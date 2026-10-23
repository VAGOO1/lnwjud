import { describe, expect, it } from 'vitest';
import { ContinuationStore } from './continuation-store.js';

describe('ContinuationStore', () => {
  it('consumes entries exactly once', () => {
    const store = new ContinuationStore<string>();
    store.set('token', 'value');
    expect(store.take('token')).toBe('value');
    expect(store.take('token')).toBeUndefined();
  });

  it('expires abandoned entries and evicts oldest entries over capacity', () => {
    let now = 100;
    const expiring = new ContinuationStore<string>({ ttlMs: 50, now: (): number => now });
    expiring.set('token', 'value');
    now = 150;
    expect(expiring.take('token')).toBeUndefined();

    const bounded = new ContinuationStore<number>({ maxEntries: 2 });
    bounded.set('first', 1); bounded.set('second', 2); bounded.set('third', 3);
    expect(bounded.take('first')).toBeUndefined();
    expect(bounded.take('second')).toBe(2);
    expect(bounded.take('third')).toBe(3);
  });
});
