import { describe, expect, it } from 'vitest';
import { createHostApprovalInvocation, hostApprovalInputDigest, readHostApprovalInvocation } from './host-approval-invocation.js';

describe('trusted host invocation proof', () => {
  it('cannot be minted by JSON, telemetry or a cloned legitimate proof', () => {
    const value = { callId: 'call', clientId: 'client', sessionId: 'session', inputDigest: 'a'.repeat(64) };
    const proof = createHostApprovalInvocation(value);
    expect(readHostApprovalInvocation(proof)).toEqual(value);
    expect(readHostApprovalInvocation(structuredClone(proof))).toBeUndefined();
    expect(readHostApprovalInvocation({ hostInvocation: true, ...value })).toBeUndefined();
    value.clientId = 'changed';
    expect(readHostApprovalInvocation(proof)?.clientId).toBe('client');
  });
  it('hashes the complete validated action independently of key order', () => {
    expect(hostApprovalInputDigest('dom_cdp', { b: [1, 2], a: 'x' })).toBe(hostApprovalInputDigest('dom_cdp', { a: 'x', b: [1, 2] }));
    expect(hostApprovalInputDigest('dom_cdp', { value: 'changed' })).not.toBe(hostApprovalInputDigest('dom_cdp', { value: 'original' }));
    expect(hostApprovalInputDigest('other', {})).not.toBe(hostApprovalInputDigest('dom_cdp', {}));
  });
});
